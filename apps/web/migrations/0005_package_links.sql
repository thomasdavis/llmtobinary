-- What each generated program reused from the library. A row exists for every linked package,
-- including dependencies of dependencies; `symbols` lists what the program calls directly.
CREATE TABLE package_links (
  object_id TEXT NOT NULL,
  dep_object_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  symbols TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (object_id, dep_object_id)
);
CREATE INDEX package_links_dep ON package_links (dep_object_id);
