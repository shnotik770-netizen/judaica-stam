// תור הדפסת מדבקות — אותו מנגנון Supabase/PostgREST שכבר בשימוש במערכת הישנה (chabad-judaica).
// PRINT_URL מצביע על טבלת print_queue, PRINT_KEY הוא מפתח ה-anon של אותו פרויקט Supabase.
// שניהם מוגדרים ידנית ב-Railway (לא בקוד) — אותם ערכים שכבר קיימים ב-chabad-judaica.

export async function enqueuePrint(labelData) {
  const url = process.env.PRINT_URL;
  const key = process.env.PRINT_KEY;
  if (!url || !key) return { demo: true };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ label_data: labelData }),
  });
  if (!res.ok) throw new Error(`שגיאת הדפסה: ${res.status}`);
  return { ok: true };
}
