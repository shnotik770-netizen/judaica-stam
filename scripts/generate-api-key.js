// מייצר מפתח API חדש, שומר רק את ה-hash שלו ב-DB, ומדפיס את הערך הגלוי פעם אחת בלבד.
// הרצה: npm run generate-key -- "תווית" internal|supplier
import { pool } from "../lib/db.js";
import { generateKey, hashKey } from "../lib/apiKey.js";

const label = process.argv[2];
const scope = process.argv[3];
if (!label || !["internal", "supplier"].includes(scope)) {
  console.error('שימוש: npm run generate-key -- "תווית" internal|supplier');
  process.exit(1);
}

const key = generateKey();
await pool.query("insert into api_keys (label, key_hash, scope) values ($1,$2,$3)", [label, hashKey(key), scope]);
console.log(`מפתח חדש עבור "${label}" (scope: ${scope}, מוצג פעם אחת בלבד — שמור אותו עכשיו):`);
console.log(key);
process.exit(0);
