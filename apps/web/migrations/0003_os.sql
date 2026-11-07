-- OS board, builds, counterexamples and test proposals (PRD-OS 6.9).
CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  features INTEGER NOT NULL,
  depends TEXT NOT NULL,
  interface TEXT NOT NULL,
  prompt TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE slot_candidates (
  slot_id TEXT NOT NULL REFERENCES slots (id),
  object_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (slot_id, object_id)
);

CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  lock TEXT NOT NULL,
  image_id TEXT NOT NULL,
  parent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX builds_created ON builds (created_at DESC);

CREATE TABLE counterexamples (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX counterexamples_status ON counterexamples (status, created_at);

CREATE TABLE test_proposals (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES slots (id),
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected')),
  reviewed_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX test_proposals_slot ON test_proposals (slot_id, status);
