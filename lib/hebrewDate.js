import { HDate } from "@hebcal/hdate";

// תאריך עברי מלא (ללא ניקוד), למשל "כ"ד תשרי תשפ"ז". dateStr: Date או ISO string, ברירת מחדל היום.
export function toHebrewDate(dateStr) {
  try {
    const d = dateStr ? new Date(dateStr) : new Date();
    return new HDate(d).renderGematriya(true);
  } catch {
    return "";
  }
}
