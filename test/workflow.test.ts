import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GogMailClient, parseConfig, type GmailMessage } from '../src/mail.js';
import { createMailWorkflow } from '../src/workflow.js';
import type { DecisionRuntimeV1, DecisionAnswer } from 'openclaw/plugin-sdk/decisions';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import plugin from '../src/index.js';
import { defaultPolicy } from '../src/policy.js';

const fakeGog = fileURLToPath(new URL('./fixtures/fake-gog.mjs', import.meta.url));
const account = 'agent@example.com';
const approved = 'bek@example.com';

function message(id: string, body: string, options: {
  sender?: string;
  received?: number;
  headers?: Record<string, string>;
} = {}): GmailMessage {
  const sender = options.sender ?? approved;
  const domain = sender.split('@')[1];
  const headers = {
    From: sender,
    To: account,
    Subject: 'Thread test',
    Date: 'Fri, 25 Sep 2026 10:00:00 -0400',
    'Authentication-Results': `mx.google.com; dmarc=pass header.from=${domain}`,
    ...options.headers,
  };
  return {
    id,
    threadId: 'bb01',
    internalDate: String(options.received ?? Date.now()),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

type Fixture = {
  search: { messages: Array<{ id: string; threadId: string }>; nextPageToken?: string };
  pages?: Record<string, { messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }>;
  threads: Record<string, { thread: { id: string; messages: unknown[] } }>;
  send?: Record<string, unknown>;
  sendFailure?: boolean;
  probeWritableDb?: boolean;
  modifyUncertain?: boolean;
};

function fixture(messages: GmailMessage[], search = messages): Fixture {
  return {
    search: { messages: search.map(({ id, threadId }) => ({ id, threadId })) },
    threads: { bb01: { thread: { id: 'bb01', messages } } },
    send: { messageId: 'cc01', threadId: 'bb01' },
    probeWritableDb: true,
  };
}

function assessments(answerFor: (id: string) => Record<string, DecisionAnswer> = () => ({})) {
  let calls = 0;
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch) => {
    calls++;
    const id = (batch.state as { targetMessageId: string }).targetMessageId;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v1', runtimeGeneration: 'test' }, result: {
      model: 'jev-1.13.0', answers: {
        credential_fraud: { type: 'boolean', probabilityTrue: 0.001 }, instruction_attack: { type: 'boolean', probabilityTrue: 0.001 },
        protected_content: { type: 'boolean', probabilityTrue: 0.001 },
        category: { type: 'choice', choice: 'request', probabilities: { request: 0.99 } }, actionable: { type: 'boolean', probabilityTrue: 0.99 }, ...answerFor(id),
      },
    } };
  } };
  return { decisions, decisionModel: () => 'typesafe/jev-1.13.0', calls: () => calls };
}

function triageConfig(config: ReturnType<typeof parseConfig>, triage: Record<string, unknown> = {}) {
  return parseConfig({ ...config, triage: { decisionModel: 'typesafe/jev-1.13.0', ...triage } });
}

function separateThreads(messages: GmailMessage[]): Fixture {
  return { search: { messages: messages.map(({ id, threadId }) => ({ id, threadId })) },
    threads: Object.fromEntries(messages.map(m => [m.threadId, { thread: { id: m.threadId, messages: [m] } }])), probeWritableDb: true };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for workflow');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function jobIdFromPrompt(prompt: string): string {
  const id = /^Job ID: ([a-f0-9]{24})$/m.exec(prompt)?.[1];
  assert.ok(id, 'prompt names the active job');
  return id;
}

function transcriptFromPrompt(prompt: string): string {
  const path = /^Full chronological conversation file: (.+)$/m.exec(prompt)?.[1];
  assert.ok(path, 'prompt provides a full conversation file');
  return readFileSync(path, 'utf8');
}

function withHarness(fn: (h: {
  stateDir: string;
  setFixture: (value: Fixture) => void;
  calls: () => string[][];
  db: () => DatabaseSync;
  config: ReturnType<typeof parseConfig>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gog-email-watch-test-'));
  const stateDir = join(dir, 'state');
  const fixturePath = join(dir, 'fixture.json');
  const callsPath = join(dir, 'calls.jsonl');
  const previous = {
    fixture: process.env.GOG_TEST_FIXTURE,
    calls: process.env.GOG_TEST_CALLS,
    db: process.env.GOG_TEST_DB,
  };
  process.env.GOG_TEST_FIXTURE = fixturePath;
  process.env.GOG_TEST_CALLS = callsPath;
  process.env.GOG_TEST_DB = join(stateDir, 'mail.sqlite');
  writeFileSync(callsPath, '');
  const config = parseConfig({ account, domains: ['example.com'], senders: [], gogPath: fakeGog });
  return fn({
    stateDir,
    setFixture: (value) => writeFileSync(fixturePath, JSON.stringify(value)),
    calls: () => readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    db: () => new DatabaseSync(join(stateDir, 'mail.sqlite')),
    config,
  }).finally(() => {
    for (const [name, value] of Object.entries({
      GOG_TEST_FIXTURE: previous.fixture,
      GOG_TEST_CALLS: previous.calls,
      GOG_TEST_DB: previous.db,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

test('registered service honors the canonical per-agent decision model before inference', async () => withHarness(async (h) => {
  const provider = assessments();
  const config = { agents: { defaults: { decisionModel: 'other/wrong' }, entries: { main: { decisionModel: 'typesafe/jev-1.13.0' } } } };
  let service: Parameters<OpenClawPluginApi['registerService']>[0] | undefined;
  const api = {
    pluginConfig: triageConfig(h.config),
    runtime: { config: { current: () => config }, decisions: provider.decisions, subagent: {} },
    registerService(value: Parameters<OpenClawPluginApi['registerService']>[0]) { service = value; },
    registerTool() {}, registerCommand() {}, registerGatewayMethod() {}, registerCli() {},
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  assert.ok(service);
  h.setFixture({ ...fixture([message('aa01', 'Please review the estimate')]), probeWritableDb: false });
  const context = { config: {}, stateDir: h.stateDir, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  try {
    await service.start(context);
    assert.equal(provider.calls(), 1, 'per-agent model must override the different default');
  } finally { await service.stop?.(context); }
}));

test('policy tools support ordinary and delegated agents without owner context while retaining version checks', async () => withHarness(async (h) => {
  let service: Parameters<OpenClawPluginApi['registerService']>[0] | undefined;
  let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
  const api = {
    pluginConfig: triageConfig(h.config),
    runtime: { config: { current: () => ({}) }, subagent: {} },
    registerService(value: Parameters<OpenClawPluginApi['registerService']>[0]) { service = value; },
    registerTool(value: Parameters<OpenClawPluginApi['registerTool']>[0]) { factory = value; },
    registerCommand() {}, registerGatewayMethod() {}, registerCli() {},
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  assert.ok(service); assert.equal(typeof factory, 'function');
  if (typeof factory !== 'function') throw new Error('tool factory missing');
  const context = { config: {}, stateDir: h.stateDir, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  h.setFixture({ ...fixture([]), probeWritableDb: false });
  try {
    await service.start(context);
    let version = 1;
    for (const sessionKey of ['agent:main:main', 'agent:helper:subagent:child', 'agent:main:gog-email-watch:agent@example.com:bb01']) {
      const agentTools = factory({ agentId: 'helper', sessionKey, senderIsOwner: false });
      assert.ok(Array.isArray(agentTools));
      const update = agentTools.find(tool => tool.name === 'gog_email_policy_update')!;
      const policy = { ...structuredClone(defaultPolicy), digestMinutes: 60, interests: `Updated by ${sessionKey}` };
      await update.execute('edit', { policy, expectedVersion: version });
      // Reusing the prior version would conceal a failed/no-op update.
      await assert.rejects(update.execute('stale', { policy, expectedVersion: version }), /version/);
      version++;
      const saved = await agentTools.find(tool => tool.name === 'gog_email_policy_get')!.execute('read', {});
      assert.ok(saved.details && typeof saved.details === 'object' && 'document' in saved.details);
      assert.deepEqual(saved.details.document, policy);
      await assert.rejects(update.execute('too-frequent', { policy: { ...policy, digestMinutes: 1 }, expectedVersion: version }), /invalid policy/);
    }
  } finally { await service.stop?.(context); }
}));

test('an unreadable thread does not discard healthy discoveries or block their dispatch', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  let workflow: ReturnType<typeof createMailWorkflow>;
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      workflow.skip({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    const f = fixture([message('aa01', 'Healthy request')]);
    f.search.messages.unshift({ id: 'ee01', threadId: 'ee02' });
    h.setFixture(f);
    await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.equal(workflow.status().messages.done, 1);
    assert.equal(workflow.status().messages.pending, 1);
  } finally { await workflow.stop(); }
}));

test('a missing send acknowledgment stays uncertain and cannot be skipped or replayed', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  let workflow: ReturnType<typeof createMailWorkflow>;
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Answer' }), /acknowledgment/);
      assert.throws(() => workflow.skip({ jobId, sessionKey, reason: 'No reply' }), /uncertain/);
      await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Retry' }), /duplicate/);
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    h.setFixture({ ...fixture([message('aa01', 'Please answer')]), send: {} });
    await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.equal(workflow.status().jobs.needs_review, 1);
    const db = h.db();
    assert.equal(db.prepare('SELECT status FROM replies').get()?.status, 'uncertain');
    db.close();
    assert.equal(h.calls().filter(args => args.includes('send')).length, 1);
  } finally { await workflow.stop(); }
}));

test('mail queued during a thread fetch is handled by the next job, not ignored', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const mail = new GogMailClient(h.config);
  const getThread = mail.getThread.bind(mail);
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  mail.getThread = async (id) => {
    const snapshot = await getThread(id);
    if (++reads === 2) await held;
    return snapshot;
  };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const jobs: string[] = [];
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, mail, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      jobs.push(jobId);
      workflow.skip({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    },
    waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    const first = message('aa01', 'First message');
    h.setFixture(fixture([first]));
    await workflow.poll();
    await waitFor(() => reads === 2);
    h.setFixture(fixture([first, message('aa02', 'Arrived during fetch')]));
    await workflow.poll();
    release();
    await waitFor(() => !workflow.status().working);
    assert.equal(jobs.length, 2);
    assert.deepEqual(workflow.status().messages, { done: 2 });
  } finally {
    release();
    await workflow.stop();
  }
}));

test('re-added domain and sender rules exclude mail from their disabled period', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const config = { ...h.config, domains: ['example.com', 'outside.test'], senders: ['bek@other.test'] };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = jobIdFromPrompt(prompt);
      workflow.skip({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    await workflow.stop();
    // Represent an earlier activation without waiting an hour in the test.
    const db = h.db();
    db.prepare("UPDATE meta SET value=? WHERE key='active_since' OR key LIKE 'domain:%' OR key LIKE 'sender:%'")
      .run(String(Math.floor(Date.now() / 1000) - 3600));
    db.close();
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
    await workflow.start();
    await workflow.stop();
    const old = Date.now() - 60_000;
    h.setFixture(fixture([
      message('aa01', 'While domain disabled', { sender: 'bek@outside.test', received: old }),
      message('aa02', 'While sender disabled', { sender: 'bek@other.test', received: old }),
      message('aa03', 'Still-approved sender', { received: old }),
    ]));
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
    await workflow.start();
    await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().messages, { done: 1, ignored: 2 });
    h.setFixture(fixture([
      message('aa04', 'After domain re-added', { sender: 'bek@outside.test' }),
      message('aa05', 'After sender re-added', { sender: 'bek@other.test' }),
    ]));
    await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().messages, { done: 3, ignored: 2 });
  } finally {
    await workflow.stop();
  }
}));

test('new mail uses full chronological thread and a stable session, then sends only through gog', async () => withHarness(async (h) => {
  const old = message('aa00', 'Original request', { received: Date.now() - 86_400_000 });
  const sent = message('aa02', 'Prior agent reply', { sender: account, received: Date.now() - 3000 });
  const external = message('aa03', 'External context', { sender: 'guest@outside.test', received: Date.now() - 2000 });
  const incoming = message('aa04', 'Please follow up.');
  h.setFixture(fixture([]));

  let workflow: ReturnType<typeof createMailWorkflow>;
  const runs: Array<{ sessionKey: string; message: string; deliver: false }> = [];
  const subagent = {
    run: async (params: { sessionKey: string; message: string; idempotencyKey: string; deliver: false; toolsAlsoAllow: string[] }) => {
      runs.push(params);
      const transcript = transcriptFromPrompt(params.message);
      assert.ok(transcript.indexOf('Original request') < transcript.indexOf('Prior agent reply'));
      assert.ok(transcript.indexOf('Prior agent reply') < transcript.indexOf('External context'));
      assert.ok(transcript.indexOf('External context') < transcript.indexOf('Please follow up.'));
      await workflow.reply({ jobId: jobIdFromPrompt(params.message), sessionKey: params.sessionKey, body: 'Here is the answer.' });
      return { runId: 'run-1', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  await workflow.start();
  const pollFixture = fixture([incoming, external, old, sent], [incoming]);
  // Gmail can omit the value of an empty header in an otherwise valid thread.
  pollFixture.threads.bb01!.thread.messages[0] = {
    ...incoming,
    payload: {
      ...incoming.payload,
      headers: [...(incoming.payload.headers ?? []), { name: 'X-MS-TNEF-Correlator' }],
    },
  };
  h.setFixture(pollFixture);
  await workflow.poll();
  await waitFor(() => workflow.status().jobs.replied === 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.sessionKey, `agent:main:gog-email-watch:${account}:bb01`);
  const send = h.calls().find((args) => args.includes('send'));
  assert.ok(send);
  assert.equal(send[send.indexOf('--to') + 1], approved);
  assert.equal(send[send.indexOf('--reply-to-message-id') + 1], incoming.id);
  assert.ok(!send.includes('--reply-all'));
  const db = h.db();
  assert.equal((db.prepare("SELECT status FROM messages WHERE id='aa04'").get() as { status: string }).status, 'done');
  db.close();
  await workflow.stop();
}));

test('duplicate mail and restart do not dispatch again; an explicit skip completes a job', async () => withHarness(async (h) => {
  const incoming = message('aa01', 'No reply is needed.');
  h.setFixture(fixture([]));
  let runs = 0;
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent = {
    run: async (params: { sessionKey: string; message: string; idempotencyKey: string; deliver: false; toolsAlsoAllow: string[] }) => {
      runs++;
      workflow.skip({ jobId: jobIdFromPrompt(params.message), sessionKey: params.sessionKey, reason: 'Already handled' });
      return { runId: 'run-2', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  await workflow.start();
  h.setFixture(fixture([incoming]));
  await workflow.poll();
  await waitFor(() => workflow.status().jobs.skipped === 1);
  await workflow.stop();
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  await workflow.start();
  await workflow.processNext();
  assert.equal(runs, 1);
  assert.equal(h.calls().filter((args) => args.includes('send')).length, 0);
  const db = h.db();
  assert.equal((db.prepare("SELECT status FROM jobs").get() as { status: string }).status, 'skipped');
  db.close();
  await workflow.stop();
}));

test('rejects an unapproved sender and durably retries a failed Gmail thread read', async () => withHarness(async (h) => {
  const rejected = message('aa01', 'Do not dispatch me', { sender: 'bad@outside.test' });
  h.setFixture(fixture([]));
  let runs = 0;
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent = {
    run: async (params: { sessionKey: string; message: string; idempotencyKey: string; deliver: false; toolsAlsoAllow: string[] }) => {
      runs++;
      workflow.skip({ jobId: jobIdFromPrompt(params.message), sessionKey: params.sessionKey, reason: 'Handled' });
      return { runId: 'run-4', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  await workflow.start();
  h.setFixture(fixture([rejected]));
  await workflow.poll();
  await workflow.processNext();
  assert.equal(runs, 0);
  const incoming = message('aa02', 'Please respond.');
  h.setFixture({ ...fixture([incoming]), threads: {} });
  await workflow.poll();
  const db = h.db();
  assert.equal(db.prepare("SELECT status FROM messages WHERE id='aa02'").get()?.status, 'pending');
  db.prepare("UPDATE messages SET due=0 WHERE id='aa02'").run();
  db.close();
  h.setFixture(fixture([incoming]));
  await workflow.poll();
  await waitFor(() => workflow.status().jobs.skipped === 1);
  assert.equal(runs, 1);
  await workflow.stop();
}));

test('uncertain alternate-target send cannot be retried or converted into skip', async () => withHarness(async (h) => {
  const earlier = message('aa00', 'Scheduling guest', { received: Date.now() - 3000,
    headers: { To: `${account}, guest@outside.test` } });
  const incoming = message('aa01', 'Please confirm the meeting.');
  h.setFixture(fixture([]));
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent = {
    run: async (params: { sessionKey: string; message: string; idempotencyKey: string; deliver: false; toolsAlsoAllow: string[] }) => {
      const jobId = jobIdFromPrompt(params.message);
      await assert.rejects(workflow.reply({ jobId, sessionKey: params.sessionKey, body: 'Confirmed.',
        externalScheduling: true, replyTargetMessageId: earlier.id }));
      assert.throws(() => workflow.skip({ jobId, sessionKey: params.sessionKey, reason: 'No reply needed' }));
      await assert.rejects(workflow.reply({ jobId, sessionKey: params.sessionKey, body: 'Try again.',
        externalScheduling: true, replyTargetMessageId: earlier.id }));
      return { runId: 'run-3', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  await workflow.start();
  h.setFixture({ ...fixture([earlier, incoming], [incoming]), sendFailure: true });
  await workflow.poll();
  await waitFor(() => workflow.status().jobs.needs_review === 1);
  assert.equal(h.calls().filter((args) => args.includes('send')).length, 1);
  const db = h.db();
  assert.equal((db.prepare('SELECT status FROM jobs').get() as { status: string }).status, 'needs_review');
  db.close();
  await workflow.stop();
}));

test('shadow assessments are durable, threshold previews reuse them, and question changes require new evidence', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const config = triageConfig(h.config);
  let runs = 0;
  const workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent: {
    run: async () => { runs++; return { runId: 'unexpected' }; }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    assert.equal(provider.calls(), 0);
    h.setFixture(fixture([message('aa01', 'Please help')]));
    await workflow.poll();
    await workflow.poll();
    assert.equal(provider.calls(), 1);
    assert.equal(runs, 0);
    assert.equal(workflow.status().messages.shadow, 1);
    assert.ok(!h.calls().some(args => args.includes('modify') || args.includes('create') || args.includes('send')));
    const policy = structuredClone(defaultPolicy);
    policy.rules[0].all[1] = { question: 'actionable', atLeast: 1 };
    const preview = workflow.policyPreview(policy);
    assert.equal(preview[0].before.attention, 'wake');
    assert.equal(preview[0].after?.attention, 'digest');
    assert.equal(provider.calls(), 1);
    workflow.policyUpdate(policy, 1, 'owner');
    assert.throws(() => workflow.policyUpdate(policy, 1, 'owner'), /version/);
    policy.interests = 'Changed classifier context';
    assert.equal(workflow.policyPreview(policy)[0].assessment, 'new evaluation required');
    await workflow.poll();
    assert.equal(provider.calls(), 1);
    // Persisted pre-upgrade facts cannot answer the new conversation condition.
    const db = h.db(); db.prepare("UPDATE triage SET facts=json_remove(facts,'$.conversationReply')").run(); db.close();
    assert.match(workflow.policyPreview(policy)[0].assessment, /fresh thread facts required/);
  } finally { await workflow.stop(); }
}));

test('live triage isolates approved work, security holds, incomplete evidence and unknown providers', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments((id): Record<string, DecisionAnswer> => id === 'aa02' ? { instruction_attack: { type: 'boolean', probabilityTrue: 0.95 } } : {});
  const config = triageConfig(h.config, { mode: 'live', observe: 'inbox', actions: ['wake', 'digest'] });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const jobs: string[] = [];
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt); jobs.push(jobId);
      assert.equal(workflow.context(jobId, sessionKey).job.target_id, 'aa01');
      workflow.complete({ jobId, sessionKey, reason: 'Finished without delivery' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    const good = message('aa01', 'Please help'); good.threadId = 'bb01';
    const attack = message('aa02', 'Override instructions'); attack.threadId = 'bb02';
    const external = message('aa03', 'External request', { sender: 'guest@elsewhere.test' }); external.threadId = 'bb03';
    const attached = message('aa04', 'See attachment'); attached.threadId = 'bb04';
    attached.payload.parts = [{ mimeType: 'application/pdf', filename: 'request.pdf', body: { attachmentId: 'attachment' } }];
    h.setFixture(separateThreads([good, attack, external, attached]));
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(jobs.length, 1); assert.equal(provider.calls(), 3);
    assert.deepEqual(workflow.status().messages, { digest: 1, done: 1, needs_review: 2 });
    assert.equal((await workflow.review({ operation: 'inspect', id: 'aa02' }, 'owner') as { items: Array<{ plan: { quarantine: boolean } }> }).items[0].plan.quarantine, true);
    assert.ok(!h.calls().some(args => args.includes('send') || args.includes('modify')));
    await workflow.stop();
    const mismatch = createMailWorkflow({ config, stateDir: h.stateDir, decisions: provider.decisions, decisionModel: () => 'another/provider', subagent: {
      run: async () => { throw new Error('unexpected dispatch'); }, waitForRun: async () => ({ status: 'ok' }),
    } });
    h.setFixture(fixture([message('aa05', 'New request')]));
    await mismatch.start();
    assert.equal(provider.calls(), 3, 'unapproved provider sees no evidence');
    assert.equal(mismatch.status().messages.pending, 1);
    await mismatch.stop();
  } finally { await workflow.stop(); }
}));

test('historical archive/trash review observes mail without writes, dispatch or consuming activation state', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments(id => ({ actionable: { type: 'boolean', probabilityTrue: 0.01 }, category: { type: 'choice', choice: id === 'aa01' ? 'marketing' : 'newsletter', probabilities: { marketing: id === 'aa01' ? 0.99 : 0.01, newsletter: id === 'aa01' ? 0.01 : 0.99 } } }));
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { mode: 'live' }), stateDir: h.stateDir, ...provider, subagent: {
    run: async () => { throw new Error('historical review must never dispatch'); }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    const first = message('aa01', 'Promotion', { sender: 'news@elsewhere.test', received: Date.now() - 86400000 });
    const second = message('aa02', 'Newsletter', { sender: 'list@elsewhere.test', received: Date.now() - 86400000 }); second.threadId = 'bb02';
    h.setFixture(separateThreads([first, second]));
    const report = await workflow.review({ operation: 'scan', limit: 2, days: 7 }, 'owner') as { reviewOnly: boolean; sampled: number };
    assert.equal(report.reviewOnly, true); assert.equal(report.sampled, 2);
    const trash = await workflow.review({ operation: 'list', disposition: 'trash' }, 'owner') as { items: Array<{ plan: { mutationReview: boolean } }> };
    assert.equal(trash.items.length, 1); assert.equal(trash.items[0].plan.mutationReview, true);
    assert.deepEqual(workflow.status().messages, {});
    assert.deepEqual(workflow.status().jobs, {});
    assert.ok(!h.calls().some(args => args.includes('send') || args.includes('modify') || args.includes('create')));
  } finally { await workflow.stop(); }
}));

test('message-scoped archive receipts reconcile after a lost acknowledgment without replaying the effect', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments(() => ({ actionable: { type: 'boolean', probabilityTrue: 0.01 }, category: { type: 'choice', choice: 'newsletter', probabilities: { newsletter: 0.99 } } }));
  const config = triageConfig(h.config, { mode: 'live', observe: 'inbox', actions: ['label', 'archive', 'digest'], reviewActions: ['trash'] });
  const subagent = { run: async () => { throw new Error('unexpected wake'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start();
    const target = message('aa01', 'Newsletter', { sender: 'news@elsewhere.test' });
    const protectedSibling = message('aa02', 'Invoice from same sender', { received: Date.now() - 86400000 });
    protectedSibling.labelIds.push('STARRED');
    h.setFixture({ ...fixture([target, protectedSibling], [target]), modifyUncertain: true });
    await workflow.poll();
    assert.equal(workflow.status().messages.pending, 1);
    const modified = h.calls().filter(args => args.includes('modify'));
    assert.equal(modified.length, 1); assert.ok(modified[0].includes('aa01')); assert.ok(!modified[0].includes('aa02'));
    await workflow.stop();
    const db = h.db(); db.prepare("UPDATE messages SET due=0 WHERE id='aa01'").run(); db.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.equal(workflow.status().messages.digest, 1);
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 1);
    const check = h.db(); assert.equal(check.prepare('SELECT status FROM effects').get()?.status, 'confirmed'); check.close();
  } finally { await workflow.stop(); }
}));

test('changed thread evidence blocks a reply and resolving the hold never replays its job', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const config = triageConfig(h.config, { mode: 'live', actions: ['wake'] });
  let workflow: ReturnType<typeof createMailWorkflow>, heldId = '', blocked = false;
  const first = message('aa01', 'Please reply');
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      heldId = jobIdFromPrompt(prompt);
      h.setFixture(fixture([first, message('aa02', 'New unassessed context')]));
      await assert.rejects(workflow.reply({ jobId: heldId, sessionKey, body: 'Stale answer' }), /thread changed/);
      blocked = true; return { runId: heldId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); h.setFixture(fixture([first]));
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(blocked, true); assert.equal(workflow.status().jobs.needs_review, 1);
    await workflow.review({ operation: 'close', id: heldId, note: 'Confirmed no send; prior request no longer requires action' }, 'owner');
    assert.equal(workflow.status().jobs.completed, 1);
    assert.equal(h.calls().filter(args => args.includes('send')).length, 0);
  } finally { await workflow.stop(); }
}));

test('persisted page progress drains beyond the poll bound without losing discovered messages', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const config = triageConfig(h.config);
  const subagent = { run: async () => { throw new Error('shadow dispatch'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start();
    const messages = [1, 2, 3, 4].map(i => { const m = message(`aa0${i}`, 'Please help'); m.threadId = `bb0${i}`; return m; });
    const f = separateThreads(messages);
    f.search = { messages: [f.search.messages[0]], nextPageToken: 'second' };
    f.pages = { second: { messages: [{ id: 'aa02', threadId: 'bb02' }], nextPageToken: 'third' }, third: { messages: [{ id: 'aa03', threadId: 'bb03' }], nextPageToken: 'fourth' }, fourth: { messages: [{ id: 'aa04', threadId: 'bb04' }] } };
    h.setFixture(f);
    await workflow.poll(); assert.equal(workflow.status().messages.shadow, 3);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.equal(workflow.status().messages.shadow, 4); assert.equal(provider.calls(), 4);
  } finally { await workflow.stop(); }
}));

test('deferred work resumes once with fresh checks', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const config = triageConfig(h.config, { mode: 'live', actions: ['wake', 'digest'] });
  let workflow: ReturnType<typeof createMailWorkflow>, runs = 0;
  const subagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      runs++;
      const jobId = /Job ID: ([a-f0-9]{24})/.exec(prompt)![1];
      if (runs === 1) workflow.complete({ jobId, sessionKey, reason: 'Waiting for scheduled check' }, Math.floor(Date.now() / 1000) + 3600);
      else workflow.complete({ jobId, sessionKey, reason: 'Completed' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); h.setFixture(fixture([message('aa01', 'Please help')]));
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(workflow.status().messages.deferred, 1);
    const db = h.db(); db.prepare("UPDATE messages SET due=0 WHERE status='deferred'").run(); db.close();
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(runs, 2); assert.equal(workflow.status().jobs.completed, 1);
  } finally { await workflow.stop(); }
}));

test('new human replies in participated conversations wake without an actionable request', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments(id => ({ actionable: { type: 'boolean', probabilityTrue: 0.01 },
    ...(id === 'aa04' ? { credential_fraud: { type: 'boolean' as const, probabilityTrue: 0.9 } } : {}) }));
  const config = triageConfig(h.config, { mode: 'live', actions: ['wake', 'digest'] });
  const targets: string[] = [];
  let workflow: ReturnType<typeof createMailWorkflow>;
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      targets.push(workflow.context(jobId, sessionKey).job.target_id);
      workflow.complete({ jobId, sessionKey, reason: 'Conversation update acknowledged' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    const replies = [1, 2, 3, 4].map(i => { const m = message(`aa0${i}`, 'Thanks, that works.'); m.threadId = `bb0${i}`; return m; });
    const f = separateThreads(replies);
    for (const [i, reply] of replies.entries()) {
      const prior = message(`cc0${i}`, 'My earlier contribution', { sender: account, received: Date.now() - 60000 });
      prior.threadId = reply.threadId;
      // Merely quoting/forging our From address or having other thread traffic is insufficient.
      if (i !== 1) prior.labelIds = ['SENT'];
      if (i === 2) prior.internalDate = String(Number(reply.internalDate) + 1000);
      f.threads[reply.threadId].thread.messages.unshift(prior);
    }
    h.setFixture(f); await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(targets, ['aa01']);
    assert.deepEqual(workflow.status().messages, { done: 1, digest: 2, needs_review: 1 });
  } finally { await workflow.stop(); }
}));

test('digest cadence batches staggered arrivals and survives restart and interval changes', async (t) => withHarness(async (h) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const advance = (minutes: number) => t.mock.timers.setTime(Date.now() + minutes * 60000);
  h.setFixture(fixture([]));
  const provider = assessments(() => ({ actionable: { type: 'boolean', probabilityTrue: 0.01 } }));
  const policy = { ...structuredClone(defaultPolicy), digestMinutes: 60 };
  const config = triageConfig(h.config, { mode: 'live', actions: ['wake', 'digest'], policy });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const batches: string[][] = [];
  const subagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = /Job ID: ([a-f0-9]{24})/.exec(prompt)![1];
      const context = workflow.context(jobId, sessionKey);
      assert.equal(context.replyAllowed, false);
      batches.push(context.messages.map(m => m.id));
      workflow.complete({ jobId, sessionKey, reason: 'Digest summarized' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start();
    h.setFixture(fixture([message('aa01', 'First update')])); await workflow.poll();
    advance(30);
    h.setFixture(fixture([message('aa02', 'Another update')])); await workflow.poll();
    advance(29); await workflow.processNext(); assert.equal(batches.length, 0);
    advance(1); await workflow.processNext();
    assert.deepEqual(batches, [['aa01', 'aa02']], 'one batch includes the newer pending item too');
    advance(1);
    h.setFixture(fixture([message('aa03', 'Next interval')])); await workflow.poll();
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); await workflow.processNext(); assert.equal(batches.length, 1);
    advance(29);
    workflow.policyUpdate({ ...policy, digestMinutes: 30 }, 1, 'owner');
    await workflow.poll(); await workflow.processNext();
    assert.deepEqual(batches, [['aa01', 'aa02'], ['aa03']], 'shortening the interval applies to already pending mail');
    assert.equal(provider.calls(), 3, 'scheduling changes do not reclassify unchanged evidence');
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); await workflow.processNext(); assert.equal(batches.length, 2);
  } finally { await workflow.stop(); }
}));

test('external conversation wakes require opt-in, fresh authenticated human replies and retain send restrictions', async (t) => withHarness(async (h) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const provider = assessments(id => ({ actionable: { type: 'boolean', probabilityTrue: 0.01 },
    ...(id === 'aa07' ? { credential_fraud: { type: 'boolean' as const, probabilityTrue: 0.9 } } : {}) }));
  const disabled = triageConfig(h.config, { mode: 'live', actions: ['wake', 'digest'] });
  const enabled = triageConfig(h.config, { mode: 'live', actions: ['wake', 'digest'], wakeOnExternalReplies: true });
  const reply = (id: string, headers: Record<string, string> = {}) => {
    const m = message(id, 'Here is the update', { sender: 'guest@elsewhere.test', headers });
    m.threadId = `bb${id.slice(2)}`;
    return m;
  };
  const conversations = (messages: GmailMessage[]) => {
    const f = separateThreads(messages);
    for (const m of messages) {
      const sent = message(`cc${m.id.slice(2)}`, 'My earlier message', { sender: account, received: Date.now() - 3600000 });
      sent.threadId = m.threadId; sent.labelIds = m.id === 'aa03' ? ['INBOX'] : ['SENT'];
      f.threads[m.threadId].thread.messages.unshift(sent);
    }
    return f;
  };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const targets: string[] = [];
  const subagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
      targets.push(context.job.target_id); assert.equal(context.replyAllowed, false);
      await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Not authorized' }), /reply target rejected/);
      workflow.complete({ jobId, sessionKey, reason: 'External update reviewed without sending' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  h.setFixture(fixture([]));
  workflow = createMailWorkflow({ config: disabled, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); h.setFixture(conversations([reply('aa01')])); await workflow.poll();
    assert.equal(provider.calls(), 0, 'unapproved external mail is not shared for classification');
    await workflow.stop();
    const old = reply('aa06');
    t.mock.timers.setTime(Date.now() + 60000);
    h.setFixture(fixture([]));
    workflow = createMailWorkflow({ config: enabled, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    h.setFixture(conversations([reply('aa02'), reply('aa03'), reply('aa04', { 'Auto-Submitted': 'auto-replied' }),
      reply('aa05', { 'Authentication-Results': 'mx.google.com; dmarc=fail header.from=elsewhere.test' }), old, reply('aa07')]));
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(targets, ['aa02']); assert.equal(provider.calls(), 2);
    assert.equal(workflow.status().messages.needs_review, 1, 'security checks still hold conversation replies');
    assert.ok(h.calls().some(args => args.includes('search') && args.some(value => value.includes('in:inbox'))));
    assert.equal(h.calls().filter(args => args.includes('send')).length, 0);
    await workflow.stop();
    h.setFixture(fixture([]));
    workflow = createMailWorkflow({ config: disabled, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); await workflow.stop();
    const disabledPeriod = reply('aa08');
    t.mock.timers.setTime(Date.now() + 60000);
    workflow = createMailWorkflow({ config: enabled, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); h.setFixture(conversations([disabledPeriod, reply('aa09')]));
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(targets, ['aa02', 'aa09'], 're-enabling does not replay the disabled period');
  } finally { await workflow.stop(); }
}));
