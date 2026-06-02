// import_csv.js — one-time bulk import of the bucket/savings CSV.
// Fuzzy-matches each row's "Honor Global New Hire" to a roster name,
// computes savings, writes classifications, and returns a summary.

import xlsx from 'xlsx';
import { q } from './pool.js';

// --- group -> bucket mapping ---
const GROUP_MAP = {
  'domestic': 'domestic_replacement',
  '3rd party': 'third_party_replacement',
  'third party': 'third_party_replacement',
  'avoided': 'avoided_cost',
  'avoided hire': 'avoided_cost',
  'cost': 'cost',
  'limited cost': 'cost',
  'dont know yet': 'pending',
  "don't know yet": 'pending',
  '': 'pending',
};

const money = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
};


// Explicit, human-confirmed name pairings (csv name -> roster name).
const ALIASES = {
  'abby daniel gonzalez burgos': 'Daniel Burgos',
  'zia nicole abonilla': 'Zia Abonalla',
  'manuelle g salvador': 'Manuelle Guiseppe Salvador',
  'nadine japinpin': 'Nadine Monica Q. Janipin',
  'cai cavite': 'Caryl Cavite',
  'althea beatriz yandall': 'Althea Beatriz Dingcong',
  'jan mark batu': 'John Mark Batu',
};

// --- name normalization + fuzzy match ---
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')        // drop parenthetical nicknames
    .replace(/[.\-,']/g, ' ')        // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}
function tokens(s) { return new Set(norm(s).split(' ').filter(Boolean)); }

// Token-overlap score: shared tokens / smaller set size. 1.0 = all of the
// shorter name's tokens appear in the other (handles middle names/dropped words).
function score(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

function bestMatch(name, roster) {
  const nn = norm(name);
  // explicit confirmed alias first
  if (ALIASES[nn]) {
    const target = norm(ALIASES[nn]);
    const r = roster.find(x => norm(x.name) === target);
    if (r) return { row: r, conf: 'alias', s: 1 };
  }
  // exact normalized match
  for (const r of roster) if (norm(r.name) === nn) return { row: r, conf: 'exact', s: 1 };
  // otherwise best token-overlap
  let best = null, bestS = 0;
  for (const r of roster) {
    const s = score(name, r.name);
    if (s > bestS) { bestS = s; best = r; }
  }
  if (best && bestS >= 0.67) return { row: best, conf: 'fuzzy', s: +bestS.toFixed(2) };
  return { row: null, conf: 'none', s: +bestS.toFixed(2), nearest: best?.name };
}

export async function importClassificationsFromBuffer(buffer) {
  // roster from DB (active people)
  const roster = await q(`SELECT clickup_id, name, pay_rate FROM hires WHERE active=TRUE`);

  const wb = xlsx.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });

  // find header row + column indexes by keyword (robust to column shuffling)
  const headerRowIdx = rows.findIndex(r => r.some(c => /honor global new hire/i.test(String(c))));
  const H = rows[headerRowIdx].map(c => String(c).toLowerCase().trim());
  const col = (kw) => H.findIndex(h => kw.some(k => h.includes(k)));
  const iName = col(['honor global new hire', 'new hire']);
  const iAgency = col(['agency']);
  const iSup = col(['supervisor']);
  const iGroup = col(['group']);
  const iRate = col(['hourly rate of honor', 'hourly rate']);
  const iHGAnnual = col(['current cost annually', 'annually hg']);
  const iExpl = col(['explanation of replacement', 'explanation']);
  const iRepRate = col(['hrly rate of replacement', 'rate of replacement']);
  const iPrevAnnual = col(['previous cost annually', 'previous cost']);
  const iHours = col(['hours']);

  const result = { matched: [], fuzzy: [], unmatched: [], counts: {} };

  for (const r of rows.slice(headerRowIdx + 1)) {
    const name = String(r[iName] || '').trim();
    if (!name) continue;

    const m = bestMatch(name, roster);
    const groupRaw = String(r[iGroup] || '').toLowerCase().trim();
    const bucket = GROUP_MAP[groupRaw] ?? 'pending';

    const hgAnnual = money(r[iHGAnnual]);
    const prevAnnual = money(r[iPrevAnnual]);
    const hours = money(r[iHours]) || 40;
    const repRate = money(r[iRepRate]);

    // compute savings: previous annual - this hire's annual (only for savings buckets)
    let annualSaving = null, hourlySaving = null;
    if (['avoided_cost', 'domestic_replacement', 'third_party_replacement'].includes(bucket)) {
      if (prevAnnual != null) {
        annualSaving = Math.round(prevAnnual - (hgAnnual || 0));
        const weeks = 52;
        hourlySaving = +(annualSaving / (hours * weeks)).toFixed(2);
      }
    }

    const payload = {
      bucket,
      replaced_who: String(r[iExpl] || '').trim() || null,
      replacing_who: null,
      replaced_annual_cost: prevAnnual,
      hourly_saving: hourlySaving,
      annual_saving: annualSaving,
      notes: String(r[iExpl] || '').trim() || null,
    };

    if (m.row) {
      await q(
        `INSERT INTO classifications (clickup_id,bucket,replacing_who,replaced_who,replaced_annual_cost,hourly_saving,annual_saving,notes,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (clickup_id) DO UPDATE SET
           bucket=$2, replacing_who=$3, replaced_who=$4, replaced_annual_cost=$5,
           hourly_saving=$6, annual_saving=$7, notes=$8, updated_at=now()`,
        [m.row.clickup_id, payload.bucket, payload.replacing_who, payload.replaced_who,
         payload.replaced_annual_cost, payload.hourly_saving, payload.annual_saving, payload.notes]
      );
      const entry = { csv: name, matched: m.row.name, bucket, annual_saving: annualSaving, conf: m.conf, score: m.s };
      (m.conf === 'fuzzy' ? result.fuzzy : result.matched).push(entry);
    } else {
      result.unmatched.push({ csv: name, bucket, nearest: m.nearest || null, score: m.s });
    }
  }

  result.counts = {
    matched_exact: result.matched.length,
    matched_fuzzy: result.fuzzy.length,
    unmatched: result.unmatched.length,
    total_rows: result.matched.length + result.fuzzy.length + result.unmatched.length,
  };
  return result;
}
