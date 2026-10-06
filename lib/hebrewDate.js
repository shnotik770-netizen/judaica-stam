import { HDate } from "@hebcal/hdate";

// תאריך עברי מלא (ללא ניקוד), למשל "כ"ד תשרי תשפ"ז". dateStr: Date או ISO string, ברירת מחדל היום.
// לפי התאריך האזרחי בישראל — השרת ב-Railway רץ ב-UTC, אז בלי זה פעולה מאוחרת בערב הייתה מקבלת את התאריך הקודם.
const IL_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" });
export function toHebrewDate(dateStr) {
  try {
    const d = dateStr ? new Date(dateStr) : new Date();
    const [y, m, day] = IL_DATE.format(d).split("-").map(Number);
    return new HDate(new Date(y, m - 1, day)).renderGematriya(true);
  } catch {
    return "";
  }
}
