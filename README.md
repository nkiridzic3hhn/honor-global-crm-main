# Honor Global — Workforce Cost & Savings Dashboard

Live dashboard that reads your active roster directly from ClickUp, lets you
classify hires into savings buckets, and tracks weekly payroll.

All files sit FLAT in one folder on purpose, so GitHub's drag-and-drop upload
keeps them working (no subfolders to lose).

## Files
- `index.js` — server entry (run this)
- `api.js` — API routes
- `clickup.js` — reads ClickUp directly (all stage-8 people, incl. subtasks)
- `sync.js` — syncs ClickUp into the database
- `migrate.js` — creates database tables
- `pool.js` — database connection
- `dashboard.html` — the dashboard UI
- `package.json`, `railway.json` — config
- `env.example` — list of variables to set in Railway

## Deploy on Railway

1. Put these files in a GitHub repo (drag them all into the uploader — flat is fine).

2. **Rename two files in GitHub after upload** (GitHub hides dot-files, so they
   were uploaded without the dot):
   - `env.example` is just a reference — you don't need to rename it. Leave it.
   - If you uploaded a gitignore, name it `.gitignore` (optional, not required to run).

3. Railway → New Project → Deploy from GitHub repo → pick this repo.

4. Railway → New → Database → **Add PostgreSQL** (auto-sets `DATABASE_URL`).

5. Railway → your service → **Variables**, add:
   - `CLICKUP_TOKEN` = your ClickUp API token (ClickUp: avatar → Settings → Apps → API Token; starts with `pk_`)
   - `CLICKUP_LIST_ID` = `901614819715`
   - `ACTIVE_STATUS` = `stage 8: hired - active`

6. Deploy. First boot creates tables and runs the first sync. Open the URL.

## Updating
- Auto-syncs every 5 minutes, and on page load if data is stale.
- People removed/terminated in ClickUp drop off automatically.

## Payroll parser
`api.js` → `COL_NAME / COL_AMOUNT / COL_NOTES` control how uploaded Excel/CSV
columns are detected. Share finance's real file to lock these to her headers.

## Note on access
The site is public to anyone with the URL by default. Ask if you want a login added.
