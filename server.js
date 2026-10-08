import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { sendSms, getIncomingSms, getSmsOutLog } from "./lib/call2all.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./lib/db.js";
import { asyncHandler } from "./lib/asyncHandler.js";
import { syncSms, markSmsDirty, normalizePhone } from "./lib/smsStore.js";
import { router as supplierRouter } from "./routes/supplier.js";
import { router as ordersRouter } from "./routes/orders.js";
import { router as labelsRouter } from "./routes/labels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "judaica-stam" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ספק סת"ם (יודאיקה פלוס) — פרטי שקית + עדכון סטטוס
app.use("/api/supplier", supplierRouter);

// צוות פנימי — יצירת הזמנות/שקיות
app.use("/api/orders", ordersRouter);

// מדבקות ברקוד
app.use("/api/label", labelsRouter);

// שליחת SMS — הטוקן נשאר בשרת, לעולם לא בקליינט
app.post("/api/sms/send", async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) {
    res.status(400).json({ error: "phone ו-message נדרשים" });
    return;
  }
  try {
    const data = await sendSms(phone, message);
    markSmsDirty();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// הודעות נכנסות אחרונות
app.get("/api/sms/incoming", async (req, res) => {
  try {
    const rows = await getIncomingSms({
      limit: req.query.limit,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json({ rows });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// יומן הודעות יוצאות
app.get("/api/sms/outgoing", async (req, res) => {
  try {
    const rows = await getSmsOutLog({ limit: req.query.limit });
    res.json({ rows });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// שיחה מול מספר טלפון ספציפי — כל הנכנסות + כל היוצאות אליו/ממנו, ממוינות לפי זמן (מה-DB, אחרי סנכרון חלקי)
const smsAt = "coalesce(sent_at, fetched_at)";
app.get("/api/sms/conversation", asyncHandler(async (req, res) => {
  const target = normalizePhone(req.query.phone);
  if (!target) {
    res.status(400).json({ error: "phone נדרש" });
    return;
  }
  try {
    await syncSms();
  } catch (e) {
    console.warn("sms sync failed:", e.message); // מציגים את מה שכבר שמור
  }
  const { rows } = await pool.query(
    `select id, direction, message, ${smsAt} as time, delivery_report from sms_messages where phone = $1 order by ${smsAt}, id`,
    [target]
  );
  res.json({
    phone: target,
    conversation: rows.map((r) => ({ id: r.id, direction: r.direction, message: r.message, time: r.time, deliveryReport: r.delivery_report || undefined })),
  });
}));

// --- דף ה-SMS: רשימת שיחות (נכנס+יוצא) לפי טלפון, ממוינת לפי ההודעה האחרונה (נכנסת או יוצאת), עם ספירת לא-נקראו ושם לקוח ---
// ?refresh=1 — משיכה מלאה מ-Call2All (כפתור "↻ רענון"), אחרת רק מה שחדש מאז הסנכרון הקודם
app.get("/api/sms/inbox", asyncHandler(async (req, res) => {
  let syncError = null;
  try {
    await syncSms({ full: req.query.refresh === "1" });
  } catch (e) {
    syncError = e.message;
  }
  const { rows } = await pool.query(
    `with last_msg as (
       select distinct on (phone) phone, message, direction, ${smsAt} as at
       from sms_messages order by phone, ${smsAt} desc, id desc
     ), agg as (
       select m.phone,
              max(${smsAt}) filter (where m.direction = 'in') as last_in_at,
              max(m.id) filter (where m.direction = 'in') as last_in_id,
              count(*) filter (where m.direction = 'in' and m.id > coalesce(r.last_read_id, 0)) as unread
       from sms_messages m left join sms_reads r on r.phone = m.phone
       group by m.phone
     ), names as (
       select distinct on (regexp_replace(phone, '\\D', '', 'g')) regexp_replace(phone, '\\D', '', 'g') as digits,
              concat_ws(' ', nullif(first_name, ''), nullif(last_name, '')) as name
       from customers order by regexp_replace(phone, '\\D', '', 'g'), created_at desc
     )
     select a.phone, nullif(n.name, '') as name, a.last_in_at, a.last_in_id, l.at as last_time, l.message as last_message,
            l.direction as last_direction, a.unread::int as unread
     from agg a join last_msg l on l.phone = a.phone
     left join names n on regexp_replace(n.digits, '^972', '0') = a.phone
     order by l.at desc, a.phone`
  );
  res.json({
    threads: rows,
    unread_total: rows.reduce((n, t) => n + t.unread, 0),
    unread_threads: rows.filter((t) => t.unread).length,
    sync_error: syncError,
  });
}));

// סימון שיחה כנקראה — עד ההודעה הנכנסת האחרונה שהדף הציג: {phone, last_in_id}
app.post("/api/sms/read", asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const lastInId = Number(req.body?.last_in_id);
  if (!phone || !Number.isInteger(lastInId)) {
    res.status(400).json({ error: "phone ו-last_in_id נדרשים" });
    return;
  }
  await pool.query(
    `insert into sms_reads (phone, last_read_id) values ($1, $2)
     on conflict (phone) do update set last_read_id = greatest(coalesce(sms_reads.last_read_id, 0), excluded.last_read_id), updated_at = now()`,
    [phone, lastInId]
  );
  res.json({ ok: true });
}));

// רשת ביטחון אחרונה: שגיאה שלא נתפסה בתוך route מחזירה 500 במקום להפיל את השרת
app.use((err, req, res, next) => {
  console.error("unhandled route error", err);
  res.status(500).json({ error: "שגיאת שרת" });
});

async function start() {
  if (process.env.DATABASE_URL) {
    await migrate();
  } else {
    console.warn("DATABASE_URL לא מוגדר — מדלג על מיגרציה");
  }
  app.listen(port, () => {
    console.log(`judaica-stam listening on port ${port}`);
  });
}

start();
