import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaults } from './sources.mjs';
import { toOpportunity } from './opportunities.mjs';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'novo',
      notes TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  const read = db.prepare('SELECT value FROM preferences WHERE key = ?');
  const write = db.prepare(`
    INSERT INTO preferences(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const insert = db.prepare(`
    INSERT INTO opportunities(id, payload, first_seen, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
  `);
  const update = db.prepare('UPDATE opportunities SET payload = ?, last_seen = ? WHERE id = ?');
  const byId = db.prepare('SELECT * FROM opportunities WHERE id = ?');
  const all = db.prepare('SELECT * FROM opportunities ORDER BY last_seen DESC');
  const edit = db.prepare('UPDATE opportunities SET stage = ?, notes = ? WHERE id = ?');
  const data = row => row && {
    ...JSON.parse(row.payload), stage: row.stage, notes: row.notes,
    firstSeen: row.first_seen, lastSeen: row.last_seen,
  };

  function get(key, fallback) {
    const item = read.get(key);
    return item ? JSON.parse(item.value) : fallback;
  }

  return {
    close: () => db.close(),
    list: () => all.all().map(data),
    settings: () => ({ ...defaults, ...get('settings', {}) }),
    scan: () => get('scan', null),
    set: (key, value) => write.run(key, JSON.stringify(value)),
    save(items) {
      const timestamp = new Date().toISOString();
      const unique = new Map();
      for (const raw of items) {
        const item = toOpportunity(raw);
        if (item && !unique.has(item.id)) unique.set(item.id, item);
      }
      let created = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of unique.values()) {
          const previous = byId.get(item.id);
          const current = previous && JSON.parse(previous.payload);
          // Keep a verified marketplace listing over an inferred web search result.
          const record = current?.source === 'Freelancer.com' && item.source === 'Busca web' ? current : item;
          const payload = JSON.stringify(record);
          if (insert.run(item.id, payload, timestamp, timestamp).changes) created++;
          else update.run(payload, timestamp, item.id);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { created, matched: unique.size };
    },
    edit(id, changes) {
      const row = byId.get(id);
      if (!row) return null;
      edit.run(changes.stage ?? row.stage, changes.notes ?? row.notes, id);
      return data(byId.get(id));
    },
  };
}
