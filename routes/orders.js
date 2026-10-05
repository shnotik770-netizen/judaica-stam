import express from "express";
import { pool } from "../lib/db.js";
import { requireApiKey } from "../lib/apiKey.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { enqueuePrint } from "../lib/printQueue.js";

export const router = express.Router();
router.use(requireApiKey("internal"));

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

// יצירת הזמנה + שקיות. מספר הלקוח קבוע: אם קיים — נעשה שימוש בלקוח הקיים, אחרת נוצר חדש.
router.post("/", asyncHandler(async (req, res) => {
  const { order_number, customer, bags } = req.body || {};
  if (!order_number || !customer?.customer_number || !Array.isArray(bags) || bags.length === 0) {
    res.status(400).json({ error: "order_number, customer.customer_number ו-bags נדרשים" });
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

    const cust = await client.query(
      `insert into customers (customer_number, first_name, last_name, phone, address)
       values ($1,$2,$3,$4,$5)
       on conflict (customer_number) do update set customer_number = excluded.customer_number
       returning id`,
      [customer.customer_number, customer.first_name, customer.last_name, customer.phone, customer.address]
    );
    const customerId = cust.rows[0].id;

    const order = await client.query(
      `insert into orders (order_number, customer_id, notes, target_date)
       values ($1,$2,$3,$4) returning id, order_number`,
      [order_number, customerId, req.body.notes || null, req.body.target_date || null]
    );
    const orderId = order.rows[0].id;

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

    // הדפסת מדבקה לכל שקית ברגע יצירת ההזמנה — Code128, אותו קוד מספרי שהוחזר בכל שקית
    for (const b of createdBags) {
      const text = [
        `הזמנה מספר ${order_number}`,
        `${customer.first_name} ${customer.last_name}`,
        `${ITEM_TYPE_LABELS[b.item_type] || b.item_type}${b.quantity > 1 ? ` ×${b.quantity}` : ""}`,
      ].join("\n");
      enqueuePrint({ text, barcode: b.bag_code, copies: 1 }).catch((e) =>
        console.error("enqueuePrint failed", b.bag_code, e.message)
      );
    }

    res.status(201).json({ order_number, customer_number: customer.customer_number, bags: createdBags });
  } catch (e) {
    await client.query("rollback");
    if (e.code === "23505") {
      res.status(409).json({ error: "מספר הזמנה כבר קיים" });
    } else {
      res.status(500).json({ error: e.message });
    }
  } finally {
    client.release();
  }
}));

// צפייה בהזמנה — לבדיקה/שימוש פנימי
router.get("/:order_number", asyncHandler(async (req, res) => {
  const o = await pool.query(
    `select o.id, o.order_number, o.status, c.customer_number, c.first_name, c.last_name, c.phone, c.address
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
