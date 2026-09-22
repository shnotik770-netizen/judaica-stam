# judaica-stam

אתר הזמנות ייעודי לחנות יודאייקה — יצירת הזמנה, הדפסת מדבקה, ותיאום איסוף/מסירה מול ספק הסת"ם.

פרויקט נפרד מהמערכת הפנימית הגדולה של החנות (chabad-judaica). מארח על Railway (מסד נתונים + שרת + אתר), ללא Vercel.

## הרצה מקומית
```bash
npm install
npm start
```

## תשתית
- **קוד**: GitHub — `shnotik770-netizen/judaica-stam`, ענף `main` בלבד (אין branches נפרדים — כל תיקון נכנס ישירות ל-main).
- **אירוח**: Railway בלבד (ללא Vercel) — פרויקט `hazmanat-satam`.
  - שירות `web` — שרת ה-API/אתר (Node+Express). דומיין: `web-production-68f12.up.railway.app`.
  - שירות `Postgres` — מסד הנתונים המנוהל הרשמי של Railway (עם volume אוטומטי לשמירת נתונים).
- **מדפסת מדבקות**: ממשיך להשתמש בפרויקט ה-Supabase הקיים `label-printer` (לא עובר ל-Railway) — זה החיבור היחיד שנשאר מול Supabase.

## יומן עדכונים
כל שינוי משמעותי נרשם כאן, כדי שלא נצטרך לחזור להתכתבות הישנה כדי להבין את ההיסטוריה.

- **2026-09-22** — הקמת הפרויקט: שלד Express מינימלי (`/health`), חובר ל-GitHub, נפרס ל-Railway. Postgres הוקם ראשית באופן שגוי (Docker image גולמי בלי volume) ותוקן להחלפה בתבנית Postgres המנוהלת הרשמית של Railway (דורש אישור ידני של המשתמש ב-dashboard בגלל 2FA).

