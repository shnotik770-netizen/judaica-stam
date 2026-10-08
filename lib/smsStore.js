// שמירת היסטוריית ה-SMS (נכנס + יוצא) אצלנו ב-DB, במקום למשוך הכל מ-Call2All בכל פתיחה.
// כל סנכרון מושך רק מה שהגיע מאז הסנכרון הקודם:
// - נכנסות: startDate = תאריך הסנכרון הקודם (פחות יום, למקרה של הבדלי שעות). התיעוד של Call2All לא מפרט את
//   פורמט התאריך, ולכן אם המשיכה החלקית נכשלת — נופלים למשיכה מלאה.
// - יוצאות: ל-GetSmsOutLog אין סינון תאריך מוכר — מושכים את 300 האחרונות.
// כפילויות לא נוצרות: מפתח ייחודי (כיוון, טלפון, זמן כפי ש-Call2All מחזירה, תוכן).
// רשת ביטחון: משיכה מלאה (3000 אחרונות) פעם ב-6 שעות, ובלחיצה על "↻ רענון" בדף.
import { getIncomingSms, getSmsOutLog } from "./call2all.js";
import { pool } from "./db.js";

const FULL_LIMIT = 3000;
const OUT_INCREMENTAL_LIMIT = 300;
const FULL_EVERY_MS = 6 * 60 * 60 * 1000;
const MIN_GAP_MS = 20 * 1000; // הדף מתרענן כל דקה; לא מושכים שוב אם הסנכרון האחרון היה ממש עכשיו

export const normalizePhone = (p) => String(p || "").replace(/\D/g, "").replace(/^972/, "0");

// הזמן מ-Call2All כטקסט → {local: "YYYY-MM-DD HH:MM:SS"} (שעון ישראל) או {iso} אם כולל אזור זמן, אחרת null
function parseTime(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const local = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || "00"}`;
    return m[7] ? { iso: s } : { local };
  }
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return { local: `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")} ${m[4].padStart(2, "0")}:${m[5]}:${m[6] || "00"}` };
  return null;
}
const sortKey = (p) => (p ? (p.iso ? Date.parse(p.iso) : Date.parse(p.local.replace(" ", "T") + "Z")) : 0);
const israelDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);

async function insertRows(direction, rows) {
  if (!rows.length) return 0;
  // לפי סדר זמן — כדי שה-id (שקובע "לא נקרא") יעלה עם הזמן
  const items = rows
    .map((r) => {
      const raw = String((direction === "in" ? r.receive_date : r.Time) || "");
      return {
        phone: normalizePhone(direction === "in" ? r.source : r.To),
        message: String((direction === "in" ? r.message : r.Message) || ""),
        raw, parsed: parseTime(raw),
        report: direction === "out" && r.DeliveryReport != null ? String(r.DeliveryReport) : null,
      };
    })
    .filter((x) => x.phone)
    .sort((a, b) => sortKey(a.parsed) - sortKey(b.parsed));
  const { rowCount } = await pool.query(
    `insert into sms_messages (direction, phone, message, raw_time, sent_at, delivery_report)
     select $1, x.phone, x.message, x.raw,
            case when x.iso is not null then x.iso::timestamptz
                 when x.local is not null then (x.local::timestamp at time zone 'Asia/Jerusalem') end,
            x.report
     from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) with ordinality
          as x(phone, message, raw, local, iso, report, ord)
     order by x.ord
     on conflict (direction, phone, raw_time, md5(message)) do update
       set delivery_report = coalesce(excluded.delivery_report, sms_messages.delivery_report)
       where sms_messages.delivery_report is distinct from excluded.delivery_report
     returning (xmax = 0) as inserted`,
    [
      direction,
      items.map((x) => x.phone), items.map((x) => x.message), items.map((x) => x.raw),
      items.map((x) => x.parsed?.local || null), items.map((x) => x.parsed?.iso || null), items.map((x) => x.report),
    ]
  );
  return rowCount;
}

let running = null;
let lastSyncMs = 0;
// אחרי שליחה מהאתר — שהסנכרון הבא יקרה מיד (ולא ידלג בגלל MIN_GAP_MS)
export function markSmsDirty() { lastSyncMs = 0; }

export function syncSms({ full: forceFull = false } = {}) {
  if (running) return running;
  if (!forceFull && Date.now() - lastSyncMs < MIN_GAP_MS) return Promise.resolve();
  running = (async () => {
    const { rows: [state] } = await pool.query("select last_sync_at, last_full_at from sms_sync where kind = 'all'");
    const firstEver = !state;
    const full = forceFull || firstEver || !state.last_full_at || Date.now() - new Date(state.last_full_at).getTime() > FULL_EVERY_MS;
    const startedAt = new Date();

    let incoming, mode = full ? "full" : "since";
    if (full) {
      incoming = await getIncomingSms({ limit: FULL_LIMIT });
    } else {
      const since = israelDate(new Date(new Date(state.last_sync_at).getTime() - 24 * 60 * 60 * 1000));
      try {
        incoming = await getIncomingSms({ limit: FULL_LIMIT, startDate: since });
      } catch (e) {
        console.warn("sms sync: partial incoming pull failed, falling back to full:", e.message);
        incoming = await getIncomingSms({ limit: FULL_LIMIT });
        mode = "full-fallback";
      }
    }
    const outgoing = await getSmsOutLog({ limit: full ? FULL_LIMIT : OUT_INCREMENTAL_LIMIT });

    const newIn = await insertRows("in", incoming);
    const newOut = await insertRows("out", outgoing);

    // ייבוא ראשון: היסטוריה ישנה (לפני 3 ימים) מסומנת כנקראה, כדי שהדף לא ייפתח עם מאות שיחות "לא נקראו"
    if (firstEver) {
      await pool.query(
        `insert into sms_reads (phone, last_read_id)
         select phone, max(id) from sms_messages
         where direction = 'in' and sent_at < now() - interval '3 days' group by phone
         on conflict (phone) do update set last_read_id = greatest(coalesce(sms_reads.last_read_id, 0), excluded.last_read_id)`
      );
    }
    await pool.query(
      `insert into sms_sync (kind, last_sync_at, last_full_at) values ('all', $1, $2)
       on conflict (kind) do update set last_sync_at = excluded.last_sync_at,
         last_full_at = coalesce(excluded.last_full_at, sms_sync.last_full_at)`,
      [startedAt, mode === "since" ? null : startedAt]
    );
    lastSyncMs = Date.now();
    if (newIn || newOut || mode !== "since") {
      console.log(`sms sync (${mode}): fetched in=${incoming.length} out=${outgoing.length}, new/updated in=${newIn} out=${newOut}`);
    }
  })().finally(() => { running = null; });
  return running;
}
