-- 1. RAW INGESTION BUFFER
CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  raw_text TEXT NOT NULL,
  source TEXT DEFAULT 'telegram',
  status TEXT DEFAULT 'pending',        -- 'pending', 'processed', 'failed'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. UNIFIED STATE & HIERARCHY STORE
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES tasks(id),  -- Enables recursive groups (Area -> Goal -> Project -> Task -> Subtask)
  type TEXT DEFAULT 'task',             -- 'area', 'goal', 'project', 'task', 'subtask'
  title TEXT NOT NULL,
  slot TEXT DEFAULT 'future',           -- 'now', 'next', 'later', 'future'
  status TEXT DEFAULT 'pending',         -- 'pending', 'in_progress', 'completed', 'cancelled'
  context TEXT,                         -- 'office', 'home', 'personal'

  -- Planning & Slippage Tracking (NULL = inbox, never scheduled yet)
  original_date TEXT,                   -- Immutable target date set at first scheduling
  scheduled_date TEXT,                  -- Mutable target date (updated on reschedule)
  reschedule_count INTEGER DEFAULT 0,

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,                  -- Set when status -> 'in_progress'
  completed_at DATETIME,                -- Set when status -> 'completed'
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks (scheduled_date, slot, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_id);

-- 3. AUDIT & BEHAVIOR TRANSITION LOG
CREATE TABLE IF NOT EXISTS task_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,                 -- 'CREATED', 'STARTED', 'PAUSED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED'
  from_date TEXT,
  to_date TEXT,
  reason TEXT,                          -- LLM-extracted (e.g. 'tired', 'blocked by PR', 'scope too large')
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
