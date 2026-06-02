// log.js — append an entry to the activity log. Never throws (logging must not break the app).
import { q } from './pool.js';

export async function logEvent(type, message, detail = null) {
  try {
    await q(`INSERT INTO activity_log (type, message, detail) VALUES ($1,$2,$3)`,
      [type, message, detail ? JSON.stringify(detail) : null]);
  } catch (e) {
    console.error('[log] failed:', e.message);
  }
}
