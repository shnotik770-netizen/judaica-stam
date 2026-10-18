// ניהול משתמשים והרשאות (רק מנהל) + גישת התוכנה של מיכאל (מפתחות API / גישה פתוחה זמנית) + יומן כניסות.
import express from "express";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { cleanPhone } from "../lib/phone.js";
import { SITES, loadUser, resetUsersCache, logAuthEvent } from "../lib/auth.js";
import { generateKey, hashKey } from "../lib/apiKey.js";
import { getSetting, setSetting } from "../lib/settings.js";

export const router = express.Router();

function cleanUser(body, { partial } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = String(body.name || "").trim().slice(0, 100);
    if (!out.name) return { error: "שם נדרש" };
  }
  if (!partial || body.phone !== undefined) {
    const p = cleanPhone(body.phone);
    if (p.error) return { error: p.error };
    out.phone = p.phone;
  }
  if (!partial || body.access !== undefined) out.access = (Array.isArray(body.access) ? body.access : []).filter((s) => SITES.includes(s));
  if (!partial || body.is_admin !== undefined) out.is_admin = Boolean(body.is_admin);
  if (body.active !== undefined) out.active = Boolean(body.active);
  return { user: out };
}

router.get("/", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select u.id, u.name, u.phone, u.access, u.is_admin, u.active, u.created_at, u.last_login_at,
            (select count(*)::int from sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as sessions
     from users u order by u.active desc, u.name`
  );
  res.json({ users: rows, sites: SITES });
}));

router.post("/", asyncHandler(async (req, res) => {
  const c = cleanUser(req.body || {});
  if (c.error) { res.status(400).json({ error: c.error }); return; }
  try {
    const { rows } = await pool.query(
      "insert into users (name, phone, access, is_admin) values ($1,$2,$3,$4) returning id",
      [c.user.name, c.user.phone, c.user.access, c.user.is_admin]
    );
    resetUsersCache();
    const me = await loadUser(req);
    await logAuthEvent("user_added", true, { phone: c.user.phone, userId: me?.id, ip: req.ip, detail: c.user.name });
    res.json({ id: rows[0].id });
  } catch (e) {
    if (e.code === "23505") { res.status(409).json({ error: "המספר כבר קיים ברשימה" }); return; }
    throw e;
  }
}));

// בדיקה שנשאר לפחות מנהל פעיל אחד (שלא יינעלו כולם מחוץ לניהול)
async function activeAdminsExcept(id) {
  const { rows } = await pool.query("select count(*)::int as n from users where is_admin and active and id <> $1", [id]);
  return rows[0].n;
}

router.put("/:id", asyncHandler(async (req, res) => {
  const id = +req.params.id;
  const c = cleanUser(req.body || {}, { partial: true });
  if (c.error) { res.status(400).json({ error: c.error }); return; }
  const me = await loadUser(req);
  const target = (await pool.query("select * from users where id = $1", [id])).rows[0];
  if (!target) { res.status(404).json({ error: "משתמש לא נמצא" }); return; }
  const losingAdmin = (c.user.is_admin === false || c.user.active === false) && target.is_admin && target.active;
  if (losingAdmin && me && me.id === id) { res.status(400).json({ error: "אי אפשר להסיר הרשאת מנהל / להשבית את עצמך" }); return; }
  if (losingAdmin && (await activeAdminsExcept(id)) === 0) { res.status(400).json({ error: "חייב להישאר לפחות מנהל פעיל אחד" }); return; }
  const keys = Object.keys(c.user);
  if (!keys.length) { res.json({ ok: true }); return; }
  try {
    await pool.query(`update users set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [id, ...keys.map((k) => c.user[k])]);
  } catch (e) {
    if (e.code === "23505") { res.status(409).json({ error: "המספר כבר קיים ברשימה" }); return; }
    throw e;
  }
  // הושבת או שונה הטלפון — מנתקים את כל המכשירים שלו
  if (c.user.active === false || (c.user.phone && c.user.phone !== target.phone)) {
    await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [id]);
  }
  resetUsersCache();
  await logAuthEvent("user_changed", true, { phone: target.phone, userId: me?.id, ip: req.ip, detail: target.name + ": " + keys.join(", ") });
  res.json({ ok: true });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const id = +req.params.id;
  const me = await loadUser(req);
  if (me && me.id === id) { res.status(400).json({ error: "אי אפשר למחוק את עצמך" }); return; }
  const target = (await pool.query("select * from users where id = $1", [id])).rows[0];
  if (!target) { res.status(404).json({ error: "משתמש לא נמצא" }); return; }
  if (target.is_admin && target.active && (await activeAdminsExcept(id)) === 0) { res.status(400).json({ error: "חייב להישאר לפחות מנהל פעיל אחד" }); return; }
  await pool.query("delete from users where id = $1", [id]);
  resetUsersCache();
  await logAuthEvent("user_deleted", true, { phone: target.phone, userId: me?.id, ip: req.ip, detail: target.name });
  res.json({ ok: true });
}));

// ניתוק כל המכשירים של משתמש (למשל טלפון שאבד)
router.post("/:id/logout-all", asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [+req.params.id]);
  res.json({ ok: true, revoked: rowCount });
}));

router.get("/events/log", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select e.action, e.ok, e.phone, e.ip, e.detail, e.created_at, u.name
     from auth_events e left join users u on u.phone = e.phone order by e.created_at desc limit 100`
  );
  res.json({ events: rows });
}));

// --- התוכנה של מיכאל ---
router.get("/supplier/access", asyncHandler(async (req, res) => {
  const [open, keys] = await Promise.all([
    getSetting("supplier_api_open", "1"),
    pool.query("select id, label, active, created_at, last_used_at from api_keys where scope = 'supplier' order by created_at desc"),
  ]);
  res.json({ open: open === "1", keys: keys.rows });
}));
router.put("/supplier/access", asyncHandler(async (req, res) => {
  await setSetting("supplier_api_open", req.body?.open ? "1" : "0");
  const me = await loadUser(req);
  await logAuthEvent("supplier_api_open", true, { userId: me?.id, ip: req.ip, detail: req.body?.open ? "פתוח" : "סגור — רק עם מפתח" });
  res.json({ ok: true });
}));
// מפתח חדש — מוצג פעם אחת בלבד (נשמר רק hash)
router.post("/supplier/keys", asyncHandler(async (req, res) => {
  const label = String(req.body?.label || "יודאיקה פלוס").trim().slice(0, 60);
  const key = generateKey();
  await pool.query("insert into api_keys (label, key_hash, scope) values ($1,$2,'supplier')", [label, hashKey(key)]);
  const me = await loadUser(req);
  await logAuthEvent("supplier_key_created", true, { userId: me?.id, ip: req.ip, detail: label });
  res.json({ key, label });
}));
router.delete("/supplier/keys/:id", asyncHandler(async (req, res) => {
  await pool.query("update api_keys set active = false where id = $1 and scope = 'supplier'", [req.params.id]);
  res.json({ ok: true });
}));
