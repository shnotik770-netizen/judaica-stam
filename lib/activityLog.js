import { pool } from "./db.js";

// רישום פעולה ליומן — לא זורק (לא רוצים שכשל ברישום יפיל פעולה אמיתית).
export async function logActivity(bagCode, orderNumber, action, detail) {
  try {
    await pool.query(
      "insert into activity_log (bag_code, order_number, action, detail) values ($1,$2,$3,$4)",
      [bagCode || null, orderNumber || null, action, detail || null]
    );
  } catch (e) {
    console.error("logActivity failed", action, e.message);
  }
}
