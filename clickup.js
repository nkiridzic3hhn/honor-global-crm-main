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

// Location source: ClickUp "PA: Address" field (id below). Override via CLICKUP_LOCATION_FIELD_ID if needed.
const LOCATION_FIELD_ID = process.env.CLICKUP_LOCATION_FIELD_ID || '056719ce-31fb-4e5e-8433-3b931db78798'; // PA: Address

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

// NEW: read the location field, whether it's a dropdown or a plain text field
function locationLabel(task) {
  if (!LOCATION_FIELD_ID) return '';
  const f = getField(task, LOCATION_FIELD_ID);
  if (!f || f.value == null) return '';
  const dd = dropdownLabel(f);                 // dropdown field
  if (dd) return dd;
  return typeof f.value === 'string' ? f.value.trim() : String(f.value); // text field
}

function mapTask(task) {
  const rate = getField(task, FIELD.payRate);
  return {
    clickup_id: task.id,
    name: task.name,
    status: task.status?.status || '',
    location:   locationLabel(task),
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
  // We want everyone who APPEARS IN the primary list's view — that includes
  // tasks whose home is the primary list, plus tasks linked in from other lists
  // (ClickUp "tasks in multiple lists"). The /list/{id}/task endpoint only
  // returns home-list tasks, so we also scan extra lists and keep a task only
  // if the primary list shows up in its `locations`.
  //
  // CLICKUP_LIST_ID = primary list (the one whose view you trust, e.g. Masterlist)
  // CLICKUP_EXTRA_LIST_IDS = comma-separated other lists to scan for linked tasks
  const primary = String(listId || process.env.CLICKUP_LIST_ID || '').trim();
  if (!primary) throw new Error('CLICKUP_LIST_ID is not set');
  const extras = String(process.env.CLICKUP_EXTRA_LIST_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  async function pull(id) {
    const out = [];
    let page = 0;
    while (page < 60) {
      const url = new URL(`${CLICKUP_API}/list/${id}/task`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('subtasks', 'true');
      url.searchParams.set('include_closed', 'true');
      url.searchParams.set('archived', 'false');
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`ClickUp ${res.status} (list ${id}): ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const tasks = data.tasks || [];
      out.push(...tasks);
      if (data.last_page || tasks.length === 0) break;
      page++;
    }
    return out;
  }

  // Does this task appear in the primary list? (home list OR a linked location)
  function inPrimary(t) {
    if (t.list?.id === primary) return true;
    if (Array.isArray(t.locations) && t.locations.some(l => l.id === primary)) return true;
    return false;
  }

  const byId = new Map();

  // Primary list: keep all its tasks.
  for (const t of await pull(primary)) byId.set(t.id, t);

  // Extra lists: keep ONLY tasks that are also linked into the primary list.
  for (const id of extras) {
    for (const t of await pull(id)) {
      if (!byId.has(t.id) && inPrimary(t)) byId.set(t.id, t);
    }
  }

  const active = [];
  for (const t of byId.values()) {
    const status = (t.status?.status || '').toLowerCase();
    if (status !== ACTIVE_STATUS) continue;
    active.push(mapTask(t));
  }
  return active;
}

export { FIELD, ACTIVE_STATUS };
