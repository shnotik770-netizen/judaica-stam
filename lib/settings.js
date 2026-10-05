import { pool } from "./db.js";

export async function getSetting(key, fallback = null) {
  const { rows } = await pool.query("select value from settings where key = $1", [key]);
  return rows[0]?.value ?? fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `insert into settings (key, value, updated_at) values ($1,$2,now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value]
  );
}
