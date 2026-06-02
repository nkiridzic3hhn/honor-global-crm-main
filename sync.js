// sync.js — reconcile ClickUp roster into Postgres, logging adds/removes/rate changes.
import { pool } from './pool.js';
import { fetchActiveRoster } from './clickup.js';
import { logEvent } from './log.js';

let lastSync = null, lastCount = 0, syncing = false;
export function syncStatus() { return { lastSync, lastCount, syncing }; }

export async function runSync() {
  if (syncing) return { skipped: true };
  syncing = true;
  const client = await pool.connect();
  try {
    const roster = await fetchActiveRoster();
    if (!roster.length) { return { error: 'empty-roster-skipped' }; }

    // snapshot current state to diff against
    const existing = await client.query(`SELECT clickup_id, name, agency, pay_rate, active FROM hires`);
    const prev = new Map(existing.rows.map(r => [r.clickup_id, r]));
    const firstEverSync = prev.size === 0; // don't flood the log with 113 "new hire" entries on initial load

    await client.query('BEGIN');
    const ids = roster.map(r => r.clickup_id);
    const events = []; // collect, write after commit

    for (const r of roster) {
      const before = prev.get(r.clickup_id);
      // NEW person (not seen before, or was inactive and is now back)
      if (!before) {
        if (!firstEverSync) events.push(['sync_add', `New hire added: ${r.name}${r.agency ? ' — ' + r.agency : ''}`, { name: r.name, agency: r.agency, position: r.position, pay_rate: r.pay_rate }]);
      } else if (!before.active) {
        events.push(['sync_add', `Reactivated: ${r.name}${r.agency ? ' — ' + r.agency : ''}`, { name: r.name, agency: r.agency }]);
      } else {
        // pay-rate change
        const oldRate = Number(before.pay_rate), newRate = Number(r.pay_rate);
        if (oldRate !== newRate) {
          events.push(['rate_change', `Pay rate changed: ${r.name} $${oldRate.toFixed(2)} → $${newRate.toFixed(2)}/hr`, { name: r.name, old: oldRate, new: newRate, agency: r.agency }]);
        }
      }
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

    // people who dropped off (were active, no longer present)
    const idset = new Set(ids);
    for (const [id, before] of prev) {
      if (before.active && !idset.has(id)) {
        events.push(['sync_remove', `Removed (terminated/resigned): ${before.name}${before.agency ? ' — ' + before.agency : ''}`, { name: before.name, agency: before.agency }]);
      }
    }
    await client.query(`UPDATE hires SET active=FALSE WHERE active=TRUE AND NOT (clickup_id = ANY($1))`, [ids]);

    await client.query('COMMIT');
    lastSync = new Date().toISOString(); lastCount = roster.length;

    // write log entries (after commit, non-blocking-safe)
    for (const [type, msg, detail] of events) await logEvent(type, msg, detail);
    return { count: roster.length, syncedAt: lastSync, changes: events.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[sync] failed:', e.message);
    return { error: e.message };
  } finally {
    client.release(); syncing = false;
  }
}
