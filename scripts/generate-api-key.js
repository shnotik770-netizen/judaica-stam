// מייצר מפתח API חדש, שומר רק את ה-hash שלו ב-DB, ומדפיס את הערך הגלוי פעם אחת בלבד.
// הרצה: npm run generate-key -- "תווית, למשל: יודאיקה פלוס"
import { pool } from "../lib/db.js";
import { generateKey, hashKey } from "../lib/apiKey.js";

const label = process.argv[2];
if (!label) {
  console.error('שימוש: npm run generate-key -- "תווית"');
  process.exit(1);
}

const key = generateKey();
await pool.query("insert into api_keys (label, key_hash) values ($1,$2)", [label, hashKey(key)]);
console.log(`מפתח חדש עבור "${label}" (מוצג פעם אחת בלבד — שמור אותו עכשיו):`);
console.log(key);
process.exit(0);
