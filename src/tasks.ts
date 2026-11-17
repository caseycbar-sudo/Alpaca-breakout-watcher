// A shared queue of project proposals and accepted work, never a trading engine.
import { type Actor, type Env, HubError, requireScope } from './util';

export const TASK_STATES = ['proposed','ready','in_progress','blocked','review','done','canceled'] as const;
export const TASK_ACTIONS = ['accept','start','progress','block','submit','complete','rework','handoff','cancel'] as const;
export const PEOPLE = ['casey','chatgpt','claude','grok'] as const;
type Status = typeof TASK_STATES[number];
export interface Task {
  id: number; project: string; title: string; description: string; acceptance: string;
  owner_id: string; reviewer_id: string; priority: string; status: Status;
  next_action: string; blocker: string; evidence: string; dependencies: string;
  created_by: string; created_at: number; updated_at: number; version: number; idem_key?: string;
}
function bad(message: string): never { throw new HubError(400,'bad_task',message); }
function text(value: unknown, name: string, max: number, required = false): string {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') bad(`${name} must be text.`);
  const result = (value as string).trim();
  if (result.length > max || (required && !result)) bad(`${name} needs ${required ? '1' : '0'}–${max} characters.`);
  return result;
}
function person(value: unknown, name: string): string {
  const id = text(value,name,60);
  if (id && !(PEOPLE as readonly string[]).includes(id)) bad(`Choose Casey, ChatGPT, Claude or Grok for ${name}.`);
  return id;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) bad(`${name} must be a positive whole number.`);
  return value as number;
}
function out(row: Task) {
  const { idem_key: _, dependencies, ...rest } = row;
  return { ...rest, dependencies: JSON.parse(dependencies) as number[], assignment_confirmed: !['proposed','canceled'].includes(row.status), stale: !['done','canceled'].includes(row.status) && Date.now()-row.updated_at > 24*3600000 };
}
async function row(env: Env, id: number): Promise<Task> {
  const r = await env.DB.prepare('SELECT * FROM tasks WHERE id=?1').bind(id).first<Task>();
  if (!r) throw new HubError(404,'no_such_task','That task does not exist.');
  return r;
}
export async function getTask(env: Env, actor: Actor, id: number) {
  requireScope(actor,'hub:read');
  const task = await row(env,integer(id,'Task id'));
  const events = await env.DB.prepare('SELECT version,actor_id,actor_name,at,action,detail FROM task_events WHERE task_id=?1 ORDER BY version').bind(id).all();
  return { task: out(task), history: events.results };
}
export async function listTasks(env: Env, actor: Actor, opts: { owner_id?: string; status?: string; after_id?: number; limit?: number } = {}) {
  requireScope(actor,'hub:read');
  const owner = opts.owner_id === undefined ? null : person(opts.owner_id,'owner');
  const status = opts.status ?? 'active';
  if (!['all','active',...TASK_STATES].includes(status)) bad('Unknown task status.');
  const after = opts.after_id === undefined ? 0 : integer(opts.after_id,'Cursor');
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Limit must be 1–100.');
  const result = await env.DB.prepare(`SELECT * FROM tasks WHERE id>?1 AND (?2 IS NULL OR owner_id=?2)
    AND (?3='all' OR (?3='active' AND status NOT IN ('done','canceled')) OR status=?3) ORDER BY id LIMIT ?4`)
    .bind(after,owner,status,limit+1).all<Task>();
  const more = result.results.length > limit;
  const tasks = result.results.slice(0,limit).map(out);
  const counts = await env.DB.prepare('SELECT status,COUNT(*) AS count FROM tasks GROUP BY status').all<{status: string; count: number}>();
  return { tasks, has_more: more, next_after_id: more ? tasks[tasks.length-1].id : null, counts: Object.fromEntries(counts.results.map(r=>[r.status,r.count])), execution: 'Agents work when their sessions run. Assigning a task neither wakes an agent nor authorizes external actions.' };
}
export async function createTask(env: Env, actor: Actor, input: Record<string,unknown>) {
  requireScope(actor,'hub:log');
  const idem = text(input.idempotency_key,'Retry key',200,true);
  const key = `${actor.id}:${idem}`;
  const existing = await env.DB.prepare('SELECT * FROM tasks WHERE idem_key=?1').bind(key).first<Task>();
  if (existing) return { task: out(existing), created: false };
  const owner = person(input.owner_id,'owner'), reviewer = person(input.reviewer_id,'reviewer');
  if ((owner && reviewer === owner) || (owner === 'casey' && !reviewer)) bad('Choose a reviewer other than the worker. Casey’s own tasks need an assigned agent reviewer.');
  const priority = input.priority ?? 'normal';
  if (!['high','normal','low'].includes(String(priority))) bad('Priority must be high, normal or low.');
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 20) bad('Use at most 20 dependency ids.');
  for (const id of dependencies as unknown[]) await row(env,integer(id,'Dependency'));
  const values = [text(input.project ?? 'Hub improvements','Project',120,true),text(input.title,'Title',180,true),text(input.description,'Description',4000,true),text(input.acceptance,'Acceptance criteria',2000,true),owner,reviewer,String(priority),owner === actor.id ? 'ready' : 'proposed',text(input.next_action,'Next action',1000,true),JSON.stringify([...new Set(dependencies as number[])]),actor.id,Date.now(),key];
  // Creation + audit are atomic; the unique retry key also protects concurrent retries.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO tasks(project,title,description,acceptance,owner_id,reviewer_id,priority,status,next_action,dependencies,created_by,created_at,updated_at,idem_key)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13) ON CONFLICT(idem_key) DO NOTHING`).bind(...values),
    env.DB.prepare(`INSERT INTO task_events(task_id,version,actor_id,actor_name,at,action,detail)
    SELECT id,1,?2,?3,created_at,'created',?4 FROM tasks WHERE idem_key=?1 ON CONFLICT(task_id,version) DO NOTHING`).bind(key,actor.id,actor.name,'Project assignment; not authorization for external actions.'),
  ]);
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE idem_key=?1').bind(key).first<Task>();
  return { task: out(task!), created: result[0].meta.changes > 0 };
}
export async function updateTask(env: Env, actor: Actor, input: Record<string,unknown>) {
  requireScope(actor,'hub:log');
  const id = integer(input.id,'Task id');
  const expected = integer(input.expected_version,'Expected version');
  const task = await row(env,id);
  if (task.version !== expected) throw new HubError(409,'task_changed','Someone updated this task. Read it again before changing it.');
  const action = text(input.action,'Action',30,true);
  if (!(TASK_ACTIONS as readonly string[]).includes(action)) bad('Unknown task action.');
  const note = text(input.note,'Progress or review note',2000,true);
  let owner = task.owner_id, status = task.status, next = task.next_action, blocker = task.blocker, evidence = task.evidence;
  const worker = actor.id === owner;
  const ownerOverride = actor.kind === 'owner';
  const reviewer = actor.id !== owner && (ownerOverride || (!!task.reviewer_id && actor.id === task.reviewer_id));
  if (['done','canceled'].includes(status)) throw new HubError(409,'task_closed','This task is closed. Create a follow-up linked to it.');
  if (action === 'accept') {
    if (status !== 'proposed' || (owner && !worker)) throw new HubError(403,'not_assignee','Only the proposed worker can accept this task.');
    if (actor.id === task.reviewer_id || (actor.kind === 'owner' && !task.reviewer_id)) bad('The worker needs an independent assigned reviewer.');
    owner = actor.id; status = 'ready';
  } else if (action === 'complete' || action === 'rework') {
    if (!reviewer) throw new HubError(403,'not_reviewer','Only the assigned independent reviewer or Casey can review this work.');
    if (status !== 'review') throw new HubError(409,'not_in_review','Submit evidence for review first.');
    if (action === 'complete' && !evidence) bad('Completion needs evidence.');
    status = action === 'complete' ? 'done' : 'ready';
    next = action === 'complete' ? 'Complete. Create a follow-up for further work.' : text(input.next_action,'Next action',1000,true);
    blocker = '';
  } else {
    if (!worker && !ownerOverride) throw new HubError(403,'not_worker','Only the assigned worker or Casey can update this task.');
    if (action === 'cancel') status = 'canceled';
    else if (action === 'handoff') {
      owner = person(input.owner_id,'new owner');
      if (owner === task.owner_id || (owner && owner === task.reviewer_id) || (owner === 'casey' && !task.reviewer_id)) bad('Choose a different worker who is not the reviewer.');
      status = 'proposed'; next = text(input.next_action,'Next action',1000,true); blocker = '';
    } else {
      if (!worker || status === 'proposed') throw new HubError(403,'not_accepted','The proposed worker must accept before reporting work.');
      if (action === 'start') {
        if (!['ready','blocked'].includes(status)) bad('Only ready or blocked work can start.');
        for (const dep of JSON.parse(task.dependencies) as number[]) {
          if ((await row(env,dep)).status !== 'done') throw new HubError(409,'dependency_open',`Task #${dep} must be completed first.`);
        }
        status = 'in_progress'; blocker = '';
      } else if (action === 'block') {
        if (!['ready','in_progress','blocked'].includes(status)) bad('This work cannot be blocked in its current state.');
        blocker = text(input.blocker,'Blocker',2000,true); status = 'blocked';
      } else if (action === 'submit') {
        if (status !== 'in_progress') bad('Start the task before submitting it.');
        evidence = text(input.evidence,'Evidence',4000,true); status = 'review'; blocker = '';
      } else if (action === 'progress' && status !== 'in_progress') bad('Progress belongs to work in progress.');
      next = text(input.next_action,'Next action',1000,true);
    }
  }
  const time = Date.now();
  // Compare-and-swap and audit share a transaction. The event is inserted only if this request won.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE tasks SET owner_id=?3,status=?4,next_action=?5,blocker=?6,evidence=?7,updated_at=?8,version=version+1 WHERE id=?1 AND version=?2`)
      .bind(id,expected,owner,status,next,blocker,evidence,time),
    env.DB.prepare(`INSERT INTO task_events(task_id,version,actor_id,actor_name,at,action,detail)
      SELECT id,version,?3,?4,?5,?6,?7 FROM tasks WHERE id=?1 AND version=?2 AND changes()=1`)
      .bind(id,expected+1,actor.id,actor.name,time,action,note),
  ]);
  if (!result[0].meta.changes) throw new HubError(409,'task_changed','Someone updated this task. Read it again before changing it.');
  return getTask(env,actor,id);
}

// ---------------------------------------------------------------- chat commands
//
// Some AI clients cache the hub's tool list and so cannot see update_task even
// after it ships. Every client can post a chat message, so a job can also be moved
// by writing a command as the first line of one. Same permissions, same checks:
// this is another doorway into updateTask, not a way around it.

const FIELDS = ['next_action','blocker','evidence','owner_id'] as const;

export const COMMAND_HELP =
  'Write "/job <number> <action>" on the first line, then your note on the lines below. ' +
  `Actions: ${TASK_ACTIONS.join(', ')}. ` +
  'Add "next_action: ...", "blocker: ...", "evidence: ..." or "owner_id: ..." on their own lines when the action needs them.';

/** Pull a job command out of a chat message, or return null if it is an ordinary message. */
export function parseCommand(body: string): { id: number; action: string; note: string; fields: Record<string,string> } | null {
  const lines = body.replace(/\r/g,'').split('\n');
  const head = /^\s*\/job\s+#?(\d+)\s+([a-z_]+)\s*$/i.exec(lines[0] ?? '');
  if (!head) return null;
  const fields: Record<string,string> = {};
  const noteLines: string[] = [];
  for (const line of lines.slice(1)) {
    const field = /^\s*([a-z_]+)\s*:\s*(.*)$/i.exec(line);
    const key = field?.[1]?.toLowerCase();
    if (key && (FIELDS as readonly string[]).includes(key)) fields[key] = (field![2] ?? '').trim();
    else noteLines.push(line);
  }
  return { id: Number(head[1]), action: head[2].toLowerCase(), note: noteLines.join('\n').trim(), fields };
}

/** Run a parsed command and return one plain sentence describing what happened. */
export async function runCommand(env: Env, actor: Actor, command: NonNullable<ReturnType<typeof parseCommand>>): Promise<string> {
  const who = actor.name;
  if (!command.note) return `${who} wrote a job command with no note, so nothing changed. Put the note on the lines under the command.`;
  if (!(TASK_ACTIONS as readonly string[]).includes(command.action)) {
    return `${who} asked for "${command.action}", which is not a job action. ${COMMAND_HELP}`;
  }
  let task;
  try {
    task = (await getTask(env, actor, command.id)).task;
  } catch (error) {
    return `${who} aimed a job command at #${command.id}: ${error instanceof HubError ? error.message : 'that job could not be read.'}`;
  }
  try {
    const after = await updateTask(env, actor, {
      ...command.fields, id: command.id, expected_version: task.version, action: command.action, note: command.note,
    });
    return `${who} ran "${command.action}" on job #${command.id} (${task.title}). It is now ${after.task.status}, owned by ${after.task.owner_id || 'nobody'}.`;
  } catch (error) {
    return `${who} tried "${command.action}" on job #${command.id} and the hub refused: ${error instanceof HubError ? error.message : 'something went wrong.'}`;
  }
}
