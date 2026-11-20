CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS persons (
  contact_id TEXT PRIMARY KEY, name TEXT, traits TEXT, likes TEXT, dislikes TEXT,
  affection REAL DEFAULT 20, mood REAL DEFAULT 50, energy REAL DEFAULT 50,
  emotion TEXT DEFAULT '{}', stage INTEGER DEFAULT 0, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, contact_id TEXT, type TEXT, name TEXT,
  aliases TEXT DEFAULT '[]', attrs TEXT DEFAULT '{}', importance REAL DEFAULT 1, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY, contact_id TEXT, src TEXT, dst TEXT, rel TEXT, weight REAL DEFAULT 1,
  valid_from INTEGER, valid_to INTEGER, source_memory TEXT, confidence REAL DEFAULT 0.6);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, contact_id TEXT, level INTEGER DEFAULT 1, parent_id TEXT,
  title TEXT, gist TEXT, detail TEXT, topics TEXT DEFAULT '[]', people TEXT DEFAULT '[]',
  valence REAL DEFAULT 0, arousal REAL DEFAULT 0, importance REAL DEFAULT 3, strength REAL DEFAULT 1,
  ts INTEGER, last_access INTEGER, access_count INTEGER DEFAULT 0, detail_level INTEGER DEFAULT 2);
CREATE TABLE IF NOT EXISTS mem_entities (memory_id TEXT, entity_id TEXT, PRIMARY KEY (memory_id, entity_id));
CREATE TABLE IF NOT EXISTS embeddings (owner_type TEXT, owner_id TEXT, vec TEXT, model TEXT, PRIMARY KEY (owner_type, owner_id));
CREATE TABLE IF NOT EXISTS style (contact_id TEXT, dim TEXT, base REAL, min REAL, max REAL, current REAL, updated_at INTEGER, PRIMARY KEY (contact_id, dim));
CREATE TABLE IF NOT EXISTS style_terms (contact_id TEXT, term TEXT, count INTEGER, first_seen INTEGER, last_seen INTEGER, PRIMARY KEY (contact_id, term));
