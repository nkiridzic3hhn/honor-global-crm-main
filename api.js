// api.js — Express API routes
import express from 'express';
import multer from 'multer';
import xlsx from 'xlsx';
import { q } from './pool.js';
import { runSync, syncStatus } from './sync.js';
import { runDiagnostics } from './diag.js';
import { logEvent } from './log.js';
import { importClassificationsFromBuffer } from './import_csv.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const VALID_BUCKETS = ['pending','avoided_cost','domestic_replacement','third_party_replacement','cost'];

router.get('/roster', async (req, res) => {
  try {
    const rows = await q(
      `SELECT h.*, c.bucket, c.replacing_who, c.replaced_who, c.replaced_annual_cost,
              c.hourly_saving, c.annual_saving, c.notes, c.kpis, c.role_description
       FROM hires h LEFT JOIN classifications c ON c.clickup_id = h.clickup_id
       WHERE h.active = TRUE ORDER BY h.name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/classification/:id', async (req, res) => {
  try {
    const { id } = req.params; const b = req.body || {};
    if (b.bucket && !VALID_BUCKETS.includes(b.bucket)) return res.status(400).json({ error: 'invalid bucket' });
    await q(
      `INSERT INTO classifications (clickup_id,bucket,replacing_who,replaced_who,replaced_annual_cost,hourly_saving,annual_saving,notes,kpis,role_description,updated_at)
       VALUES ($1,COALESCE($2,'pending'),$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (clickup_id) DO UPDATE SET
         bucket=COALESCE($2,classifications.bucket), replacing_who=$3, replaced_who=$4,
         replaced_annual_cost=$5, hourly_saving=$6, annual_saving=$7, notes=$8,
         kpis=$9, role_description=$10, updated_at=now()`,
      [id, b.bucket || null, b.replacing_who || null, b.replaced_who || null,
       b.replaced_annual_cost ?? null, b.hourly_saving ?? null, b.annual_saving ?? null, b.notes || null,
       b.kpis || null, b.role_description || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/payroll', async (req, res) => {
  try { res.json(await q(`SELECT * FROM payroll_weeks ORDER BY week_ending ASC NULLS LAST, period ASC`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const COL_AGENCY=['market name/company name','market name','company','agency'];
const COL_NAME=['name of employee/name','name of employee','employee name','employee','staff name'];
const COL_RATE=['rate'];
const COL_HOURS=['total hrs','hours','hrs'];
const COL_AMOUNT=['pay','amount','net pay','gross','wage'];
const COL_PERIOD=['period','pay period','week'];
const COL_NOTES=['notes/comments','note','memo','detail','comment','remarks'];
function pickCol(headers, candidates){
  const lower = headers.map(h => String(h||'').toLowerCase().trim());
  for (const c of candidates){ const i=lower.findIndex(h=>h===c); if(i>=0) return i; }
  for (const c of candidates){ const i=lower.findIndex(h=>h.includes(c)); if(i>=0) return i; }
  return -1;
}
const num = v => { const n=parseFloat(String(v??'').replace(/[^0-9.\-]/g,'')); return isNaN(n)?null:n; };
// normalize agency for grouping: collapse case + spacing differences
const normAgency = a => String(a||'').trim().replace(/\s+/g,' ')
  .toLowerCase().replace(/\b\w/g, c=>c.toUpperCase());

router.post('/payroll/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'empty sheet' });

    const headers = rows[0];
    const iAg = pickCol(headers, COL_AGENCY);
    const iN  = pickCol(headers, COL_NAME);
    const iR  = pickCol(headers, COL_RATE);
    const iH  = pickCol(headers, COL_HOURS);
    const iA  = pickCol(headers, COL_AMOUNT);
    const iP  = pickCol(headers, COL_PERIOD);
    const iNo = pickCol(headers, COL_NOTES);

    const items = [];
    const agencyMap = {};
    let detectedPeriod = '';
    for (const r of rows.slice(1)) {
      const name = String(r[iN<0?1:iN] ?? '').trim();
      const amount = num(r[iA<0?4:iA]);
      // skip the trailing total row (no name) but capture its period if present
      if (!name) continue;
      const agency = normAgency(r[iAg<0?0:iAg]);
      const period = String(r[iP] ?? '').replace(/\t/g,'').trim();
      if (period && !detectedPeriod) detectedPeriod = period;
      const item = {
        agency: agency || null,
        name,
        rate: iR>=0 ? num(r[iR]) : null,
        hours: iH>=0 ? num(r[iH]) : null,
        amount: amount || 0,
        notes: iNo>=0 ? String(r[iNo] ?? '').replace(/\\n/g,'\n').trim() : '',
      };
      items.push(item);
      const ak = agency || '(no agency)';
      agencyMap[ak] = (agencyMap[ak] || 0) + (amount || 0);
    }

    // period key: from file if found, else from request body, else error
    const period = detectedPeriod || String(req.body.week_ending || '').trim();
    if (!period) return res.status(400).json({ error: 'could not detect a Period in the file' });

    // try to derive a week_ending date from the period (end of range) for sorting
    let weekEnding = null;
    const m = period.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4}).*?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) { const mo=m[4].padStart(2,'0'), d=m[5].padStart(2,'0'), y=m[6].length===2?'20'+m[6]:m[6]; weekEnding=`${y}-${mo}-${d}`; }
    else { const s=period.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if(s){const y=s[3].length===2?'20'+s[3]:s[3]; weekEnding=`${y}-${s[1].padStart(2,'0')}-${s[2].padStart(2,'0')}`;} }

    const total = items.reduce((s,x)=>s+x.amount,0);
    const agencyTotals = Object.entries(agencyMap)
      .map(([agency,amt])=>({agency, amount:+amt.toFixed(2)}))
      .sort((a,b)=>b.amount-a.amount);

    await q(
      `INSERT INTO payroll_weeks (period,week_ending,total,items,agency_totals,notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (period) DO UPDATE SET week_ending=$2, total=$3, items=$4, agency_totals=$5, notes=$6, posted_at=now()`,
      [period, weekEnding, total, JSON.stringify(items), JSON.stringify(agencyTotals), req.body.notes || null]
    );
    await logEvent('payroll_upload', `Payroll uploaded: ${period} — ${items.length} people, $${total.toFixed(2)}`, { period, total, count: items.length });
    res.json({ ok: true, period, week_ending: weekEnding, total, count: items.length, agencies: agencyTotals.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/payroll/:period', async (req, res) => {
  try { const p=decodeURIComponent(req.params.period); await q(`DELETE FROM payroll_weeks WHERE period=$1`, [p]); await logEvent('payroll_delete', `Payroll week deleted: ${p}`, { period: p }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/settings', async (req, res) => {
  try { const [s] = await q(`SELECT * FROM settings WHERE id=1`); res.json(s); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/settings', async (req, res) => {
  try {
    const b = req.body || {};
    await q(`UPDATE settings SET hours_per_week=$1, days_per_week=$2, weeks_per_year=$3 WHERE id=1`,
      [b.hours_per_week || 40, b.days_per_week || 5, b.weeks_per_year || 52]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync', async (req, res) => { res.json(await runSync()); });
router.get('/sync/status', (req, res) => res.json(syncStatus()));

// ---- Diagnostics (temporary) — visit /api/diag to see headcount by strategy ----
router.get('/diag', async (req, res) => {
  try { res.json(await runDiagnostics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Names dump (temporary) — visit /api/names to list active people ----
router.get('/names', async (req, res) => {
  try {
    const rows = await q(`SELECT clickup_id, name FROM hires WHERE active=TRUE ORDER BY name`);
    res.json({ count: rows.length, people: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- One-time CSV import of buckets/savings ----
router.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const summary = await importClassificationsFromBuffer(req.file.buffer);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// ---- Activity log ----
router.get('/logs', async (req, res) => {
  try {
    const type = req.query.type;
    const rows = type && type !== 'all'
      ? await q(`SELECT * FROM activity_log WHERE type=$1 ORDER BY ts DESC LIMIT 500`, [type])
      : await q(`SELECT * FROM activity_log ORDER BY ts DESC LIMIT 500`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Domestic payroll (the local cost we're reducing) ----
const COL_HEAD=['headcount','head count','employees','# employees','count','staff count'];

router.get('/domestic', async (req, res) => {
  try { res.json(await q(`SELECT * FROM domestic_payroll ORDER BY week_ending ASC NULLS LAST, period ASC, agency ASC`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/domestic/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'empty sheet' });
    const headers = rows[0];
    const iAg = pickCol(headers, COL_AGENCY);
    const iA  = pickCol(headers, COL_AMOUNT);
    const iP  = pickCol(headers, COL_PERIOD);
    const iHc = pickCol(headers, COL_HEAD);
    const iNo = pickCol(headers, COL_NOTES);

    // Accumulate by (period, agency). If no agency column, everything rolls to '(all)'.
    const acc = {}; // key -> {period, agency, total, headcount}
    let firstPeriod = '';
    for (const r of rows.slice(1)) {
      const amount = num(r[iA<0?1:iA]);
      const period = String(r[iP] ?? '').replace(/\t/g,'').trim();
      if (period && !firstPeriod) firstPeriod = period;
      const agency = iAg>=0 ? normAgency(r[iAg]) : '(all)';
      if (amount == null && !agency) continue;
      const key = (period||firstPeriod||'?') + '||' + (agency || '(all)');
      if (!acc[key]) acc[key] = { period: period||firstPeriod, agency: agency||'(all)', total: 0, headcount: null };
      acc[key].total += amount || 0;
      if (iHc >= 0) { const hc = num(r[iHc]); if (hc != null) acc[key].headcount = (acc[key].headcount||0) + hc; }
    }
    const entries = Object.values(acc).filter(e => e.period);
    if (!entries.length) return res.status(400).json({ error: 'could not detect Period rows in the file' });

    let weeks = new Set();
    for (const e of entries) {
      const m = e.period.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:.*?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4}))?/);
      let we=null;
      if (m){ if(m[4]){const y=m[6].length===2?'20'+m[6]:m[6];we=`${y}-${m[4].padStart(2,'0')}-${m[5].padStart(2,'0')}`;}
              else {const y=m[3].length===2?'20'+m[3]:m[3];we=`${y}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;} }
      await q(
        `INSERT INTO domestic_payroll (period,agency,week_ending,total,headcount,notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (period,agency) DO UPDATE SET week_ending=$3, total=$4, headcount=$5, notes=$6, posted_at=now()`,
        [e.period, e.agency, we, e.total, e.headcount, req.body.notes || null]
      );
      weeks.add(e.period);
    }
    await logEvent('domestic_upload', `Domestic payroll uploaded: ${weeks.size} week(s), ${entries.length} agency-rows`, { weeks: [...weeks], rows: entries.length });
    res.json({ ok: true, weeks: [...weeks], rows: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/domestic/:period', async (req, res) => {
  try { const p=decodeURIComponent(req.params.period); await q(`DELETE FROM domestic_payroll WHERE period=$1`, [p]); await logEvent('domestic_delete', `Domestic payroll week deleted: ${p}`, { period: p }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Impact analysis: domestic vs offshore over time ----
router.get('/impact', async (req, res) => {
  try {
    const offshore = await q(`SELECT period, week_ending, total, agency_totals FROM payroll_weeks ORDER BY week_ending ASC NULLS LAST, period ASC`);
    const domestic = await q(`SELECT period, agency, week_ending, total, headcount FROM domestic_payroll ORDER BY week_ending ASC NULLS LAST, period ASC`);
    res.json({ offshore, domestic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
