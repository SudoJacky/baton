import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// Keep the historical nullable runtime/model columns for compatibility with existing databases.
// Current participant reads and writes do not use them; no table rebuild or session reset is needed.
const migration = `
CREATE TABLE participants (
 handle TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('agent','human')), runtime TEXT, role TEXT, model TEXT,
 display_name TEXT, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'offline', status_note TEXT,
 frozen INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT
);
CREATE TABLE sessions (id TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES participants(handle), last_seen_at TEXT NOT NULL);
CREATE INDEX sessions_handle ON sessions(handle);
CREATE TABLE tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, type TEXT NOT NULL,
 status TEXT NOT NULL, priority TEXT NOT NULL, creator TEXT NOT NULL REFERENCES participants(handle),
 assignee TEXT REFERENCES participants(handle), reviewer TEXT REFERENCES participants(handle), role_hint TEXT, parent_id INTEGER REFERENCES tasks(id),
 context TEXT NOT NULL, writes_code INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0,
 frozen INTEGER NOT NULL DEFAULT 0, lease_until TEXT, lease_expired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tasks_claim ON tasks(status, role_hint, priority);
CREATE INDEX tasks_assignee ON tasks(assignee, status);
CREATE TABLE task_dependencies (task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on_id INTEGER NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id, depends_on_id), CHECK(task_id != depends_on_id));
CREATE TABLE acceptance_criteria (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id), text TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, checked_by TEXT REFERENCES participants(handle), position INTEGER NOT NULL);
CREATE TABLE artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, ref TEXT NOT NULL, label TEXT, created_by TEXT NOT NULL REFERENCES participants(handle), created_at TEXT NOT NULL, UNIQUE(task_id,kind,ref));
CREATE TABLE labels (task_id INTEGER NOT NULL REFERENCES tasks(id), label TEXT NOT NULL, PRIMARY KEY(task_id,label));
CREATE TABLE write_lock (id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT REFERENCES participants(handle), task_id INTEGER REFERENCES tasks(id), acquired_at TEXT, CHECK((holder IS NULL AND task_id IS NULL AND acquired_at IS NULL) OR (holder IS NOT NULL AND acquired_at IS NOT NULL)));
INSERT INTO write_lock(id) VALUES(1);
CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('channel','dm')));
INSERT INTO channels(name,kind) VALUES('general','channel'),('planning','channel');
CREATE TABLE channel_members (channel_id INTEGER NOT NULL REFERENCES channels(id), handle TEXT NOT NULL REFERENCES participants(handle), PRIMARY KEY(channel_id,handle));
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL REFERENCES participants(handle), task_id INTEGER REFERENCES tasks(id), channel_id INTEGER REFERENCES channels(id), kind TEXT NOT NULL, body TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id), created_at TEXT NOT NULL, CHECK((task_id IS NULL) != (channel_id IS NULL)));
CREATE INDEX messages_task ON messages(task_id,created_at);
CREATE INDEX messages_channel ON messages(channel_id,id);
CREATE TABLE mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id), handle TEXT NOT NULL REFERENCES participants(handle), state TEXT NOT NULL DEFAULT 'unread' CHECK(state IN ('unread','read','resolved')), created_at TEXT NOT NULL, UNIQUE(message_id,handle));
CREATE INDEX mentions_inbox ON mentions(handle,state,id);
CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id), requester TEXT NOT NULL REFERENCES participants(handle), from_status TEXT NOT NULL, to_status TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, resolved_by TEXT REFERENCES participants(handle), resolved_at TEXT);
CREATE UNIQUE INDEX approvals_pending ON approvals(task_id,to_status) WHERE state='pending';
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT REFERENCES participants(handle), type TEXT NOT NULL, task_id INTEGER REFERENCES tasks(id), payload TEXT NOT NULL, audience TEXT, created_at TEXT NOT NULL);
CREATE INDEX events_created ON events(created_at);
CREATE INDEX events_task ON events(task_id,id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are immutable'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Events are immutable'); END;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 1;
`;

export class Store {
  private readonly connection: DatabaseSync;
  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;',
      );
      const version = this.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      if (version === 0) this.transaction(() => this.connection.exec(migration));
      else if (![1, 2, 3, 4, 5].includes(version))
        throw new Error(
          `Unsupported database version ${version}. Upgrade the server before opening this file.`,
        );
      if (version < 2)
        this.transaction(() =>
          this.connection.exec(`
      ALTER TABLE participants ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      UPDATE participants SET enabled=0 WHERE token_hash LIKE 'revoked:%';
      UPDATE participants SET frozen=0 WHERE kind='human';
      PRAGMA user_version=2;
    `),
        );
      if (version < 3)
        this.transaction(() =>
          this.connection.exec(`
        ALTER TABLE participants ADD COLUMN managed INTEGER NOT NULL DEFAULT 1;
        UPDATE participants SET token_hash='agent:'||handle WHERE kind='agent';
        DELETE FROM sessions;
        PRAGMA user_version=3;
      `),
        );
      if (version < 4)
        this.transaction(() =>
          this.connection.exec(`
        ALTER TABLE tasks ADD COLUMN repository TEXT;
        CREATE INDEX tasks_repository ON tasks(repository,status);
        CREATE TABLE write_locks (
          repository TEXT PRIMARY KEY NOT NULL,
          holder TEXT NOT NULL REFERENCES participants(handle),
          task_id INTEGER UNIQUE REFERENCES tasks(id),
          acquired_at TEXT NOT NULL
        );
        INSERT INTO write_locks SELECT '',holder,task_id,acquired_at FROM write_lock WHERE holder IS NOT NULL;
        DROP TABLE write_lock;
        PRAGMA user_version=4;
      `),
        );
      if (version < 5)
        this.transaction(() =>
          this.connection.exec(`
          ALTER TABLE tasks ADD COLUMN plan_approved_at TEXT;
          ALTER TABLE tasks ADD COLUMN plan_approved_by TEXT REFERENCES participants(handle);
          ALTER TABLE tasks ADD COLUMN workflow_plan INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE worker_runs (
            id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
            handle TEXT NOT NULL REFERENCES participants(handle),
            coordinator TEXT NOT NULL REFERENCES participants(handle),
            mode TEXT NOT NULL CHECK(mode IN ('implement','review')),
            state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','completed','stopped','expired')),
            commit_sha TEXT, lease_until TEXT NOT NULL, created_at TEXT NOT NULL
          );
            CREATE UNIQUE INDEX worker_active_task ON worker_runs(task_id) WHERE state='active';
            CREATE INDEX worker_task ON worker_runs(task_id,created_at);
          PRAGMA user_version=5;
        `),
        );
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const result = this.connection.prepare(sql).run(...params);
    return { changes: Number(result.changes), id: Number(result.lastInsertRowid) };
  }
  transaction<T>(fn: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.connection.close();
  }
}
