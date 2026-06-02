// api.js — Express API routes
import express from 'express';
import multer from 'multer';
import xlsx from 'xlsx';
import { q } from './pool.js';
import { runSync, syncStatus } from './sync.js';
import { runDiagnostics } from './diag.js';
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
  try { res.json(await q(`SELECT * FROM payroll_weeks ORDER BY week_ending ASC`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const COL_NAME=['name','employee','hire','staff','person'];
const COL_AMOUNT=['amount','pay','total','net','gross','wage','$'];
const COL_NOTES=['note','memo','detail','comment','remarks'];
function pickCol(headers, candidates){
  const lower = headers.map(h => String(h||'').toLowerCase().trim());
  for (let i=0;i<lower.length;i++) if (candidates.some(c=>lower[i].includes(c))) return i;
  return -1;
}
router.post('/payroll/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const weekEnding = req.body.week_ending;
    if (!weekEnding) return res.status(400).json({ error: 'week_ending required' });
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    if (!rows.length) return res.status(400).json({ error: 'empty sheet' });
    const headers = rows[0];
    const iN = pickCol(headers, COL_NAME), iA = pickCol(headers, COL_AMOUNT), iNo = pickCol(headers, COL_NOTES);
    const items = [];
    for (const r of rows.slice(1)) {
      const name = String(r[iN<0?0:iN] ?? '').trim();
      if (!name) continue;
      const amount = parseFloat(String(r[iA<0?1:iA] ?? '').replace(/[^0-9.\-]/g,'')) || 0;
      const notes = iNo>=0 ? String(r[iNo] ?? '').trim() : '';
      items.push({ name, amount, notes });
    }
    const total = items.reduce((s,x)=>s+x.amount,0);
    await q(
      `INSERT INTO payroll_weeks (week_ending,total,items,notes) VALUES ($1,$2,$3,$4)
       ON CONFLICT (week_ending) DO UPDATE SET total=$2, items=$3, notes=$4, posted_at=now()`,
      [weekEnding, total, JSON.stringify(items), req.body.notes || null]
    );
    res.json({ ok: true, week_ending: weekEnding, total, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/payroll/:week', async (req, res) => {
  try { await q(`DELETE FROM payroll_weeks WHERE week_ending=$1`, [req.params.week]); res.json({ ok: true }); }
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

export default router;
