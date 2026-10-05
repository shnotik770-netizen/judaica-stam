import crypto from "crypto";
import { pool } from "./db.js";

export function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateKey() {
  return "jstam_" + crypto.randomBytes(24).toString("base64url");
}

// Express middleware factory: מצפה ל-Authorization: Bearer <key>, ובודק גם scope ('internal' | 'supplier')
export function requireApiKey(scope) {
  return async function (req, res, next) {
    const auth = req.headers.authorization || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!key) {
      res.status(401).json({ error: "חסר מפתח" });
      return;
    }
    const hash = hashKey(key);
    const { rows } = await pool.query(
      "select id, label, scope from api_keys where key_hash = $1 and active = true",
      [hash]
    );
    if (rows.length === 0) {
      res.status(401).json({ error: "מפתח לא תקין" });
      return;
    }
    if (rows[0].scope !== scope) {
      res.status(403).json({ error: "למפתח הזה אין הרשאה לפעולה הזו" });
      return;
    }
    pool.query("update api_keys set last_used_at = now() where id = $1", [rows[0].id]).catch(() => {});
    req.apiKeyLabel = rows[0].label;
    next();
  };
}
