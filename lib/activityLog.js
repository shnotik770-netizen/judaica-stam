import { pool } from "./db.js";

// שדות "מצב" של שקית — נשמרים ב-activity_log.prev_state לפני כל פעולה שמשנה אותם, כדי שמחיקת שורה
// מההיסטוריה תוכל להחזיר את השקית בדיוק למצב שלפני אותה פעולה (DELETE /api/orders/activity-log/:id).
export const BAG_STATE_FIELDS = [
  "status", "collection_id", "picked_up_at", "returned_at", "result",
  "imported_at", "ready_at", "customer_notified_at", "customer_collected_at", "delivered_direct_at", "delivered_direct_note",
];

// מצב נוכחי של שקיות (לפי bag_code) — לקרוא *לפני* העדכון. מחזיר Map של bag_code -> state.
export async function snapshotBagStates(bagCodes, client = pool) {
  const { rows } = await client.query(
    `select bag_code, ${BAG_STATE_FIELDS.join(", ")} from bags where bag_code = any($1)`,
    [bagCodes]
  );
  return new Map(rows.map(({ bag_code, ...state }) => [bag_code, state]));
}

// רישום פעולה ליומן — לא זורק (לא רוצים שכשל ברישום יפיל פעולה אמיתית).
export async function logActivity(bagCode, orderNumber, action, detail, prevState) {
  try {
    await pool.query(
      "insert into activity_log (bag_code, order_number, action, detail, prev_state) values ($1,$2,$3,$4,$5)",
      [bagCode || null, orderNumber || null, action, detail || null, prevState ? JSON.stringify(prevState) : null]
    );
  } catch (e) {
    console.error("logActivity failed", action, e.message);
  }
}
