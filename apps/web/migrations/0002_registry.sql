-- Rebuildable view of the registry (PRD-OS 6.4). The objects, attestations and log are the record.
CREATE TABLE packages (
  object_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  task_id TEXT,
  outcome TEXT NOT NULL,
  model TEXT NOT NULL,
  records INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  session_id TEXT,
  gallery_id TEXT,
  author_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  licence TEXT NOT NULL,
  backfilled INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 0,
  self_consistent INTEGER NOT NULL DEFAULT 0,
  evidence_class TEXT NOT NULL DEFAULT 'E0',
  retracted INTEGER NOT NULL DEFAULT 0,
  taken_down INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX packages_created ON packages (created_at DESC);
CREATE INDEX packages_class ON packages (evidence_class, created_at DESC);
CREATE INDEX packages_author ON packages (author_id, created_at DESC);

-- Work for the off-Cloudflare verifier.
CREATE TABLE verify_jobs (
  object_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (object_id, task_id)
);
CREATE INDEX verify_jobs_status ON verify_jobs (status, created_at);
