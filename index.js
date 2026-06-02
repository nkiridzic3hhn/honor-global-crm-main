// index.js — server entry. All files live flat in this one directory.
import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import api from './api.js';
import { migrate } from './migrate.js';
import { runSync, syncStatus } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api', api);

// Sync-on-load if stale (the "both" strategy, part 1).
app.use(async (req, res, next) => {
  if (req.path === '/') {
    const { lastSync } = syncStatus();
    const stale = !lastSync || (Date.now() - new Date(lastSync).getTime() > 120000);
    if (stale) runSync().catch(() => {});
  }
  next();
});

// Serve the dashboard (dashboard.html sits next to this file).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

async function boot() {
  await migrate();
  await runSync().catch(e => console.error('[boot sync]', e.message));
  cron.schedule('*/5 * * * *', () => runSync().catch(() => {})); // scheduled refresh (part 2)
  app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
}
boot();
