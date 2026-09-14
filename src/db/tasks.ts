import type { Env } from '../types/client';

export type TaskType = 'area' | 'goal' | 'project' | 'task' | 'subtask';
export type TaskSlot = 'now' | 'next' | 'later' | 'future';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TransitionAction = 'CREATED' | 'STARTED' | 'PAUSED' | 'RESCHEDULED' | 'COMPLETED' | 'CANCELLED';

export type TaskRow = {
  id: string;
  parent_id: string | null;
  type: TaskType;
  title: string;
  slot: TaskSlot;
  status: TaskStatus;
  context: string | null;
  original_date: string | null; // NULL = inbox, never scheduled yet
  scheduled_date: string | null;
  reschedule_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type TaskOperation =
  | { op: 'CREATE'; title: string; slot?: TaskSlot; type?: TaskType; parent_id?: string; context?: string; scheduled_date?: string; reason?: string }
  | { op: 'UPDATE'; id: string; title?: string; slot?: TaskSlot; status?: TaskStatus; context?: string; reason?: string }
  | { op: 'COMPLETE'; id: string; reason?: string }
  | { op: 'RESCHEDULE'; id: string; scheduled_date: string; slot?: TaskSlot; reason?: string };

function db(env: Env): D1Database {
  if (!env.DB) throw new Error('D1 binding missing: DB');
  return env.DB as D1Database;
}

/** Step 1: capture raw inbound text so nothing is ever lost. */
export async function logEvent(env: Env, rawText: string, source: string): Promise<string> {
  const id = crypto.randomUUID();
  await db(env)
    .prepare('INSERT INTO event_log (id, raw_text, source, status) VALUES (?, ?, ?, ?)')
    .bind(id, rawText, source, 'pending')
    .run();
  return id;
}

export async function markEvent(env: Env, eventId: string, status: 'processed' | 'failed'): Promise<void> {
  await db(env).prepare('UPDATE event_log SET status = ? WHERE id = ?').bind(status, eventId).run();
}

/** Step 2: apply LLM-extracted operations, then flip the event to processed. */
export async function ingest(
  env: Env,
  rawText: string,
  source: string,
  ops: TaskOperation[],
): Promise<TaskRow[]> {
  const eventId = await logEvent(env, rawText, source);
  try {
    const rows = await mutateTasks(env, ops);
    await markEvent(env, eventId, 'processed');
    return rows;
  } catch (err) {
    await markEvent(env, eventId, 'failed');
    throw err;
  }
}

async function recordTransition(
  database: D1Database,
  task_id: string,
  action: TransitionAction,
  from_date: string | null,
  to_date: string | null,
  reason?: string,
): Promise<void> {
  await database
    .prepare('INSERT INTO task_transitions (task_id, action, from_date, to_date, reason) VALUES (?, ?, ?, ?, ?)')
    .bind(task_id, action, from_date, to_date, reason ?? null)
    .run();
}

async function createTask(database: D1Database, op: Extract<TaskOperation, { op: 'CREATE' }>): Promise<string> {
  const id = crypto.randomUUID();
  const date = op.scheduled_date ?? null; // omit date = inbox, stays out of TODAY
  await database
    .prepare(
      'INSERT INTO tasks (id, parent_id, type, title, slot, context, original_date, scheduled_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, op.parent_id ?? null, op.type ?? 'task', op.title, op.slot ?? 'future', op.context ?? null, date, date)
    .run();
  await recordTransition(database, id, 'CREATED', null, date, op.reason);
  return id;
}

/** Status changes with timestamps + transition log. Enforces Rule of One. */
async function setStatus(database: D1Database, id: string, to: TaskStatus, reason?: string): Promise<void> {
  const row = await database.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
  if (!row || row.status === to) return;

  if (to === 'in_progress') {
    // Rule of One: pause whatever else is active.
    const active = await database
      .prepare("SELECT id FROM tasks WHERE status = 'in_progress' AND id != ?")
      .bind(id)
      .all<{ id: string }>();
    for (const other of active.results ?? []) {
      await database.prepare("UPDATE tasks SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(other.id).run();
      await recordTransition(database, other.id, 'PAUSED', null, null, 'rule of one');
    }
    await database
      .prepare("UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(id)
      .run();
    await recordTransition(database, id, 'STARTED', null, null, reason);
  } else if (to === 'completed') {
    await database
      .prepare("UPDATE tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(id)
      .run();
    await recordTransition(database, id, 'COMPLETED', null, null, reason);
  } else if (to === 'cancelled') {
    await database
      .prepare("UPDATE tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(id)
      .run();
    await recordTransition(database, id, 'CANCELLED', null, null, reason);
  } else {
    await database.prepare("UPDATE tasks SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    if (row.status === 'in_progress') {
      await recordTransition(database, id, 'PAUSED', null, null, reason);
    }
  }
}

/** First scheduling sets the original promise; later moves count as reschedules. */
async function rescheduleTask(database: D1Database, op: Extract<TaskOperation, { op: 'RESCHEDULE' }>): Promise<void> {
  const row = await database.prepare('SELECT * FROM tasks WHERE id = ?').bind(op.id).first<TaskRow>();
  if (!row) return;
  if (row.original_date === null) {
    await database
      .prepare(
        'UPDATE tasks SET original_date = ?, scheduled_date = ?, slot = COALESCE(?, slot), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      )
      .bind(op.scheduled_date, op.scheduled_date, op.slot ?? null, op.id)
      .run();
  } else {
    await database
      .prepare(
        'UPDATE tasks SET scheduled_date = ?, slot = COALESCE(?, slot), reschedule_count = reschedule_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      )
      .bind(op.scheduled_date, op.slot ?? null, op.id)
      .run();
  }
  await recordTransition(database, op.id, 'RESCHEDULED', row.scheduled_date, op.scheduled_date, op.reason);
}

/** Step 3: run all operations, then return the affected rows. */
export async function mutateTasks(env: Env, ops: TaskOperation[]): Promise<TaskRow[]> {
  const database = db(env);
  const ids: string[] = [];
  for (const op of ops) {
    if (op.op === 'CREATE') {
      ids.push(await createTask(database, op));
    } else if (op.op === 'RESCHEDULE') {
      await rescheduleTask(database, op);
      ids.push(op.id);
    } else if (op.op === 'COMPLETE') {
      await setStatus(database, op.id, 'completed', op.reason);
      ids.push(op.id);
    } else {
      if (op.status) await setStatus(database, op.id, op.status, op.reason);
      await database
        .prepare(
          `UPDATE tasks SET
            title = COALESCE(?, title),
            slot = COALESCE(?, slot),
            context = COALESCE(?, context),
            updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(op.title ?? null, op.slot ?? null, op.context ?? null, op.id)
        .run();
      ids.push(op.id);
    }
  }
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await database
    .prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<TaskRow>();
  return results ?? [];
}

/** Inbox: captured but never scheduled — excluded from TODAY automatically. */
export async function listInbox(env: Env): Promise<TaskRow[]> {
  const { results } = await db(env)
    .prepare("SELECT * FROM tasks WHERE scheduled_date IS NULL AND status != 'completed' ORDER BY created_at")
    .all<TaskRow>();
  return results ?? [];
}

/** Everything still open: dated first, inbox last. */
export async function listOpen(env: Env): Promise<TaskRow[]> {
  const { results } = await db(env)
    .prepare(
      `SELECT * FROM tasks WHERE status NOT IN ('completed', 'cancelled')
       ORDER BY CASE WHEN scheduled_date IS NULL THEN 1 ELSE 0 END, scheduled_date`,
    )
    .all<TaskRow>();
  return results ?? [];
}

/** TODAY view: dated for today and not completed, NOW first. */
export async function listToday(env: Env): Promise<TaskRow[]> {
  const { results } = await db(env)
    .prepare(
      `SELECT * FROM tasks WHERE scheduled_date = DATE('now') AND status != 'completed'
       ORDER BY CASE slot WHEN 'now' THEN 0 WHEN 'next' THEN 1 WHEN 'later' THEN 2 ELSE 3 END`,
    )
    .all<TaskRow>();
  return results ?? [];
}

/** Direct children of a group (area -> goal -> project -> task). */
export async function listChildren(env: Env, parentId: string): Promise<TaskRow[]> {
  const { results } = await db(env)
    .prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY scheduled_date')
    .bind(parentId)
    .all<TaskRow>();
  return results ?? [];
}

/** Progress of a whole subtree via recursive CTE. */
export async function subtreeProgress(env: Env, rootId: string): Promise<{ total: number; completed: number }> {
  const row = await db(env)
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN sub s ON t.parent_id = s.id
       )
       SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM tasks WHERE id IN sub`,
    )
    .bind(rootId)
    .first<{ total: number; completed: number }>();
  return { total: row?.total ?? 0, completed: row?.completed ?? 0 };
}

/** Avoidance candidates: rescheduled 2+ times and still open. */
export async function listAvoidance(env: Env): Promise<TaskRow[]> {
  const { results } = await db(env)
    .prepare("SELECT * FROM tasks WHERE reschedule_count >= 2 AND status != 'completed' ORDER BY reschedule_count DESC")
    .all<TaskRow>();
  return results ?? [];
}

/** Completed late vs the original promise, with slippage in days. */
export async function listSlippage(env: Env): Promise<(TaskRow & { slippage_days: number })[]> {
  const { results } = await db(env)
    .prepare(
      `SELECT *, JULIANDAY(DATE(completed_at)) - JULIANDAY(DATE(original_date)) AS slippage_days
       FROM tasks WHERE status = 'completed' AND DATE(completed_at) > DATE(original_date)
       ORDER BY slippage_days DESC`,
    )
    .all<TaskRow & { slippage_days: number }>();
  return results ?? [];
}
