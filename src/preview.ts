import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { GogMailClient, type GmailThread } from "./mail.js";
import { PolicySchema, SettingsSchema } from "./policy.js";
import { createMailWorkflow, type MailClient, type WorkflowOptions } from "./workflow.js";

export const PreviewSchema = Type.Object({
  policy: Type.Optional(PolicySchema),
  settings: Type.Optional(SettingsSchema),
  query: Type.Optional(Type.String({ description: "Candidate base Gmail triage selection; explicit label queries and compatibility selectors retain their own scope. Empty includes archived mail." })),
}, { additionalProperties: false });
export type PreviewInput = Static<typeof PreviewSchema>;
type PreviewDisposition = "wake" | "queue" | "skip" | "trash" | "resolved" | "held" | "pending" | "ignored";

export interface PreviewResult {
  account: string;
  policyVersion: number;
  triageQuery: string;
  messages: Array<{ id: string; threadId: string; disposition: PreviewDisposition; labels: string[]; reason: string; previousStatus?: string }>;
  projected: {
    labels: Array<{ messageIds: string[]; add: string[]; remove: string[]; afterHandling?: true }>;
    trash: string[];
    wakes: Array<{ jobId: string; agentId: string; threadIds: string[]; messageIds: string[]; reason: string; replyAllowed: boolean }>;
    queue: string[];
    skip: string[];
    replies: Array<{ targetMessageId: string; to: string[]; cc: string[] }>;
  };
  errors: Array<{ messageId?: string; reason: string }>;
  note: string;
}

/** Execute the real workflow against a consistent private database snapshot.
 * Only the reader and Decisions runtime are real: all mailbox/agent writes are
 * projected, and the original configuration and durable receipts stay intact.
 */
export async function previewMailbox(options: WorkflowOptions, input: PreviewInput): Promise<PreviewResult> {
  if (!Value.Check(PreviewSchema, input)) throw new Error("invalid email preview input");
  const folder = await mkdtemp(join(tmpdir(), "gog-email-watch-preview-"));
  const controller = new AbortController();
  let workflow: ReturnType<typeof createMailWorkflow> | undefined;
  try {
    const sourcePath = join(options.stateDir, "mail.sqlite");
    if (existsSync(sourcePath)) {
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        // Pin the WAL-aware read snapshot while the asynchronous backup runs.
        source.exec("BEGIN");
        source.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
        await backup(source, join(folder, "mail.sqlite"));
      } finally { source.close(); }
    }
    const config = structuredClone(options.config);
    const projected: PreviewResult["projected"] = { labels: [], trash: [], wakes: [], queue: [], skip: [], replies: [] };
    const errors: PreviewResult["errors"] = [];
    const labelNames = new Map<string, string>();
    const observedMessages = new Map<string, string>();
    const changes = new Map<string, { add: Set<string>; remove: Set<string> }>();
    const reader = options.mail ?? new GogMailClient(config, controller.signal, () => workflow!.policyGet().settings);
    const nameOf = (id: string) => labelNames.get(id) ?? id;
    const mail: MailClient = {
      searchPage: (...args) => reader.searchPage(...args),
      async getThread(id) {
        const thread: GmailThread = structuredClone(await reader.getThread(id));
        for (const [labelId, name] of Object.entries(thread.labelNames ?? {})) labelNames.set(labelId, name);
        for (const message of thread.messages) {
          observedMessages.set(message.id, thread.id);
          const change = changes.get(message.id);
          if (change) message.labelIds = [...new Set([...message.labelIds.filter(label => !change.remove.has(label)), ...change.add])];
        }
        thread.labelNames = { ...thread.labelNames, ...Object.fromEntries(labelNames) };
        return thread;
      },
      async labelId(name) {
        const existing = [...labelNames].find(([, label]) => label === name)?.[0];
        if (["INBOX", "SPAM", "TRASH", "SENT", "DRAFT"].includes(existing ?? name))
          throw new Error(`Gmail mailbox-state label ${name} cannot be used as a category`);
        const id = existing ?? `preview_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
        labelNames.set(id, name);
        return id;
      },
      async modify(ids, add, remove) {
        const afterHandling = projected.wakes.some(wake => wake.messageIds.some(id => ids.includes(id))) &&
          add.some(label => workflow!.policyGet().settings.completionLabels.includes(nameOf(label)));
        projected.labels.push({ messageIds: [...ids], add: add.map(nameOf), remove: remove.map(nameOf), ...(afterHandling ? { afterHandling: true as const } : {}) });
        for (const id of ids) {
          const change = changes.get(id) ?? { add: new Set<string>(), remove: new Set<string>() };
          for (const label of add) { change.remove.delete(label); change.add.add(label); }
          for (const label of remove) { change.add.delete(label); change.remove.add(label); }
          changes.set(id, change);
          if (add.includes("TRASH") && !projected.trash.includes(id)) projected.trash.push(id);
        }
        return { modified: [...ids], addedLabels: [...add], removedLabels: [...remove], preview: true };
      },
      async send({ targetMessageId, to, cc }) {
        projected.replies.push({ targetMessageId, to: [...to], cc: [...cc] });
        const threadId = observedMessages.get(targetMessageId);
        if (!threadId) throw new Error("preview reply target was not read");
        return { messageId: createHash("sha256").update(`preview:${targetMessageId}`).digest("hex").slice(0, 24), threadId };
      },
    };
    workflow = createMailWorkflow({ ...options, config, stateDir: folder, mail,
      logger: { info() {}, warn() {}, error(reason) { errors.push({ reason }); } },
      subagent: {
        async run({ idempotencyKey, sessionKey }) {
          const prefix = `${config.account}:`;
          if (!idempotencyKey?.startsWith(prefix)) throw new Error("preview wake is missing its mailbox/job identity");
          const jobId = idempotencyKey.slice(prefix.length);
          const context = workflow!.context(jobId, sessionKey);
          projected.wakes.push({ jobId: context.job.id, agentId: context.job.agent_id,
            threadIds: context.messages.map(message => message.threadId),
            messageIds: context.messages.flatMap(message => message.messageIds),
            reason: context.job.reason, replyAllowed: context.replyAllowed });
          // Acknowledge only in the copy so ordinary worker finalization drains.
          // The result still reports a projected wake, never real resolution.
          workflow!.complete({ jobId, sessionKey, reason: "preview: projected wake; no agent started" });
          return { runId: `preview:${idempotencyKey}`, sessionKey };
        },
        async waitForRun() { return { status: "ok" }; },
      },
    });
    const previous = new Map(workflow.inspect().map(row => [row.id, row.message.status]));
    if (input.policy !== undefined || input.settings !== undefined || input.query !== undefined) {
      const settings = { ...input.settings, ...(input.query === undefined ? {} : { triageQuery: input.query }) };
      workflow.policyUpdate(input.policy, workflow.policyGet().version, "preview", settings);
    }
    await workflow.cycle();
    const wakeIds = new Set(projected.wakes.flatMap(wake => wake.messageIds));
    const trashIds = new Set(projected.trash);
    const messages: PreviewResult["messages"] = workflow.inspect().map(row => {
      const status = row.message.status;
      const disposition: PreviewDisposition = wakeIds.has(row.id) ? "wake" : trashIds.has(row.id) ? "trash" :
        status === "queue" ? "queue" : status === "skipped" ? "skip" : status === "done" ? row.resolved ? "resolved" : "held" :
        ["needs_review", "failed", "processing", "deferred"].includes(status) ? "held" :
        status === "ignored" ? "ignored" : "pending";
      if (disposition === "queue") projected.queue.push(row.id);
      if (disposition === "skip") projected.skip.push(row.id);
      if ((status === "pending" && row.message.attempts > 0) || status === "failed")
        errors.push({ messageId: row.id, reason: row.message.reason });
      if (row.labels && row.labels.status === "pending" && row.labels.reason)
        errors.push({ messageId: row.id, reason: String(row.labels.reason) });
      if (row.completionLabels?.status === "pending" && row.completionLabels.reason)
        errors.push({ messageId: row.id, reason: String(row.completionLabels.reason) });
      const plan = row.plan;
      const labels = plan && typeof plan === "object" && "labels" in plan && Array.isArray(plan.labels)
        ? plan.labels.filter((name): name is string => typeof name === "string") : [];
      return { id: row.id, threadId: row.threadId, disposition, labels, reason: wakeIds.has(row.id) ? "projected wake" : row.message.reason,
        previousStatus: previous.get(row.id) };
    });
    const status = workflow.status();
    if (status.lastPollError) errors.push({ reason: status.lastPollError });
    return { account: config.account, policyVersion: workflow.policyGet().version, triageQuery: status.settings.triageQuery,
      messages, projected, errors,
      note: "Read-only mailbox preview; real reads and classification may incur provider usage. No labels, mail, agent runs or live workflow state were changed. Wakes show routing, not the agent's eventual actions. Label changes marked afterHandling require successful future handling. The query overrides base triage selection; explicit label queries and compatibility selectors retain their own scope. This previews one cycle, not later polls triggered by projected label writes." };
  } finally {
    controller.abort();
    try { await workflow?.stop(); }
    finally { await rm(folder, { recursive: true, force: true }); }
  }
}
