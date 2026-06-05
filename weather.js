// weather.js — PH workforce weather/disruption monitor for Honor Global CRM.
// Self-contained: owns its own schema, cron job, Slack alerts, and API routes.
// Depends only on things you already have: pool.js, log.js, express, node-cron.
//
// Wiring (in index.js, next to where you set up express + the sync cron):
//   import { weatherRouter, startWeatherCron } from './weather.js';
//   app.use(weatherRouter);
//   startWeatherCron();
//
// Env vars to set in Railway:
//   CLICKUP_LOCATION_FIELD_ID = the custom-field id of your new "City / Province" field
//   SLACK_WEBHOOK_URL         = an incoming-webhook URL for the channel alerts post to
//   (DATABASE_URL and CLICKUP_* you already have)

import express from 'express';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './pool.js';
import { logEvent } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- tunable thresholds (move into the settings table later if you want them editable from the UI) ----
const RED_PRECIP = 7.6;   // mm/h  heavy rain
const RED_WIND   = 39;    // km/h  strong wind that downs lines
const YEL_PRECIP = 2.5;   // mm/h  moderate rain
const YEL_WIND   = 25;    // km/h
const RE_PING_HOURS = 3;  // if someone stays RED, don't re-ping more often than this
const GEOCODE_DELAY_MS = 1100; // Nominatim asks for <= 1 req/sec

let lastRun = null, lastCount = 0, running = false;
export function weatherStatus() { return { lastRun, lastCount, running }; }

// ---------- schema (additive, safe to run repeatedly) ----------
export async function ensureWeatherSchema() {
  await pool.query(`
    ALTER TABLE hires ADD COLUMN IF NOT EXISTS location          TEXT;
    ALTER TABLE hires ADD COLUMN IF NOT EXISTS latitude          NUMERIC;
    ALTER TABLE hires ADD COLUMN IF NOT EXISTS longitude         NUMERIC;
    ALTER TABLE hires ADD COLUMN IF NOT EXISTS geocoded_location TEXT;
    CREATE TABLE IF NOT EXISTS weather_status (
      clickup_id   TEXT PRIMARY KEY REFERENCES hires(clickup_id) ON DELETE CASCADE,
      level        TEXT DEFAULT 'unknown',
      precip_mm    NUMERIC,
      wind_kph     NUMERIC,
      reasons      JSONB DEFAULT '[]',
      checked_at   TIMESTAMPTZ,
      last_ping_at TIMESTAMPTZ
    );
  `);
}

// ---------- scoring ----------
function score(precip, wind, code) {
  let level = 'green';
  const reasons = [];
  const bump = (n) => { const r = { green: 0, yellow: 1, red: 2 }; if (r[n] > r[level]) level = n; };

  if (precip >= RED_PRECIP) { reasons.push({ t: `Heavy rain ${precip.toFixed(1)}mm`, k: 'red' }); level = 'red'; }
  else if (precip >= YEL_PRECIP) { reasons.push({ t: `Rain ${precip.toFixed(1)}mm`, k: 'yellow' }); bump('yellow'); }

  if (wind >= RED_WIND) { reasons.push({ t: `High wind ${Math.round(wind)}km/h`, k: 'red' }); level = 'red'; }
  else if (wind >= YEL_WIND) { reasons.push({ t: `Wind ${Math.round(wind)}km/h`, k: 'yellow' }); bump('yellow'); }

  if (code >= 95) { reasons.push({ t: 'Thunderstorm', k: 'red' }); level = 'red'; }
  else if ([61, 63, 65, 80, 81, 82, 85, 86].includes(code)) { reasons.push({ t: 'Showers', k: 'yellow' }); bump('yellow'); }

  if (!reasons.length) reasons.push({ t: 'All clear', k: 'ok' });
  return { level, reasons };
}

// ---------- geocoding (Open-Meteo geocoder + Nominatim fallback; both free, no key) ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Philippine provinces (+ Metro Manila) so we can resolve town-level and province-level addresses.
const PH_PROVINCES = ['Abra','Agusan del Norte','Agusan del Sur','Aklan','Albay','Antique','Apayao','Aurora','Basilan','Bataan','Batanes','Batangas','Benguet','Biliran','Bohol','Bukidnon','Bulacan','Cagayan','Camarines Norte','Camarines Sur','Camiguin','Capiz','Catanduanes','Cavite','Cebu','Cotabato','Davao de Oro','Davao del Norte','Davao del Sur','Davao Occidental','Davao Oriental','Dinagat Islands','Eastern Samar','Guimaras','Ifugao','Ilocos Norte','Ilocos Sur','Iloilo','Isabela','Kalinga','La Union','Laguna','Lanao del Norte','Lanao del Sur','Leyte','Maguindanao','Marinduque','Masbate','Misamis Occidental','Misamis Oriental','Mountain Province','Negros Occidental','Negros Oriental','Northern Samar','Nueva Ecija','Nueva Vizcaya','Occidental Mindoro','Oriental Mindoro','Palawan','Pampanga','Pangasinan','Quezon','Quirino','Rizal','Romblon','Samar','Sarangani','Siquijor','Sorsogon','South Cotabato','Southern Leyte','Sultan Kudarat','Sulu','Surigao del Norte','Surigao del Sur','Tarlac','Tawi-Tawi','Zambales','Zamboanga del Norte','Zamboanga del Sur','Zamboanga Sibugay','Metro Manila'];

// Turn a messy PH address into geocodable candidates, most specific first.
function placeCandidates(addr) {
  let a = String(addr).replace(/\s+/g, ' ').trim();
  a = a.replace(/\bphilippines\b/ig, ' ').replace(/\b\d{4}\b/g, ' ').replace(/\s+/g, ' ').trim(); // drop "Philippines" and zip codes
  const out = [];
  const push = v => { v = String(v).replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+/g, ' ').trim(); if (v) out.push(v); };

  // "CITY OF X" -> "X City"
  const cof = a.match(/City of ([^\s,]+(?:\s+[^\s,]+){0,2})/i);
  if (cof) push(cof[1] + ' City');

  // "<words> City"
  const cityRe = /([^\s,]+(?:\s+[^\s,]+){0,2}\s+City)\b/gi;
  let last = null, mm;
  while ((mm = cityRe.exec(a))) last = mm[1];
  if (last) { const w = last.trim().split(' '); push(last); if (w.length > 2) push(w.slice(-2).join(' ')); push(last.replace(/\s+City$/i, '')); }

  // municipality + known province (and province alone as a safe fallback)
  const prov = PH_PROVINCES.find(p => new RegExp('\\b' + p.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'i').test(a));
  if (prov) {
    const idx = a.toLowerCase().indexOf(prov.toLowerCase());
    const toks = a.slice(0, idx).split(/[\s,]+/).filter(Boolean);
    if (toks.length) { push(toks.slice(-2).join(' ') + ', ' + prov); push(toks.slice(-1).join(' ') + ', ' + prov); }
    push(prov); // province-level coordinate is fine for weather
  }

  const parts = a.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length) push(parts[parts.length - 1]);
  push(a);
  return [...new Set(out)].filter(Boolean);
}

// Open-Meteo geocoder: reliable from servers, no key, no rate-limit headaches.
async function geocodeOpenMeteo(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const d = await res.json();
  const r = (d.results || []).find(x => x.country_code === 'PH') || null;
  return r ? { lat: r.latitude, lon: r.longitude } : null;
}

// Nominatim fallback for full free-form addresses.
async function geocodeNominatim(addr) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr)}&format=json&limit=1&countrycodes=ph`;
  const res = await fetch(url, { headers: { 'User-Agent': 'HonorGlobalCRM/1.0 (workforce ops; contact ops@staffhero.co)' } });
  if (!res.ok) return null;
  const hits = await res.json();
  return hits.length ? { lat: Number(hits[0].lat), lon: Number(hits[0].lon) } : null;
}

async function geocodeMissing() {
  // only geocode active people whose location text is set and whose coords are missing or stale
  const { rows } = await pool.query(`
    SELECT clickup_id, name, location
    FROM hires
    WHERE active = TRUE
      AND location IS NOT NULL AND location <> ''
      AND (latitude IS NULL OR geocoded_location IS DISTINCT FROM location)
  `);
  let okCount = 0, missCount = 0;
  for (const r of rows) {
    let hit = null;
    try {
      for (const cand of placeCandidates(r.location)) {
        hit = await geocodeOpenMeteo(cand);
        if (hit) break;
      }
    } catch (e) { console.error('[weather] open-meteo geocode error for', r.name, e.message); }

    if (!hit) {
      try { hit = await geocodeNominatim(r.location); }
      catch (e) { console.error('[weather] nominatim error for', r.name, e.message); }
      await sleep(GEOCODE_DELAY_MS); // only throttle the Nominatim fallback
    }

    if (hit) {
      await pool.query(
        `UPDATE hires SET latitude=$1, longitude=$2, geocoded_location=$3 WHERE clickup_id=$4`,
        [hit.lat, hit.lon, r.location, r.clickup_id]
      );
      okCount++;
    } else {
      missCount++;
      console.log(`[weather] geocode MISS: ${r.name} -> "${r.location}"`);
      await logEvent('weather_geocode_miss', `Could not geocode "${r.location}" for ${r.name}`, { location: r.location });
    }
  }
  console.log(`[weather] geocode pass complete: ${okCount} located, ${missCount} missed, ${rows.length} processed`);
}

// ---------- weather fetch (Open-Meteo, free, no key) ----------
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function fetchWeather(people) {
  const result = new Map(); // clickup_id -> {precip, wind, code}
  for (const group of chunk(people, 50)) {
    const lats = group.map(p => p.latitude).join(',');
    const lngs = group.map(p => p.longitude).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
                `&current=precipitation,wind_speed_10m,weather_code&timezone=Asia%2FManila`;
    try {
      const res = await fetch(url);
      let data = await res.json();
      if (!Array.isArray(data)) data = [data];
      group.forEach((p, i) => {
        const c = data[i]?.current || {};
        result.set(p.clickup_id, {
          precip: Number(c.precipitation) || 0,
          wind: Number(c.wind_speed_10m) || 0,
          code: Number(c.weather_code) || 0,
        });
      });
    } catch (e) {
      console.error('[weather] open-meteo batch failed:', e.message);
    }
  }
  return result;
}

// ---------- Slack ----------
async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    return res.ok;
  } catch (e) {
    console.error('[weather] slack post failed:', e.message);
    return false;
  }
}

function buildAlert(person, reasons, level) {
  const first = (person.name || '').split(' ')[0] || 'there';
  const detected = reasons.filter(r => r.k !== 'ok').map(r => r.t).join(', ') || 'possible disruption';
  return `:large_orange_diamond: STATUS ALERT — ${person.name} flagged ${level.toUpperCase()}\n` +
         `Location: ${person.location || 'unknown'}\n` +
         `Detected: ${detected}\n\n` +
         `Hi ${first}, the board shows possible disruption in your area. Are you able to stay online?\n` +
         `Reply: OK / DEGRADED / DOWN + expected duration.`;
}

// ---------- main check ----------
export async function runWeatherCheck() {
  if (running) return { skipped: true };
  running = true;
  try {
    await geocodeMissing();

    const { rows: people } = await pool.query(`
      SELECT h.clickup_id, h.name, h.location, h.latitude, h.longitude,
             w.level AS prev_level, w.last_ping_at
      FROM hires h
      LEFT JOIN weather_status w ON w.clickup_id = h.clickup_id
      WHERE h.active = TRUE AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL
    `);
    if (!people.length) { return { count: 0, note: 'no geocoded hires yet' }; }

    const wx = await fetchWeather(people);
    const now = new Date();
    let redCount = 0;

    for (const p of people) {
      const w = wx.get(p.clickup_id);
      if (!w) continue;
      const { level, reasons } = score(w.precip, w.wind, w.code);
      if (level === 'red') redCount++;

      // decide whether to fire a Slack ping
      let pingNow = false;
      if (level === 'red') {
        const stale = !p.last_ping_at || (now - new Date(p.last_ping_at)) > RE_PING_HOURS * 3600 * 1000;
        if (p.prev_level !== 'red' || stale) pingNow = true;
      }
      if (pingNow) {
        const ok = await postSlack(buildAlert(p, reasons, level));
        if (ok && p.prev_level !== 'red') {
          await logEvent('weather_alert', `RED: ${p.name} (${p.location}) — auto check-in sent`, { reasons });
        }
      }

      await pool.query(`
        INSERT INTO weather_status (clickup_id, level, precip_mm, wind_kph, reasons, checked_at, last_ping_at)
        VALUES ($1,$2,$3,$4,$5,now(),$6)
        ON CONFLICT (clickup_id) DO UPDATE SET
          level=EXCLUDED.level, precip_mm=EXCLUDED.precip_mm, wind_kph=EXCLUDED.wind_kph,
          reasons=EXCLUDED.reasons, checked_at=now(),
          last_ping_at=COALESCE(EXCLUDED.last_ping_at, weather_status.last_ping_at)
      `, [p.clickup_id, level, w.precip, w.wind, JSON.stringify(reasons), pingNow ? now.toISOString() : null]);
    }

    lastRun = now.toISOString(); lastCount = people.length;
    return { count: people.length, red: redCount, ranAt: lastRun };
  } catch (e) {
    console.error('[weather] check failed:', e.message);
    return { error: e.message };
  } finally {
    running = false;
  }
}

// ---------- cron starter ----------
export async function startWeatherCron() {
  try { await ensureWeatherSchema(); } catch (e) { console.error('[weather] schema error:', e.message); }
  // first pass shortly after boot, then every 15 minutes
  setTimeout(() => runWeatherCheck().catch(() => {}), 8000);
  cron.schedule('*/15 * * * *', () => runWeatherCheck().catch(() => {}));
  console.log('[weather] monitor scheduled (every 15 min)');
}

// ---------- API routes ----------
export const weatherRouter = express.Router();

// JSON the dashboard reads
weatherRouter.get('/api/weather/status', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.clickup_id, h.name, h.position, h.agency, h.location,
             h.latitude, h.longitude,
             COALESCE(w.level,'unknown') AS level,
             w.precip_mm, w.wind_kph, w.reasons, w.checked_at, w.last_ping_at
      FROM hires h
      LEFT JOIN weather_status w ON w.clickup_id = h.clickup_id
      WHERE h.active = TRUE
      ORDER BY h.name
    `);
    res.json({ hires: rows, status: weatherStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// trigger a check on demand
weatherRouter.post('/api/weather/run', async (_req, res) => {
  const r = await runWeatherCheck();
  res.json(r);
});

// manual one-person check-in
weatherRouter.post('/api/weather/ping/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.clickup_id, h.name, h.location, w.level, w.reasons
      FROM hires h LEFT JOIN weather_status w ON w.clickup_id=h.clickup_id
      WHERE h.clickup_id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const p = rows[0];
    const reasons = Array.isArray(p.reasons) ? p.reasons : [];
    const ok = await postSlack(buildAlert(p, reasons, p.level || 'yellow'));
    if (ok) await pool.query(`UPDATE weather_status SET last_ping_at=now() WHERE clickup_id=$1`, [req.params.id]);
    res.json({ sent: ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// the board page
weatherRouter.get('/weather', (_req, res) => res.sendFile(join(__dirname, 'weather-board.html')));
