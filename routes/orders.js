import express from "express";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { enqueuePrint } from "../lib/printQueue.js";
import { toHebrewDate } from "../lib/hebrewDate.js";
import { sendSms } from "../lib/call2all.js";
import { logActivity } from "../lib/activityLog.js";
import { getSetting, setSetting } from "../lib/settings.js";

export const router = express.Router();
// ללא אימות בכוונה — החלטת החנות: מי שיש לו גישה לאתר יכול ליצור הזמנות, בלי קוד API.

const ITEM_TYPES = [
  "tefillin_pair",
  "tefillin_head",
  "tefillin_hand",
  "mezuzah",
  "megillah",
  "sefer_torah",
  "nach",
  "other",
];

const ITEM_TYPE_LABELS = {
  tefillin_pair: "תפילין זוג",
  tefillin_head: "תפילין ראש",
  tefillin_hand: "תפילין יד",
  mezuzah: "מזוזה",
  megillah: "מגילה",
  sefer_torah: "ספר תורה",
  nach: "נ\"ך",
  other: "אחר",
};

const ITEM_TYPE_PLURALS = {
  tefillin_pair: "זוגות תפילין",
  tefillin_head: "תפילין ראש",
  tefillin_hand: "תפילין יד",
  mezuzah: "מזוזות",
  megillah: "מגילות",
  sefer_torah: "ספרי תורה",
  nach: "ספרי נ\"ך",
  other: "פריטים",
};

const DEFAULT_SMS_TEMPLATE = '{items} חזרו מבדיקת סת"ם ומחכים לך ביודאיקה פלוס חב"ד.';

// מסכם רשימת שקיות לטקסט קריא ("2 מזוזות, תפילין זוג") — לשימוש בתבנית הודעת ה-SMS.
function summarizeItems(bags) {
  const totals = {};
  for (const b of bags) totals[b.item_type] = (totals[b.item_type] || 0) + (b.quantity || 1);
  return Object.entries(totals)
    .map(([type, qty]) => (qty > 1 ? `${qty} ${ITEM_TYPE_PLURALS[type] || ITEM_TYPE_LABELS[type] || type}` : (ITEM_TYPE_LABELS[type] || type)))
    .join(", ");
}

// קוד שקית מספרי בלבד (כמו ברקוד של חנות) — מספר הזמנה + 2 ספרות רצף שקית, בלי מפריד.
// למשל הזמנה 1234, שקית 2 -> "123402".
const makeBagCode = (orderNumber, bagIndex) => `${orderNumber}${String(bagIndex).padStart(2, "0")}`;

// מדפיס מדבקה לשקית אחת — מספר שקית, שם, טלפון, תאריך (עברי), סוג הפריט.
function printBagLabel(order_number, customer, bag) {
  const text = [
    `הזמנה ${order_number} | שקית ${bag.bag_code}`,
    `${customer.first_name} ${customer.last_name}`,
    customer.phone,
    toHebrewDate(new Date()),
    `${ITEM_TYPE_LABELS[bag.item_type] || bag.item_type}${bag.quantity > 1 ? ` ×${bag.quantity}` : ""}`,
  ].join("\n");
  enqueuePrint({ text, barcode: bag.bag_code, copies: 1 }).catch((e) => {
    console.error("enqueuePrint failed", bag.bag_code, e.message);
    logActivity(bag.bag_code, order_number, "print_failed", e.message);
  });
}

// הזמנה "נעולה" לעריכה/מחיקה ברגע שאחת השקיות שלה כבר נכנסה למערכת הספק (כל סטטוס מלבד waiting_pickup) —
// מאותו רגע השינוי חייב לעבור דרך הספק/המיכאל, לא דרכנו.
async function isOrderLocked(orderId) {
  const { rows } = await pool.query(
    "select 1 from bags where order_id = $1 and status != 'waiting_pickup' limit 1",
    [orderId]
  );
  return rows.length > 0;
}

// יצירת הזמנה + שקיות. מספר הזמנה מונפק אוטומטית (רץ). אין מספר לקוח — מזהים לפי טלפון
// (אם כבר קיים לקוח עם אותו טלפון, מעדכנים את הפרטים שלו ומשתמשים באותו רשומה; אחרת יוצרים חדש).
router.post("/", asyncHandler(async (req, res) => {
  const { customer, bags } = req.body || {};
  if (!customer?.phone || !customer?.first_name || !customer?.last_name || !Array.isArray(bags) || bags.length === 0) {
    res.status(400).json({ error: "customer (first_name, last_name, phone, address) ו-bags נדרשים" });
    return;
  }
  for (const b of bags) {
    if (!ITEM_TYPES.includes(b.item_type)) {
      res.status(400).json({ error: `item_type לא תקין: ${b.item_type}` });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await client.query("select id from customers where phone = $1", [customer.phone]);
    let customerId;
    if (existing.rows.length > 0) {
      customerId = existing.rows[0].id;
      await client.query(
        "update customers set first_name=$1, last_name=$2, address=$3 where id=$4",
        [customer.first_name, customer.last_name, customer.address, customerId]
      );
    } else {
      const inserted = await client.query(
        `insert into customers (first_name, last_name, phone, address)
         values ($1,$2,$3,$4) returning id`,
        [customer.first_name, customer.last_name, customer.phone, customer.address]
      );
      customerId = inserted.rows[0].id;
    }

    const order = await client.query(
      `insert into orders (order_number, customer_id, notes, target_date)
       values (nextval('order_number_seq')::text,$1,$2,$3) returning id, order_number`,
      [customerId, req.body.notes || null, req.body.target_date || null]
    );
    const orderId = order.rows[0].id;
    const order_number = order.rows[0].order_number;

    const createdBags = [];
    for (let i = 0; i < bags.length; i++) {
      const b = bags[i];
      const bagCode = makeBagCode(order_number, i + 1);
      const r = await client.query(
        `insert into bags (order_id, bag_code, item_type, item_type_note, quantity)
         values ($1,$2,$3,$4,$5) returning bag_code, item_type, quantity`,
        [orderId, bagCode, b.item_type, b.item_type_note || null, b.quantity || 1]
      );
      createdBags.push(r.rows[0]);
    }

    await client.query("commit");

    // הדפסת מדבקה לכל שקית ברגע יצירת ההזמנה — Code128, אותו קוד מספרי שהוחזר בכל שקית.
    for (const b of createdBags) printBagLabel(order_number, customer, b);

    logActivity(null, order_number, "order_created", `${createdBags.length} שקיות`);
    res.status(201).json({ order_number, bags: createdBags });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}));

// בדיקת לקוח קיים לפי טלפון — לפני יצירת הזמנה, כדי להציע את מספר הלקוח אצל הספק אם כבר ידוע
router.get("/customer-lookup", asyncHandler(async (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) {
    res.status(400).json({ error: "phone נדרש" });
    return;
  }
  const { rows } = await pool.query(
    "select first_name, last_name, address, supplier_customer_number from customers where phone = $1",
    [phone]
  );
  if (rows.length === 0) {
    res.json({ found: false });
    return;
  }
  res.json({ found: true, ...rows[0] });
}));

// סטטוס "חזר" מתפצל ל-3 תתי-מצב לצורך סינון (לא עמודה אמיתית — b.status נשאר 'returned' תמיד,
// ראו routes/orders.js POST /scan). not_collected משמש פנימית בצד הלקוח (סריקה ללקוח, מטרת "איסוף").
const BAG_STATUS_CONDITIONS = {
  returned_at_store: "b.status = 'returned' and b.customer_notified_at is null",
  notified: "b.status = 'returned' and b.customer_notified_at is not null and b.customer_collected_at is null",
  not_collected: "b.status = 'returned' and b.customer_collected_at is null",
  collected: "b.status = 'returned' and b.customer_collected_at is not null",
};

// סיכום מהיר — "X ממתינים לאיסוף, X אצל מיכאל" — מוצג מיד בכניסה לטאב "כל ההזמנות".
router.get("/summary", asyncHandler(async (req, res) => {
  const { rows } = await pool.query("select status, count(*)::int as count from bags group by status");
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const { rows: failRows } = await pool.query(
    "select count(*)::int as count from activity_log where action = 'print_failed' and created_at > now() - interval '24 hours'"
  );
  res.json({
    waiting_pickup: counts.waiting_pickup || 0,
    with_supplier: counts.with_supplier || 0,
    print_failures_24h: failRows[0]?.count || 0,
  });
}));

// רשימת שקיות עם מסננים — למסך "כל ההזמנות" (סוג פריט, מספר איסוף, סטטוס, חיפוש חופשי)
router.get("/bags", asyncHandler(async (req, res) => {
  const { item_type, collection_number, status, q } = req.query;
  const conditions = [];
  const params = [];
  if (item_type) { params.push(item_type); conditions.push(`b.item_type = $${params.length}`); }
  if (status && BAG_STATUS_CONDITIONS[status]) {
    conditions.push(BAG_STATUS_CONDITIONS[status]);
  } else if (status) {
    params.push(status); conditions.push(`b.status = $${params.length}`);
  }
  if (collection_number) { params.push(+collection_number); conditions.push(`col.collection_number = $${params.length}`); }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    conditions.push(
      `(c.first_name ilike $${params.length} or c.last_name ilike $${params.length} or
        c.phone ilike $${params.length} or b.bag_code ilike $${params.length} or o.order_number ilike $${params.length})`
    );
  }
  const where = conditions.length ? "where " + conditions.join(" and ") : "";

  const { rows } = await pool.query(
    `select o.order_number, c.first_name, c.last_name, c.phone,
            b.bag_code, b.item_type, b.item_type_note, b.quantity, b.status,
            b.picked_up_at, b.returned_at, b.customer_notified_at, b.customer_collected_at, b.created_at,
            col.collection_number, col.started_at as collection_started_at
     from bags b
     join orders o on o.id = b.order_id
     join customers c on c.id = o.customer_id
     left join collections col on col.id = b.collection_id
     ${where}
     order by b.created_at desc`,
    params
  );
  res.json({ bags: rows.map((b) => ({ ...b, created_at_hebrew: toHebrewDate(b.created_at) })) });
}));

const SCAN_DUPLICATE_WINDOW_MS = 60 * 1000;

async function loadBagForScan(code) {
  const { rows } = await pool.query(
    `select b.id, b.bag_code, b.status, b.customer_notified_at, b.customer_collected_at,
            o.order_number, c.first_name, c.last_name, c.phone
     from bags b
     join orders o on o.id = b.order_id
     join customers c on c.id = o.customer_id
     where b.bag_code = $1`,
    [code]
  );
  return rows[0] || null;
}

// כל השקיות של אותו טלפון שחזרו מהספק (כולל השקית הנסרקת עצמה) — כדי שדיווח אחד יכסה את כולן
// בבת אחת, בלי צורך לדווח כל שקית בנפרד כשכמה הזמנות חזרו יחד לאותו לקוח. ב-force (דיווח חוזר
// מכוון) כוללים גם שקיות שכבר עודכנו בעבר — לא רק את מה שעדיין ממתין.
async function findReturnedGroup(phone, { onlyUnnotified }) {
  const cond = onlyUnnotified ? "and b.customer_notified_at is null" : "";
  const { rows } = await pool.query(
    `select b.id, b.bag_code, b.item_type, b.quantity, o.order_number
     from bags b join orders o on o.id = b.order_id join customers c on c.id = o.customer_id
     where c.phone = $1 and b.status = 'returned' ${cond}`,
    [phone]
  );
  return rows;
}

// סריקה מהירה בחנות מול הלקוח הסופי, לשקיות שכבר חזרו מהספק. action נבחר מראש ע"י הצוות
// (לא מנוחש לפי מצב השקית): "notify_manual" מסמן שהלקוח עודכן בדרך כלשהי מחוץ למערכת (טלפון
// וכד') בלי לשלוח כלום; "notify_sms" שולח SMS אמיתי ורק אם נשלח בהצלחה מסמן כמו notify_manual;
// "collect" מסמן שנאסף ע"י הלקוח. notify_* מקבצים לפי מספר טלפון — דיווח על שקית אחת מסמן
// אוטומטית את כל שקיות אותו טלפון שעדיין לא עודכנו (למשל כמה הזמנות שחזרו ביחד). תומך בכמה
// שקיות בבת אחת (bag_codes) — לסריקה רציפה או ללחיצה מרשימה. `force:true` מדווח/שולח שוב
// במתכוון גם על שקית שכבר עודכנה (ה-UI מציג אזהרה ומבקש אישור מפורש לפני שליחת force) — כל
// פעם (כולל חוזרות) נרשמת ביומן הפעולות, כך שההיסטוריה המלאה של כל הדיווחים על שקית נשמרת.
router.post("/scan", asyncHandler(async (req, res) => {
  const { bag_codes, action, force } = req.body || {};
  if (!Array.isArray(bag_codes) || bag_codes.length === 0) {
    res.status(400).json({ error: "bag_codes נדרש" });
    return;
  }
  if (!["notify_manual", "notify_sms", "collect"].includes(action)) {
    res.status(400).json({ error: "action חייב להיות notify_manual, notify_sms או collect" });
    return;
  }

  const results = [];
  for (const code of bag_codes) {
    const bag = await loadBagForScan(code);
    if (!bag) {
      results.push({ bag_code: code, ok: false, error: "קוד לא מוכר" });
      continue;
    }
    const customer = { first_name: bag.first_name, last_name: bag.last_name, phone: bag.phone };

    if (bag.status !== "returned") {
      results.push({ bag_code: code, ok: false, error: "השקית עדיין לא חזרה מהספק" });
      continue;
    }

    if (action === "notify_manual" || action === "notify_sms") {
      if (bag.customer_notified_at && !force) {
        results.push({
          bag_code: code, ok: true, action: "duplicate", order_number: bag.order_number, customer,
          message: "הלקוח כבר עודכן — ככל הנראה כחלק מדיווח על שקית אחרת שלו",
          notified_at: bag.customer_notified_at,
        });
        continue;
      }

      const isRepeat = Boolean(bag.customer_notified_at);
      const group = await findReturnedGroup(bag.phone, { onlyUnnotified: !force });
      if (action === "notify_sms") {
        const template = await getSetting("sms_notify_template", DEFAULT_SMS_TEMPLATE);
        const message = template.replace("{items}", summarizeItems(group));
        try {
          await sendSms(bag.phone, message);
        } catch (e) {
          results.push({ bag_code: code, ok: false, error: "שליחת SMS נכשלה: " + e.message });
          continue;
        }
      }

      await pool.query(
        "update bags set customer_notified_at = now(), updated_at = now() where id = any($1)",
        [group.map((g) => g.id)]
      );
      const groupNote = group.length > 1 ? ` · קובצו ${group.length} שקיות של אותו טלפון` : "";
      const repeatNote = isRepeat ? " · דיווח חוזר" : "";
      for (const g of group) {
        logActivity(g.bag_code, g.order_number, "customer_notified", (action === "notify_sms" ? "SMS" : "ידני") + groupNote + repeatNote);
      }
      results.push({
        bag_code: code, ok: true, action: "notified", order_number: bag.order_number, customer,
        grouped_bag_codes: group.map((g) => g.bag_code), repeat: isRepeat,
      });
      continue;
    }

    // action === "collect"
    if (bag.customer_collected_at && Date.now() - new Date(bag.customer_collected_at).getTime() < SCAN_DUPLICATE_WINDOW_MS) {
      results.push({ bag_code: code, ok: true, action: "duplicate", order_number: bag.order_number, customer });
      continue;
    }
    await pool.query("update bags set customer_collected_at = now(), updated_at = now() where id = $1", [bag.id]);
    logActivity(bag.bag_code, bag.order_number, "customer_collected", null);
    results.push({ bag_code: code, ok: true, action: "collected", order_number: bag.order_number, customer });
  }

  res.json({ results });
}));

// הגדרות (כרגע רק תבנית ה-SMS) — למסך "ניהול". נרשם לפני ה-route הפרמטרי /:order_number כדי שלא יתבלע בו.
router.get("/settings", asyncHandler(async (req, res) => {
  const sms_notify_template = await getSetting("sms_notify_template", DEFAULT_SMS_TEMPLATE);
  res.json({ sms_notify_template });
}));
router.put("/settings", asyncHandler(async (req, res) => {
  const { sms_notify_template } = req.body || {};
  if (!sms_notify_template || !sms_notify_template.trim()) {
    res.status(400).json({ error: "sms_notify_template נדרש" });
    return;
  }
  await setSetting("sms_notify_template", sms_notify_template.trim());
  logActivity(null, null, "settings_changed", "sms_notify_template");
  res.json({ ok: true });
}));

// יומן פעולות אחרונות — למסך "ניהול". נרשם לפני ה-route הפרמטרי /:order_number כדי שלא יתבלע בו.
// bag_code (התאמה מדויקת) — להיסטוריה המלאה של שקית ספציפית (מסך העריכה). q (חיפוש חכם) —
// מסנן גם לפי קוד שקית/מספר הזמנה וגם לפי שם/טלפון הלקוח (דרך join ל-bags/orders/customers,
// כי activity_log עצמה לא שומרת פרטי לקוח) — לתיבת החיפוש בטאב "ניהול".
router.get("/activity-log", asyncHandler(async (req, res) => {
  const limit = Math.min(+req.query.limit || 100, 500);
  const bagCode = (req.query.bag_code || "").trim();
  const q = (req.query.q || "").trim();

  if (bagCode) {
    const { rows } = await pool.query(
      "select bag_code, order_number, action, detail, created_at from activity_log where bag_code = $1 order by created_at desc limit $2",
      [bagCode, limit]
    );
    res.json({ log: rows });
    return;
  }

  if (q) {
    const { rows } = await pool.query(
      `select al.bag_code, al.order_number, al.action, al.detail, al.created_at
       from activity_log al
       left join bags b on b.bag_code = al.bag_code
       left join orders ob on ob.id = b.order_id
       left join orders oo on oo.order_number = al.order_number
       left join customers c on c.id = coalesce(ob.customer_id, oo.customer_id)
       where al.bag_code ilike $1 or al.order_number ilike $1 or
             c.first_name ilike $1 or c.last_name ilike $1 or c.phone ilike $1
       order by al.created_at desc limit $2`,
      [`%${q}%`, limit]
    );
    res.json({ log: rows });
    return;
  }

  const { rows } = await pool.query(
    "select bag_code, order_number, action, detail, created_at from activity_log order by created_at desc limit $1",
    [limit]
  );
  res.json({ log: rows });
}));

// רשימת כל ההזמנות + סיכום סטטוס שקיות לכל אחת — למסך "כל ההזמנות"
router.get("/", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select o.order_number, o.created_at, c.first_name, c.last_name, c.phone,
            count(b.id) as bag_count,
            count(b.id) filter (where b.status = 'waiting_pickup') as waiting_count,
            count(b.id) filter (where b.status = 'with_supplier') as with_supplier_count,
            count(b.id) filter (where b.status = 'returned') as returned_count
     from orders o
     join customers c on c.id = o.customer_id
     left join bags b on b.order_id = o.id
     group by o.id, c.id
     order by o.created_at desc`
  );
  res.json({ orders: rows });
}));

// צפייה בהזמנה — גם למסך העריכה. locked=true אם אחת השקיות כבר נכנסה למערכת הספק (לא ניתן יותר
// לערוך/למחוק את ההזמנה או שקיות שלה — השינוי חייב לעבור דרכו).
router.get("/:order_number", asyncHandler(async (req, res) => {
  const o = await pool.query(
    `select o.id, o.order_number, o.status, c.first_name, c.last_name, c.phone, c.address
     from orders o join customers c on c.id = o.customer_id
     where o.order_number = $1`,
    [req.params.order_number]
  );
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  const bags = await pool.query(
    `select bag_code, item_type, item_type_note, quantity, status, result, picked_up_at, returned_at
     from bags where order_id = $1 order by bag_code`,
    [o.rows[0].id]
  );
  const { id, ...order } = o.rows[0];
  const locked = bags.rows.some((b) => b.status !== "waiting_pickup");
  res.json({ ...order, locked, bags: bags.rows });
}));

// עריכת פרטי לקוח ופרטי שקיות קיימות בהזמנה (סוג/הערה/כמות, לא מספר שקית/ברקוד) —
// רק כל עוד ההזמנה לא נעולה (ראו isOrderLocked למעלה).
router.put("/:order_number", asyncHandler(async (req, res) => {
  const { customer, bags } = req.body || {};
  if (!customer?.phone || !customer?.first_name || !customer?.last_name) {
    res.status(400).json({ error: "customer (first_name, last_name, phone, address) נדרש" });
    return;
  }
  const o = await pool.query(
    "select id, customer_id from orders where order_number = $1",
    [req.params.order_number]
  );
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  const { id: orderId, customer_id: customerId } = o.rows[0];
  if (await isOrderLocked(orderId)) {
    res.status(409).json({ error: "ההזמנה כבר נכנסה למערכת הספק ולא ניתנת לעריכה" });
    return;
  }

  await pool.query(
    "update customers set first_name=$1, last_name=$2, phone=$3, address=$4 where id=$5",
    [customer.first_name, customer.last_name, customer.phone, customer.address, customerId]
  );

  for (const b of bags || []) {
    if (!ITEM_TYPES.includes(b.item_type)) {
      res.status(400).json({ error: `item_type לא תקין: ${b.item_type}` });
      return;
    }
    await pool.query(
      "update bags set item_type=$1, item_type_note=$2, quantity=$3, updated_at=now() where bag_code=$4 and order_id=$5",
      [b.item_type, b.item_type_note || null, b.quantity || 1, b.bag_code, orderId]
    );
  }

  logActivity(null, req.params.order_number, "order_edited", null);
  res.json({ ok: true });
}));

// הוספת שקית חדשה להזמנה קיימת (ומדפיסה לה מדבקה מיד, כמו ביצירת הזמנה) — רק כל עוד ההזמנה לא נעולה.
router.post("/:order_number/bags", asyncHandler(async (req, res) => {
  const { item_type, item_type_note, quantity } = req.body || {};
  if (!ITEM_TYPES.includes(item_type)) {
    res.status(400).json({ error: `item_type לא תקין: ${item_type}` });
    return;
  }
  const o = await pool.query(
    `select o.id, o.order_number, c.first_name, c.last_name, c.phone
     from orders o join customers c on c.id = o.customer_id where o.order_number = $1`,
    [req.params.order_number]
  );
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  const order = o.rows[0];
  if (await isOrderLocked(order.id)) {
    res.status(409).json({ error: "ההזמנה כבר נכנסה למערכת הספק ולא ניתנת לעריכה" });
    return;
  }

  const existing = await pool.query("select bag_code from bags where order_id = $1", [order.id]);
  const nextIndex = 1 + existing.rows.reduce((max, r) => {
    const n = +String(r.bag_code).slice(-2);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  const bagCode = makeBagCode(order.order_number, nextIndex);

  const r = await pool.query(
    `insert into bags (order_id, bag_code, item_type, item_type_note, quantity)
     values ($1,$2,$3,$4,$5) returning bag_code, item_type, item_type_note, quantity, status`,
    [order.id, bagCode, item_type, item_type_note || null, quantity || 1]
  );
  const bag = r.rows[0];
  printBagLabel(order.order_number, order, bag);
  logActivity(bag.bag_code, order.order_number, "bag_added", null);
  res.status(201).json(bag);
}));

// מחיקת שקית בודדת מהזמנה — רק כל עוד ההזמנה לא נעולה.
router.delete("/:order_number/bags/:bag_code", asyncHandler(async (req, res) => {
  const o = await pool.query("select id from orders where order_number = $1", [req.params.order_number]);
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  const orderId = o.rows[0].id;
  if (await isOrderLocked(orderId)) {
    res.status(409).json({ error: "ההזמנה כבר נכנסה למערכת הספק ולא ניתנת לעריכה" });
    return;
  }
  const { rows } = await pool.query(
    "delete from bags where bag_code = $1 and order_id = $2 returning id",
    [req.params.bag_code, orderId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "שקית לא נמצאה בהזמנה הזו" });
    return;
  }
  logActivity(req.params.bag_code, req.params.order_number, "bag_deleted", null);
  res.json({ deleted: req.params.bag_code });
}));

// מחיקת הזמנה (ושקיותיה) — רק כל עוד ההזמנה לא נעולה.
router.delete("/:order_number", asyncHandler(async (req, res) => {
  const o = await pool.query("select id from orders where order_number = $1", [req.params.order_number]);
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  if (await isOrderLocked(o.rows[0].id)) {
    res.status(409).json({ error: "ההזמנה כבר נכנסה למערכת הספק ולא ניתנת למחיקה" });
    return;
  }
  await pool.query("delete from orders where id = $1", [o.rows[0].id]);
  logActivity(null, req.params.order_number, "order_deleted", null);
  res.json({ deleted: req.params.order_number });
}));

// תיקון ידני של סטטוס שקית — עוקף את ה"נעילה" במתכוון, לתיקון טעויות (למשל סריקה שגויה).
// זהירות: לא מנהל קשרים (collection/טיימר כפילות) כמו הנתיבים הרגילים — שינוי ישיר של status בלבד,
// עם אפשרות לאפס את חותמות הלקוח. כל שימוש נרשם ביומן הפעולות לצורך מעקב.
const BAG_STATUSES = ["waiting_pickup", "with_supplier", "returned"];
router.put("/bags/:bag_code/force-status", asyncHandler(async (req, res) => {
  const { status, reset_notified, reset_collected } = req.body || {};
  if (!BAG_STATUSES.includes(status)) {
    res.status(400).json({ error: `status חייב להיות אחד מ: ${BAG_STATUSES.join(", ")}` });
    return;
  }
  const sets = ["status=$1", "updated_at=now()"];
  const params = [status, req.params.bag_code];
  if (reset_notified) sets.push("customer_notified_at=null");
  if (reset_collected) sets.push("customer_collected_at=null");
  const { rows } = await pool.query(
    `update bags set ${sets.join(", ")} where bag_code=$2 returning bag_code, status`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  logActivity(req.params.bag_code, null, "manual_fix", `status=${status}`);
  res.json(rows[0]);
}));

// הדפסה חוזרת של מדבקה — למשל אחרי שההדפסה המקורית נכשלה (PRINT_URL/PRINT_KEY לא היו מוגדרים
// עדיין), או שהמדבקה הפיזית אבדה/נקרעה. מותר גם על הזמנה נעולה — לא משנה שום מצב, רק מדפיס שוב.
router.post("/bags/:bag_code/reprint", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select b.bag_code, b.item_type, b.quantity, o.order_number, c.first_name, c.last_name, c.phone
     from bags b join orders o on o.id = b.order_id join customers c on c.id = o.customer_id
     where b.bag_code = $1`,
    [req.params.bag_code]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  const bag = rows[0];
  printBagLabel(bag.order_number, bag, bag);
  logActivity(bag.bag_code, bag.order_number, "label_reprinted", null);
  res.json({ ok: true });
}));
