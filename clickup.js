// clickup.js — direct ClickUp REST client. Pulls ALL stage-8 people incl. subtasks.
const CLICKUP_API = 'https://api.clickup.com/api/v2';

const FIELD = {
  payRate:   '7f329dab-1e98-4e6a-980a-66aeb8fddf0e',
  startDate: '131c60e8-8838-431b-ab6e-1ef4778b2db2',
  supervisor:'15288916-23e5-4087-96be-fd79bc6afc4e',
  agency:    '96706edc-b763-4f82-882f-232d0905e25e',
  position:  'cc650c28-67ae-4759-b203-772350af743a',
  roleType:  '452cf9ba-3e5d-4c4b-be83-e9f4cbd1208f',
};

const ACTIVE_STATUS = (process.env.ACTIVE_STATUS || 'stage 8: hired - active').toLowerCase();

function headers() {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) throw new Error('CLICKUP_TOKEN is not set');
  return { Authorization: token, 'Content-Type': 'application/json' };
}

function dropdownLabel(field) {
  if (!field || field.value === undefined || field.value === null) return '';
  const opts = field.type_config?.options || [];
  let opt = null;
  if (typeof field.value === 'number') opt = opts[field.value];
  if (!opt) opt = opts.find(o => o.id === field.value);
  if (!opt) opt = opts.find(o => String(o.orderindex) === String(field.value));
  return opt ? (opt.name ?? opt.label ?? '') : '';
}
function getField(task, id) { return (task.custom_fields || []).find(f => f.id === id); }

function mapTask(task) {
  const rate = getField(task, FIELD.payRate);
  return {
    clickup_id: task.id,
    name: task.name,
    status: task.status?.status || '',
    position:   dropdownLabel(getField(task, FIELD.position)),
    supervisor: dropdownLabel(getField(task, FIELD.supervisor)),
    agency:     dropdownLabel(getField(task, FIELD.agency)),
    role_type:  dropdownLabel(getField(task, FIELD.roleType)),
    pay_rate:   rate && rate.value != null ? Number(rate.value) : 0,
    start_date: getField(task, FIELD.startDate)?.value || '',
    is_subtask: !!task.parent,
  };
}

export async function fetchActiveRoster(listId) {
  const id = listId || process.env.CLICKUP_LIST_ID;
  if (!id) throw new Error('CLICKUP_LIST_ID is not set');
  const all = [];
  let page = 0;
  while (page < 50) {
    const url = new URL(`${CLICKUP_API}/list/${id}/task`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('subtasks', 'true');
    url.searchParams.set('include_closed', 'true');
    url.searchParams.set('archived', 'false');
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ClickUp ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const tasks = data.tasks || [];
    all.push(...tasks);
    if (data.last_page || tasks.length === 0) break;
    page++;
  }
  const seen = new Set(); const active = [];
  for (const t of all) {
    const status = (t.status?.status || '').toLowerCase();
    if (status !== ACTIVE_STATUS) continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    active.push(mapTask(t));
  }
  return active;
}
export { FIELD, ACTIVE_STATUS };
