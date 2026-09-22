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
- **SMS (ימות המשיח / Call2All)**: `lib/call2all.js` — עטיפה ל-API (SendSms, GetIncomingSms, GetSmsOutLog). הטוקן נקרא אך ורק מ-`process.env.CALL2ALL_TOKEN` בצד השרת, **אף פעם לא נכתב בקוד/git**. יש להגדיר אותו ידנית במשתני הסביבה של שירות `web` ב-Railway (Variables tab) — לא דרך קוד או API אוטומטי, כדי שהטוקן לא יעבור דרך שום כלי אוטומציה.

## API
- `POST /api/sms/send` — `{phone, message}`
- `GET /api/sms/incoming?limit=&startDate=&endDate=` — הודעות נכנסות אחרונות
- `GET /api/sms/outgoing?limit=` — יומן הודעות יוצאות
- `GET /api/sms/conversation?phone=0501234567` — כל ההתכתבות (נכנס+יוצא) מול מספר ספציפי, ממוינת לפי זמן

## יומן עדכונים
כל שינוי משמעותי נרשם כאן, כדי שלא נצטרך לחזור להתכתבות הישנה כדי להבין את ההיסטוריה.

- **2026-09-22** — הקמת הפרויקט: שלד Express מינימלי (`/health`), חובר ל-GitHub, נפרס ל-Railway. Postgres הוקם ראשית באופן שגוי (Docker image גולמי בלי volume) ותוקן להחלפה בתבנית Postgres המנוהלת הרשמית של Railway (דורש אישור ידני של המשתמש ב-dashboard בגלל 2FA).
- **2026-09-22** — הוספת אינטגרציית SMS מול ימות המשיח/Call2All: שליחה, קריאת הודעות נכנסות, יומן יוצאות, ותצוגת שיחה מול מספר ספציפי (`/api/sms/conversation`). דורש הגדרת `CALL2ALL_TOKEN` ידנית ב-Railway (ראו למעלה).

