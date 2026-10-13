// הזמנות פריטים — הזמנה עם כמה פריטים (למשל טלית + כיפה + תיק), לכל פריט מדבקה עם ברקוד ומעקב מצב משלו.
// מספר הזמנה: 5 ספרות (item_order_number_seq). קוד פריט: מספר הזמנה + 2 ספרות (7 ספרות). סוגי המוצרים
// והמצבים מנוהלים מדף הניהול (product_types / item_statuses). ללא אימות — כמו שאר צד החנות.
import express from "express";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { enqueuePrint } from "../lib/printQueue.js";
import { toHebrewDate } from "../lib/hebrewDate.js";
import { cleanPhone } from "../lib/phone.js";
import { cleanPrice } from "../lib/money.js";

export const router = express.Router();

const lineCode = (orderNumber, lineNo) => `${orderNumber}${String(lineNo).padStart(2, "0")}`;
const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(" ");

async function logEvent(client, orderId, line, action, detail) {
  try {
    await client.query(
      "insert into item_events (item_order_id, line_id, item_code, action, detail) values ($1,$2,$3,$4,$5)",
      [orderId, line?.id || null, line?.item_code || null, action, detail || null]
    );
  } catch (e) {
    console.error("item event log failed", action, e.message);
  }
}

// --- רשימות מנוהלות ---
router.get("/meta", asyncHandler(async (req, res) => {
  const [types, statuses] = await Promise.all([
    pool.query("select * from product_types order by position, id"),
    pool.query("select * from item_statuses order by position, id"),
  ]);
  res.json({ product_types: types.rows, statuses: statuses.rows });
}));

function listRoutes(path, table, extraFields) {
  router.post(`/${path}`, asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) { res.status(400).json({ error: "שם נדרש" }); return; }
    const flags = extraFields.map((f) => Boolean(req.body?.[f]));
    try {
      const { rows } = await pool.query(
        `insert into ${table} (name, position${extraFields.map((f) => ", " + f).join("")})
         values ($1, (select coalesce(max(position), 0) + 1 from ${table})${extraFields.map((_, i) => `, $${i + 2}`).join("")}) returning *`,
        [name, ...flags]
      );
      res.json(rows[0]);
    } catch (e) {
      if (e.code === "23505") { res.status(409).json({ error: "השם כבר קיים ברשימה" }); return; }
      throw e;
    }
  }));
  // עדכון שם / סדר / פעיל / דגלים
  router.put(`/${path}/:id`, asyncHandler(async (req, res) => {
    const sets = [];
    const params = [req.params.id];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) { res.status(400).json({ error: "שם נדרש" }); return; }
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if (req.body?.position !== undefined) { params.push(+req.body.position || 0); sets.push(`position = $${params.length}`); }
    for (const f of ["active", ...extraFields]) {
      if (req.body?.[f] !== undefined) { params.push(Boolean(req.body[f])); sets.push(`${f} = $${params.length}`); }
    }
    if (!sets.length) { res.status(400).json({ error: "אין מה לעדכן" }); return; }
    try {
      const { rows } = await pool.query(`update ${table} set ${sets.join(", ")} where id = $1 returning *`, params);
      if (!rows.length) { res.status(404).json({ error: "לא נמצא" }); return; }
      res.json(rows[0]);
    } catch (e) {
      if (e.code === "23505") { res.status(409).json({ error: "השם כבר קיים ברשימה" }); return; }
      throw e;
    }
  }));
  // מחיקה — רק אם לא בשימוש; אחרת מבקשים להסתיר (active=false) כדי לא לשבור פריטים קיימים
  router.delete(`/${path}/:id`, asyncHandler(async (req, res) => {
    const col = table === "product_types" ? "product_type_id" : "status_id";
    const used = await pool.query(`select 1 from item_order_lines where ${col} = $1 limit 1`, [req.params.id]);
    if (used.rows.length) {
      res.status(409).json({ error: "יש פריטים שמשתמשים בזה — אפשר רק להסתיר (לא יוצע יותר בהזמנות חדשות)" });
      return;
    }
    await pool.query(`delete from ${table} where id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));
}
listRoutes("product-types", "product_types", []);
listRoutes("statuses", "item_statuses", ["is_ready", "is_final"]);

async function finalStatusId(client = pool) {
  const { rows } = await client.query("select id from item_statuses where is_final order by active desc, position limit 1");
  return rows[0]?.id || null;
}

// --- מדבקה לפריט ---
const LINE_SELECT = `
  select l.*, pt.name as product_type, s.name as status, s.is_ready, s.is_final, s.position as status_position,
         o.order_number, o.target_date, o.created_at as order_created_at, o.id as order_id,
         c.first_name, c.last_name, c.phone,
         (select count(*) from item_order_lines x where x.item_order_id = o.id)::int as line_count
  from item_order_lines l
  join item_orders o on o.id = l.item_order_id
  join customers c on c.id = o.customer_id
  join item_statuses s on s.id = l.status_id
  left join product_types pt on pt.id = l.product_type_id`;

// מדבקה: מספר הזמנה ופריט, לקוח, ושורת פריט — סוג + שם בלבד (בלי הערות, יעד ותאריך)
const lineText = (l) => [l.product_type, l.item_name].filter(Boolean).join(" — ");
function printLineLabel(l) {
  const text = [
    `הזמנה ${l.order_number} | פריט ${l.line_no}/${l.line_count}`,
    `${fullName(l)} · ${l.phone}`,
    lineText(l) || "פריט",
  ].join("\n");
  enqueuePrint({ text, barcode: l.item_code, copies: 1 }).catch((e) => {
    console.error("enqueuePrint failed", l.item_code, e.message);
    logEvent(pool, l.order_id, l, "print_failed", e.message);
  });
}

// --- הזמנות ---
function cleanLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return { error: "צריך לפחות פריט אחד" };
  const out = [];
  for (const [i, l] of lines.entries()) {
    const description = String(l?.description || "").trim().slice(0, 1000); // הערות / הסבר
    const item_name = String(l?.item_name || "").trim().slice(0, 200);
    const product_type_id = l?.product_type_id ? +l.product_type_id : null;
    if (!product_type_id && !item_name) return { error: `פריט ${i + 1}: צריך לבחור סוג פריט או לכתוב שם פריט` };
    const quantity = Math.max(1, Math.min(999, parseInt(l?.quantity, 10) || 1));
    out.push({ description: description || null, item_name: item_name || null, product_type_id, quantity, status_id: l?.status_id ? +l.status_id : null });
  }
  return { lines: out };
}

async function upsertCustomer(client, customer) {
  const existing = await client.query("select id from customers where phone = $1 order by created_at desc limit 1", [customer.phone]);
  if (existing.rows.length) {
    await client.query("update customers set first_name=$1, last_name=$2 where id=$3", [customer.first_name, customer.last_name, existing.rows[0].id]);
    return existing.rows[0].id;
  }
  const ins = await client.query(
    "insert into customers (first_name, last_name, phone, address) values ($1,$2,$3,'') returning id",
    [customer.first_name, customer.last_name, customer.phone]
  );
  return ins.rows[0].id;
}

function cleanCustomer(c) {
  const customer = { first_name: String(c?.first_name || "").trim(), last_name: String(c?.last_name || "").trim() };
  if (!customer.first_name && !customer.last_name) return { error: "צריך שם פרטי או שם משפחה" };
  const p = cleanPhone(c?.phone);
  if (p.error) return { error: p.error };
  customer.phone = p.phone;
  return { customer };
}

async function insertLines(client, order, lines, startNo) {
  const defaultStatus = (await client.query("select id from item_statuses where active order by position limit 1")).rows[0]?.id;
  const created = [];
  for (const [i, l] of lines.entries()) {
    const no = startNo + i;
    const { rows } = await client.query(
      `insert into item_order_lines (item_order_id, line_no, item_code, product_type_id, item_name, description, quantity, status_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, item_code`,
      [order.id, no, lineCode(order.order_number, no), l.product_type_id, l.item_name, l.description, l.quantity, l.status_id || defaultStatus]
    );
    created.push(rows[0]);
  }
  return created;
}

router.post("/orders", asyncHandler(async (req, res) => {
  const cc = cleanCustomer(req.body?.customer);
  if (cc.error) { res.status(400).json({ error: cc.error }); return; }
  const cl = cleanLines(req.body?.lines);
  if (cl.error) { res.status(400).json({ error: cl.error }); return; }
  const target_date = req.body?.target_date || null;
  const notes = String(req.body?.notes || "").trim().slice(0, 1000) || null;
  const price = cleanPrice(req.body?.price); // כמה הלקוח אמור לשלם — חובה בהזמנת פריטים
  if (price.error) { res.status(400).json({ error: price.error }); return; }
  if (price.value == null) { res.status(400).json({ error: "חובה לרשום סכום לתשלום" }); return; }
  const pay = cleanPrice(req.body?.payment?.amount); // שולם בפועל כבר עכשיו
  if (pay.error) { res.status(400).json({ error: "סכום התשלום לא תקין" }); return; }
  const client = await pool.connect();
  let order, created;
  try {
    await client.query("begin");
    const customerId = await upsertCustomer(client, cc.customer);
    order = (await client.query(
      `insert into item_orders (order_number, customer_id, target_date, notes, price)
       values (nextval('item_order_number_seq')::text, $1, $2, $3, $4) returning id, order_number`,
      [customerId, target_date, notes, price.value]
    )).rows[0];
    if (pay.value > 0) {
      await client.query("insert into item_order_payments (item_order_id, amount, note) values ($1,$2,$3)",
        [order.id, pay.value, String(req.body.payment.note || "").trim().slice(0, 300) || null]);
    }
    created = await insertLines(client, order, cl.lines, 1);
    await logEvent(client, order.id, null, "order_created", `${created.length} פריטים` + (target_date ? ` · יעד ${target_date}` : ""));
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  // המדבקות לא מודפסות אוטומטית — הדף שואל אילו להדפיס (POST /orders/:n/print-labels)
  res.json({ order_number: order.order_number, item_codes: created.map((c) => c.item_code) });
}));

// רשימה: state=active (ברירת מחדל — לא סופקו, לפי דחיפות: תאריך יעד קרוב קודם) / supplied / all
router.get("/orders", asyncHandler(async (req, res) => {
  const state = req.query.state || "active";
  const conds = [];
  const params = [];
  if (state === "active") conds.push("o.supplied_at is null");
  if (state === "supplied") conds.push("o.supplied_at is not null");
  const q = String(req.query.q || "").trim();
  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    conds.push(`(o.order_number ilike $${i} or c.first_name ilike $${i} or c.last_name ilike $${i} or c.phone ilike $${i}
      or exists (select 1 from item_order_lines l2 left join product_types p2 on p2.id = l2.product_type_id
                 where l2.item_order_id = o.id and (l2.item_code ilike $${i} or l2.item_name ilike $${i} or l2.description ilike $${i} or p2.name ilike $${i})))`);
  }
  if (req.query.status_id) {
    params.push(+req.query.status_id);
    conds.push(`exists (select 1 from item_order_lines l3 where l3.item_order_id = o.id and l3.status_id = $${params.length})`);
  }
  const { rows } = await pool.query(
    `select o.order_number, o.target_date, o.notes, o.supplied_at, o.created_at, c.first_name, c.last_name, c.phone,
            o.price::float as price, (select coalesce(sum(p.amount), 0)::float from item_order_payments p where p.item_order_id = o.id) as paid_total,
            (o.target_date - (now() at time zone 'Asia/Jerusalem')::date) as days_left,
            coalesce(json_agg(json_build_object('item_code', l.item_code, 'line_no', l.line_no, 'product_type', pt.name,
              'item_name', l.item_name, 'description', l.description, 'quantity', l.quantity, 'status_id', l.status_id, 'status', s.name,
              'is_ready', s.is_ready, 'is_final', s.is_final) order by l.line_no) filter (where l.id is not null), '[]') as lines
     from item_orders o
     join customers c on c.id = o.customer_id
     left join item_order_lines l on l.item_order_id = o.id
     left join item_statuses s on s.id = l.status_id
     left join product_types pt on pt.id = l.product_type_id
     ${conds.length ? "where " + conds.join(" and ") : ""}
     group by o.id, c.id
     order by ${state === "supplied" ? "o.supplied_at desc" : "o.target_date asc nulls last, o.created_at asc"}
     limit 300`,
    params
  );
  res.json({ orders: rows.map((o) => ({ ...o, created_at_hebrew: toHebrewDate(o.created_at) })) });
}));

async function loadOrder(orderNumber) {
  const { rows } = await pool.query(
    `select o.*, c.first_name, c.last_name, c.phone from item_orders o join customers c on c.id = o.customer_id where o.order_number = $1`,
    [orderNumber]
  );
  return rows[0] || null;
}

router.get("/orders/:n", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const [lines, events, payments] = await Promise.all([
    pool.query(LINE_SELECT + " where o.id = $1 order by l.line_no", [order.id]),
    pool.query("select item_code, action, detail, created_at from item_events where item_order_id = $1 order by created_at desc, id desc limit 200", [order.id]),
    pool.query("select id, amount::float as amount, note, created_at from item_order_payments where item_order_id = $1 order by created_at", [order.id]),
  ]);
  const { id, customer_id, ...rest } = order;
  res.json({
    ...rest,
    created_at_hebrew: toHebrewDate(order.created_at),
    price: order.price == null ? null : Number(order.price),
    payments: payments.rows,
    paid_total: payments.rows.reduce((sum, p) => sum + p.amount, 0),
    lines: lines.rows.map(({ id: _i, item_order_id, order_id, ...l }) => l),
    events: events.rows,
  });
}));

// עריכת פרטי הזמנה: לקוח / תאריך יעד / הערות
router.put("/orders/:n", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const changes = [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (req.body?.customer) {
      const cc = cleanCustomer(req.body.customer);
      if (cc.error) { await client.query("rollback"); res.status(400).json({ error: cc.error }); return; }
      if (cc.customer.phone !== order.phone) {
        const cid = await upsertCustomer(client, cc.customer);
        await client.query("update item_orders set customer_id = $1 where id = $2", [cid, order.id]);
        changes.push(`טלפון: ${order.phone} → ${cc.customer.phone}`);
      } else {
        await client.query("update customers set first_name=$1, last_name=$2 where id=$3", [cc.customer.first_name, cc.customer.last_name, order.customer_id]);
      }
      if (fullName(cc.customer) !== fullName(order)) changes.push(`שם: ${fullName(order)} → ${fullName(cc.customer)}`);
    }
    if (req.body?.target_date !== undefined) {
      const td = req.body.target_date || null;
      await client.query("update item_orders set target_date = $1 where id = $2", [td, order.id]);
      const before = order.target_date || null;
      if (before !== td) changes.push(`תאריך יעד: ${before || "—"} → ${td || "—"}`);
    }
    if (req.body?.price !== undefined) {
      const price = cleanPrice(req.body.price);
      if (price.error || price.value == null) { await client.query("rollback"); res.status(400).json({ error: price.error || "חובה לרשום סכום לתשלום" }); return; }
      await client.query("update item_orders set price = $1 where id = $2", [price.value, order.id]);
      const before = order.price == null ? null : Number(order.price);
      if (before !== price.value) changes.push(`סכום לתשלום: ${before ?? "—"} → ${price.value ?? "—"}`);
    }
    if (req.body?.notes !== undefined) {
      const notes = String(req.body.notes || "").trim().slice(0, 1000) || null;
      await client.query("update item_orders set notes = $1 where id = $2", [notes, order.id]);
      if ((order.notes || null) !== notes) changes.push("הערות עודכנו");
    }
    await client.query("update item_orders set updated_at = now() where id = $1", [order.id]);
    if (changes.length) await logEvent(client, order.id, null, "order_edited", changes.join(" · "));
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

router.delete("/orders/:n", asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query("delete from item_orders where order_number = $1", [req.params.n]);
  if (!rowCount) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  res.json({ ok: true });
}));

// תשלומים (שולם בפועל)
router.post("/orders/:n/payments", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const amt = cleanPrice(req.body?.amount);
  if (amt.error || !(amt.value > 0)) { res.status(400).json({ error: "סכום התשלום חייב להיות מספר גדול מ-0" }); return; }
  const note = String(req.body?.note || "").trim().slice(0, 300) || null;
  await pool.query("insert into item_order_payments (item_order_id, amount, note) values ($1,$2,$3)", [order.id, amt.value, note]);
  await logEvent(pool, order.id, null, "payment_added", `₪${amt.value}` + (note ? ` · ${note}` : ""));
  res.json({ ok: true });
}));
router.delete("/orders/:n/payments/:id", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const { rows } = await pool.query("delete from item_order_payments where id = $1 and item_order_id = $2 returning amount::float as amount", [req.params.id, order.id]);
  if (!rows.length) { res.status(404).json({ error: "תשלום לא נמצא" }); return; }
  await logEvent(pool, order.id, null, "payment_deleted", `₪${rows[0].amount}`);
  res.json({ ok: true });
}));

router.post("/orders/:n/lines", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const cl = cleanLines([req.body || {}]);
  if (cl.error) { res.status(400).json({ error: cl.error.replace("פריט 1: ", "") }); return; }
  const next = (await pool.query("select coalesce(max(line_no), 0) + 1 as n from item_order_lines where item_order_id = $1", [order.id])).rows[0].n;
  if (next > 99) { res.status(400).json({ error: "אפשר עד 99 פריטים בהזמנה" }); return; }
  const created = await insertLines(pool, order, cl.lines, next);
  await pool.query("update item_orders set supplied_at = null, updated_at = now() where id = $1", [order.id]);
  await logEvent(pool, order.id, created[0], "line_added", null);
  res.json({ item_code: created[0].item_code });
}));

async function loadLine(code, client = pool) {
  const { rows } = await client.query(LINE_SELECT + " where l.item_code = $1", [code]);
  return rows[0] || null;
}

// אחרי כל שינוי מצב: ההזמנה "סופקה" כשכל הפריטים במצב סופי (ומתבטל אם פריט חזר אחורה)
async function syncSupplied(client, orderId) {
  await client.query(
    `update item_orders o set supplied_at = case
       when exists (select 1 from item_order_lines l where l.item_order_id = o.id)
        and not exists (select 1 from item_order_lines l join item_statuses s on s.id = l.status_id where l.item_order_id = o.id and not s.is_final)
       then coalesce(o.supplied_at, now()) else null end,
       updated_at = now()
     where o.id = $1`,
    [orderId]
  );
}

async function setLineStatus(client, line, statusId, via) {
  if (line.status_id === statusId) return false;
  const st = (await client.query("select name from item_statuses where id = $1", [statusId])).rows[0];
  if (!st) throw Object.assign(new Error("מצב לא קיים"), { status: 400 });
  await client.query("update item_order_lines set status_id = $1, status_changed_at = now() where id = $2", [statusId, line.id]);
  await logEvent(client, line.order_id, line, "status_changed", `${line.status} → ${st.name}` + (via ? ` · ${via}` : ""));
  return true;
}

// עדכון פריט: מצב / סוג / תיאור / כמות
router.put("/lines/:code", asyncHandler(async (req, res) => {
  const line = await loadLine(req.params.code);
  if (!line) { res.status(404).json({ error: "פריט לא נמצא" }); return; }
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (req.body?.status_id) await setLineStatus(client, line, +req.body.status_id);
    const sets = [], params = [line.id], changes = [];
    if (req.body?.product_type_id !== undefined) { params.push(req.body.product_type_id ? +req.body.product_type_id : null); sets.push(`product_type_id = $${params.length}`); changes.push("סוג"); }
    if (req.body?.item_name !== undefined) { params.push(String(req.body.item_name || "").trim().slice(0, 200) || null); sets.push(`item_name = $${params.length}`); changes.push("שם"); }
    if (req.body?.description !== undefined) { params.push(String(req.body.description || "").trim().slice(0, 300) || null); sets.push(`description = $${params.length}`); changes.push("הערות"); }
    if (req.body?.quantity !== undefined) { params.push(Math.max(1, parseInt(req.body.quantity, 10) || 1)); sets.push(`quantity = $${params.length}`); changes.push("כמות"); }
    if (sets.length) {
      await client.query(`update item_order_lines set ${sets.join(", ")} where id = $1`, params);
      await logEvent(client, line.order_id, line, "line_edited", changes.join(", "));
    }
    await syncSupplied(client, line.order_id);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    if (e.status) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

router.delete("/lines/:code", asyncHandler(async (req, res) => {
  const line = await loadLine(req.params.code);
  if (!line) { res.status(404).json({ error: "פריט לא נמצא" }); return; }
  await pool.query("delete from item_order_lines where id = $1", [line.id]);
  await logEvent(pool, line.order_id, { item_code: line.item_code }, "line_deleted", lineText(line));
  await syncSupplied(pool, line.order_id);
  res.json({ ok: true });
}));

// "סמן הכל כסופק" — כל הפריטים בהזמנה למצב הסופי
router.post("/orders/:n/supply-all", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const finalId = await finalStatusId();
  if (!finalId) { res.status(400).json({ error: "אין מצב שמסומן כ\"סופי\" ברשימת המצבים (ניהול)" }); return; }
  const client = await pool.connect();
  let changed = 0;
  try {
    await client.query("begin");
    const lines = (await client.query(LINE_SELECT + " where o.id = $1", [order.id])).rows;
    for (const l of lines) if (await setLineStatus(client, l, finalId, "סימון כל ההזמנה")) changed++;
    await syncSupplied(client, order.id);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, changed });
}));

// סריקה מהירה: code = קוד פריט (7 ספרות) או מספר הזמנה (5 ספרות). whole_order — כל הפריטים של אותה הזמנה.
router.post("/scan", asyncHandler(async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const statusId = +req.body?.status_id;
  if (!code || !statusId) { res.status(400).json({ error: "קוד ומצב נדרשים" }); return; }
  const status = (await pool.query("select * from item_statuses where id = $1", [statusId])).rows[0];
  if (!status) { res.status(400).json({ error: "מצב לא קיים" }); return; }
  let lines;
  const single = await loadLine(code);
  if (single) {
    lines = req.body?.whole_order
      ? (await pool.query(LINE_SELECT + " where o.id = $1 order by l.line_no", [single.order_id])).rows
      : [single];
  } else {
    const order = await loadOrder(code);
    if (!order) { res.status(404).json({ error: "קוד לא מוכר" }); return; }
    lines = (await pool.query(LINE_SELECT + " where o.id = $1 order by l.line_no", [order.id])).rows;
  }
  if (!lines.length) { res.status(404).json({ error: "אין פריטים בהזמנה" }); return; }
  const client = await pool.connect();
  let changed = 0;
  try {
    await client.query("begin");
    for (const l of lines) if (await setLineStatus(client, l, statusId, "סריקה")) changed++;
    await syncSupplied(client, lines[0].order_id);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  const l0 = lines[0];
  res.json({
    ok: true, changed, total: lines.length, status: status.name,
    order_number: l0.order_number, customer: { first_name: l0.first_name, last_name: l0.last_name },
    items: lines.map((l) => ({ item_code: l.item_code, text: lineText(l), was: l.status })),
  });
}));

router.post("/lines/:code/reprint", asyncHandler(async (req, res) => {
  const line = await loadLine(req.params.code);
  if (!line) { res.status(404).json({ error: "פריט לא נמצא" }); return; }
  printLineLabel(line);
  await logEvent(pool, line.order_id, line, "label_reprinted", null);
  res.json({ ok: true });
}));

// הדפסת מדבקות לפריטים שנבחרו (item_codes; בלי — כולם)
router.post("/orders/:n/print-labels", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const codes = Array.isArray(req.body?.item_codes) ? req.body.item_codes.map(String) : null;
  const { rows } = await pool.query(
    LINE_SELECT + " where o.id = $1" + (codes ? " and l.item_code = any($2)" : "") + " order by l.line_no",
    codes ? [order.id, codes] : [order.id]
  );
  rows.forEach(printLineLabel);
  if (rows.length) await logEvent(pool, order.id, null, "label_reprinted", rows.map((r) => r.item_code).join(", "));
  res.json({ ok: true, count: rows.length });
}));

// זיהוי קוד שנסרק: קוד פריט (7 ספרות) או מספר הזמנה (5 ספרות)
router.get("/lookup/:code", asyncHandler(async (req, res) => {
  const code = String(req.params.code || "").trim();
  const line = await loadLine(code);
  if (line) { res.json({ order_number: line.order_number, item_code: line.item_code }); return; }
  const order = await loadOrder(code);
  if (order) { res.json({ order_number: order.order_number, item_code: null }); return; }
  res.status(404).json({ error: "קוד לא מוכר" });
}));

router.post("/orders/:n/reprint", asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.n);
  if (!order) { res.status(404).json({ error: "הזמנה לא נמצאה" }); return; }
  const { rows } = await pool.query(LINE_SELECT + " where o.id = $1 order by l.line_no", [order.id]);
  rows.forEach(printLineLabel);
  await logEvent(pool, order.id, null, "label_reprinted", `${rows.length} מדבקות`);
  res.json({ ok: true, count: rows.length });
}));
