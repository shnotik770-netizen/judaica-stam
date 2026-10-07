// "שפה משותפת" לרישום פרטי הפריט מול יודאיקה פלוס (לפי המסמך של מיכאל, 07.10.2026). הקודים נשלחים לספק
// בדיוק כך (שדה variant בכל שקית) — אצלו הם נכנסים לפריט אוטומטית, וקוד שלא ברשימה לא ינוחש. לכן מקבלים
// רק את הקודים האלה, ורק את השדות שרלוונטיים לסוג הפריט. שדה שלא נשאל — לא נשמר ולא נשלח.
export const VARIANT_FIELDS = {
  method: { label: "שיטה", options: { rashi: "רש\"י", rt: "ר\"ת" } },
  leather: { label: "סוג", options: { gassot: "גסות", pshutim: "פשוטים", dakot: "דקות", parshiot_only: "פרשיות בלי בתים" } },
  form: { label: "מצב", options: { rolled: "בבתים (סגורות)", open: "פתוחות" } },
};

export const VARIANT_BY_ITEM_TYPE = {
  tefillin_pair: ["method", "leather"],
  tefillin_head: ["method", "leather"],
  tefillin_hand: ["method", "leather"],
  mezuzah: ["form"],
};

// מנקה variant שהגיע מהטופס לפי סוג הפריט. מחזיר {variant} (null אם אין כלום) או {error} על קוד לא מוכר.
export function cleanVariant(itemType, variant) {
  if (variant == null) return { variant: null };
  if (typeof variant !== "object" || Array.isArray(variant)) return { error: "variant חייב להיות אובייקט" };
  const allowed = VARIANT_BY_ITEM_TYPE[itemType] || [];
  const out = {};
  for (const [key, value] of Object.entries(variant)) {
    if (value == null || value === "") continue;
    if (!allowed.includes(key)) continue; // שדה שלא שייך לסוג הפריט (למשל אחרי החלפת סוג) — מתעלמים
    if (!(value in VARIANT_FIELDS[key].options)) return { error: `ערך לא מוכר ל-${key}: ${value}` };
    out[key] = value;
  }
  return { variant: Object.keys(out).length ? out : null };
}

// טקסט קצר בעברית למדבקה/יומן, למשל "ר\"ת · פשוטים"
export function variantText(variant) {
  if (!variant) return "";
  return Object.entries(variant)
    .map(([k, v]) => VARIANT_FIELDS[k]?.options[v] || v)
    .join(" · ");
}
