import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { DecisionAnswer, DecisionRuntimeV1 } from "openclaw/plugin-sdk/decisions";
import { parseConfig, type GmailMessage, type GmailThread } from "../src/mail.js";
import { previewMailbox } from "../src/preview.js";
import { defaultPolicy } from "../src/policy.js";
import { MailState } from "../src/state.js";
import { createMailWorkflow, type MailClient, type MailSubagent } from "../src/workflow.js";

const account = "agent@example.com";
const model = "typesafe/jev-1.13.0";
const secret = "Private email body must not appear in preview output.";
const noAgents: MailSubagent = {
  async run() { throw new Error("preview escaped into the real agent runtime"); },
  async waitForRun() { throw new Error("preview escaped into the real agent runtime"); },
};

function message(index: number, sender = "person@example.net"): GmailMessage {
  const id = `aa0${index}`;
  return { id, threadId: `bb0${index}`, internalDate: String(Date.now() - 1000), labelIds: ["INBOX"], payload: {
    mimeType: "text/plain", body: { data: Buffer.from(secret).toString("base64url") },
    headers: [{ name: "From", value: sender }, { name: "To", value: account },
      { name: "Authentication-Results", value: `mx.google.com; dmarc=pass header.from=${sender.split("@")[1]}` }],
  } };
}

function reader(messages: GmailMessage[]) {
  const reads: string[] = [];
  const queries: Array<string | undefined> = [];
  const mail: MailClient = {
    async searchPage(_after, _page, _scope, _before, query) {
      queries.push(query);
      const selected = query?.includes("from:vip@example.com") ? messages.filter(message =>
        message.payload.headers?.some(header => header.name === "From" && header.value === "vip@example.com")) : messages;
      return { messages: selected.map(({ id, threadId }) => ({ id, threadId })) };
    },
    async getThread(id): Promise<GmailThread> {
      reads.push(id);
      return { id, messages: messages.filter(message => message.threadId === id) };
    },
    async labelId() { throw new Error("preview attempted to create a real Gmail label"); },
    async modify() { throw new Error("preview attempted to change real Gmail state"); },
    async send() { throw new Error("preview attempted to deliver real email"); },
  };
  return { mail, reads, queries };
}

function dump(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}

test("preview runs label-first routing in a WAL snapshot while preserving live state and every external effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gog-email-preview-test-"));
  const stateDir = join(dir, "live");
  const messages = [message(1), message(2), message(3), message(4), message(5, "vip@example.com"), message(6), message(7)];
  const originalMessages = structuredClone(messages);
  const discoverable: GmailMessage[] = [];
  const mailbox = reader(discoverable);
  const policy = { ...defaultPolicy, deletePrompt: "Only discarded promotions", labels: [
    { name: "Urgent", description: "Owned action needed now", action: "queue" as const },
    { name: "Routine", description: "Owned action can wait", action: "queue" as const },
    { name: "Informational", description: "No owned action", action: "skip" as const },
    { name: "Discard", description: "Discarded promotion", action: "delete" as const },
    { name: "Known sender", description: "Configured sender notification", action: "wake" as const, match: { senders: ["vip@example.com"] } },
  ] };
  const config = parseConfig({ account, domains: ["example.com"], triage: { decisionModel: model, policy } });
  const originalConfig = structuredClone(config);
  const live = createMailWorkflow({ config, stateDir, mail: mailbox.mail, subagent: noAgents });
  const state = new MailState(stateDir);
  try {
    await live.cycle();
    discoverable.push(...messages);
    state.setMeta("active_since", Math.floor(Date.now() / 1000) - 60);
    for (const [index, status] of [[6, "done"], [7, "needs_review"]] as const) {
      state.db.prepare("INSERT INTO messages(id,thread_id,received,sender,status,job_id,discovered) VALUES (?,?,?,?,?,?,?)")
        .run(`aa0${index}`, `bb0${index}`, Number(messages[index - 1].internalDate), "person@example.net", status, `job${index}`, Math.floor(Date.now() / 1000));
      state.db.prepare("INSERT INTO jobs(id,thread_id,target_id,message_ids,status,created) VALUES (?,?,?,?,?,?)")
        .run(`job${index}`, `bb0${index}`, `aa0${index}`, JSON.stringify([`aa0${index}`]), index === 6 ? "completed" : "needs_review", Math.floor(Date.now() / 1000));
    }
    state.db.prepare("INSERT INTO replies(target_id,job_id,status,updated,result) VALUES ('aa06','job6','sent',?,?)")
      .run(Math.floor(Date.now() / 1000), JSON.stringify({ messageId: "cc06", threadId: "bb06" }));
    const before = dump(state.db);
    assert.ok(existsSync(join(stateDir, "mail.sqlite-wal")), "source has live WAL contents");
    const inferenceThreads: string[] = [];
    const decisions: DecisionRuntimeV1 = { async evaluate(batch) {
      const thread = (batch.state as { threadId: string }).threadId;
      inferenceThreads.push(thread);
      const routing: Record<string, string> = { bb01: "Urgent", bb02: "Routine", bb03: "Informational", bb04: "Discard" };
      const selectedLabel = routing[thread];
      const answers: Record<string, DecisionAnswer> = {};
      for (const [key, question] of Object.entries(batch.questions)) {
        answers[key] = { type: "choice", choice: key !== "deletion_match" && typeof question.instructions === "string" && question.instructions.includes(`Label: ${selectedLabel}\n`) ? "apply" : "skip", probabilities: {} };
      }
      return { status: "ok", provenance: { providerId: "typesafe", rubricVersion: "preview-test", runtimeGeneration: "test" },
        result: { model: "jev-1.13.0", answers } };
    } };
    const result = await previewMailbox({ config, stateDir, mail: mailbox.mail, subagent: noAgents, decisions, decisionModel: () => model }, {
      policy: { ...policy, labels: policy.labels.map(label => label.name === "Urgent" ? { ...label, action: "wake" } : label) },
      settings: { completionLabels: ["Handled"] }, query: "",
    });
    assert.deepEqual(dump(state.db), before, "preview cannot consume messages, cutoffs, policies, jobs or send receipts");
    assert.deepEqual(config, originalConfig);
    assert.deepEqual(messages, originalMessages, "projection overlays cannot mutate reader-owned values");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.projected.wakes.flatMap(wake => wake.messageIds).sort(), ["aa01", "aa05"]);
    assert.deepEqual(result.projected.queue, ["aa02"]);
    assert.deepEqual(result.projected.skip, ["aa03"]);
    assert.deepEqual(result.projected.trash, ["aa04"]);
    assert.equal(result.messages.find(message => message.id === "aa06")?.disposition, "resolved");
    assert.equal(result.messages.find(message => message.id === "aa07")?.disposition, "held");
    assert.ok(result.projected.labels.some(change => change.messageIds.includes("aa01") && change.add.includes("Urgent")));
    assert.ok(result.projected.labels.some(change => change.messageIds.includes("aa05") && change.add.includes("Known sender")),
      "deterministic matches project through the same label worker as Jev classifications");
    assert.ok(result.projected.labels.some(change => change.messageIds.includes("aa01") && change.add.includes("Handled") && change.afterHandling),
      "a projected wake does not falsely certify the agent's future handling");
    assert.ok(result.projected.labels.some(change => change.messageIds.includes("aa03") && change.add.includes("Handled") && !change.afterHandling));
    assert.equal(result.triageQuery, "");
    assert.ok(mailbox.queries.includes(""), "candidate triage query reaches real discovery");
    assert.ok(!inferenceThreads.some(thread => ["bb05", "bb06", "bb07"].includes(thread)), "rules-only matches, completed mail and uncertain work do not enter inference");
    assert.deepEqual(result.projected.replies, []);
    assert.ok(!JSON.stringify(result).includes(secret));
    const invalidCompletion = await previewMailbox({ config, stateDir, mail: mailbox.mail, subagent: noAgents, decisions, decisionModel: () => model }, {
      settings: { completionLabels: ["TRASH"] }, query: "",
    });
    assert.ok(invalidCompletion.errors.some(error => error.messageId === "aa03" && error.reason.includes("TRASH")),
      "completion-label delivery failures must be visible alongside classification and category errors");
    assert.deepEqual(dump(state.db), before);
  } finally {
    state.close();
    await live.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview candidate concurrency cannot dispatch before copied running predecessors become holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gog-email-preview-test-"));
  const messages = [message(1, "vip@example.com"), message(2, "vip@example.com")];
  messages[1].threadId = messages[0].threadId;
  const mailbox = reader(messages);
  const config = parseConfig({ account, settings: { wakeFrom: ["vip@example.com"] } });
  const live = createMailWorkflow({ config, stateDir: dir, mail: mailbox.mail, subagent: noAgents });
  await live.stop();
  const state = new MailState(dir);
  try {
    state.db.prepare("INSERT INTO jobs(id,thread_id,target_id,message_ids,status,created) VALUES ('predecessor','bb01','aa01','[\"aa01\"]','running',1)").run();
    for (const [id, status, job] of [["aa01", "processing", "predecessor"], ["aa02", "queued", null]] as const)
      state.db.prepare("INSERT INTO messages(id,thread_id,received,sender,status,job_id,discovered,wake_from) VALUES (?,'bb01',?,'vip@example.com',?,?,1,1)")
        .run(id, Date.now(), status, job);
    const before = dump(state.db);
    const result = await previewMailbox({ config, stateDir: dir, mail: mailbox.mail, subagent: noAgents }, { settings: { agentConcurrency: 2 } });
    assert.deepEqual(result.projected.wakes, []);
    assert.ok(result.messages.every(message => message.disposition === "held"));
    assert.deepEqual(dump(state.db), before, "reconciling copied execution cannot mutate the live predecessor");
  } finally { state.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("preview reports classification failure without creating live state or fabricating a successful route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gog-email-preview-test-"));
  const stateDir = join(dir, "never-created-live-state");
  const mailbox = reader([message(1)]);
  const config = parseConfig({ account, triage: { decisionModel: model } });
  const decisions: DecisionRuntimeV1 = { async evaluate() {
    throw new Error("classification service unavailable");
  } };
  try {
    const result = await previewMailbox({ config, stateDir, mail: mailbox.mail, subagent: noAgents, decisions, decisionModel: () => model }, {});
    assert.ok(!existsSync(stateDir));
    assert.equal(result.messages[0]?.disposition, "pending");
    assert.ok(result.errors.some(error => error.messageId === "aa01" && error.reason.includes("classification service unavailable")));
    assert.deepEqual(result.projected, { labels: [], trash: [], wakes: [], queue: [], skip: [], replies: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
