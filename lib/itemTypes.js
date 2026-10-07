// סוגי הפריטים — משותף לנתיבי החנות (routes/orders.js) ולנתיבי הספק (routes/supplier.js)
export const ITEM_TYPES = [
  "tefillin_pair",
  "tefillin_head",
  "tefillin_hand",
  "mezuzah",
  "megillah",
  "sefer_torah",
  "nach",
  "other",
];

export const ITEM_TYPE_LABELS = {
  tefillin_pair: "תפילין זוג",
  tefillin_head: "תפילין ראש",
  tefillin_hand: "תפילין יד",
  mezuzah: "מזוזה",
  megillah: "מגילה",
  sefer_torah: "ספר תורה",
  nach: "נ\"ך",
  other: "אחר",
};
