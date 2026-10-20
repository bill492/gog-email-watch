import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GogMailClient, parseConfig, type GmailMessage } from '../src/mail.js';
import { createMailWorkflow, type MailSubagent, type WorkflowOptions } from '../src/workflow.js';
import type { DecisionRuntimeV1, DecisionAnswer } from 'openclaw/plugin-sdk/decisions';
import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
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
  threadDelayMs?: number;
  labels?: Array<{ id: string; name: string; type: 'user' | 'system' }>;
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
    const id = (batch.state as { threadId: string }).threadId;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v1', runtimeGeneration: 'test' }, result: {
      model: 'jev-1.13.0', answers: {
        action: { type: 'choice', choice: 'queue', probabilities: { queue: 1 } }, ...answerFor(id),
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
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('timed out waiting for workflow');
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
  sentBody: () => string;
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
    sentBody: () => readFileSync(`${callsPath}.body.html`, 'utf8'),
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

test('registered service starts without waiting for inference and honors the canonical per-agent model', async () => withHarness(async (h) => {
  const provider = assessments();
  let release!: () => void;
  const inference = new Promise<void>(resolve => { release = resolve; });
  const decisions: DecisionRuntimeV1 = { evaluate: async (...args) => {
    const result = provider.decisions.evaluate(...args);
    await inference;
    return result;
  } };
  const config = { agents: { defaults: { decisionModel: 'other/wrong' }, entries: { main: { decisionModel: 'typesafe/jev-1.13.0' } } } };
  let service: Parameters<OpenClawPluginApi['registerService']>[0] | undefined;
  const api = {
    pluginConfig: triageConfig(h.config),
    runtime: { config: { current: () => config }, decisions, subagent: {} },
    registerService(value: Parameters<OpenClawPluginApi['registerService']>[0]) { service = value; },
    registerTool() {}, registerCommand() {}, registerGatewayMethod() {}, registerCli() {},
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  assert.ok(service);
  h.setFixture({ ...fixture([message('aa01', 'Please review the estimate', { received: Date.now() - 60000 })]), probeWritableDb: false });
  const context = { config: {}, stateDir: h.stateDir, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  let ready = false;
  const started = Promise.resolve(service.start(context)).then(() => { ready = true; });
  try {
    await waitFor(() => provider.calls() === 1);
    assert.equal(ready, true, 'Gateway activation must not wait for mailbox work');
    assert.equal(provider.calls(), 1, 'per-agent model must override the different default');
  } finally { release(); await started; await service.stop?.(context); }
}));

test('policy tools support ordinary and delegated agents without owner context while retaining version checks', async () => withHarness(async (h) => {
  let service: Parameters<OpenClawPluginApi['registerService']>[0] | undefined;
  let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
  const api = {
    pluginConfig: h.config,
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
      const health = await agentTools.find(tool => tool.name === 'gog_email_status')!.execute('status', {});
      assert.ok(health.details && typeof health.details === 'object' && 'running' in health.details);
      assert.equal(health.details.running, true);
      assert.ok('triageEnabled' in health.details);
      assert.equal(health.details.triageEnabled, false);
      const inspectTool: AnyAgentTool = agentTools.find(tool => tool.name === 'gog_email_inspect')!;
      assert.deepEqual((await inspectTool.execute('messages', {})).details, []);
      assert.deepEqual((await inspectTool.execute('scan', { scan: true })).details, null);
      await assert.rejects(inspectTool.execute('job', { jobId: 'missing' }), /job not found/);
      await assert.rejects(inspectTool.execute('ambiguous', { id: 'aa01', jobId: 'missing' }), /choose only one/);
      const update = agentTools.find(tool => tool.name === 'gog_email_policy_update')!;
      const policy = { ...structuredClone(defaultPolicy), queueMinutes: 0.5, prompt: `Updated by ${sessionKey}` };
      await update.execute('edit', { policy, expectedVersion: version });
      // Reusing the prior version would conceal a failed/no-op update.
      await assert.rejects(update.execute('stale', { policy, expectedVersion: version }), /version/);
      version++;
      const saved = await agentTools.find(tool => tool.name === 'gog_email_policy_get')!.execute('read', {});
      assert.ok(saved.details && typeof saved.details === 'object' && 'document' in saved.details);
      assert.deepEqual(saved.details.document, policy);
      assert.equal(saved.details.document.queueMinutes, 0.5, 'sub-minute intervals are supported');
      await update.execute('settings', { expectedVersion: version, settings: { wakePrompt: `Instructions from ${sessionKey}`, concurrency: 7, labelConcurrency: 2 } });
      version++;
      const runtime = await agentTools.find(tool => tool.name === 'gog_email_policy_get')!.execute('read-settings', {});
      assert.ok(runtime.details && typeof runtime.details === 'object' && 'settings' in runtime.details);
      assert.equal((runtime.details.settings as { labelConcurrency: number }).labelConcurrency, 2);
      await assert.rejects(update.execute('empty', { expectedVersion: version }), /invalid|provide/);
    }
  } finally { await service.stop?.(context); }
}));

test('live settings reschedule polling, tune discovery and survive restarts without triage', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  h.setFixture(fixture([]));
  const subagent: MailSubagent = { run: async () => { throw new Error('empty inbox'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  const searches = () => h.calls().filter(args => args.includes('search'));
  try {
    await workflow.start();
    workflow.policyUpdate(undefined, 1, 'main', { pollIntervalSeconds: 1, concurrency: 7,
      discoveryOverlapSeconds: 20, reconcileIntervalSeconds: 100, reconcileLookbackSeconds: 200 });
    assert.equal(workflow.policyGet().settings.labelConcurrency, 7);
    assert.equal(workflow.policyGet().settings.retryDelaySeconds, 1);
    assert.equal(workflow.policyGet().configuredSettings.labelConcurrency, null);
    assert.equal(workflow.policyGet().configuredSettings.retryDelaySeconds, null);
    // A long gap catches up first. Subsequent timer-driven polls use the new overlap.
    t.mock.timers.setTime(Date.now() + 3600000);
    await workflow.poll();
    let before = searches().length;
    const lastPoll = workflow.status().lastPoll;
    t.mock.timers.tick(1000);
    await waitFor(() => searches().length > before && !workflow.status().polling);
    assert.ok(searches().at(-1)!.some(arg => arg.includes(`after:${lastPoll - 20} `)));
    workflow.policyUpdate(undefined, 2, 'main', { reconcileIntervalSeconds: 2, reconcileLookbackSeconds: 600, labelConcurrency: 2 });
    before = searches().length;
    t.mock.timers.tick(1000);
    await waitFor(() => searches().length > before && !workflow.status().polling);
    assert.ok(searches().at(-1)!.some(arg => arg.includes(`after:${Math.floor(Date.now() / 1000) - 600} `)));
    const saved = workflow.policyGet();
    assert.equal(saved.configuredSettings.labelConcurrency, 2);
    await workflow.stop();
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet(), saved);
    workflow.policyUpdate(undefined, saved.version, 'main', { concurrency: 9, labelConcurrency: null, retryDelaySeconds: null });
    assert.equal(workflow.policyGet().settings.labelConcurrency, 9);
    assert.equal(workflow.policyGet().configuredSettings.labelConcurrency, null);
    assert.equal(workflow.policyGet().settings.retryDelaySeconds, 1);
    await workflow.stop();
    const edited = parseConfig({ ...h.config, settings: { pollIntervalSeconds: 3, responderPrompt: 'File override' } });
    workflow = createMailWorkflow({ config: edited, stateDir: h.stateDir, subagent });
    await workflow.start();
    assert.equal(workflow.policyGet().settings.pollIntervalSeconds, 3);
    assert.equal(workflow.policyGet().settings.responderPrompt, 'File override');
  } finally { await workflow.stop(); }
}));

test('retry deadlines and timeout overrides survive restart without replaying queued chains', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 19, 12).getTime() });
  const target = message('aa02', 'TARGET ' + '😀'.repeat(300) + ' TAIL', { received: Date.now() - 60000 });
  const sibling = message('aa01', 'SIBLING_CONTEXT', { received: Date.parse('2026-09-24T10:00:00Z'), headers: { Date: '' } });
  h.setFixture(fixture([sibling, target], [target]));
  const requests: Array<{ evidence: string; instructions: string; timeout: number }> = [];
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    requests.push({ evidence: JSON.stringify((batch.state as { evidence: unknown }).evidence), instructions: JSON.stringify(batch.questions), timeout: opts.timeoutMs });
    if (requests.length === 1) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = parseConfig({ ...triageConfig(h.config), settings: {
    evidence: { maxBytes: 1024, context: 'message' }, decisionTimeoutSeconds: 12.5, retryDelaySeconds: 5,
  } });
  const subagent: MailSubagent = { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start();
    assert.equal(workflow.status().messages.pending, 1);
    t.mock.timers.setTime(Date.now() + 2000); await workflow.poll(); assert.equal(requests.length, 1);
    t.mock.timers.setTime(Date.now() + 3000); await workflow.poll();
    assert.equal(workflow.status().messages.queue, 1); assert.equal(requests.length, 2);
    assert.equal(requests[1].timeout, 12500);
    assert.ok(requests[1].evidence.includes('TARGET') && requests[1].evidence.includes('TAIL'));
    assert.ok(requests[1].evidence.includes('Sent date: Fri, 25 Sep 2026 10:00:00 -0400'));
    assert.match(requests[1].instructions, /Today's date: 2026-10-19 \([^)]+\)/);
    assert.ok(requests[1].evidence.includes('SIBLING_CONTEXT'));
    workflow.policyUpdate(undefined, 1, 'main', { wakePrompt: 'Handle succinctly', decisionTimeoutSeconds: 45, concurrency: 3 });
    await workflow.poll(); assert.equal(requests.length, 2, 'operational settings do not reclassify queue');
    workflow.policyUpdate(undefined, 2, 'main', { evidence: { maxBytes: 4096, context: 'thread' } });
    await workflow.poll();
    assert.equal(requests.length, 2, 'deprecated evidence knobs do not truncate or invalidate a chain');
    workflow.policyUpdate({ ...defaultPolicy, prompt: 'Queue project work; skip resolved requests.' }, 3, 'main');
    await workflow.poll();
    assert.equal(requests.length, 3); assert.equal(requests[2].timeout, 45000);
    assert.ok(requests[2].evidence.includes('TAIL') && requests[2].evidence.includes('SIBLING_CONTEXT'));
    assert.ok(requests[2].evidence.includes('2026-09-24T10:00:00.000Z (Gmail timestamp; sent Date header missing)'));
    assert.match(readFileSync(join(h.stateDir, 'triage', 'aa02.md'), 'utf8'), /Sent date: 2026-09-24T10:00:00.000Z \(Gmail timestamp; sent Date header missing\)/);
    const saved = workflow.policyGet();
    await workflow.stop();
    // v0.3.3 persisted this file fingerprint, including the now-ignored evidence knobs.
    const legacy = h.db();
    legacy.prepare("UPDATE meta SET value=? WHERE key='runtime_config_settings'").run('f43c4abbc9516d550f1e7a1c36f55ff3bf19ebaccce407c7ecbe08a1cf168dc0');
    legacy.prepare('UPDATE policies SET settings=? WHERE version=?').run(JSON.stringify({ ...saved.configuredSettings, evidence: { maxBytes: 1024, context: 'message' } }), saved.version);
    legacy.prepare("DELETE FROM meta WHERE key='triage_unit'").run();
    legacy.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet(), { ...saved, version: saved.version + 1 }); assert.equal(requests.length, 3);
  } finally { await workflow.stop(); }
}));

test('a whole chain is classified once with full plaintext, then wakes once with independent chain labels', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const body = 'TARGET_REQUEST ' + 'plain mail content '.repeat(2000) + ' END_OF_LONG_MESSAGE';
  const target = message('aa01', body, { received: Date.now() - 60000 });
  const followup = message('aa04', 'FOLLOWUP_REQUEST', { received: Date.now() - 45000 });
  const reply = message('aa02', 'ALREADY_COMPLETED: I sent the requested files.', { sender: account, received: Date.now() - 30000,
    headers: { Date: 'Mon, 19 Oct 2026 10:00:00 -0400' } });
  reply.labelIds = ['SENT'];
  const draft = message('aa03', 'UNSENT_DRAFT', { sender: account }); draft.labelIds = ['DRAFT'];
  h.setFixture(fixture([target, followup, reply, draft], [target, followup]));
  const provider = assessments();
  let actions = 0, labels = 0, wakes = 0;
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, options) => {
    const input = batch.state as { evidence: { text: string } };
    assert.ok(input.evidence.text.includes(body), 'no byte truncation, including with legacy maxBytes configured');
    assert.ok(input.evidence.text.includes('FOLLOWUP_REQUEST'));
    assert.ok(input.evidence.text.includes('ALREADY_COMPLETED'), 'a long target must not crowd out the latest sent reply');
    assert.ok(!input.evidence.text.includes('UNSENT_DRAFT'));
    const label = options.purpose.endsWith('.labels');
    if (label) labels++; else actions++;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: options.rubricVersion, runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(batch.questions).map(id =>
        [id, { type: 'choice', choice: label ? 'apply' : 'queue', probabilities: {} }])) } };
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const config = triageConfig(parseConfig({ ...h.config, settings: { evidence: { maxBytes: 1024, context: 'message' } } }),
    { policy: { ...defaultPolicy, queueMinutes: 2, labels: [{ name: 'Project', description: 'Project conversations' }] } });
  const subagent: MailSubagent = { run: async ({ sessionKey, message: prompt }) => {
    wakes++;
    const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
    assert.equal(context.messages.length, 1, 'the agent sees one conversation, not duplicate entries');
    assert.match(readFileSync(context.messages[0].transcript!, 'utf8'), /END_OF_LONG_MESSAGE/);
    workflow.complete({ jobId, sessionKey, reason: 'Chain handled' }); return { runId: jobId };
  }, waitForRun: async () => ({ status: 'ok' }) };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start();
    assert.deepEqual(workflow.status().messages, { queue: 2 }, 'both members share one decision');
    await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(actions, 1); assert.equal(labels, 1); assert.equal(wakes, 0);
    const current = await new GogMailClient(h.config).getThread('bb01');
    assert.ok(current.messages.filter(m => ['aa01', 'aa04'].includes(m.id)).every(m => m.labelIds.includes('Label_1')));
    assert.deepEqual(current.messages.find(m => m.id === reply.id)!.labelIds, ['SENT']);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start();
    t.mock.timers.setTime(Date.now() + 120000); await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.equal(actions, 1); assert.equal(labels, 1); assert.equal(wakes, 1);
    assert.deepEqual(workflow.status().messages, { done: 2 });
  } finally { await workflow.stop(); }
}));

test('due wakes refresh changed threads, retain unresolved follow-ups, and retry unreadable mail without replaying unchanged decisions', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const targets = Array.from({ length: 5 }, (_, i) => {
    const target = message(`aa0${i + 1}`, 'Original request', { received: Date.now() - 60000 });
    target.threadId = `bb0${i + 1}`; return target;
  });
  const sibling = { ...message('aa06', 'Another request in this chain', { received: Date.now() - 45000 }), threadId: 'bb03' };
  const mailbox = () => {
    const value = { ...separateThreads(targets), probeWritableDb: false };
    value.threads.bb03.thread.messages.push(sibling);
    value.search.messages.push({ id: sibling.id, threadId: sibling.threadId });
    return value;
  };
  h.setFixture(mailbox());
  const counts = new Map<string, number>();
  const provider = assessments(id => {
    const count = (counts.get(id) ?? 0) + 1; counts.set(id, count);
    const choice = count === 1 || id === 'bb04' ? 'queue' : id === 'bb03' ? 'wake' : 'skip';
    return { action: { type: 'choice', choice, probabilities: {} } };
  });
  const config = triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy: { ...defaultPolicy, queueMinutes: 1 } });
  const wakes: string[][] = [];
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = { run: async ({ sessionKey, message: prompt }) => {
    const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
    wakes.push(context.messages.map(row => row.id));
    const followup = context.messages.find(row => row.id === 'aa03');
    if (followup) assert.match(readFileSync(followup.transcript!, 'utf8'), /STILL_UNRESOLVED/);
    workflow.complete({ jobId, sessionKey, reason: 'Current work handled' });
    return { runId: jobId };
  }, waitForRun: async () => ({ status: 'ok' }) };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); assert.equal(provider.calls(), 5); await workflow.stop();
    const updated = mailbox();
    for (const id of ['2', '3', '4']) {
      const reply = message(`cc0${id}`, id === '3' ? 'STILL_UNRESOLVED: please approve the revised budget.' : 'Completed this request.',
        { sender: id === '3' ? 'customer@elsewhere.test' : account });
      reply.threadId = `bb0${id}`; if (id !== '3') reply.labelIds = ['SENT'];
      updated.threads[`bb0${id}`].thread.messages.push(reply);
    }
    targets[4].labelIds = [];
    const unreadable = updated.threads.bb04; delete updated.threads.bb04;
    h.setFixture(updated);
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); assert.equal(provider.calls(), 5, 'no refresh before a wake is due');
    t.mock.timers.setTime(Date.now() + 60000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01', 'aa03']], 'resolved and archived mail must not reach the agent');
    assert.equal(provider.calls(), 7, 'only the two readable changed threads need Jev again');
    assert.deepEqual(workflow.status().messages, { done: 3, ignored: 1, pending: 1, skipped: 1 });
    updated.threads.bb04 = unreadable; h.setFixture(updated);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(provider.calls(), 8);
    assert.deepEqual(wakes, [['aa01', 'aa03'], ['aa04']], 'a transient read failure must not postpone due work for another queue interval');
    assert.deepEqual(workflow.status().messages, { done: 4, ignored: 1, skipped: 1 });
    assert.ok(!h.calls().some(args => args.includes('send') || args.includes('modify')));
  } finally { await workflow.stop(); }
}));

test('skipped backlog stays quiet across days and restarts, labels independently, and can be reconsidered by policy', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 19, 12).getTime() });
  h.setFixture({ ...fixture([message('aa01', 'Publication receipt', { received: Date.now() - 60000 })]), probeWritableDb: false });
  let actions = 0, labels = 0, wakes = 0;
  const requests: string[] = [];
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    requests.push(JSON.stringify(batch.questions));
    const label = opts.purpose.endsWith('.labels');
    if (label) labels++; else actions++;
    const choice = label ? 'apply' : actions === 1 ? 'skip' : 'wake';
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: opts.rubricVersion, runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(batch.questions).map(key => [key, { type: 'choice', choice, probabilities: {} }])) } };
  } };
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Receipts', description: 'Publication receipts' }] } });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }) => {
      wakes++;
      const jobId = jobIdFromPrompt(prompt);
      workflow.complete({ jobId, sessionKey, reason: 'Handled after policy change' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.deepEqual(workflow.status().messages, { skipped: 1 });
    assert.deepEqual(workflow.inspect('aa01')[0].plan, { action: 'skip' });
    assert.equal(actions, 1); assert.equal(labels, 1); assert.equal(wakes, 0);
    assert.ok(requests.every(request => /Today's date: 2026-10-19 \([^)]+\)/.test(request)), 'action and independent labels both get the current date');
    const mail = (await new GogMailClient(h.config).getThread('bb01')).messages[0];
    assert.deepEqual(mail.labelIds.sort(), ['INBOX', 'Label_1']);
    assert.equal(workflow.status().nextQueueWakeAt, null);
    t.mock.timers.setTime(Date.now() + 2 * 86400000);
    await workflow.poll(); await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start();
    assert.equal(actions, 1); assert.equal(labels, 1); assert.equal(wakes, 0);
    assert.deepEqual(workflow.status().jobs, {});
    const current = workflow.policyGet();
    workflow.policyUpdate({ ...current.document, prompt: 'Wake for publication receipts needing verification.' }, current.version, 'main');
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(actions, 2); assert.equal(labels, 1); assert.equal(wakes, 1);
    assert.match(requests.at(-1)!, /Today's date: 2026-10-21 \([^)]+\)/);
    assert.deepEqual(workflow.status().messages, { done: 1 });
    assert.ok(!h.calls().some(args => args.includes('send') || args.includes('TRASH') || args.includes('--remove')));
  } finally { await workflow.stop(); }
}));

test('live gog output and timeout overrides recover actual failed subprocess reads', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const target = message('aa01', 'Large message '.repeat(300), { received: Date.now() - 60000 });
  h.setFixture(fixture([target]));
  const provider = assessments();
  const config = parseConfig({ ...triageConfig(h.config), settings: { gogMaxOutputBytes: 256, retryDelaySeconds: 0 } });
  const workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start();
    assert.equal(workflow.status().messages.pending, 1); assert.equal(provider.calls(), 0);
    const db = h.db();
    assert.match(String(db.prepare("SELECT reason FROM messages WHERE id='aa01'").get()?.reason), /MAXBUFFER/);
    db.close();
    h.setFixture({ ...fixture([target]), threadDelayMs: 1500 });
    workflow.policyUpdate(undefined, 1, 'main', { gogMaxOutputBytes: 65536, gogTimeoutSeconds: 0.5 });
    await workflow.poll();
    assert.equal(workflow.status().messages.pending, 1); assert.equal(provider.calls(), 0);
    workflow.policyUpdate(undefined, 2, 'main', { gogTimeoutSeconds: 3 });
    await workflow.poll();
    assert.equal(workflow.status().messages.queue, 1); assert.equal(provider.calls(), 1);
  } finally { await workflow.stop(); }
}));

test('in-flight settings edits preserve decisions, independent worker capacities and custom wake instructions', async () => withHarness(async h => {
  const messages = Array.from({ length: 4 }, (_, i) => {
    const mail = message(`aa0${i}`, 'Actionable', { received: Date.now() - 60000 }); mail.threadId = `bb0${i}`; return mail;
  });
  h.setFixture({ ...separateThreads(messages), probeWritableDb: false });
  let releaseActions!: () => void, releaseLabels!: () => void;
  const actionGate = new Promise<void>(resolve => { releaseActions = resolve; });
  const labelGate = new Promise<void>(resolve => { releaseLabels = resolve; });
  let actions = 0, labels = 0, activeLabels = 0, peakLabels = 0, wakes = 0;
  const waitTimeouts: Array<number | undefined> = [];
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (_batch, opts) => {
    const label = opts.purpose.endsWith('.labels');
    if (label) {
      labels++; activeLabels++; peakLabels = Math.max(peakLabels, activeLabels);
      await labelGate; activeLabels--;
    } else { actions++; await actionGate; }
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: { [label ? 'label_0' : 'action']: { type: 'choice', choice: label ? 'apply' : 'wake', probabilities: {} } } } };
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  workflow = createMailWorkflow({ config: parseConfig({ ...triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Project', description: 'Project mail' }] } }),
    settings: { concurrency: 4, labelConcurrency: 2, agentWaitTimeoutSeconds: 0.25 } }), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      wakes++; assert.match(prompt, /Start with commitments/);
      const jobId = jobIdFromPrompt(prompt);
      assert.equal(workflow.context(jobId, sessionKey).messages.length, 4);
      workflow.complete({ jobId, sessionKey, reason: 'Done' }); return { runId: jobId };
    }, waitForRun: async ({ timeoutMs }) => { waitTimeouts.push(timeoutMs); return { status: 'ok' }; },
  } });
  const start = workflow.start();
  try {
    await waitFor(() => actions === 4);
    workflow.policyUpdate(undefined, 1, 'main', { wakePrompt: 'Start with commitments', decisionTimeoutSeconds: 60 });
    releaseActions(); await start;
    await waitFor(() => labels === 2 && !workflow.status().working);
    assert.equal(wakes, 1); assert.equal(workflow.status().messages.done, 4);
    assert.ok(waitTimeouts.length > 0 && waitTimeouts.every(timeout => timeout !== undefined && timeout > 0 && timeout <= 250));
    workflow.policyUpdate(undefined, 2, 'main', { responderPrompt: 'Be concise' });
    releaseLabels(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(actions, 4); assert.equal(labels, 4); assert.equal(peakLabels, 2);
    assert.equal(workflow.inspect().filter(row => row.labels?.status === 'done').length, 4);
  } finally { releaseActions(); releaseLabels(); await start; await workflow.stop(); }
}));

test('host-pending runs remain active until the responder or triage agent completes', async t => {
  for (const triage of [false, true]) await t.test(triage ? 'triage' : 'responder', async () => withHarness(async h => {
    h.setFixture(fixture([]));
    let workflow: ReturnType<typeof createMailWorkflow>, jobId = '', sessionKey = '', runs = 0, waits = 0;
    const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
    if (triage) h.setFixture(fixture([message('aa01', 'Existing mail', { received: Date.now() - 60000 })]));
    workflow = createMailWorkflow({ config: triage ? triageConfig(h.config) : h.config, stateDir: h.stateDir, ...provider,
      subagent: {
        run: async input => { runs++; jobId = jobIdFromPrompt(input.message); sessionKey = input.sessionKey; return { runId: jobId, sessionKey }; },
        waitForRun: async () => {
          if (++waits === 1) return { status: 'pending' };
          workflow.context(jobId, sessionKey);
          workflow.complete({ jobId, sessionKey, reason: 'Host queue drained; work completed' });
          return { status: 'ok' };
        },
      } });
    try {
      await workflow.start();
      if (!triage) { h.setFixture(fixture([message('aa01', 'New mail')])); await workflow.poll(); }
      await waitFor(() => !workflow.status().working);
      assert.equal(workflow.status().jobs.completed, 1, 'pending is not a failed or unresolved run');
      assert.equal(workflow.status().messages.done, 1);
      assert.equal(runs, 1, 'waiting must not redispatch'); assert.equal(waits, 2);
    } finally { await workflow.stop(); }
  }));
});

test('uncertain normal and alternate-target sends cannot be skipped or replayed', async t => {
  for (const alternate of [false, true]) await t.test(alternate ? 'alternate transport failure' : 'missing acknowledgment', async () => withHarness(async h => {
    h.setFixture(fixture([]));
    const earlier = message('aa00', 'Scheduling guest', { received: Date.now() - 3000, headers: { To: `${account}, guest@outside.test` } });
    const replyOptions = alternate ? { externalScheduling: true, replyTargetMessageId: earlier.id } : {};
    let checksCompleted = false;
    let workflow: ReturnType<typeof createMailWorkflow>;
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent: {
      run: async ({ sessionKey, message: prompt }) => {
        const jobId = jobIdFromPrompt(prompt);
        await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Answer', ...replyOptions }), alternate ? /gog command failed/ : /acknowledgment/);
        assert.throws(() => workflow.skip({ jobId, sessionKey, reason: 'No reply' }), /uncertain/);
        await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Retry', ...replyOptions }), /duplicate/);
        checksCompleted = true;
        return { runId: jobId };
      }, waitForRun: async () => ({ status: 'ok' }),
    } });
    try {
      await workflow.start();
      const incoming = message('aa01', 'Please answer');
      h.setFixture({ ...fixture([earlier, incoming], [incoming]), ...(alternate ? { sendFailure: true } : { send: {} }) });
      await workflow.poll();
      await waitFor(() => !workflow.status().working);
      assert.ok(checksCompleted, 'worker error handling must not hide a failed assertion');
      assert.equal(workflow.status().jobs.needs_review, 1);
      const jobId = String(workflow.status().unresolvedJobs[0].id);
      const snapshot = workflow.inspectJob(jobId);
      assert.equal(snapshot.job.run_id, jobId);
      assert.ok(snapshot.job.session_key);
      assert.ok(snapshot.job.started > 0);
      assert.ok(snapshot.transcript);
      assert.match(readFileSync(snapshot.transcript, 'utf8'), /Please answer/);
      assert.equal(snapshot.replies[0].status, 'uncertain');
      assert.equal(snapshot.messages[0].message.id, 'aa01');
      assert.equal(workflow.inspect('aa01')[0].message.status, 'needs_review');
      assert.throws(() => workflow.context(jobId, snapshot.job.session_key), /not active/);
      assert.throws(() => workflow.complete({ jobId, sessionKey: snapshot.job.session_key, reason: 'Inspection is not authority' }), /not active/);
      const sends = h.calls().filter(args => args.includes('send'));
      assert.equal(sends.length, 1);
      assert.equal(sends[0][sends[0].indexOf('--reply-to-message-id') + 1], alternate ? earlier.id : incoming.id);
      assert.equal(sends[0][sends[0].indexOf('--to') + 1], alternate ? `${approved},guest@outside.test` : approved);
    } finally { await workflow.stop(); }
  }));
});

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

test('re-added rules exclude disabled-period mail while continuously matching rules still authorize it', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  h.setFixture(fixture([]));
  const config = { ...h.config, domains: ['example.com', 'outside.test'], senders: ['bek@other.test', 'dual@outside.test'] };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
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
    t.mock.timers.setTime(Date.now() + 3600000);
    workflow = createMailWorkflow({ config: { ...h.config, senders: ['dual@outside.test'] }, stateDir: h.stateDir, subagent });
    await workflow.start();
    await workflow.stop();
    const old = Date.now();
    t.mock.timers.setTime(Date.now() + 60000);
    h.setFixture(fixture([
      message('aa01', 'While domain disabled', { sender: 'bek@outside.test', received: old }),
      message('aa02', 'While sender disabled', { sender: 'bek@other.test', received: old }),
      message('aa03', 'Still-approved sender', { received: old }),
      message('aa06', 'Sender route stayed enabled while domain was disabled', { sender: 'dual@outside.test', received: old }),
    ]));
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
    await workflow.start();
    await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().messages, { done: 2, ignored: 2 });
    h.setFixture(fixture([
      message('aa04', 'After domain re-added', { sender: 'bek@outside.test' }),
      message('aa05', 'After sender re-added', { sender: 'bek@other.test' }),
    ]));
    await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().messages, { done: 4, ignored: 2 });
  } finally {
    await workflow.stop();
  }
}));

test('new mail uses full chronological thread and a stable session, then sends only through gog', async () => withHarness(async (h) => {
  const old = message('aa00', 'Original request', { received: Date.now() - 86_400_000 });
  const sent = message('aa02', 'Prior agent reply', { sender: account, received: Date.now() - 3000 });
  const external = message('aa03', 'External context', { sender: 'guest@outside.test', received: Date.now() - 2000 });
  const incoming = message('aa04', 'Please follow up.', { headers: {
    To: `${account}, "Sarah, Team" <SARAH@example.com>, guest@external.test`,
    Cc: 'sarah@example.com, alias@example.com, Charlie <charlie@example.com>, bek@unblocklabs.ai',
    'Reply-To': 'attacker@example.com', Bcc: 'hidden@example.com',
  } });
  const config = parseConfig({ account, senders: [approved, 'sarah@example.com', 'charlie@example.com', 'bek@unblocklabs.ai'],
    selfAddresses: ['alias@example.com'], gogPath: fakeGog });
  h.setFixture(fixture([]));

  let workflow: ReturnType<typeof createMailWorkflow>;
  const runs: Array<Parameters<MailSubagent['run']>[0]> = [];
  const subagent: MailSubagent = {
    run: async (params) => {
      runs.push(params);
      const transcript = transcriptFromPrompt(params.message);
      const positions = ['Original request', 'Prior agent reply', 'External context', 'Please follow up.'].map(text => transcript.indexOf(text));
      assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])), 'every message is present in chronological order');
      const reply = { jobId: jobIdFromPrompt(params.message), sessionKey: params.sessionKey, body: 'Intro <unsafe>\n\n- First\n- Second & final' };
      await assert.rejects(workflow.reply({ ...reply, externalTo: ['a@external.test,b@external.test'] }), /invalid explicit external recipient/);
      await workflow.reply({ ...reply, externalTo: ['Customer <CUSTOMER@external.test>', 'customer@external.test'] });
      return { runId: 'run-1', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    workflow.policyUpdate(undefined, workflow.policyGet().version, 'main', { responderPrompt: 'Summarize any commitments before responding.' });
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
    await waitFor(() => !workflow.status().working);
    assert.equal(workflow.status().jobs.replied, 1);
    assert.equal(runs.length, 1);
    assert.match(runs[0].message, /Summarize any commitments before responding/);
    assert.equal(runs[0]?.sessionKey, `agent:main:gog-email-watch:${account}:bb01`);
    const send = h.calls().find((args) => args.includes('send'));
    assert.ok(send);
    assert.equal(send[send.indexOf('--to') + 1], `${approved},sarah@example.com,customer@external.test`);
    assert.equal(send[send.indexOf('--cc') + 1], 'charlie@example.com,bek@unblocklabs.ai');
    assert.equal(send[send.indexOf('--reply-to-message-id') + 1], incoming.id);
    assert.ok(!send.includes('--reply-all'));
    assert.match(h.sentBody(), /Intro &lt;unsafe&gt;/);
    assert.match(h.sentBody(), /<ul><li>First<\/li><li>Second &amp; final<\/li><\/ul>/);
    assert.deepEqual(workflow.status().messages, { done: 1 });
  } finally { await workflow.stop(); }
}));

test('duplicate mail and restart do not dispatch again; an explicit skip completes a job', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  let runs = 0;
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async (params) => {
      runs++;
      workflow.skip({ jobId: jobIdFromPrompt(params.message), sessionKey: params.sessionKey, reason: 'Already handled' });
      return { runId: 'run-2', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    const incoming = message('aa01', 'No reply is needed.');
    h.setFixture(fixture([incoming]));
    await workflow.poll();
    await waitFor(() => workflow.status().jobs.skipped === 1);
    await workflow.stop();
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
    await workflow.start();
    await workflow.poll();
    assert.equal(runs, 1);
    assert.equal(h.calls().filter((args) => args.includes('send')).length, 0);
    const db = h.db();
    assert.equal((db.prepare("SELECT status FROM jobs").get() as { status: string }).status, 'skipped');
    db.close();
  } finally { await workflow.stop(); }
}));

test('only authorized human mail dispatches; unreadable threads retry after restart without blocking healthy mail', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const rejected = [
    message('aa01', 'Unapproved domain', { sender: 'bad@example.com.evil.com' }),
    message('aa02', 'Subdomain is not approved', { sender: 'bad@sub.example.com' }),
    message('aa03', 'Self', { sender: account }),
    message('aa04', 'Multiple From addresses', { sender: 'one@example.com,two@example.com', headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=example.com' } }),
    message('aa05', 'Missing authentication', { headers: { 'Authentication-Results': '' } }),
    message('aa06', 'Non-Google authentication', { headers: { 'Authentication-Results': 'evil.example; dmarc=pass header.from=example.com' } }),
    message('aa07', 'Failed authentication', { headers: { 'Authentication-Results': 'mx.google.com; dmarc=fail header.from=example.com' } }),
    message('aa08', 'Mismatched authentication domain', { headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=example.com.evil.com' } }),
    message('aa09', 'Forged second header', { headers: { 'Authentication-Results': 'mx.google.com; dmarc=fail header.from=example.com' } }),
    message('aa0a', 'Before activation', { received: Date.now() - 60000 }),
    message('aa0b', 'Automatic reply', { headers: { 'Auto-Submitted': 'auto-replied' } }),
    message('aa0c', 'Mailing list', { headers: { 'List-ID': 'list' } }),
    message('aa0d', 'Sent mail'),
  ];
  rejected[8].payload.headers!.push({ name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=example.com' });
  rejected[12].labelIds = ['SENT'];
  const healthy = message('ab01', 'Healthy mail'), unreadable = message('ab02', 'Temporarily unreadable');
  for (const m of [...rejected, healthy, unreadable]) m.threadId = `bb${m.id}`;
  const deliveries: string[] = [];
  const config = { ...h.config, settings: { retryDelaySeconds: 0 } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      deliveries.push(workflow.context(jobId, sessionKey).job.target_id);
      workflow.skip({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    const f = separateThreads([...rejected, healthy, unreadable]);
    const missing = f.threads[unreadable.threadId];
    delete f.threads[unreadable.threadId];
    h.setFixture(f);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(deliveries, [healthy.id]);
    assert.deepEqual(workflow.status().messages, { done: 1, ignored: rejected.length, pending: 1 });
    assert.equal(workflow.inspect(unreadable.id)[0].message.status, 'pending');
    await workflow.stop();
    f.threads[unreadable.threadId] = missing;
    h.setFixture(f);
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(deliveries, [healthy.id, unreadable.id]);
    assert.deepEqual(workflow.status().messages, { done: 2, ignored: rejected.length });
    assert.deepEqual(workflow.status().jobs, { skipped: 2 });
  } finally { await workflow.stop(); }
}));

test('deferred responder resumes once when due', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  h.setFixture(fixture([]));
  const config = h.config;
  let workflow: ReturnType<typeof createMailWorkflow>, runs = 0;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      runs++;
      const jobId = /Job ID: ([a-f0-9]{24})/.exec(prompt)![1];
      if (runs === 1) workflow.complete({ jobId, sessionKey, reason: 'Waiting for scheduled check' }, Math.floor(Date.now() / 1000) + 3600);
      else workflow.complete({ jobId, sessionKey, reason: 'Completed' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start(); h.setFixture(fixture([message('aa01', 'Please help')]));
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(workflow.status().messages.deferred, 1);
    t.mock.timers.setTime(Date.now() + 3599000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(runs, 1, 'must not resume early');
    t.mock.timers.setTime(Date.now() + 1000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(runs, 2); assert.equal(workflow.status().jobs.completed, 1);
  } finally { await workflow.stop(); }
}));

test('deferred daily queue resumes together at the explicit time after restart', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const messages = ['aa01', 'aa02'].map(id => message(id, 'Queued work', { received: Date.now() - 60000 }));
  h.setFixture(fixture(messages));
  const provider = assessments();
  const config = triageConfig(h.config);
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = jobIdFromPrompt(prompt);
      assert.equal(workflow.status().activeJob?.id, jobId);
      assert.equal(workflow.status().activeJob?.elapsedSeconds, 0);
      wakes.push(workflow.context(jobId, sessionKey).messages.map(row => row.id));
      workflow.complete({ jobId, sessionKey, reason: 'Work outcome' }, wakes.length === 1 ? Math.floor(Date.now() / 1000) + 3600 : undefined);
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start();
    assert.equal(workflow.status().nextQueueWakeAt, Math.floor(Date.now() / 1000) + 86400);
    t.mock.timers.setTime(Date.now() + 86400000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01']]);
    assert.equal(workflow.status().messages.deferred, 2);
    assert.equal(workflow.status().nextDeferredWakeAt, Math.floor(Date.now() / 1000) + 3600);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    t.mock.timers.setTime(Date.now() + 3599000);
    await workflow.poll(); assert.equal(wakes.length, 1);
    t.mock.timers.setTime(Date.now() + 1000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01'], ['aa01']], 'explicit defer must not wait for another daily queue interval');
    assert.equal(provider.calls(), 2, 'explicit deferral reassesses the chain once with the new day');
    assert.equal(workflow.status().messages.done, 2);
    assert.equal(workflow.status().activeJob, null);
    assert.equal(workflow.status().nextDeferredWakeAt, null);
  } finally { await workflow.stop(); }
}));

test('a large old-mail cycle drains all pages with configured concurrency, one wake and no daily budget', async () => withHarness(async h => {
  const messages = Array.from({ length: 251 }, (_, i) => {
    const m = message((0xaa00 + i).toString(16), 'Actionable backlog', { received: Date.now() - 86400000 });
    m.threadId = (0xbb00 + i).toString(16); return m;
  });
  // Dedicated responder regressions probe SQLite locking. Parallel fake Gmail
  // processes must not manufacture competing SQLite writers in this load test.
  const f = { ...separateThreads(messages), probeWritableDb: false }, refs = f.search.messages;
  f.search = { messages: refs.slice(0, 80), nextPageToken: 'p2' };
  f.pages = { p2: { messages: refs.slice(80, 160), nextPageToken: 'p3' }, p3: { messages: refs.slice(160, 240), nextPageToken: 'p4' }, p4: { messages: refs.slice(240) } };
  h.setFixture(f);
  let active = 0, peak = 0, calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: { wake: 1 } } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, options) => {
    active++; calls++; peak = Math.max(peak, active);
    await gate;
    try { return await provider.decisions.evaluate(batch, options); } finally { active--; }
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      const context = workflow.context(jobId, sessionKey);
      wakes.push(context.messages.map(row => row.id));
      assert.match(readFileSync(context.messages[0].transcript!, 'utf8'), /Actionable backlog/);
      workflow.complete({ jobId, sessionKey, reason: 'All handled' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  const started = workflow.start();
  try {
    await waitFor(() => calls >= 50); release();
    await started; await waitFor(() => !workflow.status().working);
    // Real Gmail treats after:0 as an empty result, not an unbounded search.
    assert.ok(h.calls().filter(args => args.includes('search')).every(args =>
      !args[args.indexOf('search') + 1].split(/\s+/).includes('after:0')));
    assert.equal(peak, 50); assert.equal(calls, 251);
    assert.equal(wakes.length, 1); assert.equal(wakes[0].length, 251);
    assert.deepEqual(workflow.status().messages, { done: 251 });
    assert.deepEqual(workflow.status().jobs, { completed: 1 });
    await workflow.poll(); assert.equal(calls, 251); assert.equal(wakes.length, 1);
    const cutoff = workflow.status().triage!.backlogBefore;
    await workflow.stop();
    workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
      run: async () => { throw new Error('completed cycle must not repeat'); }, waitForRun: async () => ({ status: 'ok' }),
    } });
    await workflow.start(); assert.equal(workflow.status().triage!.backlogBefore, cutoff);
    assert.equal(calls, 251);
  } finally { release(); await started; await workflow.stop(); }
}));

test('queue cadence persists and policy updates accept unbounded instructions without reclassifying scheduling changes', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const old = message('aa01', 'Old queued item', { received: Date.now() - 60000 });
  h.setFixture(fixture([old]));
  const provider = assessments();
  const policy = { ...defaultPolicy, prompt: 'Instruction '.repeat(1000), deletePrompt: 'Deletion criteria '.repeat(1000), queueMinutes: 60 };
  const config = triageConfig(h.config, { policy });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = jobIdFromPrompt(prompt);
      wakes.push(workflow.context(jobId, sessionKey).messages.map(row => row.id));
      workflow.complete({ jobId, sessionKey, reason: 'Queued mail handled' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); assert.equal(wakes.length, 0);
    for (let poll = 0; poll < 15; poll++) {
      t.mock.timers.setTime(Date.now() + 2 * 60000);
      await workflow.poll();
      assert.equal(provider.calls(), 1, 'two-minute polls do not reclassify queued mail');
      assert.equal(wakes.length, 0);
    }
    const fresh = message('aa02', 'New mail also enters triage', { sender: 'other@outside.test' });
    fresh.threadId = 'bb02';
    h.setFixture(separateThreads([old, fresh]));
    await workflow.poll(); assert.equal(provider.calls(), 2); assert.equal(wakes.length, 0);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    workflow.policyUpdate({ ...policy, queueMinutes: 30 }, 1, 'delegated-agent');
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01', 'aa02']]); assert.equal(provider.calls(), 2);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); assert.equal(workflow.policyGet().document.queueMinutes, 30);
    assert.equal(wakes.length, 1); assert.equal(provider.calls(), 2);
  } finally { await workflow.stop(); }
}));

test('independent label failures and slow inference cannot block waking; arbitrary labels retry separately', async () => withHarness(async h => {
  const first = message('aa01', 'Urgent', { received: Date.now() - 60000 });
  const second = message('aa02', 'Retry action next cycle', { received: Date.now() - 60000 }); second.threadId = 'bb02';
  h.setFixture(separateThreads([first, second]));
  const labels = Array.from({ length: 13 }, (_, i) => ({ name: `Projects / 客户 ${i} & follow-up`, description: 'Apply to this project. '.repeat(300) }));
  let labelAttempts = 0, actionCalls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let workflow: ReturnType<typeof createMailWorkflow>, wakes = 0;
  let retryPoll: Promise<void> | undefined;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (opts.purpose.endsWith('.labels')) {
      labelAttempts++;
      assert.equal(Object.keys(batch.questions).length, 13);
      assert.ok(!('action' in batch.questions));
      await gate;
      if (labelAttempts === 1) return { status: 'unavailable', reason: 'transport' };
      return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
        result: { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(batch.questions).map(key => [key, { type: 'choice', choice: 'apply', probabilities: { apply: 1 } }])) } };
    }
    actionCalls++;
    assert.deepEqual(Object.keys(batch.questions), ['action']);
    if (actionCalls === 2) return { status: 'unavailable', reason: 'transport' };
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: { action: { type: 'choice', choice: 'wake', probabilities: { wake: 1 } } } } };
  } };
  workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { concurrency: 1, policy: { ...defaultPolicy, labels } }), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      wakes++;
      const jobId = jobIdFromPrompt(prompt); workflow.complete({ jobId, sessionKey, reason: 'Handled before labeling' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); await waitFor(() => labelAttempts === 1 && !workflow.status().working);
    assert.equal(wakes, 1); assert.equal(workflow.status().triage!.labeling, true);
    retryPoll = workflow.poll();
    await waitFor(() => wakes === 2);
    await retryPoll;
    assert.equal(workflow.status().triage!.labeling, true, 'later-cycle wake does not wait for the earlier label request');
    release(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.match(String(workflow.inspect('aa01')[0].labels?.reason), /transport/);
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(actionCalls, 3); assert.equal(labelAttempts, 3); assert.equal(wakes, 2);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    const creates = h.calls().filter(args => args.includes('create'));
    assert.deepEqual(creates.map(args => args.at(-1)).sort(), labels.map(label => label.name).sort());
  } finally { release(); await retryPoll; await workflow.stop(); }
}));

test('label policy edits during a Gmail write remain pending until the new labels apply', async () => withHarness(async h => {
  h.setFixture(fixture([message('aa01', 'Receipt', { received: Date.now() - 60000 })]));
  const config = parseConfig({ ...triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Old', description: 'All mail' }] } }),
    settings: { retryDelaySeconds: 0 } });
  const mail = new GogMailClient(config), modify = mail.modify.bind(mail);
  let writing = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mail.modify = async (...args) => { writing = true; await gate; return modify(...args); };
  const provider = assessments(() => ({ label_0: { type: 'choice', choice: 'apply', probabilities: {} } }));
  const workflow = createMailWorkflow({ config, stateDir: h.stateDir, mail, ...provider,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => writing);
    workflow.policyUpdate({ ...defaultPolicy, labels: [{ name: 'New', description: 'All mail' }] }, 1, 'main');
    release(); await waitFor(() => !workflow.status().triage!.labeling);
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    const labels = (await mail.getThread('bb01')).messages[0].labelIds;
    assert.deepEqual(labels, ['INBOX', 'Label_1', 'Label_2'], 'new policy is applied without undoing the old completed write');
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(provider.calls(), 3, 'one action and one label assessment per label policy');
  } finally { release(); await workflow.stop(); }
}));

test('label retries use recreated Gmail labels without another classification', async () => withHarness(async h => {
  const target = message('aa01', 'Receipt', { received: Date.now() - 60000 });
  h.setFixture({ ...fixture([target]), labels: [{ id: 'Label_1', name: 'Receipts', type: 'user' }], modifyUncertain: true });
  let labelCalls = 0;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (!opts.purpose.endsWith('.labels')) return provider.decisions.evaluate(batch, opts);
    labelCalls++;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: { label_0: { type: 'choice', choice: 'apply', probabilities: {} } } } };
  } };
  const workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy: { ...defaultPolicy, labels: [{ name: 'Receipts', description: 'Purchase receipts' }] } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'pending');
    // Gmail assigns a new ID when a user deletes and recreates a label.
    h.setFixture({ ...fixture([target]), labels: [{ id: 'Label_2', name: 'Receipts', type: 'user' }] });
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.deepEqual(thread.messages[0].labelIds, ['INBOX', 'Label_2']);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(provider.calls(), 1); assert.equal(labelCalls, 1);
  } finally { await workflow.stop(); }
}));

test('categorization cannot change mailbox folders but can apply non-folder system flags', async () => withHarness(async h => {
  const target = message('aa01', 'Keep this queued', { received: Date.now() - 60000 });
  h.setFixture({ ...fixture([target]), labels: [
    { id: 'TRASH', name: 'TRASH', type: 'system' }, { id: 'STARRED', name: 'STARRED', type: 'system' },
  ] });
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (!opts.purpose.endsWith('.labels')) return provider.decisions.evaluate(batch, opts);
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: { label_0: { type: 'choice', choice: 'apply', probabilities: {} } } } };
  } };
  const policy = { ...defaultPolicy, labels: [{ name: 'TRASH', description: 'Expired promotions' }] };
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy }), stateDir: h.stateDir, ...provider, decisions,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    const mail = new GogMailClient(h.config);
    assert.deepEqual((await mail.getThread('bb01')).messages[0].labelIds, ['INBOX']);
    assert.equal(workflow.status().messages.queue, 1);
    assert.match(String(workflow.inspect('aa01')[0].labels?.reason), /mailbox-state label/);
    assert.ok(!h.calls().some(args => args.includes('modify')));
    workflow.policyUpdate({ ...policy, labels: [{ name: 'STARRED', description: 'Worth keeping handy' }] }, 1, 'main');
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.deepEqual((await mail.getThread('bb01')).messages[0].labelIds, ['INBOX', 'STARRED']);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(provider.calls(), 1);
  } finally { await workflow.stop(); }
}));

test('date-range scans traverse all pages, delete matches only, and never queue, wake or label', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 19, 12).getTime() });
  h.setFixture(fixture([]));
  const deletePrompt = 'Delete expired promotions only.';
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb00' ? 'keep' : 'delete', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    assert.equal(opts.purpose, 'gog-email-watch.delete-scan');
    assert.ok(JSON.stringify(batch.questions).includes(deletePrompt));
    assert.match(JSON.stringify(batch.questions), /Today's date: 2026-10-19 \([^)]+\)/);
    const question = batch.questions.action;
    assert.ok(question.type === 'choice');
    assert.deepEqual(Object.keys(question.criteria).sort(), ['delete', 'keep']);
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt, labels: [{ name: 'Never here', description: 'anything' }] } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: { run: async () => { throw new Error('historical scan woke'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start();
    const messages = Array.from({ length: 61 }, (_, i) => message((0xaa00 + i).toString(16), 'Promotion', { received: Date.parse('2025-04-01') }));
    messages[0].threadId = 'bb00';
    const outside = message('ff01', 'Outside exact range', { received: Date.parse('2026-01-01') });
    const sent = message('ff02', 'Sent reply is context only', { sender: account, received: Date.parse('2025-04-02') }); sent.labelIds = ['SENT'];
    const f = fixture([...messages.slice(1), outside, sent]);
    f.threads.bb00 = { thread: { id: 'bb00', messages: [messages[0]] } };
    f.search.messages.unshift({ id: messages[0].id, threadId: 'bb00' });
    f.probeWritableDb = false; const refs = f.search.messages;
    f.search = { messages: refs.slice(0, 20), nextPageToken: 'p2' };
    f.pages = { p2: { messages: refs.slice(20, 40), nextPageToken: 'p3' }, p3: { messages: refs.slice(40, 60), nextPageToken: 'p4' }, p4: { messages: refs.slice(60) } };
    h.setFixture(f);
    const report = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(report.deleted, 60); assert.equal(report.results.length, 61); assert.equal(report.failed, 0);
    assert.equal(provider.calls(), 2, 'one request per chain, even when it spans discovery pages'); assert.deepEqual(workflow.status().messages, {}); assert.deepEqual(workflow.status().jobs, {});
    const calls = h.calls(), firstModify = calls.findIndex(args => args.includes('modify'));
    assert.ok(calls.findLastIndex(args => args.includes('search')) < firstModify, 'enumerate before mutations');
    assert.ok(calls.some(args => args.some(value => value.includes('before:1767225600'))));
    assert.ok(!calls.some(args => args.includes('create') || args.includes('send')));
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.ok((await new GogMailClient(h.config).getThread('bb00')).messages[0].labelIds.includes('INBOX'));
    assert.deepEqual(thread.messages.find(m => m.id === outside.id)!.labelIds, ['INBOX']);
    assert.deepEqual(thread.messages.find(m => m.id === sent.id)!.labelIds, ['SENT']);
    assert.equal(thread.messages.filter(m => m.labelIds.includes('TRASH')).length, 60);
    // Restoring mail invalidates the old effect receipt, not its classification.
    thread.messages.find(m => m.id === 'aa01')!.labelIds = ['INBOX'];
    h.setFixture({ ...fixture(thread.messages), probeWritableDb: false });
    const repeated = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(repeated.deleted, 1); assert.equal(repeated.failed, 0);
    assert.ok((await new GogMailClient(h.config).getThread('bb01')).messages.find(m => m.id === 'aa01')!.labelIds.includes('TRASH'));
    assert.equal(provider.calls(), 2, 'unchanged scan instructions and evidence reuse classification');
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 61);
  } finally { await workflow.stop(); }
}));

test('deletion rechecks mailbox scope after classification without restricting historical archived mail', async t => {
  for (const scenario of [
    { historical: false, labels: [], deleted: false },
    { historical: true, labels: ['SPAM'], deleted: false },
    { historical: true, labels: ['SENT'], deleted: false },
    { historical: true, labels: ['DRAFT'], deleted: false },
    { historical: true, labels: [], deleted: true },
  ]) await t.test(`${scenario.historical ? 'historical' : 'backlog'}: ${scenario.labels.join(',') || 'archived'}`, async () => withHarness(async h => {
    const target = message('aa01', 'Expired promotion', { received: scenario.historical ? Date.parse('2025-04-01') : Date.now() - 60000 });
    h.setFixture(fixture(scenario.historical ? [] : [target]));
    const provider = assessments(() => ({ action: { type: 'choice', choice: 'delete', probabilities: {} } }));
    const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
      // Gmail state changes while Jev is deciding; content stays identical.
      h.setFixture(fixture([{ ...target, labelIds: scenario.labels }]));
      return provider.decisions.evaluate(batch, opts);
    } };
    const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt: 'Delete expired promotions' } }),
      stateDir: h.stateDir, ...provider, decisions,
      subagent: { run: async () => { throw new Error('deletion must not wake'); }, waitForRun: async () => ({ status: 'ok' }) } });
    try {
      await workflow.start();
      if (scenario.historical) {
        h.setFixture(fixture([target]));
        const report = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
        assert.equal(report.deleted, Number(scenario.deleted));
      }
      const actual = (await new GogMailClient(h.config).getThread('bb01')).messages[0];
      assert.deepEqual(actual.labelIds, scenario.deleted ? ['TRASH'] : scenario.labels);
      assert.equal(h.calls().filter(args => args.includes('modify')).length, Number(scenario.deleted));
    } finally { await workflow.stop(); }
  }));
});

test('scan progress and per-message outcomes remain inspectable after the response and restart', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb01' ? 'delete' : 'keep', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    entered = true;
    await blocked;
    if ((batch.state as { threadId: string }).threadId === 'bb03') return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig(h.config, { concurrency: 1, policy: { ...defaultPolicy, deletePrompt: 'Delete promotions.' } });
  const options: WorkflowOptions = { config, stateDir: h.stateDir, ...provider, decisions,
    subagent: { run: async () => { throw new Error('scan must not wake'); }, waitForRun: async () => ({ status: 'ok' }) } };
  let workflow = createMailWorkflow(options);
  let scan: ReturnType<typeof workflow.scan> | undefined;
  try {
    await workflow.start();
    const messages = ['aa01', 'aa02', 'aa03'].map(id => ({ ...message(id, 'Historical mail', { received: Date.parse('2025-04-01') }), threadId: id.replace('aa', 'bb') }));
    h.setFixture(separateThreads(messages));
    scan = workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    await waitFor(() => entered);
    assert.equal(workflow.status().scan?.status, 'processing');
    assert.equal(workflow.status().scan?.from, '2025-01-01');
    assert.equal(workflow.status().scan?.discovered, 3);
    assert.equal(workflow.status().scan?.processed, 0);
    assert.deepEqual(workflow.inspectScan()?.results, []);
    release();
    // The client need not retain its original response to retrieve the outcome.
    await scan;
    const saved = workflow.inspectScan()!;
    assert.equal(saved.status, 'completed');
    assert.equal(saved.processed, 3);
    assert.equal(saved.deleted, 1); assert.equal(saved.failed, 1);
    assert.equal(saved.results.find(row => row.id === 'aa02')?.action, 'keep');
    assert.match(saved.results.find(row => row.id === 'aa03')!.error!, /transport/);
    assert.ok(saved.finishedAt);
    await workflow.stop();
    h.setFixture(fixture([]));
    workflow = createMailWorkflow(options);
    await workflow.start();
    assert.deepEqual(workflow.inspectScan(), saved);
    assert.equal(workflow.status().scan?.deleted, 1);
    // Only a newly accepted scan replaces the latest result.
    await assert.rejects(workflow.scan({ from: 'invalid', to: '2026-01-01' }), /date/);
    assert.deepEqual(workflow.inspectScan(), saved);
    await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.deepEqual(workflow.inspectScan()?.results, []);
    assert.equal(workflow.status().scan?.deleted, 0);
  } finally { release(); await scan?.catch(() => {}); await workflow.stop(); }
}));

test('full plaintext and attachments are classified without review vetoes; uncertain deletion reconciles on retry', async () => withHarness(async h => {
  const target = message('aa02', '', { received: Date.now() - 60000 });
  target.payload = { mimeType: 'multipart/alternative', headers: [...target.payload.headers!, { name: 'DKIM-Signature', value: 'DKIM_BLOAT'.repeat(2000) }], parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('CURRENT_PROMOTION\n' + '😀'.repeat(1000) + 'UNSENT_TAIL').toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML_ONLY</p>'.repeat(20000)).toString('base64url') } },
    { mimeType: 'application/pdf', filename: 'offer.pdf', body: { attachmentId: 'not-downloaded' } },
  ] };
  const sibling = message('aa01', 'Leave this sibling alone', { received: Date.now() - 86400000 });
  h.setFixture({ ...fixture([sibling, target], [target]), modifyUncertain: true });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'delete', probabilities: { delete: 0.51 } } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    const encoded = JSON.stringify(batch.state);
    assert.ok(encoded.includes('CURRENT_PROMOTION'));
    assert.ok(!encoded.includes('DKIM_BLOAT') && !encoded.includes('HTML_ONLY') && encoded.includes('UNSENT_TAIL'));
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy: { ...defaultPolicy, deletePrompt: 'Delete promotions' } });
  const subagent: MailSubagent = { run: async () => { throw new Error('deletion woke'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start(); assert.equal(workflow.status().messages.pending, 1);
    const inspected = workflow.inspect('aa02')[0];
    assert.deepEqual(inspected.plan, { action: 'delete' });
    assert.deepEqual(inspected.coverage, { complete: false, missing: ['unscanned attachment'] });
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); assert.equal(workflow.status().messages.done, 1); assert.equal(provider.calls(), 1);
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 1);
    assert.equal(workflow.inspect('aa02')[0].effects[0].status, 'confirmed');
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.ok(thread.messages.find(m => m.id === 'aa01')!.labelIds.includes('INBOX'));
  } finally { await workflow.stop(); }
}));

test('provider failures stay pending beyond three attempts and are not cached as classifications', async () => withHarness(async h => {
  h.setFixture(fixture(['aa01', 'aa02'].map(id => message(id, 'Retry this chain', { received: Date.now() - 60000 }))));
  let calls = 0;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    calls++;
    if (calls < 5) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async () => { throw new Error('queued mail wakes later'); }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    for (let attempt = 1; attempt < 5; attempt++) {
      assert.equal(workflow.status().messages.pending, 2);
      assert.equal(calls, attempt, 'one failed request per chain per cycle, not one per member');
      const pending = workflow.inspect('aa01')[0];
      assert.ok(pending, 'first-attempt failures must be inspectable');
      assert.equal(pending.message?.status, 'pending');
      assert.match(pending.message.reason, /transport/);
      assert.equal(pending.message.attempts, attempt);
      assert.ok(pending.message.due > 0);
      assert.equal(pending.plan, undefined);
      await workflow.poll();
    }
    assert.equal(calls, 5); assert.equal(workflow.status().messages.queue, 2);
    assert.equal(workflow.status().messages.needs_review, undefined);
  } finally { await workflow.stop(); }
}));

test('file policy edits refresh queued decisions and labels while the original backlog cutoff survives disablement', async () => withHarness(async h => {
  const old = message('aa01', 'Existing before enable', { received: Date.now() - 60000 });
  h.setFixture({ ...fixture([old]), probeWritableDb: false });
  let actions = 0, labels = 0, wakes = 0;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    const label = opts.purpose.endsWith('.labels');
    if (label) labels++; else actions++;
    const choice = label ? 'apply' : JSON.stringify(batch.questions).includes('Wake after config edit') ? 'wake' : 'queue';
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(batch.questions).map(key => [key, { type: 'choice', choice, probabilities: {} }])) } };
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      wakes++;
      const jobId = jobIdFromPrompt(prompt); workflow.complete({ jobId, sessionKey, reason: 'Handled after reconfiguration' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  const config = triageConfig(h.config);
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(actions, 1); assert.equal(wakes, 0);
    const cutoff = workflow.status().triage!.backlogBefore;
    await workflow.stop();
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); await workflow.stop();
    const fresh = message('aa02', 'Arrived after original enable', { sender: 'someone@outside.test', received: cutoff + 1000 });
    h.setFixture({ ...fixture([old, fresh]), probeWritableDb: false });
    const edited = { ...defaultPolicy, prompt: 'Wake after config edit', labels: [{ name: 'New label', description: 'This conversation' }] };
    workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: edited }), stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); await waitFor(() => !workflow.status().working && !workflow.status().triage!.labeling);
    assert.equal(workflow.status().triage!.backlogBefore, cutoff);
    assert.equal(actions, 2); assert.equal(labels, 1); assert.equal(wakes, 1);
    await workflow.stop();
    workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...edited, labels: [{ name: 'Second label', description: 'This conversation' }] } }),
      stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(actions, 2); assert.equal(wakes, 1); assert.equal(labels, 2);
  } finally { await workflow.stop(); }
}));

test('historical deletion removes waiting queue mail and invalid dates cannot mutate it', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const target = message('aa01', 'Expired item', { received: Date.parse('2025-04-01') });
  h.setFixture(fixture([target]));
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (opts.purpose.endsWith('.delete-scan')) return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: { action: { type: 'choice', choice: 'delete', probabilities: { delete: 1 } } } } };
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { maxAgeDays: null } }, { policy: { ...defaultPolicy, deletePrompt: 'Delete expired items', queueMinutes: 1 } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: { run: async () => { throw new Error('deleted queue item woke'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(workflow.status().messages.queue, 1);
    for (const from of ['2025-02-30', '2025-01-01T00:00:00', 'Jan 1, 2025']) {
      await assert.rejects(workflow.scan({ from, to: '2026-01-01' }), /date|timezone/);
    }
    const result = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(result.deleted, 1);
    t.mock.timers.setTime(Date.now() + 120000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().jobs, {}); assert.equal(workflow.status().messages.done, 1);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'cancelled');
  } finally { await workflow.stop(); }
}));

test('legacy unexecuted triage states migrate without replaying completed or uncertain jobs', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const subagent: MailSubagent = { run: async () => { throw new Error('no immediate wake'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, ...provider, subagent });
  await workflow.start(); await workflow.stop();
  const db = h.db();
  db.prepare('UPDATE policies SET document=?,created=?,editor=? WHERE version=1').run(JSON.stringify({ schemaVersion: 1, rules: [] }), 0, 'legacy');
  const messages = ['digest', 'shadow', 'queued', 'needs_review', 'done', 'needs_review'].map((status, i) => {
    const m = message((0xaa00 + i).toString(16), 'Legacy mail', { received: Date.now() - 86400000 });
    db.prepare("INSERT INTO messages(id,thread_id,received,sender,status,discovered,job_id) VALUES (?,?,?,?,?,?,?)")
      .run(m.id, m.threadId, Number(m.internalDate), approved, status, Math.floor(Date.now() / 1000), i === 5 ? 'old-uncertain' : null);
    db.prepare('INSERT INTO triage VALUES (?,?,?,?,?,?,?,?,?,?)').run(m.id, m.threadId, '', '', 1, '{}', '{"attention":"review"}', '{}', 0, 1);
    return m;
  });
  db.prepare("INSERT INTO jobs(id,thread_id,target_id,message_ids,status,created) VALUES ('old-uncertain','bb01','aa05','[\"aa05\"]','needs_review',1)").run();
  db.prepare("INSERT INTO jobs(id,thread_id,target_id,message_ids,status,created) VALUES ('old-completed','triage','','[\"aa04\"]','completed',1)").run();
  db.prepare("UPDATE messages SET job_id='old-completed' WHERE id='aa04'").run();
  mkdirSync(join(h.stateDir, 'triage'));
  writeFileSync(join(h.stateDir, 'triage', 'aa04.md'), 'Original completed conversation');
  db.prepare("INSERT INTO replies VALUES ('aa05','old-uncertain','uncertain',1,'')").run();
  db.close();
  h.setFixture({ ...fixture(messages), probeWritableDb: false });
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(provider.calls(), 1);
    assert.equal(workflow.status().messages.queue, 4); assert.equal(workflow.status().messages.done, 1);
    assert.equal(workflow.status().messages.needs_review, 1);
    assert.equal(readFileSync(workflow.inspectJob('old-completed').messages[0].transcript!, 'utf8'), 'Original completed conversation');
    workflow.resolve('old-uncertain', 'Confirmed prior external outcome; do not resend');
    const check = h.db(); assert.equal(check.prepare("SELECT status FROM replies WHERE target_id='aa05'").get()?.status, 'uncertain'); check.close();
    await workflow.poll(); assert.equal(provider.calls(), 1);
  } finally { await workflow.stop(); }
}));

test('a waiting wake survives policy replacement and a later downgrade to the daily queue', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const first = message('aa01', 'First old item', { received: Date.now() - 60000 });
  const second = message('aa02', 'Second old item', { received: Date.now() - 60000 }); second.threadId = 'bb02';
  h.setFixture({ ...separateThreads([first, second]), probeWritableDb: false });
  let secondAttempts = 0, downgrade = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb02' && downgrade ? 'queue' : 'wake', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if ((batch.state as { threadId: string }).threadId === 'bb02' && secondAttempts++ === 0) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      wakes.push(workflow.context(jobId, sessionKey).messages.map(row => row.id));
      if (wakes.length === 1) await gate;
      workflow.complete({ jobId, sessionKey, reason: 'Done' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); await waitFor(() => wakes.length === 1); assert.deepEqual(wakes, [['aa01']]);
    await workflow.poll(); assert.equal(workflow.status().jobs.queued, 1);
    workflow.policyUpdate({ ...defaultPolicy, prompt: 'Revised wake instructions' }, 1, 'main');
    await workflow.poll();
    const updated = { ...separateThreads([first, second]), probeWritableDb: false };
    const reply = message('cc02', 'No urgency; keep this for the next daily check.', { sender: account });
    reply.threadId = 'bb02'; reply.labelIds = ['SENT'];
    updated.threads.bb02.thread.messages.push(reply); h.setFixture(updated); downgrade = true;
    release(); await waitFor(() => !workflow.status().working && workflow.status().jobs.completed === 2);
    assert.deepEqual(wakes, [['aa01']], 'the later reply downgrades the waiting urgent item');
    assert.equal(workflow.status().messages.queue, 1);
    t.mock.timers.setTime(Date.now() + 86400000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01'], ['aa02']]);
  } finally { release(); await workflow.stop(); }
}));

test('rolling triage skips old messages before inference, handles new replies once, and expires a waiting queue', async (t) => withHarness(async (h) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const day = 86400000;
  const old = message('aa01', 'Old mail must not call Jev', { received: Date.now() - 40 * day });
  const queued = message('aa02', 'Expires before queue delivery', { received: Date.now() - 29 * day });
  queued.threadId = 'bb02';
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb02' ? 'queue' : 'wake', probabilities: {} } }));
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, queueMinutes: 3 * 1440 } });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      const context = workflow.context(jobId, sessionKey);
      wakes.push(context.messages.flatMap(row => row.messageIds));
      assert.equal(context.replyAllowed, false, 'triage does not grant send authorization');
      workflow.complete({ jobId, sessionKey, reason: 'Handled without sending' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  h.setFixture(separateThreads([old, queued]));
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start();
    assert.equal(provider.calls(), 1, 'old mail never reaches the decision provider');
    assert.equal(workflow.inspect(old.id)[0].message?.reason, 'older than maxAgeDays');
    assert.equal(workflow.status().messages.skipped, 1);
    t.mock.timers.setTime(Date.now() + 60000);
    const reply = message('aa03', 'New external reply in the old thread', { sender: 'outside@elsewhere.test' });
    const other = message('aa04', 'Another new conversation', { sender: 'outside@elsewhere.test' });
    other.threadId = 'bb04';
    const current = separateThreads([old, queued, other]);
    current.threads.bb01.thread.messages.push(reply);
    current.search.messages.push({ id: reply.id, threadId: reply.threadId });
    h.setFixture(current);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa03', 'aa04']], 'new messages across threads share one wake; old sibling stays excluded');
    assert.equal(provider.calls(), 3);
    await workflow.poll(); assert.equal(provider.calls(), 3);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.equal(provider.calls(), 3, 'restart does not replay successful mail');
    t.mock.timers.setTime(Date.now() + 4 * day);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(wakes.length, 1, 'expired queue cannot wake');
    assert.equal(provider.calls(), 3, 'expiry does not cost an inference');
    assert.equal(workflow.inspect(queued.id)[0].message?.reason, 'older than maxAgeDays');
    const snapshot = workflow.policyGet();
    workflow.policyUpdate(undefined, snapshot.version, 'agent', { maxAgeDays: null });
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa03', 'aa04'], ['aa01', 'aa02']], 'agent can opt old mail and its already-due queue back in without reopening completed messages');
    assert.equal(h.calls().filter(args => args.includes('send') || args.includes('modify')).length, 0);
  } finally { await workflow.stop(); }
}));

test('new replies reconcile waiting conversation members without a second wake', async t => {
  for (const scenario of [
    { initial: 'queue', reply: 'wake', due: false },
    { initial: 'wake', reply: 'wake', due: false },
    { initial: 'queue', reply: 'queue', due: true },
    { initial: 'wake', reply: 'queue', due: false },
  ] as const) await t.test(`${scenario.initial} to ${scenario.reply}${scenario.due ? ' (due)' : ''}`, async t => withHarness(async h => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const blocker = message('ff01', 'Unrelated active work'); blocker.threadId = 'ff02';
    h.setFixture(separateThreads([blocker]));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const wakes: string[][] = [];
    let workflow: ReturnType<typeof createMailWorkflow>;
    const provider = assessments();
    const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
      const latest = (batch.state as { facts: { latestMessageId: string } }).facts.latestMessageId;
      const result = await provider.decisions.evaluate(batch, opts);
      return result.status !== 'ok' ? result : { ...result, result: { ...result.result, answers: {
        action: { type: 'choice', choice: latest === 'aa01' ? scenario.initial : latest === 'aa02' ? scenario.reply : 'wake', probabilities: {} },
      } } };
    } };
    const config = triageConfig(h.config);
    const subagent: MailSubagent = { run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      const ids = workflow.context(jobId, sessionKey).messages.flatMap(row => row.messageIds);
      wakes.push(ids);
      if (ids.includes(blocker.id)) await gate;
      workflow.complete({ jobId, sessionKey, reason: 'Whole conversation handled' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }) };
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    try {
      await workflow.start(); await waitFor(() => wakes.length === 1);
      t.mock.timers.setTime(Date.now() + 60000);
      const first = message('aa01', 'Initial request');
      const inbox = separateThreads([blocker, first]);
      h.setFixture(inbox); await workflow.poll();
      if (scenario.due) {
        t.mock.timers.setTime(Date.now() + 86400000);
        await workflow.poll();
      }
      t.mock.timers.setTime(Date.now() + 60000);
      const reply = message('aa02', 'The same request is now urgent');
      inbox.threads.bb01.thread.messages.push(reply);
      inbox.search.messages.push({ id: reply.id, threadId: reply.threadId });
      h.setFixture(inbox); await workflow.poll();
      release(); await waitFor(() => !workflow.status().working && !workflow.status().jobs.queued);
      const delayed = scenario.initial === 'wake' && scenario.reply === 'queue';
      assert.deepEqual(wakes, delayed ? [['ff01']] : [['ff01'], ['aa01', 'aa02']],
        'waiting members share one wake; an urgent-to-queue downgrade waits for its cadence');
      assert.equal(provider.calls(), 3, 'one assessment for each new conversation state');
      await workflow.stop();
      workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
      t.mock.timers.setTime(Date.now() + 86400000);
      await workflow.start(); await waitFor(() => !workflow.status().working);
      assert.deepEqual(wakes, [['ff01'], ['aa01', 'aa02']], 'completed work does not reappear at the next queue interval');
      assert.equal(workflow.status().messages.done, 3);
    } finally { release(); await workflow.stop(); }
  }));
});

test('upgrading defaults preserves saved agent policy until an explicit file edit', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const config = triageConfig(h.config), provider = assessments();
  const subagent: MailSubagent = { run: async () => { throw new Error('empty mailbox'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  const custom = { prompt: 'Only wake for customer outages', deletePrompt: 'Expired offers only', queueMinutes: 60,
    labels: [{ name: 'Customers', description: 'Customer conversations' }] };
  try {
    await workflow.start();
    workflow.policyUpdate(custom, workflow.policyGet().version, 'agent');
    await workflow.stop();
    const db = h.db();
    // A prior release fingerprint differs from the new built-in default.
    db.prepare("UPDATE meta SET value='previous-release-default' WHERE key='triage_config_policy'").run();
    db.prepare("UPDATE meta SET value='thread' WHERE key='triage_unit'").run();
    db.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet().document, custom);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet().document, custom, 'an unchanged restart retains customizations');
    await workflow.stop();
    workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: defaultPolicy }), stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet().document, defaultPolicy, 'explicitly selecting the default in the file is still an edit');
  } finally { await workflow.stop(); }
}));

test('mail that expires during label inference is not modified', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  h.setFixture(fixture([message('aa01', 'Pending categorization', { received: Date.now() - 29 * 86400000 })]));
  const provider = assessments(() => ({ label_0: { type: 'choice', choice: 'apply', probabilities: {} } }));
  let labeling = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (opts.purpose.endsWith('.labels')) { labeling = true; await gate; }
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Work', description: 'Pending work' }] } });
  const workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => labeling);
    t.mock.timers.setTime(Date.now() + 2 * 86400000);
    release(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 0, 'expiry prevents the delayed label write');
  } finally { release(); await workflow.stop(); }
}));

test('oversized conversations retain recent plaintext and expose truncation without changing full agent transcripts', async () => withHarness(async h => {
  const old = message('aa01', 'EARLIEST_HISTORY ' + 'old body '.repeat(1000), { received: Date.now() - 86400000 });
  const latest = message('aa02', 'NEW_REQUEST 😀 ' + 'current details '.repeat(1000), { received: Date.now() - 60000 });
  h.setFixture(fixture([old, latest], [latest]));
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    const text = JSON.stringify(batch.state);
    assert.ok(text.includes('NEW_REQUEST 😀'));
    assert.ok(!text.includes('EARLIEST_HISTORY') && !text.includes('�'));
    assert.ok(text.length < 12000, 'oversized payload is shortened before reaching the provider');
    return provider.decisions.evaluate(batch, opts);
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  let woke = false;
  workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { maxInputTokens: 1000 } }), stateDir: h.stateDir,
    ...provider, decisions, subagent: {
      run: async ({ sessionKey, message: prompt }) => {
        const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
        const transcript = readFileSync(context.messages[0].transcript!, 'utf8');
        assert.ok(transcript.includes('EARLIEST_HISTORY') && transcript.includes('NEW_REQUEST'));
        assert.deepEqual(context.messages[0].triage?.coverage, { complete: false, missing: ['conversation trimmed to token budget'] });
        workflow.complete({ jobId, sessionKey, reason: 'Read full transcript' }); woke = true;
        return { runId: jobId };
      }, waitForRun: async () => ({ status: 'ok' }),
    } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.equal(woke, true); assert.equal(provider.calls(), 1);
  } finally { await workflow.stop(); }
}));
