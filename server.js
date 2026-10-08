import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { sendSms, getIncomingSms, getSmsOutLog } from "./lib/call2all.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./lib/db.js";
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

// שיחה מול מספר טלפון ספציפי — כל הנכנסות + כל היוצאות אליו/ממנו, ממוינות לפי זמן
const normalizePhone = (p) => (p || "").replace(/\D/g, "").replace(/^972/, "0");

app.get("/api/sms/conversation", async (req, res) => {
  const phone = req.query.phone;
  if (!phone) {
    res.status(400).json({ error: "phone נדרש" });
    return;
  }
  const target = normalizePhone(phone);
  try {
    const [incoming, outgoing] = await Promise.all([
      getIncomingSms({ limit: req.query.limit || 3000 }),
      getSmsOutLog({ limit: req.query.limit }),
    ]);
    const inbound = incoming
      .filter((r) => normalizePhone(r.source) === target)
      .map((r) => ({ direction: "in", message: r.message, time: r.receive_date }));
    const outbound = outgoing
      .filter((r) => normalizePhone(r.To) === target)
      .map((r) => ({ direction: "out", message: r.Message, time: r.Time, deliveryReport: r.DeliveryReport }));
    const conversation = [...inbound, ...outbound].sort(
      (a, b) => new Date(a.time) - new Date(b.time)
    );
    res.json({ phone: target, conversation });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- דף ה-SMS: רשימת שיחות (נכנס+יוצא) לפי טלפון, ממוינת לפי ההודעה הנכנסת האחרונה, עם ספירת לא-נקראו ושם לקוח ---
const smsTime = (t) => { const d = new Date(t); return isNaN(d) ? 0 : d.getTime(); };
app.get("/api/sms/inbox", async (req, res) => {
  try {
    const [incoming, outgoing] = await Promise.all([
      getIncomingSms({ limit: req.query.limit || 3000 }),
      getSmsOutLog({ limit: req.query.limit || 3000 }),
    ]);
    const threads = new Map();
    const thread = (phone) => {
      if (!threads.has(phone)) threads.set(phone, { phone, incoming: [], last_in: null, last_time: null, last_message: null, last_direction: null });
      return threads.get(phone);
    };
    for (const r of incoming) {
      const t = thread(normalizePhone(r.source));
      t.incoming.push(r.receive_date);
      if (!t.last_in || smsTime(r.receive_date) > smsTime(t.last_in)) t.last_in = r.receive_date;
      if (!t.last_time || smsTime(r.receive_date) > smsTime(t.last_time)) { t.last_time = r.receive_date; t.last_message = r.message; t.last_direction = "in"; }
    }
    for (const r of outgoing) {
      const t = thread(normalizePhone(r.To));
      if (!t.last_time || smsTime(r.Time) > smsTime(t.last_time)) { t.last_time = r.Time; t.last_message = r.Message; t.last_direction = "out"; }
    }
    const phones = [...threads.keys()].filter(Boolean);
    const [reads, customers] = await Promise.all([
      pool.query("select phone, last_read_in from sms_reads where phone = any($1)", [phones]),
      pool.query(
        `select distinct on (regexp_replace(phone, '\\D', '', 'g')) regexp_replace(phone, '\\D', '', 'g') as digits, first_name, last_name
         from customers order by regexp_replace(phone, '\\D', '', 'g'), created_at desc`
      ),
    ]);
    const readMap = new Map(reads.rows.map((r) => [r.phone, r.last_read_in]));
    const nameMap = new Map(customers.rows.map((c) => [normalizePhone(c.digits), [c.first_name, c.last_name].filter(Boolean).join(" ")]));
    const list = phones.map((phone) => {
      const t = threads.get(phone);
      const readUpTo = readMap.has(phone) ? smsTime(readMap.get(phone)) : -1;
      return {
        phone, name: nameMap.get(phone) || null,
        last_in: t.last_in, last_time: t.last_time, last_message: t.last_message, last_direction: t.last_direction,
        unread: t.incoming.filter((time) => smsTime(time) > readUpTo).length,
      };
    });
    // קודם שיחות עם הודעה נכנסת — מהנכנסת האחרונה החדשה ביותר; אחריהן שיחות יוצאות-בלבד לפי ההודעה האחרונה
    list.sort((a, b) => (b.last_in ? 1 : 0) - (a.last_in ? 1 : 0) || smsTime(b.last_in || b.last_time) - smsTime(a.last_in || a.last_time));
    res.json({ threads: list, unread_total: list.reduce((n, t) => n + t.unread, 0), unread_threads: list.filter((t) => t.unread).length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// סימון שיחה כנקראה — עד ההודעה הנכנסת האחרונה שהלקוח (הדף) ראה: {phone, last_in}
app.post("/api/sms/read", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const lastIn = String(req.body?.last_in || "").trim();
  if (!phone || !lastIn) {
    res.status(400).json({ error: "phone ו-last_in נדרשים" });
    return;
  }
  await pool.query(
    `insert into sms_reads (phone, last_read_in) values ($1, $2)
     on conflict (phone) do update set last_read_in = excluded.last_read_in, updated_at = now()`,
    [phone, lastIn]
  );
  res.json({ ok: true });
});

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
