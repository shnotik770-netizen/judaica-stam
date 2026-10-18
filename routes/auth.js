// כניסה בקוד SMS: request-code → verify → עוגיית חיבור לחצי שנה. logout / me.
import express from "express";
import crypto from "crypto";
import { pool } from "../lib/db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendSms } from "../lib/call2all.js";
import { normalizePhone } from "../lib/phone.js";
import {
  COOKIE, CODE_MINUTES, CODE_MAX_ATTEMPTS, sha256, rateLimited, logAuthEvent, createSession, loadUser,
  firstPage, canAccess, SITES, SITE_PAGES, usersExist, authDisabled,
} from "../lib/auth.js";

export const router = express.Router();

const GENERIC_SENT = "נשלח אליך קוד ב-SMS";

router.post("/request-code", asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!/^0\d{8,9}$/.test(phone)) { res.status(400).json({ error: "מספר טלפון לא תקין" }); return; }
  // הגבלות: לפי IP (10 בקשות / 15 דק'), לפי טלפון (3 קודים / 15 דק', לפחות 30 שניות בין קודים)
  if (rateLimited("code-ip:" + req.ip, 10, 15 * 60e3)) { res.status(429).json({ error: "יותר מדי בקשות — נסה שוב בעוד כמה דקות" }); return; }
  const recent = (await pool.query(
    "select count(*)::int as n, max(created_at) as last from auth_codes where phone = $1 and created_at > now() - interval '15 minutes'", [phone]
  )).rows[0];
  if (recent.n >= 3 || (recent.last && Date.now() - new Date(recent.last).getTime() < 30e3)) {
    res.status(429).json({ error: "כבר נשלח קוד לאחרונה — חכה מעט ונסה שוב" }); return;
  }
  const user = (await pool.query("select id, name from users where phone = $1 and active", [phone])).rows[0];
  if (!user) {
    // לבקשת בעל החנות: מספר שלא ברשימה — אומרים במפורש (ההגבלות למעלה מונעות סריקה המונית של מספרים)
    await logAuthEvent("code_requested", false, { phone, ip: req.ip, detail: "מספר לא מוכר" });
    res.status(404).json({ error: "המספר לא מוכר במערכת" });
    return;
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const salt = crypto.randomBytes(16).toString("hex");
  await pool.query(
    "insert into auth_codes (phone, salt, code_hash, expires_at, ip) values ($1,$2,$3, now() + make_interval(mins => $4), $5)",
    [phone, salt, sha256(salt + code), CODE_MINUTES, req.ip]
  );
  try {
    await sendSms(phone, `קוד הכניסה שלך למערכת יודאיקה: ${code}\nתקף ל-${CODE_MINUTES} דקות. אין למסור אותו לאף אחד.`);
  } catch (e) {
    await logAuthEvent("code_requested", false, { phone, userId: user.id, ip: req.ip, detail: "שליחת SMS נכשלה: " + e.message });
    res.status(502).json({ error: "שליחת ה-SMS נכשלה — נסה שוב בעוד רגע" });
    return;
  }
  await logAuthEvent("code_requested", true, { phone, userId: user.id, ip: req.ip });
  res.json({ ok: true, message: GENERIC_SENT });
}));

router.post("/verify", asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || "").replace(/\D/g, "");
  if (rateLimited("verify-ip:" + req.ip, 20, 15 * 60e3)) { res.status(429).json({ error: "יותר מדי ניסיונות — נסה שוב בעוד כמה דקות" }); return; }
  if (!phone || code.length !== 6) { res.status(400).json({ error: "יש להזין את הקוד בן 6 הספרות" }); return; }
  const row = (await pool.query(
    "select * from auth_codes where phone = $1 and used_at is null and expires_at > now() order by created_at desc limit 1", [phone]
  )).rows[0];
  if (!row) { res.status(400).json({ error: "הקוד פג תוקף או לא נמצא — בקש קוד חדש" }); return; }
  if (row.attempts >= CODE_MAX_ATTEMPTS) { res.status(429).json({ error: "יותר מדי ניסיונות שגויים — בקש קוד חדש" }); return; }
  const ok = crypto.timingSafeEqual(Buffer.from(sha256(row.salt + code)), Buffer.from(row.code_hash));
  const user = (await pool.query("select id from users where phone = $1 and active", [phone])).rows[0];
  if (!ok || !user) {
    await pool.query("update auth_codes set attempts = attempts + 1 where id = $1", [row.id]);
    await logAuthEvent("login", false, { phone, userId: user?.id, ip: req.ip, detail: "קוד שגוי" });
    const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
    res.status(400).json({ error: "קוד שגוי" + (left > 0 ? ` (נשארו ${left} ניסיונות)` : " — בקש קוד חדש") });
    return;
  }
  await pool.query("update auth_codes set used_at = now() where id = $1", [row.id]);
  await pool.query("update users set last_login_at = now() where id = $1", [user.id]);
  await createSession(res, req, user.id);
  await logAuthEvent("login", true, { phone, userId: user.id, ip: req.ip });
  const full = (await pool.query("select id, name, access, is_admin from users where id = $1", [user.id])).rows[0];
  // next — רק נתיב פנימי באתר שיש אליו הרשאה
  const next = String(req.body?.next || "");
  const nextSite = Object.entries(SITE_PAGES).find(([, p]) => next.startsWith(p))?.[0];
  const redirect = next.startsWith("/") && !next.startsWith("//") && nextSite && canAccess(full, nextSite) ? next : firstPage(full);
  res.json({ ok: true, redirect: redirect || "/login.html?denied=1" });
}));

router.post("/logout", asyncHandler(async (req, res) => {
  const user = await loadUser(req);
  if (user) await pool.query("update sessions set revoked_at = now() where id = $1", [user.session_id]);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}));

router.get("/me", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (authDisabled() || !(await usersExist())) {
    res.json({ open: true, user: null, access: SITES, is_admin: true });
    return;
  }
  const user = await loadUser(req);
  if (!user) { res.status(401).json({ error: "לא מחובר" }); return; }
  res.json({
    user: { name: user.name, phone: user.phone },
    access: SITES.filter((s) => canAccess(user, s)),
    is_admin: user.is_admin,
    expires_at: user.expires_at,
  });
}));
