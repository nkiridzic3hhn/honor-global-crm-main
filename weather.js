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
const GEOCODE_VERSION = (process.env.GEOCODER_API_KEY ? 100 : 0) + 10; // street-level when a geocoder key is set, town-level otherwise; either change forces a re-geocode

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

  // One-time full re-geocode whenever the geocoding logic version changes.
  // This clears stale/wrong coordinates so every active hire is recomputed with the latest logic.
  await pool.query(`CREATE TABLE IF NOT EXISTS weather_meta (key TEXT PRIMARY KEY, value TEXT);`);
  const { rows } = await pool.query(`SELECT value FROM weather_meta WHERE key='geocode_version'`);
  const stored = rows.length ? Number(rows[0].value) : 0;
  if (stored !== GEOCODE_VERSION) {
    const r = await pool.query(`UPDATE hires SET latitude=NULL, longitude=NULL, geocoded_location=NULL WHERE latitude IS NOT NULL`);
    await pool.query(`INSERT INTO weather_meta (key,value) VALUES ('geocode_version',$1)
                      ON CONFLICT (key) DO UPDATE SET value=$1`, [String(GEOCODE_VERSION)]);
    console.log(`[weather] geocode logic v${GEOCODE_VERSION}: cleared ${r.rowCount} stale coordinate(s); all hires will re-geocode on the next pass`);
  }
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
const PH_CITIES = ['Makati','Mandaluyong','Marikina','Muntinlupa','Pasig','Pasay','Taguig','Caloocan','Valenzuela','Manila','Bacoor','Dasmarinas','Antipolo','Cainta','Taytay','Binan','Calamba','Santa Rosa','Cabuyao','Bacolod','Iloilo','Davao','Cagayan de Oro','Zamboanga','General Santos','Baguio','Angeles','Las Pi\u00f1as','Para\u00f1aque'];
// Well-known barangays / subdivisions that are usually written WITHOUT their city.
const GEO_HINTS = { 'bajada': 'Davao City', 'bago gallera': 'Davao City', 'matina': 'Davao City', 'lanang': 'Davao City', 'bf homes': 'Las Pi\u00f1as', 'bf international': 'Las Pi\u00f1as' };
const GEO_STOP = new Set(['blk','block','lot','brgy','barangay','purok','sitio','zone','phase','ph','unit','bldg','st','street','ave','avenue','rd','road','blvd','subd','subdivision','village','homes','residences','tower','no','door','floor','flr','rm','room','pob','poblacion']);
const escRe = s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
const cleanStr = v => String(v).replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+/g, ' ').trim();

// Build candidates from a messy PH address.
// names[] = bare place names for Open-Meteo; addrs[] = richer strings for Nominatim.
function placeCandidates(addr) {
  let a = String(addr).replace(/\s+/g, ' ').trim();
  a = a.replace(/\bCDO\b/ig, 'Cagayan de Oro').replace(/\bGen\.?\s?San\b/ig, 'General Santos').replace(/\bBGC\b/ig, 'Taguig').replace(/\bQ\.?\s?C\.?\b/ig, 'Quezon City');
  a = a.replace(/\bphilippines\b/ig, ' ').replace(/\b\d{4,}\b/g, ' ').replace(/\s+/g, ' ').trim();
  const names = [], addrs = [];
  const addName = v => { v = cleanStr(v); if (v && !names.includes(v)) names.push(v); };
  const addAddr = v => { v = cleanStr(v); if (v && !addrs.includes(v)) addrs.push(v); };

  for (const c of PH_CITIES) { if (new RegExp('\\b' + escRe(c) + '\\b', 'i').test(a)) { addName(c); break; } }

  const al = a.toLowerCase();
  for (const k in GEO_HINTS) { if (al.includes(k)) { addName(GEO_HINTS[k]); break; } }


  const cof = a.match(/City of ([^\s,]+(?:\s+[^\s,]+){0,2})/i);
  if (cof) { addName(cof[1] + ' City'); addName(cof[1]); }

  const cityRe = /([^\s,]+(?:\s+[^\s,]+){0,2}\s+City)\b/gi;
  let last = null, mm;
  while ((mm = cityRe.exec(a))) last = mm[1];
  if (last) {
    const c = cleanStr(last), w = c.split(' ');
    addName(c);
    if (w.length > 2) addName(w.slice(-2).join(' '));
    addName(c.replace(/\s+City$/i, ''));
    if (w.length > 2) addName(w.slice(-2).join(' ').replace(/\s+City$/i, ''));
  }

  const prov = PH_PROVINCES.find(p => new RegExp('\\b' + escRe(p) + '\\b', 'i').test(a));
  if (prov) {
    const idx = a.toLowerCase().indexOf(prov.toLowerCase());
    const toks = a.slice(0, idx).split(/[\s,]+/).filter(t => t && !/\d/.test(t) && !GEO_STOP.has(t.toLowerCase().replace(/\.$/, '')));
    const m1 = toks.slice(-1).join(' '), m2 = toks.slice(-2).join(' ');
    if (m2 && m2 !== m1) addName(m2);
    if (m1) addName(m1);
    if (m2 && m2 !== m1) addAddr(m2 + ', ' + prov);
    if (m1) addAddr(m1 + ', ' + prov);
    addName(prov);
    addAddr(prov);
  }

  addAddr(a);
  return { names, addrs };
}

// Open-Meteo geocoder: reliable from servers, no key. Expects a plain place NAME.
async function geocodeOpenMeteo(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const d = await res.json();
  const ph = (d.results || []).filter(x => x.country_code === 'PH');
  // Prefer populated places (P*) or admin areas (A*); never accept water features (GeoNames H*).
  const r = ph.find(x => /^[PA]/.test(x.feature_code || '')) || ph.find(x => !/^H/.test(x.feature_code || '')) || null;
  return r ? { lat: r.latitude, lon: r.longitude } : null;
}

// Nominatim fallback: handles "town, province" and full free-form addresses.
async function geocodeNominatim(q) {
  const query = /philippines/i.test(q) ? q : q + ', Philippines';
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&countrycodes=ph`;
  const res = await fetch(url, { headers: { 'User-Agent': 'HonorGlobalCRM/1.0 (workforce ops; contact ops@staffhero.co)' } });
  if (!res.ok) return null;
  const hits = await res.json();
  // Never accept sea/bay/coast features, nor country/region centroids (e.g. "Philippines").
  const isBad = h =>
    h.class === 'water' ||
    (h.class === 'natural' && /^(water|bay|sea|strait|cape|reef|shoal|spring|beach|peak|wetland)$/i.test(h.type || '')) ||
    h.addresstype === 'country' || h.type === 'country' ||
    (h.place_rank != null && Number(h.place_rank) <= 6);
  const good = (hits || []).find(h => !isBad(h));
  return good ? { lat: Number(good.lat), lon: Number(good.lon) } : null;
}

// LocationIQ: full street-address geocoder (needs a free API key in GEOCODER_API_KEY).
// This is what places each person at their actual street, not just the city centre.
const GEOCODER_KEY = process.env.GEOCODER_API_KEY || '';
const LIQ_DELAY_MS = 700; // free tier allows ~2 req/sec; stay well under
async function geocodeLocationIQ(addr) {
  if (!GEOCODER_KEY) return null;
  const q = /philippines/i.test(addr) ? addr : addr + ', Philippines';
  const url = `https://us1.locationiq.com/v1/search?key=${GEOCODER_KEY}&q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=ph&normalizecity=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'HonorGlobalCRM/1.0 (ops@staffhero.co)' } });
  if (!res.ok) return null;
  const hits = await res.json();
  if (!Array.isArray(hits) || !hits.length) return null;
  const h = hits[0];
  if (h.class === 'water' || h.type === 'country' || h.addresstype === 'country') return null;
  return { lat: Number(h.lat), lon: Number(h.lon) };
}

// Photon (komoot): free, keyless, OpenStreetMap-based street-level geocoder.
// Reads the full address and returns a precise point. Locked to a Philippines bounding box.
const PHOTON_DELAY_MS = 300;
async function geocodePhoton(addr) {
  // Try cleaned "barangay, district, city" queries first (resolve to the real part of town),
  // then the raw address as a last attempt.
  const tries = [];
  for (const q of barangayQueries(addr)) if (q) tries.push(q);
  const raw = String(addr).replace(/\s+/g, ' ').trim();
  if (raw && !tries.includes(raw)) tries.push(raw);
  for (const q of tries.slice(0, 3)) {
    let res;
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&lang=en&bbox=116.9,4.6,126.6,21.2`;
      res = await fetch(url, { headers: { 'User-Agent': 'HonorGlobalCRM/1.0 (ops@staffhero.co)' } });
    } catch (e) { continue; }
    if (!res.ok) continue;
    let d; try { d = await res.json(); } catch (e) { continue; }
    const f = (d.features || [])[0];
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) continue;
    const p = f.properties || {};
    if (/^(country|state|sea|ocean|water)$/i.test(p.type || '')) continue;
    if (p.countrycode && String(p.countrycode).toUpperCase() !== 'PH') continue;
    const [lon, lat] = f.geometry.coordinates;
    if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon };
  }
  return null;
}

// Addresses clearly outside the Philippines must never be force-placed on a PH map.
const FOREIGN_COUNTRIES = new Set(['armenia','peru','colombia','argentina','mexico','brazil','brasil','chile','venezuela','ecuador','bolivia','paraguay','uruguay','guatemala','honduras','nicaragua','el salvador','costa rica','panama','dominican republic','cuba','jamaica','egypt','morocco','nigeria','ghana','kenya','uganda','tanzania','south africa','india','pakistan','bangladesh','nepal','sri lanka','indonesia','malaysia','thailand','vietnam','cambodia','china','japan','south korea','korea','taiwan','united states','usa','u.s.a','u.s','canada','united kingdom','uk','ireland','australia','new zealand','spain','portugal','france','germany','netherlands','belgium','italy','greece','turkey','russia','ukraine','poland','romania','georgia','azerbaijan','kazakhstan','iran','iraq','israel','palestine','lebanon','syria','jordan','saudi arabia','united arab emirates','uae','qatar','kuwait','bahrain','oman','yemen','afghanistan']);
function isForeign(addr) {
  if (!addr) return false;
  const segs = String(addr).split(',').map(x => x.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
  if (!segs.length) return false;
  const tail = segs.slice(-2);
  if (tail.includes('philippines') || tail.includes('ph')) return false;
  return tail.some(x => FOREIGN_COUNTRIES.has(x));
}

// Build barangay/district-level lookup queries from a full address, most specific first.
// e.g. "Duplex 1, Kahayahay 2, Brgy. San Jose, Talamban, Cebu City"
//   -> ["San Jose, Talamban, Cebu City", "Talamban, Cebu City", "Cebu City"]
// This lets the geocoder place people at their actual part of town, not just the city centre.
function barangayQueries(addr) {
  addr = String(addr).replace(/\bCDO\b/ig, 'Cagayan de Oro').replace(/\bGen\.?\s?San\b/ig, 'General Santos').replace(/\bBGC\b/ig, 'Taguig').replace(/\bQ\.?\s?C\.?\b/ig, 'Quezon City');
  let segs = addr.split(',').map(s => s.replace(/\b\d{4,}\b/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const UNIT = /^(unit|units|blk|block|lot|lots|duplex|bldg|building|phase|flr|floor|rm|room|door|apt|apartment|house|hse|no|number|#)\b/i;
  let meaningful = segs.filter(s => !/^\d/.test(s) && !UNIT.test(s));
  if (!meaningful.length) meaningful = segs;
  meaningful = meaningful.map(s => s.replace(/^(brgy\.?|barangay)\s+/i, '').trim()).filter(Boolean);
  // Never query country-level / generic terms — they resolve to the country centroid (in the sea).
  const GENERIC = /^(philippines|phil\.?|ph|pilipinas|republic of the philippines)$/i;
  meaningful = meaningful.filter(s => !GENERIC.test(s));
  const out = [];
  const push = a => { const q = a.join(', '); if (q && !out.includes(q)) out.push(q); };
  const n = meaningful.length;
  if (n >= 3) push(meaningful.slice(-3));
  if (n >= 2) push(meaningful.slice(-2));
  if (n >= 1) push(meaningful.slice(-1));
  return out.slice(0, 3);
}

async function geocodeMissing() {
  // First, clear any coordinates previously (wrongly) assigned to addresses outside the Philippines.
  const placed = await pool.query(`SELECT clickup_id, name, location FROM hires WHERE active = TRUE AND location IS NOT NULL AND location <> '' AND latitude IS NOT NULL`);
  let cleared = 0;
  for (const r of placed.rows) {
    if (isForeign(r.location)) {
      await pool.query(`UPDATE hires SET latitude=NULL, longitude=NULL, geocoded_location=NULL WHERE clickup_id=$1`, [r.clickup_id]);
      cleared++;
      console.log(`[weather] cleared off-map placement (outside PH): ${r.name} | ${r.location}`);
    }
  }

  const { rows } = await pool.query(`
    SELECT clickup_id, name, location
    FROM hires
    WHERE active = TRUE
      AND location IS NOT NULL AND location <> ''
      AND (latitude IS NULL OR geocoded_location IS DISTINCT FROM location)
  `);
  let okCount = 0, missCount = 0;
  let foreignCount = 0;
  for (const r of rows) {
    if (isForeign(r.location)) {
      foreignCount++;
      console.log(`[weather] skip (outside PH): ${r.name} | ${r.location}`);
      continue;
    }
    const { names } = placeCandidates(r.location);
    let hit = null;
    // 1) Best: paid key (LocationIQ) -> exact street address.
    if (GEOCODER_KEY) {
      try { hit = await geocodeLocationIQ(r.location); } catch (e) { console.error('[weather] locationiq err', e.message); }
      await sleep(LIQ_DELAY_MS);
    }
    // 2) Free street-level lookup via Photon, constrained to the Philippines.
    if (!hit) {
      try { hit = await geocodePhoton(r.location); } catch (e) { console.error('[weather] photon err', e.message); }
      await sleep(PHOTON_DELAY_MS);
    }
    // 3) Last resort: town/city centre via Open-Meteo.
    if (!hit) {
      for (const n of names) {
        try { hit = await geocodeOpenMeteo(n); } catch (e) { console.error('[weather] open-meteo err', e.message); }
        if (hit) break;
      }
    }
    if (hit) {
      await pool.query(`UPDATE hires SET latitude=$1, longitude=$2, geocoded_location=$3 WHERE clickup_id=$4`, [hit.lat, hit.lon, r.location, r.clickup_id]);
      okCount++;
    } else {
      missCount++;
      console.log(`[weather] geocode MISS: ${r.name} | names=[${names.join(' | ')}] tried=[${barangayQueries(r.location).join(' | ')}]`);
      await logEvent('weather_geocode_miss', `Could not geocode "${r.location}" for ${r.name}`, { location: r.location });
    }
  }
  console.log(`[weather] geocode pass complete: ${okCount} located, ${missCount} missed, ${foreignCount} outside PH, ${cleared} cleared, ${rows.length} processed`);
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
