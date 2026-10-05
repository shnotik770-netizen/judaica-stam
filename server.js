import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { sendSms, getIncomingSms, getSmsOutLog } from "./lib/call2all.js";
import { migrate } from "./db/migrate.js";
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
