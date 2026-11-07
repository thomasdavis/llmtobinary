-- Accounts and social data (PRD-OS 6.1, 6.4). Nothing here can affect an evidence class.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,                -- GitHub numeric ID: logins can change
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  github_created_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'curator', 'owner')),
  licence_accepted TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX users_login ON users (login);

-- The cookie holds a random token; only its hash is stored.
CREATE TABLE login_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_sessions_user ON login_sessions (user_id);

CREATE TABLE stars (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, object_id)
);
CREATE INDEX stars_object ON stars (object_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  body TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_object ON comments (object_id, created_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX reports_status ON reports (status, created_at);

-- Generations attributed to a member. The broker writes these, never the browser.
CREATE TABLE generations (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX generations_user ON generations (user_id, created_at);

-- Per-member daily spend, in integer micro-dollars so concurrent updates cannot drift.
CREATE TABLE member_spend (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  micro_usd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
