// אבטחה: כניסה בקוד SMS, חיבורים (עוגייה httpOnly, תוקף חצי שנה) והרשאות לפי אתר.
// אתרים: store = דף החנות (סת"ם), items = הזמנות פריטים, supplier = דף האיסוף של מיכאל.
// AUTH_DISABLED=1 (משתנה סביבה ב-Railway) — כיבוי חירום של כל הבדיקות, למשל אם שליחת SMS לא עובדת.
import crypto from "crypto";
import { pool } from "./db.js";
import { getSetting } from "./settings.js";
import { hashKey } from "./apiKey.js";

export const SITES = ["store", "items", "supplier"];
export const SITE_PAGES = { store: "/orders.html", items: "/items.html", supplier: "/supplier.html" };
export const COOKIE = "jsid";
const SESSION_DAYS = 182; // חצי שנה
export const CODE_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const authDisabled = () => process.env.AUTH_DISABLED === "1";

// --- הגבלת קצב בזיכרון (לפי IP) — מתאפסת בהפעלה מחדש; ההגבלה לפי טלפון נשמרת ב-DB ---
const buckets = new Map();
export function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now); buckets.set(key, arr);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
  return false;
}

export async function logAuthEvent(action, ok, { phone, userId, ip, detail } = {}) {
  try {
    await pool.query("insert into auth_events (phone, user_id, action, ok, ip, detail) values ($1,$2,$3,$4,$5,$6)",
      [phone || null, userId || null, action, ok, ip || null, detail || null]);
  } catch (e) { console.error("auth event log failed", e.message); }
}

// כל עוד אין אף משתמש — מצב התקנה: הכל פתוח (כמו לפני), כדי שלא ננעל בחוץ לפני שהוגדרו משתמשים
let usersExistCache = { at: 0, value: false };
export async function usersExist() {
  if (Date.now() - usersExistCache.at < 30000) return usersExistCache.value;
  const { rows } = await pool.query("select exists (select 1 from users where active) as e");
  usersExistCache = { at: Date.now(), value: rows[0].e };
  return rows[0].e;
}
export function resetUsersCache() { usersExistCache.at = 0; }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await pool.query(
    "insert into sessions (token_hash, user_id, expires_at, ip, user_agent) values ($1,$2,$3,$4,$5)",
    [sha256(token), userId, expires, req.ip, String(req.get("user-agent") || "").slice(0, 300)]
  );
  res.cookie(COOKIE, token, { httpOnly: true, secure: req.secure, sameSite: "lax", expires, path: "/" });
}

// מצרף req.user אם יש חיבור תקף (משתמש פעיל, לא בוטל, לא פג)
export async function loadUser(req) {
  if (req.user !== undefined) return req.user;
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const { rows } = await pool.query(
    `select s.id as session_id, s.expires_at, s.last_seen_at, u.id, u.name, u.phone, u.access, u.is_admin
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.active`,
    [sha256(token)]
  );
  if (!rows.length) return null;
  req.user = rows[0];
  if (Date.now() - new Date(rows[0].last_seen_at).getTime() > 3600e3) {
    pool.query("update sessions set last_seen_at = now(), ip = $2 where id = $1", [rows[0].session_id, req.ip]).catch(() => {});
  }
  return req.user;
}

export const canAccess = (user, site) => !!user && (user.is_admin || (user.access || []).includes(site));
export const firstPage = (user) => {
  const site = SITES.find((s) => canAccess(user, s));
  return site ? SITE_PAGES[site] : null;
};

// --- דפים: בלי חיבור → מסך כניסה; בלי הרשאה לאתר → לאתר שמותר ---
const PAGE_SITES = { "/orders.html": "store", "/items.html": "items", "/supplier.html": "supplier" };
export async function pageGuard(req, res, next) {
  try {
    if (req.method !== "GET" || !PAGE_SITES[req.path]) return next();
    if (authDisabled() || !(await usersExist())) return next();
    const user = await loadUser(req);
    if (!user) return res.redirect("/login.html?next=" + encodeURIComponent(req.originalUrl));
    if (!canAccess(user, PAGE_SITES[req.path])) return res.redirect(firstPage(user) || "/login.html?denied=1");
    res.set("Cache-Control", "no-store");
    next();
  } catch (e) { next(e); }
}

// --- API: איזו הרשאה צריך לכל נתיב ---
function requiredSites(method, path) {
  if (path.startsWith("/api/auth/")) return "public";
  if (path.startsWith("/api/users")) return "admin";
  if (path.startsWith("/api/supplier/")) return "supplier-api";
  // דף האיסוף של מיכאל משתמש גם בהיסטוריה וברשימת השקיות
  if (path.startsWith("/api/orders/activity-log") && (method === "GET" || method === "DELETE")) return ["store", "supplier"];
  if (path === "/api/orders/bags" && method === "GET") return ["store", "supplier"];
  if (path.startsWith("/api/orders/customer-lookup")) return ["store", "items"];
  if (path.startsWith("/api/orders") || path.startsWith("/api/sms")) return ["store"];
  // רשימות סוגי מוצרים / מצבים — מנוהלות מדף הניהול של החנות
  if (/^\/api\/items\/(meta|product-types|statuses)/.test(path)) return ["store", "items"];
  if (path.startsWith("/api/items")) return ["items"];
  return "any"; // למשל /api/label — כל משתמש מחובר
}

// התוכנה של מיכאל: מפתח API (Authorization: Bearer / X-Api-Key) עם scope=supplier, או גישה פתוחה זמנית (הגדרה בניהול)
async function supplierApiKeyOk(req) {
  const auth = req.get("authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : String(req.get("x-api-key") || "").trim();
  if (key) {
    const { rows } = await pool.query("select id from api_keys where key_hash = $1 and active and scope = 'supplier'", [hashKey(key)]);
    if (rows.length) { pool.query("update api_keys set last_used_at = now() where id = $1", [rows[0].id]).catch(() => {}); return true; }
    return false;
  }
  return (await getSetting("supplier_api_open", "0")) === "1";
}

export async function apiGuard(req, res, next) {
  try {
    if (!req.path.startsWith("/api/")) return next();
    const need = requiredSites(req.method, req.path);
    if (need === "public" || authDisabled() || !(await usersExist())) return next();
    res.set("Cache-Control", "no-store");
    const user = await loadUser(req);
    if (need === "supplier-api") {
      if (canAccess(user, "supplier")) return next();
      // בלי חיבור של דפדפן — רק מפתח / גישה פתוחה (דפדפן תמיד שולח sec-fetch-*; התוכנה של מיכאל לא)
      const fromBrowser = Boolean(req.get("sec-fetch-mode") || req.get("sec-fetch-site"));
      if (!fromBrowser && (await supplierApiKeyOk(req))) return next();
      return res.status(user ? 403 : 401).json({ error: user ? "אין הרשאה" : "נדרשת כניסה" });
    }
    if (!user) return res.status(401).json({ error: "נדרשת כניסה", login: true });
    if (need === "admin") return user.is_admin ? next() : res.status(403).json({ error: "רק מנהל" });
    if (need === "any" || need.some((s) => canAccess(user, s))) return next();
    return res.status(403).json({ error: "אין לך הרשאה לפעולה הזו" });
  } catch (e) { next(e); }
}

// בקשה ששנה משהו (POST/PUT/DELETE) מאתר זר — חוסמים (הגנת CSRF, בנוסף לעוגייה SameSite=Lax)
export function sameOriginGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "בקשה ממקור לא מורשה" });
    } catch { return res.status(403).json({ error: "בקשה ממקור לא מורשה" }); }
  }
  next();
}

// כותרות אבטחה בסיסיות לכל תשובה
export function securityHeaders(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
}

// משתמשים ראשונים מ-BOOTSTRAP_USERS (משתנה סביבה, JSON) — רק כשאין עדיין אף משתמש. לא בקוד: הריפו ציבורי.
// [{"name":"…","phone":"05…","access":["store","items","supplier"],"admin":true}, …]
export async function bootstrapUsers(normalizePhone) {
  const raw = process.env.BOOTSTRAP_USERS;
  if (!raw) return;
  const { rows } = await pool.query("select count(*)::int as n from users");
  if (rows[0].n > 0) return;
  let list;
  try { list = JSON.parse(raw); } catch (e) { console.error("BOOTSTRAP_USERS: JSON לא תקין"); return; }
  for (const u of list) {
    const phone = normalizePhone(u.phone);
    const access = (u.access || []).filter((s) => SITES.includes(s));
    if (!phone || !u.name) continue;
    await pool.query("insert into users (name, phone, access, is_admin) values ($1,$2,$3,$4) on conflict (phone) do nothing",
      [String(u.name).trim(), phone, access, Boolean(u.admin)]);
  }
  resetUsersCache();
  console.log(`bootstrap users: ${list.length}`);
}
