// תור הדפסת מדבקות — אותו מנגנון Supabase שכבר בשימוש במערכת הישנה (chabad-judaica).
// הטבלה print_queue מוגנת ב-RLS בלי policies, אז הכנסה ישירה אליה עם מפתח ה-anon
// נחסמת תמיד (זו הייתה הסיבה שההדפסה לא עבדה). הדרך הנתמכת היא דרך הפונקציה
// create_print_label (SECURITY DEFINER), שדורשת סוד תואם ל-kiosk_print_secret שב-Vault.
// PRINT_URL/PRINT_KEY/PRINT_SECRET מוגדרים ידנית ב-Railway (לא בקוד).

function rpcUrl(baseUrl) {
  return baseUrl.replace(/\/rest\/v1\/.*$/, "/rest/v1/rpc/create_print_label");
}

export async function enqueuePrint(labelData) {
  const url = process.env.PRINT_URL;
  const key = process.env.PRINT_KEY;
  const secret = process.env.PRINT_SECRET;
  if (!url || !key) return { demo: true };
  if (!secret) throw new Error("שגיאת הדפסה: חסר PRINT_SECRET בהגדרות השרת");
  const res = await fetch(rpcUrl(url), {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_secret: secret, p_label_data: labelData }),
  });
  if (!res.ok) throw new Error(`שגיאת הדפסה: ${res.status}`);
  return { ok: true };
}
