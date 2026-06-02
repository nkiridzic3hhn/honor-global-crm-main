// pool.js — Postgres connection
import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
