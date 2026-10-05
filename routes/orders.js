import express from "express";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { enqueuePrint } from "../lib/printQueue.js";
import { toHebrewDate } from "../lib/hebrewDate.js";
import { sendSms } from "../lib/call2all.js";

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
  enqueuePrint({ text, barcode: bag.bag_code, copies: 1 }).catch((e) =>
    console.error("enqueuePrint failed", bag.bag_code, e.message)
  );
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

// רשימת שקיות עם מסננים — למסך "כל ההזמנות" (סוג פריט, מספר איסוף, סטטוס)
router.get("/bags", asyncHandler(async (req, res) => {
  const { item_type, collection_number, status } = req.query;
  const conditions = [];
  const params = [];
  if (item_type) { params.push(item_type); conditions.push(`b.item_type = $${params.length}`); }
  if (status && BAG_STATUS_CONDITIONS[status]) {
    conditions.push(BAG_STATUS_CONDITIONS[status]);
  } else if (status) {
    params.push(status); conditions.push(`b.status = $${params.length}`);
  }
  if (collection_number) { params.push(+collection_number); conditions.push(`col.collection_number = $${params.length}`); }
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

// סריקה מהירה בחנות מול הלקוח הסופי, לשקיות שכבר חזרו מהספק. action נבחר מראש ע"י הצוות
// (לא מנוחש לפי מצב השקית) — "notify" מסמן שהלקוח קיבל עדכון ושולח SMS, "collect" מסמן שנאסף
// ע"י הלקוח. תומך גם בכמה שקיות בבת אחת (bag_codes) — לסריקה רציפה או לסימון V מרשימה.
router.post("/scan", asyncHandler(async (req, res) => {
  const { bag_codes, action } = req.body || {};
  if (!Array.isArray(bag_codes) || bag_codes.length === 0) {
    res.status(400).json({ error: "bag_codes נדרש" });
    return;
  }
  if (!["notify", "collect"].includes(action)) {
    res.status(400).json({ error: "action חייב להיות notify או collect" });
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

    if (action === "notify") {
      if (bag.customer_notified_at && Date.now() - new Date(bag.customer_notified_at).getTime() < SCAN_DUPLICATE_WINDOW_MS) {
        results.push({ bag_code: code, ok: true, action: "duplicate", order_number: bag.order_number, customer });
        continue;
      }
      await pool.query("update bags set customer_notified_at = now(), updated_at = now() where id = $1", [bag.id]);
      sendSms(bag.phone, `שלום ${bag.first_name}, ההזמנה שלך מספר ${bag.order_number} מוכנה לאיסוף בחנות.`).catch((e) =>
        console.error("sendSms failed", bag.bag_code, e.message)
      );
      results.push({ bag_code: code, ok: true, action: "notified", order_number: bag.order_number, customer });
      continue;
    }

    // action === "collect"
    if (bag.customer_collected_at && Date.now() - new Date(bag.customer_collected_at).getTime() < SCAN_DUPLICATE_WINDOW_MS) {
      results.push({ bag_code: code, ok: true, action: "duplicate", order_number: bag.order_number, customer });
      continue;
    }
    await pool.query("update bags set customer_collected_at = now(), updated_at = now() where id = $1", [bag.id]);
    results.push({ bag_code: code, ok: true, action: "collected", order_number: bag.order_number, customer });
  }

  res.json({ results });
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
  res.json({ deleted: req.params.order_number });
}));
