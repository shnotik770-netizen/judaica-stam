// עוטף route handler אסינכרוני כך ששגיאה (כולל שגיאת DB) תעבור ל-Express error handler
// במקום ליפול כ-unhandled rejection ולהפיל את כל השרת (Express 4 לא תופס את זה אוטומטית).
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
