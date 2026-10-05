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
    // תוכן המדבקה: מספר שקית, שם, טלפון, תאריך הזמנה (עברי, ללא ניקוד), סוג הפריט.
    const hebrewOrderDate = toHebrewDate(new Date());
    for (const b of createdBags) {
      const text = [
        `הזמנה ${order_number} | שקית ${b.bag_code}`,
        `${customer.first_name} ${customer.last_name}`,
        customer.phone,
        hebrewOrderDate,
        `${ITEM_TYPE_LABELS[b.item_type] || b.item_type}${b.quantity > 1 ? ` ×${b.quantity}` : ""}`,
      ].join("\n");
      enqueuePrint({ text, barcode: b.bag_code, copies: 1 }).catch((e) =>
        console.error("enqueuePrint failed", b.bag_code, e.message)
      );
    }

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

// רשימת שקיות עם מסננים — למסך "כל ההזמנות" (סוג פריט, מספר איסוף, סטטוס)
router.get("/bags", asyncHandler(async (req, res) => {
  const { item_type, collection_number, status } = req.query;
  const conditions = [];
  const params = [];
  if (item_type) { params.push(item_type); conditions.push(`b.item_type = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`b.status = $${params.length}`); }
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
  res.json({ bags: rows });
}));

const SCAN_DUPLICATE_WINDOW_MS = 60 * 1000;

// סריקה מהירה בחנות מול הלקוח הסופי — לאחר שהשקית חזרה מהספק: סריקה ראשונה מסמנת
// "לקוח קיבל עדכון" (ושולחת SMS), סריקה שנייה מסמנת "נאסף ע"י לקוח". מזהה לבד איזה שלב לפי מה שכבר נרשם.
router.post("/scan", asyncHandler(async (req, res) => {
  const { bag_code } = req.body || {};
  if (!bag_code) {
    res.status(400).json({ error: "bag_code נדרש" });
    return;
  }
  const { rows } = await pool.query(
    `select b.id, b.bag_code, b.status, b.customer_notified_at, b.customer_collected_at,
            o.order_number, c.first_name, c.last_name, c.phone
     from bags b
     join orders o on o.id = b.order_id
     join customers c on c.id = o.customer_id
     where b.bag_code = $1`,
    [bag_code]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  const bag = rows[0];
  const customer = { first_name: bag.first_name, last_name: bag.last_name, phone: bag.phone };

  if (bag.status !== "returned") {
    res.status(409).json({ error: "השקית עדיין לא חזרה מהספק" });
    return;
  }

  if (!bag.customer_notified_at) {
    await pool.query("update bags set customer_notified_at = now(), updated_at = now() where id = $1", [bag.id]);
    sendSms(bag.phone, `שלום ${bag.first_name}, ההזמנה שלך מספר ${bag.order_number} מוכנה לאיסוף בחנות.`).catch((e) =>
      console.error("sendSms failed", bag.bag_code, e.message)
    );
    res.json({ action: "notified", bag_code: bag.bag_code, order_number: bag.order_number, customer });
    return;
  }

  if (!bag.customer_collected_at) {
    await pool.query("update bags set customer_collected_at = now(), updated_at = now() where id = $1", [bag.id]);
    res.json({ action: "collected", bag_code: bag.bag_code, order_number: bag.order_number, customer });
    return;
  }

  if (Date.now() - new Date(bag.customer_collected_at).getTime() < SCAN_DUPLICATE_WINDOW_MS) {
    res.json({ action: "duplicate", bag_code: bag.bag_code, order_number: bag.order_number, customer });
    return;
  }
  res.status(409).json({ error: "השקית כבר נאספה ע\"י הלקוח" });
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

// צפייה בהזמנה — לבדיקה/שימוש פנימי
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
  res.json({ ...order, bags: bags.rows });
}));

// מחיקת הזמנה (ושקיותיה) — לשימוש פנימי/ניקוי נתוני בדיקה
router.delete("/:order_number", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    "delete from orders where order_number = $1 returning id",
    [req.params.order_number]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  res.json({ deleted: req.params.order_number });
}));
