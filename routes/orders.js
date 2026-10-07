import express from "express";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { enqueuePrint } from "../lib/printQueue.js";
import { toHebrewDate } from "../lib/hebrewDate.js";
import { sendSms } from "../lib/call2all.js";
import { logActivity, snapshotBagStates, BAG_STATE_FIELDS } from "../lib/activityLog.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { cleanVariant, variantText, cleanMezuzahCases, VARIANT_FIELDS } from "../lib/variant.js";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "../lib/itemTypes.js";

export const router = express.Router();
// ללא אימות בכוונה — החלטת החנות: מי שיש לו גישה לאתר יכול ליצור הזמנות, בלי קוד API.


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
// תיאור שינויים לקריא ("כמות: מ-6 ל-7") — ליומן כשהחנות עורכת הזמנה (bag_edited / order_edited)
const shownValue = (v) => (v == null || v === "" ? "לא צוין" : String(v));
const CUSTOMER_LABELS = { first_name: "שם פרטי", last_name: "שם משפחה", phone: "טלפון", address: "כתובת" };
function describeCustomerChanges(before, after) {
  return Object.keys(CUSTOMER_LABELS)
    .filter((k) => (before[k] || "") !== (after[k] || ""))
    .map((k) => `${CUSTOMER_LABELS[k]}: מ-${shownValue(before[k])} ל-${shownValue(after[k])}`);
}
function describeBagChanges(before, after) {
  const changes = [];
  if (before.item_type !== after.item_type) {
    changes.push(`סוג פריט: מ-${ITEM_TYPE_LABELS[before.item_type]} ל-${ITEM_TYPE_LABELS[after.item_type]}`);
  }
  if (before.quantity !== after.quantity) changes.push(`כמות: מ-${before.quantity} ל-${after.quantity}`);
  if ((before.item_type_note || null) !== (after.item_type_note || null)) {
    changes.push(`הערה: מ-${shownValue(before.item_type_note)} ל-${shownValue(after.item_type_note)}`);
  }
  const bv = before.variant || {}, av = after.variant || {};
  for (const key of new Set([...Object.keys(bv), ...Object.keys(av)])) {
    if (bv[key] !== av[key]) {
      const label = (v) => (v == null ? "לא צוין" : VARIANT_FIELDS[key]?.options[v] || v);
      changes.push(`${VARIANT_FIELDS[key]?.label || key}: מ-${label(bv[key])} ל-${label(av[key])}`);
    }
  }
  if ((before.mezuzah_cases ?? null) !== (after.mezuzah_cases ?? null)) {
    changes.push(`בתי מזוזה: מ-${shownValue(before.mezuzah_cases)} ל-${shownValue(after.mezuzah_cases)}`);
  }
  return changes;
}

// שורת הפריט על המדבקה: "3 מזוזות (פתוחות · 2 בתים)" / "תפילין זוג (ר"ת · פשוטים)"
const LABEL_SHORT_VALUES = { rolled: "סגורות", open: "פתוחות" };
function labelItemText(bag) {
  const base = bag.quantity > 1
    ? `${bag.quantity} ${ITEM_TYPE_PLURALS[bag.item_type] || ITEM_TYPE_LABELS[bag.item_type] || bag.item_type}`
    : ITEM_TYPE_LABELS[bag.item_type] || bag.item_type;
  const details = Object.entries(bag.variant || {})
    .map(([k, v]) => LABEL_SHORT_VALUES[v] || VARIANT_FIELDS[k]?.options[v] || v);
  if (bag.mezuzah_cases != null) details.push(bag.mezuzah_cases === 1 ? "בית אחד" : `${bag.mezuzah_cases} בתים`);
  return details.length ? `${base} (${details.join(" · ")})` : base;
}

// orderDate — תאריך ההזמנה (בהדפסה חוזרת: התאריך המקורי, לא היום). כל הנתונים נקראים מהמסד ברגע ההדפסה,
// כך שהדפסה חוזרת אחרי תיקון מדפיסה את הפרטים המעודכנים.
function printBagLabel(order_number, customer, bag, orderDate) {
  const text = [
    `הזמנה ${order_number} | שקית ${bag.bag_code}`,
    `${customer.first_name} ${customer.last_name} · ${customer.phone}`,
    toHebrewDate(orderDate || new Date()),
    labelItemText(bag),
  ].join("\n");
  enqueuePrint({ text, barcode: bag.bag_code, copies: 1 }).catch((e) => {
    console.error("enqueuePrint failed", bag.bag_code, e.message);
    logActivity(bag.bag_code, order_number, "print_failed", e.message);
  });
}

// הזמנה "נעולה" לעריכה/מחיקה ברגע שאחת השקיות שלה באמת נכנסה למערכת הספק — כלומר נמשכה
// לתוכנה שלו (imported_at, נקבע ב-GET /api/supplier/with-me) או כבר חזרה לגמרי (returned).
// לא מספיק שהיא רק נסרקה כ"נאסף" (status='with_supplier') — בפער שבין הסריקה הפיזית לבין
// המשיכה בפועל לתוכנה שלו עדיין אפשר לתקן טעויות בצד שלנו.
async function isOrderLocked(orderId) {
  const { rows } = await pool.query(
    "select 1 from bags where order_id = $1 and (imported_at is not null or status in ('returned', 'delivered_direct')) limit 1",
    [orderId]
  );
  return rows.length > 0;
}

// יצירת הזמנה + שקיות. מספר הזמנה מונפק אוטומטית (רץ). אין מספר לקוח — מזהים לפי טלפון
// (אם כבר קיים לקוח עם אותו טלפון, מעדכנים את הפרטים שלו ומשתמשים באותו רשומה; אחרת יוצרים חדש).
router.post("/", asyncHandler(async (req, res) => {
  const { customer, bags } = req.body || {};
  if (!customer?.phone || !customer?.first_name || !customer?.last_name || !Array.isArray(bags) || bags.length === 0) {
    res.status(400).json({ error: "customer (first_name, last_name, phone) ו-bags נדרשים" });
    return;
  }
  for (const b of bags) {
    if (!ITEM_TYPES.includes(b.item_type)) {
      res.status(400).json({ error: `item_type לא תקין: ${b.item_type}` });
      return;
    }
    const v = cleanVariant(b.item_type, b.variant);
    if (v.error) { res.status(400).json({ error: v.error }); return; }
    b.variant = v.variant;
    const cases = cleanMezuzahCases(b.item_type, b.mezuzah_cases, b.quantity);
    if (cases.error) { res.status(400).json({ error: cases.error }); return; }
    b.mezuzah_cases = cases.value;
  }

  // תשלום שהתקבל כבר בשעת הזנת ההזמנה (לא חובה) — נשמר יחד עם ההזמנה, באותה טרנזקציה
  let initialPayment = null;
  if (req.body.payment && req.body.payment.amount !== undefined && req.body.payment.amount !== "" && req.body.payment.amount !== null) {
    const amount = Math.round(Number(req.body.payment.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "סכום התשלום חייב להיות מספר גדול מ-0" });
      return;
    }
    initialPayment = { amount, note: String(req.body.payment.note || "").trim().slice(0, 300) || null };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    // "הובא ע\"י" מולא — לא משייכים ללקוח קיים לפי טלפון (גם אם תואם), תמיד לקוח חדש
    const broughtBy = String(req.body.brought_by || "").trim().slice(0, 200) || null;
    const existing = broughtBy
      ? { rows: [] }
      : await client.query("select id from customers where phone = $1 order by created_at desc limit 1", [customer.phone]);
    let customerId;
    if (existing.rows.length > 0) {
      customerId = existing.rows[0].id;
      await client.query(
        // כתובת לא חובה (הטופס מזהיר ומאפשר להמשיך) — כתובת ריקה לא מוחקת כתובת קיימת של לקוח מוכר
        "update customers set first_name=$1, last_name=$2, address=coalesce(nullif($3, ''), address) where id=$4",
        [customer.first_name, customer.last_name, (customer.address || "").trim(), customerId]
      );
    } else {
      const inserted = await client.query(
        `insert into customers (first_name, last_name, phone, address)
         values ($1,$2,$3,$4) returning id`,
        [customer.first_name, customer.last_name, customer.phone, (customer.address || "").trim()]
      );
      customerId = inserted.rows[0].id;
    }

    const order = await client.query(
      `insert into orders (order_number, customer_id, notes, target_date, brought_by)
       values (nextval('order_number_seq')::text,$1,$2,$3,$4) returning id, order_number`,
      [customerId, req.body.notes || null, req.body.target_date || null, broughtBy]
    );
    const orderId = order.rows[0].id;
    const order_number = order.rows[0].order_number;

    const createdBags = [];
    for (let i = 0; i < bags.length; i++) {
      const b = bags[i];
      const bagCode = makeBagCode(order_number, i + 1);
      const r = await client.query(
        `insert into bags (order_id, bag_code, item_type, item_type_note, quantity, variant, mezuzah_cases)
         values ($1,$2,$3,$4,$5,$6,$7) returning bag_code, item_type, quantity, variant, mezuzah_cases`,
        [orderId, bagCode, b.item_type, b.item_type_note || null, b.quantity || 1, b.variant ? JSON.stringify(b.variant) : null, b.mezuzah_cases]
      );
      createdBags.push(r.rows[0]);
    }
    if (initialPayment) {
      await client.query(
        "insert into order_payments (order_id, amount, note) values ($1,$2,$3)",
        [orderId, initialPayment.amount, initialPayment.note]
      );
    }

    await client.query("commit");

    // הדפסת מדבקה לכל שקית ברגע יצירת ההזמנה — Code128, אותו קוד מספרי שהוחזר בכל שקית.
    for (const b of createdBags) printBagLabel(order_number, customer, b);

    logActivity(null, order_number, "order_created", `${createdBags.length} שקיות` + (broughtBy ? ` · הובא ע"י ${broughtBy}` : ""));
    if (initialPayment) {
      logActivity(null, order_number, "payment_added", `₪${initialPayment.amount}` + (initialPayment.note ? ` · ${initialPayment.note}` : "") + " · בשעת ההזמנה");
    }
    res.status(201).json({ order_number, bags: createdBags });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}));

// בדיקת לקוח קיים לפי טלפון — בזמן הקלדה בטופס הזמנה חדשה, כדי למלא אוטומטית שם/כתובת ולהציע את
// מספר הלקוח אצל הספק. ההשוואה לפי ספרות בלבד (050-1234567 = 0501234567); מחזיר גם את הטלפון כפי
// שהוא שמור, כדי שהטופס ישלח אותו בדיוק כך ו-POST / יזהה את אותו לקוח (שם ההשוואה מדויקת).
router.get("/customer-lookup", asyncHandler(async (req, res) => {
  const digits = (req.query.phone || "").replace(/\D/g, "");
  if (!digits) {
    res.status(400).json({ error: "phone נדרש" });
    return;
  }
  const { rows } = await pool.query(
    `select first_name, last_name, phone, address, supplier_customer_number from customers
     where regexp_replace(phone, '\\D', '', 'g') = $1
     order by created_at desc limit 1`,
    [digits]
  );
  if (rows.length === 0) {
    res.json({ found: false });
    return;
  }
  res.json({ found: true, ...rows[0] });
}));

// הצעות לקוחות לפי חלק מהטלפון — בטופס הזמנה חדשה, מ-6 ספרות. רק מציע (עד 5), הבחירה בידי המשתמש.
// ההשוואה לפי ספרות בלבד, בכל מקום במספר (לא רק התחלה).
router.get("/customer-search", asyncHandler(async (req, res) => {
  const digits = (req.query.phone || "").replace(/\D/g, "");
  if (digits.length < 6) {
    res.json({ customers: [] });
    return;
  }
  const { rows } = await pool.query(
    `select first_name, last_name, phone, address, supplier_customer_number from customers
     where regexp_replace(phone, '\\D', '', 'g') like $1
     order by (regexp_replace(phone, '\\D', '', 'g') = $2) desc, created_at desc
     limit 5`,
    [`%${digits}%`, digits]
  );
  res.json({ customers: rows });
}));

// סטטוס "חזר" מתפצל ל-3 תתי-מצב לצורך סינון (לא עמודה אמיתית — b.status נשאר 'returned' תמיד,
// ראו routes/orders.js POST /scan). not_collected משמש פנימית בצד הלקוח (סריקה ללקוח, מטרת "איסוף").
const BAG_STATUS_CONDITIONS = {
  ready: "b.status = 'with_supplier' and b.ready_at is not null",
  returned_at_store: "b.status = 'returned' and b.customer_notified_at is null",
  notified: "b.status = 'returned' and b.customer_notified_at is not null and b.customer_collected_at is null",
  not_collected: "b.status = 'returned' and b.customer_collected_at is null",
  collected: "b.status = 'returned' and b.customer_collected_at is not null",
};

// סיכום מהיר — "X ממתינים לאיסוף, X אצל מיכאל" — מוצג מיד בכניסה לטאב "כל ההזמנות".
router.get("/summary", asyncHandler(async (req, res) => {
  const { rows } = await pool.query("select status, count(*)::int as count from bags group by status");
  const { rows: readyRows } = await pool.query(
    "select count(*)::int as count from bags where status = 'with_supplier' and ready_at is not null"
  );
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const { rows: failRows } = await pool.query(
    "select count(*)::int as count from activity_log where action = 'print_failed' and created_at > now() - interval '24 hours'"
  );
  res.json({
    waiting_pickup: counts.waiting_pickup || 0,
    with_supplier: counts.with_supplier || 0,
    ready: readyRows[0]?.count || 0, // מתוך with_supplier — שוחררו מהתוכנה של מיכאל ומחכים למסירה לחנות
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
    `select o.order_number, o.brought_by, c.first_name, c.last_name, c.phone,
            b.bag_code, b.item_type, b.item_type_note, b.quantity, b.variant, b.mezuzah_cases, b.supplier_note, b.status,
            b.picked_up_at, b.imported_at, b.ready_at, b.returned_at, b.delivered_direct_at, b.delivered_direct_note, b.customer_notified_at, b.customer_collected_at, b.created_at,
            (select max(r.received_at) from bag_reports r where r.bag_id = b.id) as report_received_at,
            (select coalesce(sum(p.amount), 0)::float from order_payments p where p.order_id = o.id) as paid_total,
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
    `select b.id, b.bag_code, b.item_type, b.quantity, b.status, b.customer_notified_at, b.customer_collected_at,
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
          bag_code: code, ok: true, action: "duplicate", order_number: bag.order_number, item_type: bag.item_type, quantity: bag.quantity, customer,
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
          // ה-UI מציג על זה התראה קבועה עד שסוגרים אותה — לכן מחזירים את פרטי השקית/הלקוח/הקבוצה
          logActivity(bag.bag_code, bag.order_number, "sms_failed", e.message);
          results.push({
            bag_code: code, ok: false, sms_failed: true, error: "שליחת SMS נכשלה: " + e.message,
            order_number: bag.order_number, item_type: bag.item_type, quantity: bag.quantity, customer,
            grouped_bag_codes: group.map((g) => g.bag_code),
          });
          continue;
        }
      }

      const prevStates = await snapshotBagStates(group.map((g) => g.bag_code));
      await pool.query(
        "update bags set customer_notified_at = now(), updated_at = now() where id = any($1)",
        [group.map((g) => g.id)]
      );
      const groupNote = group.length > 1 ? ` · קובצו ${group.length} שקיות של אותו טלפון` : "";
      const repeatNote = isRepeat ? " · דיווח חוזר" : "";
      for (const g of group) {
        logActivity(g.bag_code, g.order_number, "customer_notified", (action === "notify_sms" ? "SMS" : "ידני") + groupNote + repeatNote, prevStates.get(g.bag_code));
      }
      results.push({
        bag_code: code, ok: true, action: "notified", order_number: bag.order_number, item_type: bag.item_type, quantity: bag.quantity, customer,
        grouped_bag_codes: group.map((g) => g.bag_code), repeat: isRepeat,
      });
      continue;
    }

    // action === "collect"
    if (bag.customer_collected_at && Date.now() - new Date(bag.customer_collected_at).getTime() < SCAN_DUPLICATE_WINDOW_MS) {
      results.push({ bag_code: code, ok: true, action: "duplicate", order_number: bag.order_number, item_type: bag.item_type, quantity: bag.quantity, customer });
      continue;
    }
    const prevCollect = (await snapshotBagStates([bag.bag_code])).get(bag.bag_code);
    await pool.query("update bags set customer_collected_at = now(), updated_at = now() where id = $1", [bag.id]);
    logActivity(bag.bag_code, bag.order_number, "customer_collected", null, prevCollect);
    results.push({ bag_code: code, ok: true, action: "collected", order_number: bag.order_number, item_type: bag.item_type, quantity: bag.quantity, customer });
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
const withHebrewDates = (rows) => rows.map((r) => ({ ...r, created_at_hebrew: toHebrewDate(r.created_at) }));

// פעולות שמשנות את מצב השקית — מחיקה שלהן מההיסטוריה מחזירה את השקית למצב שלפניהן.
// (השוואות זמן נעשות ב-SQL מול השורה עצמה: Date של JS מאבד את המיקרו-שניות של timestamptz.)
const STATE_ACTIONS = ["picked_up", "released", "returned", "delivered_direct", "customer_notified", "customer_collected", "manual_fix"];
const STATE_ACTION_LABELS = {
  delivered_direct: "נמסר ללקוח ע\"י מיכאל", picked_up: "נאסף ע\"י מיכאל", released: "מוכן אצל מיכאל (שוחרר מהתוכנה)", returned: "הוחזר ממיכאל", customer_notified: "עודכן ללקוח",
  customer_collected: "נאסף ע\"י לקוח", manual_fix: "תיקון ידני",
  label_reprinted: "מדבקה הודפסה שוב", print_failed: "הדפסה נכשלה", bag_added: "שקית נוספה",
};

// לשורות שנרשמו לפני שהתחלנו לשמור prev_state — שחזור המצב הקודם לפי סוג הפעולה. לתיקון ידני ישן אין
// דרך לדעת מה היה קודם (null = לא ניתן לשחזר).
async function derivePrevState(client, row) {
  switch (row.action) {
    case "picked_up":
      return { status: "waiting_pickup", collection_id: null, picked_up_at: null, imported_at: null };
    case "released":
      return { ready_at: null };
    case "delivered_direct":
      return { status: "with_supplier", delivered_direct_at: null, delivered_direct_note: null };
    case "returned":
      return { status: "with_supplier", returned_at: null, customer_notified_at: null, customer_collected_at: null };
    case "customer_notified": {
      const { rows } = await client.query(
        `select created_at from activity_log where bag_code = $1 and action = 'customer_notified' and id <> $2
           and created_at < (select created_at from activity_log where id = $2)
         order by created_at desc limit 1`,
        [row.bag_code, row.id]
      );
      return { customer_notified_at: rows[0]?.created_at || null };
    }
    case "customer_collected":
      return { customer_collected_at: null };
    default:
      return null;
  }
}

// מחיקת שורה מהיסטוריית שקית. שורה של פעולה שמשנה מצב (STATE_ACTIONS) גם מחזירה את השקית למצב שלפניה.
// אם אחריה יש עוד פעולות מצב על אותה שקית, הן מבוטלות גם (אחרת המצב לא יהיה עקבי) — לכן בלי
// ?confirm_later=1 מחזירים 409 עם רשימתן, וה-UI מבקש אישור. ?log_only=1 — מחיקת השורה בלבד בלי שינוי השקית
// (לשורה ישנה שאין לה מצב קודם שמור). כל מחיקה נרשמת ביומן (log_entry_deleted).
router.delete("/activity-log/:id", asyncHandler(async (req, res) => {
  const confirmLater = req.query.confirm_later === "1";
  const logOnly = req.query.log_only === "1";
  const client = await pool.connect();
  let row, later = [], reverted = false;
  try {
    await client.query("begin");
    const found = await client.query("select * from activity_log where id = $1 for update", [req.params.id]);
    row = found.rows[0];
    if (!row) {
      await client.query("rollback");
      res.status(404).json({ error: "השורה לא נמצאה (אולי כבר נמחקה)" });
      return;
    }
    const isState = row.bag_code && STATE_ACTIONS.includes(row.action) && !logOnly;
    if (isState) {
      const laterRes = await client.query(
        `select id, action, created_at from activity_log
         where bag_code = $1 and action = any($2) and id <> $3
           and created_at > (select created_at from activity_log where id = $3)
         order by created_at`,
        [row.bag_code, STATE_ACTIONS, row.id]
      );
      later = laterRes.rows;
      if (later.length && !confirmLater) {
        await client.query("rollback");
        res.status(409).json({
          needs_confirm: true,
          error: "יש פעולות מאוחרות יותר על השקית שיבוטלו גם",
          later: later.map((l) => ({ action: l.action, label: STATE_ACTION_LABELS[l.action] || l.action, created_at: l.created_at })),
        });
        return;
      }
      const prev = row.prev_state || (await derivePrevState(client, row));
      if (!prev) {
        await client.query("rollback");
        res.status(409).json({
          no_prev_state: true,
          error: "לשורה הזו לא נשמר המצב הקודם של השקית (נרשמה לפני שהתחלנו לשמור אותו) — אפשר למחוק רק את השורה, ולתקן את הסטטוס ידנית בטאב \"ניהול\"",
        });
        return;
      }
      const keys = BAG_STATE_FIELDS.filter((k) => k in prev);
      if (keys.length) {
        const values = keys.map((k) => (k === "result" && prev[k] != null ? JSON.stringify(prev[k]) : prev[k]));
        await client.query(
          `update bags set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where bag_code = $1`,
          [row.bag_code, ...values]
        );
      }
      reverted = true;
    }
    await client.query("delete from activity_log where id = any($1)", [[row.id, ...later.map((l) => l.id)]]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  const label = STATE_ACTION_LABELS[row.action] || row.action;
  logActivity(row.bag_code, row.order_number, "log_entry_deleted",
    `${label} מ-${new Date(row.created_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}` +
    (later.length ? ` + ${later.length} פעולות מאוחרות` : "") + (reverted ? " · השקית הוחזרה למצב הקודם" : ""));
  res.json({ ok: true, reverted, removed_later: later.length });
}));

router.get("/activity-log", asyncHandler(async (req, res) => {
  const limit = Math.min(+req.query.limit || 100, 500);
  const bagCode = (req.query.bag_code || "").trim();
  const q = (req.query.q || "").trim();

  // היסטוריית שקית — בלי רשומות "שורה נמחקה" (הן מופיעות רק ביומן הכללי, כדי לא להעמיס על ההיסטוריה)
  if (bagCode) {
    const { rows } = await pool.query(
      // כולל אירועים ברמת ההזמנה של השקית (נוצרה / נערכו פרטי לקוח) — הם נרשמים בלי bag_code
      `select id, bag_code, order_number, action, detail, created_at from activity_log
       where action <> 'log_entry_deleted'
         and (bag_code = $1 or (bag_code is null and action in ('order_created', 'order_edited', 'payment_added', 'payment_deleted') and order_number =
              (select o.order_number from bags b join orders o on o.id = b.order_id where b.bag_code = $1)))
       order by created_at desc limit $2`,
      [bagCode, limit]
    );
    res.json({ log: withHebrewDates(rows) });
    return;
  }

  if (q) {
    const { rows } = await pool.query(
      `select al.id, al.bag_code, al.order_number, al.action, al.detail, al.created_at
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
    res.json({ log: withHebrewDates(rows) });
    return;
  }

  const { rows } = await pool.query(
    "select id, bag_code, order_number, action, detail, created_at from activity_log order by created_at desc limit $1",
    [limit]
  );
  res.json({ log: withHebrewDates(rows) });
}));

// מאגר לקוחות — לטאב "ניהול". q = חיפוש חופשי (שם פרטי/משפחה/טלפון/כתובת), כולל סיכום הזמנות/שקיות לכל לקוח.
router.get("/customers", asyncHandler(async (req, res) => {
  const q = (req.query.q || "").trim();
  const params = [];
  let where = "";
  if (q) {
    params.push(`%${q}%`);
    where = `where c.first_name ilike $1 or c.last_name ilike $1 or c.phone ilike $1 or c.address ilike $1
                or c.supplier_customer_number ilike $1
                or (c.first_name || ' ' || c.last_name) ilike $1`;
  }
  const { rows } = await pool.query(
    `select c.id, c.first_name, c.last_name, c.phone, c.address, c.supplier_customer_number, c.created_at,
            count(distinct o.id)::int as order_count,
            count(b.id)::int as bag_count,
            count(b.id) filter (where b.status = 'returned' and b.customer_collected_at is null)::int as awaiting_customer_count,
            max(o.created_at) as last_order_at
     from customers c
     left join orders o on o.customer_id = c.id
     left join bags b on b.order_id = o.id
     ${where}
     group by c.id
     order by max(o.created_at) desc nulls last, c.created_at desc
     limit 500`,
    params
  );
  res.json({ customers: rows });
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

// צפייה בהזמנה — גם למסך העריכה. locked=true אם אחת השקיות כבר נמשכה בפועל לתוכנה של הספק
// (imported_at) או כבר חזרה (returned) — לא ניתן יותר לערוך/למחוק את ההזמנה או שקיות שלה.
router.get("/:order_number", asyncHandler(async (req, res) => {
  const o = await pool.query(
    `select o.id, o.order_number, o.status, o.brought_by, c.first_name, c.last_name, c.phone, c.address, c.supplier_customer_number
     from orders o join customers c on c.id = o.customer_id
     where o.order_number = $1`,
    [req.params.order_number]
  );
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  const bags = await pool.query(
    `select bag_code, item_type, item_type_note, quantity, variant, mezuzah_cases, supplier_note, supplier_note_at, status, result, picked_up_at, returned_at, imported_at, ready_at,
            delivered_direct_at, delivered_direct_note,
            customer_notified_at, customer_collected_at,
            (select max(r.received_at) from bag_reports r where r.bag_id = bags.id) as report_received_at
     from bags where order_id = $1 order by bag_code`,
    [o.rows[0].id]
  );
  const { id, ...order } = o.rows[0];
  const locked = bags.rows.some((b) => b.imported_at != null || b.status === "returned" || b.status === "delivered_direct");
  const { rows: payments } = await pool.query(
    "select id, amount::float as amount, method, note, created_at from order_payments where order_id = $1 order by created_at",
    [id]
  );
  res.json({ ...order, locked, bags: bags.rows, payments, paid_total: payments.reduce((sum, p) => sum + p.amount, 0) });
}));

// עריכת פרטי לקוח ופרטי שקיות קיימות בהזמנה (סוג/הערה/כמות, לא מספר שקית/ברקוד) —
// רק כל עוד ההזמנה לא נעולה (ראו isOrderLocked למעלה).
router.put("/:order_number", asyncHandler(async (req, res) => {
  const { customer, bags } = req.body || {};
  if (!customer?.phone || !customer?.first_name || !customer?.last_name) {
    res.status(400).json({ error: "customer (first_name, last_name, phone) נדרש" });
    return;
  }
  const o = await pool.query(
    `select o.id, o.customer_id, o.brought_by, c.first_name, c.last_name, c.phone, c.address
     from orders o join customers c on c.id = o.customer_id where o.order_number = $1`,
    [req.params.order_number]
  );
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  const before = o.rows[0];
  const { id: orderId, customer_id: customerId } = before;
  if (await isOrderLocked(orderId)) {
    res.status(409).json({ error: "ההזמנה כבר נכנסה למערכת הספק ולא ניתנת לעריכה" });
    return;
  }

  // בדיקה של כל השקיות לפני ששומרים משהו — שלא תישאר הזמנה חצי-מעודכנת אם שקית אחת לא תקינה
  const cleanedBags = [];
  for (const b of bags || []) {
    if (!ITEM_TYPES.includes(b.item_type)) {
      res.status(400).json({ error: `item_type לא תקין: ${b.item_type}` });
      return;
    }
    const v = cleanVariant(b.item_type, b.variant);
    if (v.error) {
      res.status(400).json({ error: v.error });
      return;
    }
    const cases = cleanMezuzahCases(b.item_type, b.mezuzah_cases, b.quantity);
    if (cases.error) {
      res.status(400).json({ error: cases.error });
      return;
    }
    cleanedBags.push({
      bag_code: b.bag_code, item_type: b.item_type, item_type_note: b.item_type_note || null,
      quantity: b.quantity || 1, variant: v.variant, mezuzah_cases: cases.value,
    });
  }
  const { rows: oldBags } = await pool.query(
    "select bag_code, item_type, item_type_note, quantity, variant, mezuzah_cases from bags where order_id = $1",
    [orderId]
  );
  const oldByCode = new Map(oldBags.map((b) => [b.bag_code, b]));

  // שינויים ברמת ההזמנה (לקוח + "הובא ע\"י") — נרשמים פעם אחת להזמנה, ומוצגים בהיסטוריה של כל שקית שלה
  const newCustomer = {
    first_name: customer.first_name, last_name: customer.last_name, phone: customer.phone,
    address: (customer.address || "").trim(),
  };
  const orderChanges = describeCustomerChanges(before, newCustomer);
  let broughtBy = before.brought_by;
  if ("brought_by" in (req.body || {})) {
    broughtBy = String(req.body.brought_by || "").trim().slice(0, 200) || null;
    if (broughtBy !== (before.brought_by || null)) {
      orderChanges.push(`הובא ע"י: מ-${shownValue(before.brought_by)} ל-${shownValue(broughtBy)}`);
    }
  }

  await pool.query("update orders set brought_by = $1, updated_at = now() where id = $2", [broughtBy, orderId]);
  await pool.query(
    "update customers set first_name=$1, last_name=$2, phone=$3, address=$4 where id=$5",
    [newCustomer.first_name, newCustomer.last_name, newCustomer.phone, newCustomer.address, customerId]
  );
  const bagChanges = [];
  for (const b of cleanedBags) {
    const old = oldByCode.get(b.bag_code);
    if (!old) continue;
    await pool.query(
      "update bags set item_type=$1, item_type_note=$2, quantity=$3, variant=$4, mezuzah_cases=$5, updated_at=now() where bag_code=$6 and order_id=$7",
      [b.item_type, b.item_type_note, b.quantity, b.variant ? JSON.stringify(b.variant) : null, b.mezuzah_cases, b.bag_code, orderId]
    );
    const changes = describeBagChanges(old, b);
    if (changes.length) bagChanges.push({ bag_code: b.bag_code, changes });
  }

  // ביומן: רק מה שבאמת השתנה ("כמות: מ-6 ל-7"). שמירה בלי שינוי — לא נרשמת.
  if (orderChanges.length) logActivity(null, req.params.order_number, "order_edited", orderChanges.join(" · "));
  for (const bc of bagChanges) logActivity(bc.bag_code, req.params.order_number, "bag_edited", bc.changes.join(" · "));
  res.json({ ok: true, order_changes: orderChanges, bag_changes: bagChanges });
}));

// תשלום שהתקבל על הזמנה (בד"כ בשעת המסירה) — {amount, method?, note?}. לא תלוי בנעילת ההזמנה. נרשם ביומן ההזמנה.
const PAYMENT_METHODS = ["מזומן", "אשראי", "העברה בנקאית", "ביט", "פייבוקס", "צ'ק", "אחר"];
router.post("/:order_number/payments", asyncHandler(async (req, res) => {
  const amount = Math.round(Number(req.body?.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "סכום חייב להיות מספר גדול מ-0" });
    return;
  }
  const method = req.body?.method ? String(req.body.method) : null;
  if (method && !PAYMENT_METHODS.includes(method)) {
    res.status(400).json({ error: `אמצעי תשלום לא מוכר: ${method}` });
    return;
  }
  const note = String(req.body?.note || "").trim().slice(0, 300) || null;
  const o = await pool.query("select id from orders where order_number = $1", [req.params.order_number]);
  if (o.rows.length === 0) {
    res.status(404).json({ error: "הזמנה לא נמצאה" });
    return;
  }
  const { rows } = await pool.query(
    "insert into order_payments (order_id, amount, method, note) values ($1,$2,$3,$4) returning id",
    [o.rows[0].id, amount, method, note]
  );
  logActivity(null, req.params.order_number, "payment_added",
    `₪${amount}` + (method ? ` · ${method}` : "") + (note ? ` · ${note}` : ""));
  res.status(201).json({ ok: true, id: rows[0].id });
}));

router.delete("/:order_number/payments/:id", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `delete from order_payments p using orders o
     where p.id = $1 and p.order_id = o.id and o.order_number = $2
     returning p.amount::float as amount, p.method`,
    [req.params.id, req.params.order_number]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "התשלום לא נמצא" });
    return;
  }
  logActivity(null, req.params.order_number, "payment_deleted", `₪${rows[0].amount}` + (rows[0].method ? ` · ${rows[0].method}` : ""));
  res.json({ ok: true });
}));

// הוספת שקית חדשה להזמנה קיימת (ומדפיסה לה מדבקה מיד, כמו ביצירת הזמנה) — רק כל עוד ההזמנה לא נעולה.
router.post("/:order_number/bags", asyncHandler(async (req, res) => {
  const { item_type, item_type_note, quantity } = req.body || {};
  if (!ITEM_TYPES.includes(item_type)) {
    res.status(400).json({ error: `item_type לא תקין: ${item_type}` });
    return;
  }
  const cleaned = cleanVariant(item_type, req.body.variant);
  if (cleaned.error) {
    res.status(400).json({ error: cleaned.error });
    return;
  }
  const cases = cleanMezuzahCases(item_type, req.body.mezuzah_cases, quantity);
  if (cases.error) {
    res.status(400).json({ error: cases.error });
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
    `insert into bags (order_id, bag_code, item_type, item_type_note, quantity, variant, mezuzah_cases)
     values ($1,$2,$3,$4,$5,$6,$7) returning bag_code, item_type, item_type_note, quantity, status, variant, mezuzah_cases`,
    [order.id, bagCode, item_type, item_type_note || null, quantity || 1, cleaned.variant ? JSON.stringify(cleaned.variant) : null, cases.value]
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

// דוחות הספק על שקית (POST /api/supplier/report) — למסך העריכה בחנות, מהחדש לישן
router.get("/bags/:bag_code/reports", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select r.id, r.summary, r.report, r.received_at
     from bag_reports r join bags b on b.id = r.bag_id
     where b.bag_code = $1 order by r.received_at desc`,
    [req.params.bag_code]
  );
  res.json({ reports: rows.map((r) => ({ ...r, received_at_hebrew: toHebrewDate(r.received_at) })) });
}));
// עם אפשרות לאפס את חותמות הלקוח. כל שימוש נרשם ביומן הפעולות לצורך מעקב.
const BAG_STATUSES = ["waiting_pickup", "with_supplier", "returned", "delivered_direct"];
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
  const prevFix = (await snapshotBagStates([req.params.bag_code])).get(req.params.bag_code);
  const { rows } = await pool.query(
    `update bags set ${sets.join(", ")} where bag_code=$2 returning bag_code, status`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  logActivity(req.params.bag_code, null, "manual_fix", `status=${status}`, prevFix);
  res.json(rows[0]);
}));

// הדפסה חוזרת של מדבקה — למשל אחרי שההדפסה המקורית נכשלה (PRINT_URL/PRINT_KEY לא היו מוגדרים
// עדיין), או שהמדבקה הפיזית אבדה/נקרעה. מותר גם על הזמנה נעולה — לא משנה שום מצב, רק מדפיס שוב.
router.post("/bags/:bag_code/reprint", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select b.bag_code, b.item_type, b.quantity, b.variant, b.mezuzah_cases, o.order_number, o.created_at as order_created_at,
            c.first_name, c.last_name, c.phone
     from bags b join orders o on o.id = b.order_id join customers c on c.id = o.customer_id
     where b.bag_code = $1`,
    [req.params.bag_code]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "קוד לא מוכר" });
    return;
  }
  const bag = rows[0];
  printBagLabel(bag.order_number, bag, bag, bag.order_created_at);
  logActivity(bag.bag_code, bag.order_number, "label_reprinted", null);
  res.json({ ok: true });
}));
