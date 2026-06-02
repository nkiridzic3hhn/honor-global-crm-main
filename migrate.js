// migrate.js — creates tables if they don't exist. Safe to run repeatedly.
import { pool } from './pool.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hires (
  clickup_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  position     TEXT,
  supervisor   TEXT,
  agency       TEXT,
  role_type    TEXT,
  pay_rate     NUMERIC DEFAULT 0,
  start_date   TEXT,
  is_subtask   BOOLEAN DEFAULT FALSE,
  active       BOOLEAN DEFAULT TRUE,
  last_synced  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classifications (
  clickup_id          TEXT PRIMARY KEY REFERENCES hires(clickup_id) ON DELETE CASCADE,
  bucket              TEXT NOT NULL DEFAULT 'pending',
  replacing_who       TEXT,
  replaced_who        TEXT,
  replaced_annual_cost NUMERIC,
  hourly_saving       NUMERIC,
  annual_saving       NUMERIC,
  notes               TEXT,
  kpis                TEXT,
  role_description    TEXT,
  updated_at          TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payroll_weeks (
  id            SERIAL PRIMARY KEY,
  period        TEXT UNIQUE,
  week_ending   DATE,
  total         NUMERIC NOT NULL DEFAULT 0,
  items         JSONB NOT NULL DEFAULT '[]',
  agency_totals JSONB NOT NULL DEFAULT '[]',
  notes         TEXT,
  posted_at     TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  id              INT PRIMARY KEY DEFAULT 1,
  hours_per_week  NUMERIC DEFAULT 40,
  days_per_week   NUMERIC DEFAULT 5,
  weeks_per_year  NUMERIC DEFAULT 52,
  CHECK (id = 1)
);
CREATE TABLE IF NOT EXISTS domestic_payroll (
  id            SERIAL PRIMARY KEY,
  period        TEXT NOT NULL,
  agency        TEXT NOT NULL DEFAULT '(all)',
  week_ending   DATE,
  total         NUMERIC NOT NULL DEFAULT 0,
  headcount     INTEGER,
  notes         TEXT,
  posted_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE(period, agency)
);
CREATE TABLE IF NOT EXISTS activity_log (
  id        SERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ DEFAULT now(),
  type      TEXT NOT NULL,
  message   TEXT NOT NULL,
  detail    JSONB
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE classifications ADD COLUMN IF NOT EXISTS kpis TEXT;
ALTER TABLE classifications ADD COLUMN IF NOT EXISTS role_description TEXT;
ALTER TABLE payroll_weeks ADD COLUMN IF NOT EXISTS period TEXT;
ALTER TABLE payroll_weeks ADD COLUMN IF NOT EXISTS agency_totals JSONB NOT NULL DEFAULT '[]';
ALTER TABLE payroll_weeks ALTER COLUMN week_ending DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payroll_weeks_period_key') THEN
    BEGIN ALTER TABLE payroll_weeks ADD CONSTRAINT payroll_weeks_period_key UNIQUE (period); EXCEPTION WHEN others THEN NULL; END;
  END IF;
END $$;
`;

export async function migrate() {
  await pool.query(SCHEMA);
  console.log('[db] schema ready');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
