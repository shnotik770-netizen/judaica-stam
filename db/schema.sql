-- סכמת judaica-stam. כל הפקודות בטוחות להרצה חוזרת (idempotent).
create extension if not exists pgcrypto;

-- לקוחות — אין מספר לקוח שלנו. מזהים לקוח קיים לפי טלפון (routes/orders.js). ספק הסת"ם
-- (יודאיקה פלוס) עושה התאמה אוטומטית אצלו לפי שם/טלפון; מה שלא מתאים נשאר אצלו לשיוך ידני.
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  phone text not null,
  address text not null,
  created_at timestamptz not null default now()
);
-- טבלה ישנה (מהדיפלוי הראשון) כללה customer_number חובה+ייחודי — מוסר לגמרי, idempotent
alter table customers drop column if exists customer_number;
-- מספר הלקוח שיודאיקה פלוס משייכים ללקוח הזה אצלם (מדווח חזרה דרך POST /api/supplier/customer-link).
-- כשאותו טלפון חוזר בעתיד, נציע את המספר הזה אוטומטית בטופס ההזמנה.
alter table customers add column if not exists supplier_customer_number text;

-- מספר הזמנה רץ, מונפק אוטומטית בשרת — אף אחד לא מזין אותו ידנית
create sequence if not exists order_number_seq start 1001;

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references customers(id),
  status text not null default 'open',
  notes text,
  target_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- איסוף (pickup run) — קיבוץ אוטומטי של שקיות שנסרקו באותו ביקור של הספק, לצורך מעקב.
-- שקית שנסרקת ומצטרפת ל"איסוף" פתוח (נסרק בו משהו ב-30 הדקות האחרונות) מצטרפת אליו;
-- אחרת נפתח איסוף חדש עם מספר רץ. ראו הלוגיקה ב-routes/supplier.js.
create sequence if not exists collection_number_seq start 1;
create table if not exists collections (
  id uuid primary key default gen_random_uuid(),
  collection_number int not null unique default nextval('collection_number_seq'),
  started_at timestamptz not null default now(),
  last_scan_at timestamptz not null default now()
);

-- שקיות — יחידת המעקב מול הספק. כל שקית = ברקוד נפרד, יכולה לנוע בנפרד מהזמנה שלה.
create table if not exists bags (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  bag_code text not null unique,
  item_type text not null check (item_type in
    ('tefillin_pair','tefillin_head','tefillin_hand','mezuzah','megillah','sefer_torah','nach','other')),
  item_type_note text,
  quantity int not null default 1,
  status text not null default 'waiting_pickup' check (status in ('waiting_pickup','with_supplier','returned')),
  result jsonb,
  collection_id uuid references collections(id),
  picked_up_at timestamptz,
  returned_at timestamptz,
  -- השלב האחרון אחרי שחזר מהספק: עדכנו את הלקוח (SMS) שהוא מוכן, ואז הלקוח בא ואסף אותו מהחנות.
  customer_notified_at timestamptz,
  customer_collected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- טבלה ישנה לא כללה את העמודות האלה — מוסיפים בדיעבד, idempotent. חייב לרוץ לפני יצירת
-- האינדקס על collection_id, אחרת ב-DB קיים (שבו ה-create table היה no-op) העמודה עוד לא קיימת.
alter table bags add column if not exists collection_id uuid references collections(id);
alter table bags add column if not exists customer_notified_at timestamptz;
alter table bags add column if not exists customer_collected_at timestamptz;
-- מתי התוכנה של הספק משכה (GET /api/supplier/with-me) את השקית בפעם הראשונה אחרי שנאספה —
-- "נכנסה לתוכנה שלו". משמש כתת-מצב בתצוגת "מה אצלי" (ראו routes/supplier.js).
alter table bags add column if not exists imported_at timestamptz;
create index if not exists idx_bags_order on bags(order_id);
create index if not exists idx_bags_status on bags(status);
create index if not exists idx_bags_collection on bags(collection_id);

-- יומן פעולות — רשומה לכל פעולה משמעותית (יצירה/סריקה/עריכה/מחיקה/תיקון ידני), למסך "ניהול".
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  bag_code text,
  order_number text,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_activity_log_created on activity_log(created_at desc);
-- מצב השקית *לפני* הפעולה (רק לפעולות שמשנות מצב: איסוף/החזרה/עדכון/איסוף לקוח/תיקון ידני) — כדי
-- שמחיקת שורה מההיסטוריה תחזיר את השקית למצב הקודם. שורות ישנות בלי זה — ראו derivePrevState ב-routes/orders.js.
alter table activity_log add column if not exists prev_state jsonb;
create index if not exists idx_activity_log_bag on activity_log(bag_code, created_at);

-- הגדרות כלליות (key/value) — כרגע רק תבנית הודעת ה-SMS ל"דיווח ללקוח", ניתנת לעריכה במסך "ניהול"
-- בלי לדרוש דיפלוי קוד. {items} בתבנית מוחלף בסיכום הפריטים (ראו routes/orders.js).
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
insert into settings (key, value) values
  ('sms_notify_template', '{items} חזרו מבדיקת סת"ם ומחכים לך ביודאיקה פלוס חב"ד.')
on conflict (key) do nothing;

-- מפתחות API. נשמר רק hash, לא הערך עצמו.
-- scope: 'internal' (צוות החנות — /api/orders) | 'supplier' (ספק חיצוני — /api/supplier/*)
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  key_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
-- טבלה ישנה (מהדיפלוי הראשון) לא כללה scope — מוסיפים בדיעבד, idempotent
alter table api_keys add column if not exists scope text not null default 'internal';
alter table api_keys drop constraint if exists api_keys_scope_check;
alter table api_keys add constraint api_keys_scope_check check (scope in ('internal','supplier'));

-- מפתח קיים שכבר הונפק ל"יודאיקה פלוס" לפני שהיה scope — מסמן אותו בדיעבד כ-supplier
update api_keys set scope = 'supplier' where label = 'יודאיקה פלוס' and scope = 'internal';

-- דוחות שהתוכנה של הספק (יודאיקה פלוס) שולחת על שקית — POST /api/supplier/report. פורמט חופשי: summary
-- (טקסט קצר לתצוגה) ו/או report (כל JSON שהתוכנה שלו מייצרת — נשמר כמו שהוא, מוצג גנרית בחנות).
-- כמה דוחות לשקית אפשריים (תיקון/השלמה) — מוצג האחרון, ההיסטוריה נשמרת.
create table if not exists bag_reports (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id) on delete cascade,
  summary text,
  report json, -- json ולא jsonb: שומר את סדר השדות כמו שהתוכנה שלו שלחה (לתצוגה)
  received_at timestamptz not null default now()
);
create index if not exists idx_bag_reports_bag on bag_reports(bag_id, received_at desc);

-- "הובא ע"י" — מי הביא את הפריטים לחנות בשם הלקוח (לא חובה). כשמולא, ההזמנה לא משויכת ללקוח קיים
-- לפי טלפון (תמיד נוצר לקוח חדש) — כי הטלפון שנמסר עלול להיות של המביא ולא של בעל הפריטים.
alter table orders add column if not exists brought_by text;

-- פרטי הפריט לפי "שפה משותפת" עם יודאיקה פלוס (מסמך של מיכאל, 07.10.2026) — קודים קבועים, רק מה שנשאל בקבלה:
-- תפילין: {"method": "rashi"|"rt", "leather": "gassot"|"pshutim"|"dakot"|"parshiot_only"}; מזוזה: {"form": "rolled"|"open"}.
-- null = לא נשאל כלום. נשלח לספק כמו שהוא בשדה variant (ראו lib/variant.js, SUPPLIER_API.md).
alter table bags add column if not exists variant jsonb;

-- "מוכן אצל מיכאל": התוכנה של הספק סיימה את הבדיקה ושלחה דוח (POST /api/supplier/report) — השקית שוחררה
-- מהתוכנה אבל עדיין פיזית אצלו. רק "מסירה לחנות" (bulk-scan return) מעבירה ל-returned, כדי שנדע שהגיעה לחנות.
alter table bags add column if not exists ready_at timestamptz;

-- "נמסר ללקוח ע"י מיכאל": השקית לא חזרה לחנות — מיכאל מסר אותה ללקוח בדרך אחרת (סטטוס סופי delivered_direct).
-- מרחיבים את ה-check של status (נוצר אוטומטית בשם bags_status_check) — drop+add, idempotent.
alter table bags add column if not exists delivered_direct_at timestamptz;
alter table bags add column if not exists delivered_direct_note text;
alter table bags drop constraint if exists bags_status_check;
alter table bags add constraint bags_status_check
  check (status in ('waiting_pickup','with_supplier','returned','delivered_direct'));

-- כמה בתי מזוזה הגיעו עם המזוזות (נשאל בקבלה; לא חובה). רק למזוזה, 0..quantity. null = לא נשאל.
alter table bags add column if not exists mezuzah_cases int;

-- הערה של הספק על השקית (POST /api/supplier/note) — למשל פער בכמות/בבתי מזוזה, או משהו שהחנות צריכה לדעת
-- כשהשקית חוזרת. מוצגת בחנות על השקית. ריקה = אין הערה.
alter table bags add column if not exists supplier_note text;
alter table bags add column if not exists supplier_note_at timestamptz;
