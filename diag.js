// diag.js — diagnostics to find where the headcount gap comes from.
// Tries several ClickUp fetch strategies and reports counts for each,
// so we can see which one reaches the true total (your 113).

const API = 'https://api.clickup.com/api/v2';
const ACTIVE = (process.env.ACTIVE_STATUS || 'stage 8: hired - active').toLowerCase();

function headers() {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) throw new Error('CLICKUP_TOKEN not set');
  return { Authorization: token };
}

// Strategy A: list endpoint, subtasks=true (what we ship now).
async function listEndpoint(listId, extra = {}) {
  const all = []; let page = 0;
  while (page < 60) {
    const u = new URL(`${API}/list/${listId}/task`);
    u.searchParams.set('page', String(page));
    u.searchParams.set('subtasks', 'true');
    u.searchParams.set('include_closed', 'true');
    u.searchParams.set('archived', 'false');
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    const r = await fetch(u, { headers: headers() });
    if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).slice(0,200)}`);
    const d = await r.json();
    const t = d.tasks || [];
    all.push(...t);
    if (d.last_page || t.length === 0) break;
    page++;
  }
  return all;
}

// Strategy B: team (workspace) filtered endpoint, which paginates subtasks better.
async function teamEndpoint(teamId, listId) {
  const all = []; let page = 0;
  while (page < 60) {
    const u = new URL(`${API}/team/${teamId}/task`);
    u.searchParams.set('page', String(page));
    u.searchParams.set('subtasks', 'true');
    u.searchParams.set('include_closed', 'true');
    u.searchParams.append('list_ids[]', listId);
    const r = await fetch(u, { headers: headers() });
    if (!r.ok) throw new Error(`team ${r.status}: ${(await r.text()).slice(0,200)}`);
    const d = await r.json();
    const t = d.tasks || [];
    all.push(...t);
    if (d.last_page || t.length === 0) break;
    page++;
  }
  return all;
}

function summarize(tasks) {
  const stage8 = tasks.filter(t => (t.status?.status || '').toLowerCase() === ACTIVE);
  const subs = stage8.filter(t => t.parent);
  const uniq = new Set(stage8.map(t => t.id));
  // status breakdown
  const byStatus = {};
  for (const t of tasks) { const s = t.status?.status || '?'; byStatus[s] = (byStatus[s]||0)+1; }
  return {
    raw_total: tasks.length,
    stage8_total: stage8.length,
    stage8_unique: uniq.size,
    stage8_subtasks: subs.length,
    stage8_parents: stage8.length - subs.length,
    status_breakdown: byStatus,
  };
}

export async function runDiagnostics() {
  const listId = process.env.CLICKUP_LIST_ID;
  const teamId = process.env.CLICKUP_TEAM_ID || '90161515120'; // workspace id default
  const out = { listId, teamId: teamId || '(not set)' };

  try {
    const a = await listEndpoint(listId);
    out.strategyA_list = summarize(a);
  } catch (e) { out.strategyA_list = { error: e.message }; }

  // also try list endpoint WITHOUT include_closed to compare
  try {
    const a2 = await listEndpoint(listId, { include_closed: 'false' });
    out.strategyA_no_closed = summarize(a2);
  } catch (e) { out.strategyA_no_closed = { error: e.message }; }

  if (teamId) {
    try {
      const b = await teamEndpoint(teamId, listId);
      out.strategyB_team = summarize(b);
    } catch (e) { out.strategyB_team = { error: e.message }; }
  }

  return out;
}
