// עטיפת ה-API של ימות המשיח/Call2All. הטוקן נקרא רק מ-process.env.CALL2ALL_TOKEN —
// לעולם לא נחשף ללקוח (כל הקריאות האלה רצות רק בצד השרת).
const BASE = "https://www.call2all.co.il/ym/api";

function requireToken() {
  const token = process.env.CALL2ALL_TOKEN;
  if (!token) throw new Error("CALL2ALL_TOKEN לא מוגדר בצד השרת");
  return token;
}

export async function sendSms(phone, message) {
  const token = requireToken();
  const params = new URLSearchParams({ token, phones: phone, message });
  const res = await fetch(`${BASE}/SendSms?${params}`);
  const data = await res.json();
  if (data.responseStatus !== "OK") throw new Error(data.message || "שגיאת שליחת SMS");
  return data;
}

export async function getIncomingSms({ limit, startDate, endDate } = {}) {
  const token = requireToken();
  const params = new URLSearchParams({ token });
  if (limit) params.set("limit", String(limit));
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const res = await fetch(`${BASE}/GetIncomingSms?${params}`);
  const data = await res.json();
  if (data.responseStatus !== "OK") throw new Error(data.message || "שגיאת קריאת הודעות נכנסות");
  return data.rows || [];
}

export async function getSmsOutLog({ limit } = {}) {
  const token = requireToken();
  const params = new URLSearchParams({ token });
  if (limit) params.set("limit", String(limit));
  const res = await fetch(`${BASE}/GetSmsOutLog?${params}`);
  const data = await res.json();
  if (data.responseStatus !== "OK") throw new Error(data.message || "שגיאת קריאת יומן הודעות יוצאות");
  return data.rows || [];
}
