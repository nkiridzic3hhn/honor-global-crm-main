// sync.js — reconcile ClickUp roster into Postgres.
import { pool } from './pool.js';
import { fetchActiveRoster } from './clickup.js';

let lastSync = null, lastCount = 0, syncing = false;
export function syncStatus() { return { lastSync, lastCount, syncing }; }

export async function runSync() {
  if (syncing) return { skipped: true };
  syncing = true;
  const client = await pool.connect();
  try {
    const roster = await fetchActiveRoster();
    await client.query('BEGIN');
    const ids = roster.map(r => r.clickup_id);
    for (const r of roster) {
      await client.query(
        `INSERT INTO hires (clickup_id,name,position,supervisor,agency,role_type,pay_rate,start_date,is_subtask,active,last_synced)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,now())
         ON CONFLICT (clickup_id) DO UPDATE SET
           name=EXCLUDED.name, position=EXCLUDED.position, supervisor=EXCLUDED.supervisor,
           agency=EXCLUDED.agency, role_type=EXCLUDED.role_type, pay_rate=EXCLUDED.pay_rate,
           start_date=EXCLUDED.start_date, is_subtask=EXCLUDED.is_subtask, active=TRUE, last_synced=now()`,
        [r.clickup_id, r.name, r.position, r.supervisor, r.agency, r.role_type, r.pay_rate, r.start_date, r.is_subtask]
      );
      await client.query(
        `INSERT INTO classifications (clickup_id) VALUES ($1) ON CONFLICT (clickup_id) DO NOTHING`,
        [r.clickup_id]
      );
    }
    if (ids.length) {
      await client.query(`UPDATE hires SET active=FALSE WHERE active=TRUE AND NOT (clickup_id = ANY($1))`, [ids]);
    } else {
      await client.query('ROLLBACK');
      return { error: 'empty-roster-skipped' };
    }
    await client.query('COMMIT');
    lastSync = new Date().toISOString(); lastCount = roster.length;
    return { count: roster.length, syncedAt: lastSync };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[sync] failed:', e.message);
    return { error: e.message };
  } finally {
    client.release(); syncing = false;
  }
}
