-- Evidence is per slot: a package tested for one slot proves nothing about another.
ALTER TABLE slot_candidates ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
