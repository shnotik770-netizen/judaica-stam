import express from "express";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logActivity, snapshotBagStates } from "../lib/activityLog.js";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "../lib/itemTypes.js";
import { VARIANT_FIELDS, cleanVariant } from "../lib/variant.js";

export const router = express.Router();
// ללא אימות בכוונה — החלטת המשתמש: מיכאל אמור להיות מחובר תמיד בלי להזין מפתח כדי לעבוד.
// (סיכון מודע: כל מי שיגלה/ינחש את ה-URL יכול לקרוא לנתיבים האלה — ראו README ליומן ההחלטה.)

const DUPLICATE_WINDOW_MS = 60 * 1000;
const COLLECTION_WINDOW_MS = 30 * 60 * 1000; // חלון קיבוץ לאיסוף: סריקה בפער של עד 30 דקות מצטרפת לאותו איסוף

const BAG_SELECT = `
  select b.*, o.order_number, o.notes as order_notes, o.brought_by,
         c.first_name, c.last_name, c.phone, c.address, c.supplier_customer_number,
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
  if (bag.status === "delivered_direct") return "delivered_direct";
  if (bag.status === "returned") return "returning";
  if (bag.ready_at) return "ready"; // התוכנה שלו שלחה דוח ושחררה — מוכן אצלו, עוד לא נמסר לחנות
  return bag.imported_at ? "imported" : "collected";
}

function serializeBag(bag) {
  return {
    bag_code: bag.bag_code,
    order_number: bag.order_number,
    brought_by: bag.brought_by || null, // מי הביא את הפריטים בשם הלקוח (לא חובה)
    status: bag.status,
    stage: bagStage(bag),
    item_type: bag.item_type,
    item_type_note: bag.item_type_note,
    quantity: bag.quantity,
    // פרטי הפריט בקודים המוסכמים עם הספק (lib/variant.js); null = לא נשאל כלום בקבלה
    variant: bag.variant || null,
    picked_up_at: bag.picked_up_at,
    imported_at: bag.imported_at,
    ready_at: bag.ready_at || null,
    returned_at: bag.returned_at,
    delivered_direct_at: bag.delivered_direct_at || null,
    delivered_direct_note: bag.delivered_direct_note || null,
    report_received_at: bag.report_received_at || null, // null = עוד לא נשלח דוח על השקית
    collection_number: bag.collection_number || null,
    collection_started_at: bag.collection_started_at || null,
    customer: {
      first_name: bag.first_name,
      last_name: bag.last_name,
      phone: bag.phone,
      address: bag.address,
      // מספר הלקוח אצל הספק (customer-link) — כדי שהשקית תיכנס אצלו ישר לכרטיס הנכון, גם אם הלקוח החליף טלפון
      supplier_customer_number: bag.supplier_customer_number || null,
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
  // בלי פירוט ביומן — הדוח עצמו נשמר ב-result ומוצג בכפתור "דוח ממיכאל"
  logActivity(bag.bag_code, bag.order_number, "returned", null, prev);
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
  const { bag_codes, action, force } = req.body || {};
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
        // מסירה לחנות של שקית שהתוכנה של הספק עוד לא שחררה (אין דוח) — מותר, אבל רק אחרי אישור מפורש (force)
        if (!bag.ready_at && !force) {
          results.push({ bag_code: code, ok: false, needs_confirm: true, error: "שקית זו לא דווחה כנבדקה" });
          continue;
        }
        await returnBag(bag, bag.result || null);
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
// {bag_code, summary?, report?} או כמה בבת אחת {reports: [...]}. report = כל JSON, נשמר כמו שהוא.
// דוח = השקית נבדקה ושוחררה מהתוכנה שלו: אם היא אצל הספק היא עוברת ל"מוכן אצל מיכאל" (ready_at) — אבל
// *לא* מוחזרת לחנות. ההחזרה רק ב"מסירה לחנות" (bulk-scan return), כדי שנדע שהשקית באמת הגיעה פיזית.
// mark_returned (מהגרסה הקודמת) מתקבל אבל כבר לא מחזיר — מתנהג כמו דוח רגיל.
router.post("/report", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.reports) ? body.reports : [body];
  if (items.length === 0 || items.length > 200) {
    res.status(400).json({ error: "צריך דוח אחד לפחות (ועד 200 בבקשה אחת)" });
    return;
  }
  const results = [];
  for (const item of items) {
    const { bag_code, summary, report } = item || {};
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
    let released = false;
    if (bag.status === "with_supplier" && !bag.ready_at) {
      const prev = (await snapshotBagStates([bag.bag_code])).get(bag.bag_code);
      await pool.query(
        "update bags set ready_at = now(), result = $2, updated_at = now() where id = $1",
        [bag.id, report === undefined ? JSON.stringify({ summary: cleanSummary }) : JSON.stringify(report)]
      );
      logActivity(bag.bag_code, bag.order_number, "released", null, prev);
      released = true;
    }
    results.push({
      bag_code: bag.bag_code, ok: true, report_id: rows[0].id, received_at: rows[0].received_at,
      released, returned: false, // returned נשאר תמיד false — ההחזרה רק ב"מסירה לחנות"
    });
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

// "נמסר ללקוח ישירות" — השקית לא חוזרת לחנות: מיכאל מסר אותה ללקוח בדרך אחרת. סטטוס סופי delivered_direct,
// יורדת מ"אצלי" (with-me) ולא מחכה למסירה לחנות. גוף: {bag_code, note?} (note = איך נמסר, לא חובה).
// ניתן לביטול מההיסטוריה (snapshot ב-prev_state).
router.post("/deliver-direct", asyncHandler(async (req, res) => {
  const { bag_code, note } = req.body || {};
  if (!bag_code) {
    res.status(400).json({ error: "bag_code נדרש" });
    return;
  }
  const bag = await loadBag(String(bag_code));
  if (!bag) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  if (bag.status !== "with_supplier") {
    res.status(409).json({ error: "אפשר לסמן רק שקית שנמצאת אצל הספק" });
    return;
  }
  const cleanNote = String(note || "").trim().slice(0, 300) || null;
  const prev = (await snapshotBagStates([bag.bag_code])).get(bag.bag_code);
  await pool.query(
    `update bags set status = 'delivered_direct', delivered_direct_at = now(), delivered_direct_note = $2, updated_at = now()
     where id = $1`,
    [bag.id, cleanNote]
  );
  logActivity(bag.bag_code, bag.order_number, "delivered_direct", cleanNote, prev);
  res.json({ ok: true, bag: serializeBag(await loadBag(bag.bag_code)) });
}));

// תיקון פרטים מהספק — כשמיכאל מגלה שמשהו נרשם לא נכון בקבלה (כמות, סוג, פרטי פריט, או שם/טלפון/כתובת של הלקוח).
// גוף: {bag_code, item_type?, quantity?, item_type_note?, variant?, customer?: {first_name?, last_name?, phone?, address?}}
// או כמה בבת אחת {updates: [...]}. רק השדות שנשלחו נבדקים; ביומן נרשם רק מה שבאמת השתנה ("כמות: מ-6 ל-7").
// variant מתמזג עם הקיים (ערך null/"" מוחק שדה), ואחר כך מנוקה לפי סוג הפריט. עוקף את נעילת ההזמנה במתכוון —
// הספק מתקן לפי מה שיש אצלו פיזית. הלקוח שמתעדכן הוא הלקוח של ההזמנה של השקית (משפיע על כל ההזמנות שלו).
const CUSTOMER_FIELD_LABELS = { first_name: "שם פרטי", last_name: "שם משפחה", phone: "טלפון", address: "כתובת" };
const shown = (v) => (v == null || v === "" ? "לא צוין" : String(v));
const variantValueLabel = (key, v) => (v == null ? "לא צוין" : VARIANT_FIELDS[key]?.options[v] || v);

async function applySupplierUpdate(item) {
  const { bag_code, customer } = item || {};
  if (!bag_code) return { bag_code: null, ok: false, error: "bag_code נדרש" };
  const bag = await loadBag(String(bag_code));
  if (!bag) return { bag_code, ok: false, error: "קוד לא מוכר" };

  const bagSets = {};
  const changes = [];
  // סוג פריט
  let itemType = bag.item_type;
  if (item.item_type !== undefined && item.item_type !== bag.item_type) {
    if (!ITEM_TYPES.includes(item.item_type)) return { bag_code, ok: false, error: `item_type לא תקין: ${item.item_type}` };
    itemType = item.item_type;
    bagSets.item_type = itemType;
    changes.push(`סוג פריט: מ-${ITEM_TYPE_LABELS[bag.item_type]} ל-${ITEM_TYPE_LABELS[itemType]}`);
  }
  // כמות
  if (item.quantity !== undefined) {
    const q = Number(item.quantity);
    if (!Number.isInteger(q) || q < 1) return { bag_code, ok: false, error: "quantity חייב להיות מספר שלם חיובי" };
    if (q !== bag.quantity) { bagSets.quantity = q; changes.push(`כמות: מ-${bag.quantity} ל-${q}`); }
  }
  // הערה
  if (item.item_type_note !== undefined) {
    const note = String(item.item_type_note ?? "").trim() || null;
    if (note !== (bag.item_type_note || null)) { bagSets.item_type_note = note; changes.push(`הערה: מ-${shown(bag.item_type_note)} ל-${shown(note)}`); }
  }
  // פרטי פריט (variant) — מיזוג עם הקיים, ניקוי לפי סוג הפריט (גם אם רק סוג הפריט השתנה)
  if (item.variant !== undefined || bagSets.item_type) {
    const merged = { ...(bag.variant || {}), ...(item.variant && typeof item.variant === "object" ? item.variant : {}) };
    const cleaned = cleanVariant(itemType, merged);
    if (cleaned.error) return { bag_code, ok: false, error: cleaned.error };
    const before = bag.variant || {};
    const after = cleaned.variant || {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] !== after[key]) {
        changes.push(`${VARIANT_FIELDS[key]?.label || key}: מ-${variantValueLabel(key, before[key])} ל-${variantValueLabel(key, after[key])}`);
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) bagSets.variant = cleaned.variant ? JSON.stringify(cleaned.variant) : null;
  }
  // פרטי לקוח
  const customerSets = {};
  if (customer && typeof customer === "object") {
    for (const key of Object.keys(CUSTOMER_FIELD_LABELS)) {
      if (customer[key] === undefined) continue;
      const value = String(customer[key] ?? "").trim();
      if (!value && key !== "address") return { bag_code, ok: false, error: `${key} לא יכול להיות ריק` };
      if (value !== (bag[key] || "")) {
        customerSets[key] = value;
        changes.push(`${CUSTOMER_FIELD_LABELS[key]}: מ-${shown(bag[key])} ל-${shown(value)}`);
      }
    }
  }

  if (changes.length === 0) return { bag_code: bag.bag_code, ok: true, changes: [] };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const bagKeys = Object.keys(bagSets);
    if (bagKeys.length) {
      await client.query(
        `update bags set ${bagKeys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`,
        [bag.id, ...bagKeys.map((k) => bagSets[k])]
      );
    }
    const custKeys = Object.keys(customerSets);
    if (custKeys.length) {
      await client.query(
        `update customers set ${custKeys.map((k, i) => `${k} = $${i + 2}`).join(", ")}
         where id = (select customer_id from orders where order_number = $1)`,
        [bag.order_number, ...custKeys.map((k) => customerSets[k])]
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  logActivity(bag.bag_code, bag.order_number, "supplier_update", changes.join(" · "));
  return { bag_code: bag.bag_code, ok: true, changes };
}

router.post("/update", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.updates) ? body.updates : [body];
  if (items.length === 0 || items.length > 200) {
    res.status(400).json({ error: "צריך עדכון אחד לפחות (ועד 200 בבקשה אחת)" });
    return;
  }
  const results = [];
  for (const item of items) results.push(await applySupplierUpdate(item));
  res.json({ results });
}));

// מספר הלקוח אצל הספק. עדיף לפי שקית — {bag_code, customer_number}: מעדכן רק את הלקוח של ההזמנה של אותה שקית,
// בלי תלות בטלפון (ובלי לפגוע בלקוחות אחרים עם אותו טלפון, למשל מי ש"הביא" פריטים). אפשרות ישנה לפי טלפון —
// {phone, customer_number}: משווה לפי ספרות בלבד (050-1234567 = 0501234567) ומעדכן את כל הלקוחות עם אותו טלפון.
router.post("/customer-link", asyncHandler(async (req, res) => {
  const { phone, bag_code, customer_number } = req.body || {};
  if (!customer_number || (!phone && !bag_code)) {
    res.status(400).json({ error: "customer_number נדרש, יחד עם bag_code (מועדף) או phone" });
    return;
  }
  const number = String(customer_number).trim();
  let rows;
  if (bag_code) {
    ({ rows } = await pool.query(
      `update customers set supplier_customer_number = $2
       where id = (select o.customer_id from bags b join orders o on o.id = b.order_id where b.bag_code = $1)
       returning id`,
      [String(bag_code), number]
    ));
    if (rows.length === 0) {
      res.status(404).json({ error: "קוד שקית לא מוכר" });
      return;
    }
    const bag = await loadBag(String(bag_code));
    logActivity(bag.bag_code, bag.order_number, "customer_linked", `מספר לקוח אצל מיכאל: ${number}`);
    res.json({ ok: true, updated: rows.length });
    return;
  }
  const digits = String(phone).replace(/\D/g, "");
  ({ rows } = await pool.query(
    "update customers set supplier_customer_number = $2 where regexp_replace(phone, '\\D', '', 'g') = $1 returning id",
    [digits, number]
  ));
  if (rows.length === 0) {
    res.status(404).json({ error: "לא נמצא לקוח עם הטלפון הזה אצלנו" });
    return;
  }
  logActivity(null, null, "customer_linked", `טלפון ${phone} · מספר לקוח אצל מיכאל: ${number}`);
  res.json({ ok: true, updated: rows.length });
}));
