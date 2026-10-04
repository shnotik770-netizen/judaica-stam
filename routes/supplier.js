import express from "express";
import { pool } from "../lib/db.js";
import { requireApiKey } from "../lib/apiKey.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const router = express.Router();
router.use(requireApiKey);

const DUPLICATE_WINDOW_MS = 60 * 1000;

async function loadBag(code) {
  const { rows } = await pool.query(
    `select b.*, o.order_number, o.notes as order_notes,
            c.customer_number, c.first_name, c.last_name, c.phone, c.address
     from bags b
     join orders o on o.id = b.order_id
     join customers c on c.id = o.customer_id
     where b.bag_code = $1`,
    [code]
  );
  return rows[0] || null;
}

function serializeBag(bag) {
  return {
    bag_code: bag.bag_code,
    order_number: bag.order_number,
    status: bag.status,
    item_type: bag.item_type,
    item_type_note: bag.item_type_note,
    quantity: bag.quantity,
    customer: {
      customer_number: bag.customer_number,
      first_name: bag.first_name,
      last_name: bag.last_name,
      phone: bag.phone,
      address: bag.address,
    },
  };
}

// פרטי שקית — לפי קוד ברקוד
router.get("/bag/:code", asyncHandler(async (req, res) => {
  const bag = await loadBag(req.params.code);
  if (!bag) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  res.json(serializeBag(bag));
}));

// עדכון סטטוס — מזהה לבד אם זו מסירה (איסוף) או החזרה, לפי מצב השקית הנוכחי
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
    const { rows } = await pool.query(
      `update bags set status='with_supplier', picked_up_at=now(), updated_at=now()
       where id=$1 returning *`,
      [bag.id]
    );
    res.json({ action: "picked_up", bag: serializeBag({ ...bag, ...rows[0] }) });
    return;
  }

  if (bag.status === "with_supplier") {
    // סריקה כפולה באותו ביקור — לא נרשם שוב, בלי שאלה
    if (bag.picked_up_at && now - new Date(bag.picked_up_at).getTime() < DUPLICATE_WINDOW_MS) {
      res.json({ action: "duplicate", bag: serializeBag(bag) });
      return;
    }
    const { rows } = await pool.query(
      `update bags set status='returned', returned_at=now(), result=$2, updated_at=now()
       where id=$1 returning *`,
      [bag.id, result ? JSON.stringify(result) : null]
    );
    res.json({ action: "returned", bag: serializeBag({ ...bag, ...rows[0] }) });
    return;
  }

  // status === 'returned'
  if (bag.returned_at && now - new Date(bag.returned_at).getTime() < DUPLICATE_WINDOW_MS) {
    res.json({ action: "duplicate", bag: serializeBag(bag) });
    return;
  }
  res.status(409).json({ error: "השקית כבר הוחזרה" });
}));
