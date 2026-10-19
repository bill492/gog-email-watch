import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type MessageStatus = "pending" | "queued" | "ignored" | "processing" | "done" | "needs_review" | "shadow" | "digest" | "deferred";
export type JobStatus = "running" | "replied" | "skipped" | "completed" | "deferred" | "needs_review";

export interface StoredMessage {
  id: string;
  thread_id: string;
  received: number;
  sender: string;
  status: MessageStatus;
  reason: string;
  job_id: string | null;
  discovered: number;
  attempts: number;
  due: number;
}

export interface StoredJob {
  id: string;
  thread_id: string;
  target_id: string;
  message_ids: string;
  status: JobStatus;
  created: number;
  finished: number | null;
  reason: string;
  agent_id: string;
  session_key: string;
  run_id: string;
  evidence_hash: string;
  policy_version: number;
}

export class MailState {
  readonly db: DatabaseSync;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "mail.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, received INTEGER NOT NULL,
        sender TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        job_id TEXT, discovered INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_queue ON messages(status, received);
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, target_id TEXT NOT NULL,
        message_ids TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
        finished INTEGER, reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS replies(
        target_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL,
        updated INTEGER NOT NULL, result TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS replies_job ON replies(job_id);
      CREATE TABLE IF NOT EXISTS policies(version INTEGER PRIMARY KEY, document TEXT NOT NULL, created INTEGER NOT NULL, editor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assessments(key TEXT PRIMARY KEY, outcome TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS triage(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, evidence_hash TEXT NOT NULL,
        assessment_key TEXT NOT NULL, policy_version INTEGER NOT NULL, facts TEXT NOT NULL, plan TEXT NOT NULL,
        coverage TEXT NOT NULL, historical INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, status TEXT NOT NULL,
        intent TEXT NOT NULL, receipt TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, target TEXT NOT NULL, operation TEXT NOT NULL,
        note TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL);
    `);
    // Additive migration: never rewrite prior jobs, receipts, or activation cutoffs.
    for (const [table, columns] of Object.entries({
      messages: { attempts: "INTEGER NOT NULL DEFAULT 0", due: "INTEGER NOT NULL DEFAULT 0" },
      jobs: { agent_id: "TEXT NOT NULL DEFAULT ''", session_key: "TEXT NOT NULL DEFAULT ''", run_id: "TEXT NOT NULL DEFAULT ''", evidence_hash: "TEXT NOT NULL DEFAULT ''", policy_version: "INTEGER NOT NULL DEFAULT 0" },
    })) {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const [column, declaration] of Object.entries(columns)) if (!existing.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string | number): void {
    this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(key, String(value));
  }

  message(id: string): StoredMessage | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as StoredMessage | undefined;
  }

  queued(): StoredMessage | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE status='queued' ORDER BY received,id LIMIT 1").get() as StoredMessage | undefined;
  }

  queuedThread(threadId: string): StoredMessage[] {
    return this.db.prepare("SELECT * FROM messages WHERE status='queued' AND thread_id=? ORDER BY received,id").all(threadId) as unknown as StoredMessage[];
  }

  job(id: string): StoredJob | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as StoredJob | undefined;
  }

  hasReplyForJob(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM replies WHERE job_id=? LIMIT 1").get(id);
  }

  hasReplyTarget(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM replies WHERE target_id=?").get(key);
  }

  counts(table: "messages" | "jobs"): Record<string, number> {
    const rows = this.db.prepare(`SELECT status,count(*) AS count FROM ${table} GROUP BY status`).all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map(({ status, count }) => [status, count]));
  }
}
