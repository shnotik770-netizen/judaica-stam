# judaica-stam

אתר הזמנות ייעודי לחנות יודאייקה — יצירת הזמנה, הדפסת מדבקה, ותיאום איסוף/מסירה מול ספק הסת"ם.

פרויקט נפרד מהמערכת הפנימית הגדולה של החנות (chabad-judaica). מארח על Railway (מסד נתונים + שרת + אתר), ללא Vercel.

## הרצה מקומית
```bash
npm install
npm start
```

## תשתית
- **קוד**: GitHub — `shnotik770-netizen/judaica-stam`, ענף `main` בלבד (אין branches נפרדים — כל תיקון נכנס ישירות ל-main).
- **אירוח**: Railway בלבד (ללא Vercel) — פרויקט `hazmanat-satam`.
  - שירות `web` — שרת ה-API/אתר (Node+Express). דומיין: `web-production-68f12.up.railway.app`.
  - שירות `Postgres` — מסד הנתונים המנוהל הרשמי של Railway (עם volume אוטומטי לשמירת נתונים).
- **מדפסת מדבקות**: ממשיך להשתמש בפרויקט ה-Supabase הקיים `label-printer` (לא עובר ל-Railway) — זה החיבור היחיד שנשאר מול Supabase.
- **SMS (ימות המשיח / Call2All)**: `lib/call2all.js` — עטיפה ל-API (SendSms, GetIncomingSms, GetSmsOutLog). הטוקן נקרא אך ורק מ-`process.env.CALL2ALL_TOKEN` בצד השרת, **אף פעם לא נכתב בקוד/git**. יש להגדיר אותו ידנית במשתני הסביבה של שירות `web` ב-Railway (Variables tab) — לא דרך קוד או API אוטומטי, כדי שהטוקן לא יעבור דרך שום כלי אוטומציה.

## API

### פנימי (צוות החנות)
- `POST /api/sms/send` — `{phone, message}`
- `GET /api/sms/incoming?limit=&startDate=&endDate=` — הודעות נכנסות אחרונות
- `GET /api/sms/outgoing?limit=` — יומן הודעות יוצאות
- `GET /api/sms/conversation?phone=0501234567` — כל ההתכתבות (נכנס+יוצא) מול מספר ספציפי, ממוינת לפי זמן
- `GET /api/label/:code` (`?type=qr` לברקוד QR, ברירת מחדל Code128) — מדבקת ברקוד לשקית, תמונת PNG
- `POST /api/orders` — יצירת הזמנה+שקיות: `{order_number, customer:{customer_number, first_name, last_name, phone, address}, bags:[{item_type, item_type_note?, quantity}]}`. מחזיר `bag_code` לכל שקית. **מפעיל אוטומטית הדפסת מדבקה לכל שקית** (דרך `lib/printQueue.js`). דורש מפתח API מסוג `internal`.
- `GET /api/orders/:order_number` — צפייה בהזמנה + שקיות (`internal`)
- `DELETE /api/orders/:order_number` — מחיקת הזמנה+שקיותיה (`internal`)

### ספק הסת"ם (יודאיקה פלוס — "ניהול עבודה")
מגנים ב-API key מסוג `supplier` (header `Authorization: Bearer <key>`), מונפק דרך `npm run generate-key -- "<תווית>" supplier`.
- `GET /api/supplier/bag/:code` — פרטי שקית לפי קוד ברקוד (הזמנה, לקוח, סוג+כמות)
- `POST /api/supplier/scan` — `{bag_code, result?}`. מזהה לבד איסוף מול החזרה לפי מצב השקית הנוכחי (ראו "מודל הנתונים" למטה). מחזיר `{action: "picked_up"|"returned"|"duplicate", bag}` או שגיאה.
- `GET /api/supplier/with-me` — כל השקיות שכרגע אצל הספק (`status=with_supplier`) — למסך "מה אצלי".

### מסכי UI (סטטיים, `public/`)
- `/orders.html` — לצוות החנות: טופס יצירת הזמנה (לקוח + שקיות מרובות), דורש מפתח `internal` (נשמר ב-localStorage של הדפדפן, לא בקוד).
- `/supplier.html` — למיכאל: טאב "סריקה" (קלט רציף לסורק ברקוד — Enter שולח, צפצוף+סיכום רץ של נסרקו/תקינים/דורש בירור) וטאב "מה אצלי" (טבלת כל השקיות שבידו כרגע). דורש מפתח `supplier` (נשמר ב-localStorage).

## מודל הנתונים
`customers` (מספר לקוח **קבוע**, לעולם לא ממוחזר — זה המזהה שהספק מקשר אליו) → `orders` (מספר הזמנה קבוע) → `bags` (יחידת המעקב מול הספק: לכל שקית ברקוד **מספרי בלבד** — `{מספר הזמנה}{אינדקס שקית דו-ספרתי}`, למשל `123402` — בלי מפריד, כמו ברקוד חנות רגיל, ותואם למה שהמדפסת הפיזית כבר מכירה. `status`: `waiting_pickup → with_supplier → returned`). סוגי פריט (רשימה סגורה): `tefillin_pair/head/hand, mezuzah, megillah, sefer_torah, nach, other`.

## אימות
- מיגרציה (`db/schema.sql`) רצה אוטומטית בכל עליית שרת (`server.js` מריץ `migrate()` לפני `listen`), כל עוד `DATABASE_URL` מוגדר (מוגדר ב-Railway כ-reference `${{Postgres.DATABASE_URL}}` — אף פעם לא כערך גלוי).
- מפתחות API — טבלת `api_keys`, נשמר רק hash, עם `scope` (`internal`/`supplier`) שקובע לאיזה נתיבים מפתח מסוים מורשה (403 אם לא תואם — כדי שמפתח הספק לא יוכל ליצור הזמנות, ולהפך). `scripts/generate-api-key.js` קיים לשימוש מקומי (`npm run generate-key -- "תווית" internal|supplier`) אם יש `DATABASE_URL` זמין; בפועל (כשאין גישה למחשב עם חיבור ל-DB) נוצר מפתח חדש דרך Railway Function זמני שמריץ את אותה לוגיקה בתוך הסביבה של Railway (יש לו גישה אוטומטית ל-`DATABASE_URL` בלי שאף אחד צריך לראות את הסיסמה), ונמחק מיד אחרי.
- מפתח "יודאיקה פלוס" (`scope=supplier`) הופק ונבדק מקצה לקצה (יצירת הזמנה → `bag/:code` → `scan` איסוף → `scan` החזרה עם תוצאה → מצב סופי) מול הסביבה החיה.
- **הדפסה בפועל**: `lib/printQueue.js` משתמש באותו מנגנון Supabase/PostgREST שכבר עובד ב-chabad-judaica (`PRINT_URL`/`PRINT_KEY`) — צריך להגדיר אותם ידנית ב-Railway (Variables של שירות `web`) עם אותם ערכים שכבר קיימים ב-chabad-judaica, כדי שהדפסה אוטומטית ביצירת הזמנה תעבוד בפועל (בלעדיהם — מצב דמו, לא נדפס בפועל).

## יומן עדכונים
כל שינוי משמעותי נרשם כאן, כדי שלא נצטרך לחזור להתכתבות הישנה כדי להבין את ההיסטוריה.

- **2026-09-22** — הקמת הפרויקט: שלד Express מינימלי (`/health`), חובר ל-GitHub, נפרס ל-Railway. Postgres הוקם ראשית באופן שגוי (Docker image גולמי בלי volume) ותוקן להחלפה בתבנית Postgres המנוהלת הרשמית של Railway (דורש אישור ידני של המשתמש ב-dashboard בגלל 2FA).
- **2026-09-22** — הוספת אינטגרציית SMS מול ימות המשיח/Call2All: שליחה, קריאת הודעות נכנסות, יומן יוצאות, ותצוגת שיחה מול מספר ספציפי (`/api/sms/conversation`). דורש הגדרת `CALL2ALL_TOKEN` ידנית ב-Railway (ראו למעלה).
- **2026-10-04** — מודל נתונים + אינטגרציית ספק (ראו "מודל הנתונים"/"API" למעלה). באימות מקצה-לקצה מול הסביבה החיה התגלה באג אמיתי: שאילתת `GET /api/orders/:order_number` השתמשה בעמודת `status` דו-משמעית (קיימת גם ב-`orders` וגם ב-`bags`) — Postgres דחה את השאילתה, השגיאה לא נתפסה (אין try/catch ב-routes), ו-Node קרס (unhandled rejection), מה שגרם ל-502 וללולאת הפעלה-מחדש ב-Railway. תוקן: (1) תוקנה השאילתה, (2) כל ה-routes עטופים עכשיו ב-`asyncHandler` (`lib/asyncHandler.js`) כדי ששגיאת DB לא תפיל את כל השרת, (3) נוספה שכבת הגנה אחרונה (`app.use((err,req,res,next)=>...)`) שמחזירה 500 במקום קריסה. נוסף גם `DELETE /api/orders/:order_number` לניקוי נתוני בדיקה.
- **2026-10-04** — תגובת הספק (יודאיקה פלוס) למסמך ההתממשקות נקלטה: הוא פונה אלינו (pull, לא webhook), יחידת המעקב היא "שקית" (ברקוד נפרד לכל שקית, לא להזמנה כולה), זיהוי לקוח לפי מספר קבוע בלבד. בהתאם: נבנה מודל נתונים מלא (`customers/orders/bags`), שתי נקודות החיבור לספק (`/api/supplier/bag/:code`, `/api/supplier/scan`), אימות ב-API key, הפקת מדבקות ברקוד (Code128/QR, `/api/label/:code`), ו-endpoint פנימי ליצירת הזמנות. מיגרציה רצה אוטומטית בעליית השרת.
- **2026-10-05** — החלטה: ברקוד Code128 מספרי בלבד (כמו ברקוד חנות, בלי מפריד) — זה גם מה שהמדפסת הפיזית כבר מדפיסה. שונה `bag_code` מ-`1234-2` ל-`123402`. נוסף: (1) הפעלת הדפסה אוטומטית בפועל ביצירת הזמנה דרך `lib/printQueue.js` (אותו מנגנון Supabase כמו ב-chabad-judaica), (2) `GET /api/supplier/with-me` למסך "מה אצלי" של הספק, (3) הפרדת scope (`internal`/`supplier`) על מפתחות ה-API כדי שמפתח אחד לא ייתן גישה לנתיבים של השני, (4) שני מסכי UI סטטיים: `/orders.html` (יצירת הזמנה לצוות החנות) ו-`/supplier.html` (סריקה רציפה עם צפצוף+סיכום, וטבלת "מה אצלי" למיכאל).

