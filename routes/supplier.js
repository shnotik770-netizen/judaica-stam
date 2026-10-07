import express from "express";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logActivity, snapshotBagStates } from "../lib/activityLog.js";

export const router = express.Router();
// ללא אימות בכוונה — החלטת המשתמש: מיכאל אמור להיות מחובר תמיד בלי להזין מפתח כדי לעבוד.
// (סיכון מודע: כל מי שיגלה/ינחש את ה-URL יכול לקרוא לנתיבים האלה — ראו README ליומן ההחלטה.)

const DUPLICATE_WINDOW_MS = 60 * 1000;
const COLLECTION_WINDOW_MS = 30 * 60 * 1000; // חלון קיבוץ לאיסוף: סריקה בפער של עד 30 דקות מצטרפת לאותו איסוף

const BAG_SELECT = `
  select b.*, o.order_number, o.notes as order_notes,
         c.first_name, c.last_name, c.phone, c.address,
         col.collection_number, col.started_at as collection_started_at,
         (select max(r.received_at) from bag_reports r where r.bag_id = b.id) as report_received_at
  from bags b
  join orders o on o.id = b.order_id
  join customers c on c.id = o.customer_id
  left join collections col on col.id = b.collection_id
`;

async function loadBag(code) {
  const { rows } = await pool.query(BAG_SELECT + " where b.bag_code = $1", [code]);
  return rows[0] || null;
}

// שלב תצוגה למסך "מה אצלי": אספתי (עוד לא נמשך ע"י התוכנה) / נכנס לתוכנה (נמשך) / במסירה לחנות (כבר הוחזר).
function bagStage(bag) {
  if (bag.status === "returned") return "returning";
  return bag.imported_at ? "imported" : "collected";
}

function serializeBag(bag) {
  return {
    bag_code: bag.bag_code,
    order_number: bag.order_number,
    status: bag.status,
    stage: bagStage(bag),
    item_type: bag.item_type,
    item_type_note: bag.item_type_note,
    quantity: bag.quantity,
    picked_up_at: bag.picked_up_at,
    imported_at: bag.imported_at,
    returned_at: bag.returned_at,
    report_received_at: bag.report_received_at || null, // null = עוד לא נשלח דוח על השקית
    collection_number: bag.collection_number || null,
    collection_started_at: bag.collection_started_at || null,
    customer: {
      first_name: bag.first_name,
      last_name: bag.last_name,
      phone: bag.phone,
      address: bag.address,
    },
  };
}

// מוצא איסוף פתוח (נסרק בו משהו ב-30 הדקות האחרונות) או פותח חדש, ומעדכן last_scan_at.
async function getOrCreateCollection(client) {
  const open = await client.query(
    `select id from collections where last_scan_at > now() - interval '30 minutes' order by last_scan_at desc limit 1`
  );
  if (open.rows.length > 0) {
    await client.query("update collections set last_scan_at = now() where id = $1", [open.rows[0].id]);
    return open.rows[0].id;
  }
  const created = await client.query("insert into collections default values returning id");
  return created.rows[0].id;
}

// כל השקיות שממתינות לאיסוף — תצוגה מקדימה בלבד, לא השלב המרכזי (ראו README).
router.get("/pending", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(BAG_SELECT + " where b.status = 'waiting_pickup' order by o.created_at asc");
  res.json({ bags: rows.map(serializeBag) });
}));

// כל השקיות שכרגע אצל הספק, פלוס מה שהוחזר לאחרונה (שעתיים אחרונות — שלב "במסירה לחנות") — למסך "מה אצלי".
// קריאה לנתיב הזה היא גם "משיכה" של השקיות לתוכנה שלו — לכן מסמנת imported_at לכל שקית
// שעוד לא נמשכה (בלי לגעת בשקיות שכבר סומנו).
router.get("/with-me", asyncHandler(async (req, res) => {
  await pool.query(
    "update bags set imported_at = now() where status = 'with_supplier' and imported_at is null"
  );
  const { rows } = await pool.query(
    BAG_SELECT + ` where b.status = 'with_supplier'
       or (b.status = 'returned' and b.returned_at > now() - interval '2 hours')
     order by coalesce(b.returned_at, b.picked_up_at) asc`
  );
  res.json({ bags: rows.map(serializeBag) });
}));

// פרטי שקית — לפי קוד ברקוד
router.get("/bag/:code", asyncHandler(async (req, res) => {
  const bag = await loadBag(req.params.code);
  if (!bag) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  res.json(serializeBag(bag));
}));

// מבצע בפועל מסירה (איסוף) — פתוח/הצטרפות ל"איסוף" + עדכון השקית, בטרנזקציה אחת.
async function pickupBag(bag) {
  const prev = (await snapshotBagStates([bag.bag_code])).get(bag.bag_code);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const collectionId = await getOrCreateCollection(client);
    await client.query(
      `update bags set status='with_supplier', picked_up_at=now(), collection_id=$2, updated_at=now()
       where id=$1`,
      [bag.id, collectionId]
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  logActivity(bag.bag_code, bag.order_number, "picked_up", null, prev);
}

// מבצע בפועל החזרה
async function returnBag(bag, result) {
  const prev = (await snapshotBagStates([bag.bag_code])).get(bag.bag_code);
  await pool.query(
    `update bags set status='returned', returned_at=now(), result=$2, updated_at=now() where id=$1`,
    [bag.id, result ? JSON.stringify(result) : null]
  );
  logActivity(bag.bag_code, bag.order_number, "returned", result ? JSON.stringify(result) : null, prev);
}

// עדכון סטטוס — מזהה לבד אם זו מסירה (איסוף) או החזרה, לפי מצב השקית הנוכחי. לסריקה בודדת
// (מכשיר/מצלמה) — מתאים כי פיזית ברור אם סורקים בביקור איסוף או בביקור החזרה.
router.post("/scan", asyncHandler(async (req, res) => {
  const { bag_code, result } = req.body || {};
  if (!bag_code) {
    res.status(400).json({ error: "bag_code נדרש" });
    return;
  }
  const bag = await loadBag(bag_code);
  if (!bag) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }

  const now = Date.now();

  if (bag.status === "waiting_pickup") {
    await pickupBag(bag);
    const fresh = await loadBag(bag_code);
    res.json({ action: "picked_up", bag: serializeBag(fresh) });
    return;
  }

  if (bag.status === "with_supplier") {
    // סריקה כפולה באותו ביקור — לא נרשם שוב, בלי שאלה
    if (bag.picked_up_at && now - new Date(bag.picked_up_at).getTime() < DUPLICATE_WINDOW_MS) {
      res.json({ action: "duplicate", bag: serializeBag(bag) });
      return;
    }
    await returnBag(bag, result);
    const fresh = await loadBag(bag_code);
    res.json({ action: "returned", bag: serializeBag(fresh) });
    return;
  }

  // status === 'returned'
  if (bag.returned_at && now - new Date(bag.returned_at).getTime() < DUPLICATE_WINDOW_MS) {
    res.json({ action: "duplicate", bag: serializeBag(bag) });
    return;
  }
  res.status(409).json({ error: "השקית כבר הוחזרה" });
}));

// סימון מרובה מרשימה (במקום סריקה) — מיכאל יכול לעבור על "ממתין לאיסוף"/"מה אצלי" ולסמן
// V על כמה שקיות בבת אחת, במקום לסרוק כל אחת. action נקבע לפי הרשימה שבה מסמנים (לא ניחוש).
router.post("/bulk-scan", asyncHandler(async (req, res) => {
  const { bag_codes, action } = req.body || {};
  if (!Array.isArray(bag_codes) || bag_codes.length === 0) {
    res.status(400).json({ error: "bag_codes נדרש" });
    return;
  }
  if (!["pickup", "return"].includes(action)) {
    res.status(400).json({ error: "action חייב להיות pickup או return" });
    return;
  }

  const results = [];
  for (const code of bag_codes) {
    try {
      const bag = await loadBag(code);
      if (!bag) {
        results.push({ bag_code: code, ok: false, error: "קוד לא מוכר" });
        continue;
      }
      if (action === "pickup") {
        if (bag.status !== "waiting_pickup") {
          results.push({ bag_code: code, ok: false, error: "השקית לא ממתינה לאיסוף" });
          continue;
        }
        await pickupBag(bag);
      } else {
        if (bag.status !== "with_supplier") {
          results.push({ bag_code: code, ok: false, error: "השקית לא אצל הספק" });
          continue;
        }
        await returnBag(bag, null);
      }
      const fresh = await loadBag(code);
      results.push({ bag_code: code, ok: true, bag: serializeBag(fresh) });
    } catch (e) {
      results.push({ bag_code: code, ok: false, error: e.message });
    }
  }
  res.json({ results });
}));

// הספק מדווח לנו מה מספר הלקוח שהוא שייך ללקוח הזה אצלו — נשמר לפי טלפון, ויוצע אוטומטית
// בפעם הבאה שאותו טלפון מוזן אצלנו בהזמנה חדשה.
// דוח מהתוכנה של הספק על שקית — פורמט חופשי (ראו SUPPLIER_API.md). גוף: דוח בודד
// {bag_code, summary?, report?, mark_returned?} או כמה בבת אחת {reports: [...]}. report = כל JSON, נשמר כמו שהוא.
// mark_returned:true גם מסמן את השקית כהוחזרה (אם היא אצל הספק) — כמו "מסירה לחנות", עם הדוח כ-result.
router.post("/report", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.reports) ? body.reports : [body];
  if (items.length === 0 || items.length > 200) {
    res.status(400).json({ error: "צריך דוח אחד לפחות (ועד 200 בבקשה אחת)" });
    return;
  }
  const results = [];
  for (const item of items) {
    const { bag_code, summary, report, mark_returned } = item || {};
    if (!bag_code) { results.push({ bag_code: null, ok: false, error: "bag_code נדרש" }); continue; }
    if ((summary == null || String(summary).trim() === "") && report === undefined) {
      results.push({ bag_code, ok: false, error: "צריך summary או report (או שניהם)" });
      continue;
    }
    const bag = await loadBag(String(bag_code));
    if (!bag) { results.push({ bag_code, ok: false, error: "קוד לא מוכר" }); continue; }
    if (bag.status === "waiting_pickup") {
      results.push({ bag_code, ok: false, error: "השקית עוד לא נאספה — אי אפשר לשלוח עליה דוח" });
      continue;
    }
    const cleanSummary = summary == null ? null : String(summary).trim().slice(0, 2000) || null;
    const { rows } = await pool.query(
      "insert into bag_reports (bag_id, summary, report) values ($1, $2, $3) returning id, received_at",
      [bag.id, cleanSummary, report === undefined ? null : JSON.stringify(report)]
    );
    logActivity(bag.bag_code, bag.order_number, "report_received", cleanSummary ? cleanSummary.slice(0, 200) : null);
    let returned = false;
    if (mark_returned && bag.status === "with_supplier") {
      await returnBag(bag, report === undefined ? { summary: cleanSummary } : report);
      returned = true;
    }
    results.push({ bag_code: bag.bag_code, ok: true, report_id: rows[0].id, received_at: rows[0].received_at, returned });
  }
  res.json({ results });
}));

// הדוחות שהתקבלו על שקית (מהחדש לישן) — כדי שהתוכנה של הספק תוכל לוודא מה נקלט אצלנו
router.get("/report/:code", asyncHandler(async (req, res) => {
  const bag = await loadBag(req.params.code);
  if (!bag) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  const { rows } = await pool.query(
    "select id, summary, report, received_at from bag_reports where bag_id = $1 order by received_at desc",
    [bag.id]
  );
  res.json({ bag_code: bag.bag_code, reports: rows });
}));

router.post("/customer-link", asyncHandler(async (req, res) => {
  const { phone, customer_number } = req.body || {};
  if (!phone || !customer_number) {
    res.status(400).json({ error: "phone ו-customer_number נדרשים" });
    return;
  }
  const { rows } = await pool.query(
    "update customers set supplier_customer_number = $2 where phone = $1 returning id",
    [phone, customer_number]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "לא נמצא לקוח עם הטלפון הזה אצלנו" });
    return;
  }
  logActivity(null, null, "customer_linked", `phone=${phone} customer_number=${customer_number}`);
  res.json({ ok: true });
}));
