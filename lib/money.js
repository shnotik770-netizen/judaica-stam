// סכום כסף מהקלט: מספר >= 0 מעוגל לאגורות. ריק → null. {value} או {error}
export function cleanPrice(v) {
  if (v === undefined || v === null || v === "") return { value: null };
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < 0) return { error: "סכום לתשלום חייב להיות מספר (0 ומעלה)" };
  return { value: n };
}
