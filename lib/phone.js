// טלפון ישראלי בפורמט אחיד: ספרות בלבד, מתחיל ב-0 (050-123-4567 / +972 50 1234567 / 501234567 → 0501234567).
// כך אותו לקוח נשמר ונמצא תמיד באותו פורמט, לא משנה איך הקלידו.
export function normalizePhone(input) {
  let d = String(input || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  else if (/^[5-9]\d{8}$/.test(d) || /^[2-4]\d{7}$/.test(d)) d = "0" + d; // הוקלד בלי ה-0
  return d;
}

// תקין: נייד 05X / וירטואלי 07X — 10 ספרות; קווי 02/03/04/08/09 — 9 ספרות
export function isValidPhone(d) {
  return /^0[57]\d{8}$/.test(d) || /^0[23489]\d{7}$/.test(d);
}

export const INVALID_PHONE_ERROR = "מספר טלפון לא תקין — נייד: 10 ספרות שמתחילות ב-05 (או 07), קווי: 9 ספרות (02/03/04/08/09)";

// {phone} מנורמל, או {error}
export function cleanPhone(input) {
  const phone = normalizePhone(input);
  return isValidPhone(phone) ? { phone } : { error: INVALID_PHONE_ERROR };
}
