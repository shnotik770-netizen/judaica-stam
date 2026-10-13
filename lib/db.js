import pg from "pg";

// עמודות date (כמו תאריך יעד) כמחרוזת YYYY-MM-DD — בלי המרה ל-Date שתלויה באזור הזמן של השרת
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
