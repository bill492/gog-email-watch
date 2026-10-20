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
    const id = (batch.state as { targetMessageId: string }).targetMessageId;
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
  h.setFixture({ ...fixture([message('aa01', 'Please review the estimate', { received: Date.now() - 60000 })]), probeWritableDb: false });
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
  const subagent = { run: async () => { throw new Error('empty inbox'); }, waitForRun: async () => ({ status: 'ok' }) };
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

test('evidence settings and retry deadlines change real assessments without replaying queued work', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const target = message('aa02', 'TARGET ' + '😀'.repeat(300) + ' TAIL', { received: Date.now() - 60000 });
  const sibling = message('aa01', 'SIBLING_CONTEXT', { received: Date.now() - 120000 });
  h.setFixture(fixture([sibling, target], [target]));
  const requests: Array<{ evidence: string; timeout: number }> = [];
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    requests.push({ evidence: JSON.stringify((batch.state as { evidence: unknown }).evidence), timeout: opts.timeoutMs });
    if (requests.length === 1) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = parseConfig({ ...triageConfig(h.config), settings: {
    evidence: { maxBytes: 1024, context: 'message' }, decisionTimeoutSeconds: 12.5, retryDelaySeconds: 5,
  } });
  const subagent = { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start();
    assert.equal(workflow.status().messages.pending, 1);
    t.mock.timers.setTime(Date.now() + 2000); await workflow.poll(); assert.equal(requests.length, 1);
    t.mock.timers.setTime(Date.now() + 3000); await workflow.poll();
    assert.equal(workflow.status().messages.queue, 1); assert.equal(requests.length, 2);
    assert.equal(requests[1].timeout, 12500);
    assert.ok(Buffer.byteLength(requests[1].evidence) <= 1024);
    assert.ok(requests[1].evidence.includes('TARGET') && !requests[1].evidence.includes('TAIL'));
    assert.ok(!requests[1].evidence.includes('SIBLING_CONTEXT'));
    workflow.policyUpdate(undefined, 1, 'main', { wakePrompt: 'Handle succinctly', decisionTimeoutSeconds: 45, concurrency: 3 });
    await workflow.poll(); assert.equal(requests.length, 2, 'operational settings do not reclassify queue');
    workflow.policyUpdate(undefined, 2, 'main', { evidence: { maxBytes: 4096, context: 'thread' } });
    await workflow.poll();
    assert.equal(requests.length, 3); assert.equal(requests[2].timeout, 45000);
    assert.ok(requests[2].evidence.includes('TAIL') && requests[2].evidence.includes('SIBLING_CONTEXT'));
    const saved = workflow.policyGet();
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet(), saved); assert.equal(requests.length, 3);
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
    }, waitForRun: async ({ timeoutMs }) => { assert.ok(timeoutMs > 0 && timeoutMs <= 250); return { status: 'ok' }; },
  } });
  const start = workflow.start();
  try {
    await waitFor(() => actions === 4);
    workflow.policyUpdate(undefined, 1, 'main', { wakePrompt: 'Start with commitments', decisionTimeoutSeconds: 60 });
    releaseActions(); await start;
    await waitFor(() => labels === 2 && !workflow.status().working);
    assert.equal(wakes, 1); assert.equal(workflow.status().messages.done, 4);
    workflow.policyUpdate(undefined, 2, 'main', { responderPrompt: 'Be concise' });
    releaseLabels(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(actions, 4); assert.equal(labels, 4); assert.equal(peakLabels, 2);
    assert.equal(workflow.inspect().filter(row => row.labels?.status === 'done').length, 4);
  } finally { releaseActions(); releaseLabels(); await start; await workflow.stop(); }
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
  await waitFor(() => workflow.status().jobs.replied === 1);
  assert.equal(runs.length, 1);
  assert.match(runs[0].message, /Summarize any commitments before responding/);
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

test('deferred work resumes once with fresh checks', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const config = h.config;
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

test('deferred daily queue resumes together at the explicit time after restart', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const messages = ['aa01', 'aa02'].map(id => message(id, 'Queued work', { received: Date.now() - 60000 }));
  h.setFixture(fixture(messages));
  const provider = assessments();
  const config = triageConfig(h.config);
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const subagent = {
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
    assert.deepEqual(wakes, [['aa01', 'aa02']]);
    assert.equal(workflow.status().messages.deferred, 2);
    assert.equal(workflow.status().nextDeferredWakeAt, Math.floor(Date.now() / 1000) + 3600);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    t.mock.timers.setTime(Date.now() + 3599000);
    await workflow.poll(); assert.equal(wakes.length, 1);
    t.mock.timers.setTime(Date.now() + 1000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01', 'aa02'], ['aa01', 'aa02']], 'explicit defer must not wait for another daily queue interval');
    assert.equal(provider.calls(), 2, 'unchanged mail reuses its successful decisions');
    assert.equal(workflow.status().messages.done, 2);
    assert.equal(workflow.status().activeJob, null);
    assert.equal(workflow.status().nextDeferredWakeAt, null);
  } finally { await workflow.stop(); }
}));


test('one cycle drains every discovery page and all pending messages', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent: {
    run: async () => { throw new Error('unapproved new mail must not wake'); }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    const messages = Array.from({ length: 104 }, (_, i) => message((0xaa00 + i).toString(16), 'Not approved', { sender: 'external@other.test' }));
    const f = fixture(messages);
    const refs = f.search.messages;
    f.search = { messages: refs.slice(0, 26), nextPageToken: 'p2' };
    f.pages = { p2: { messages: refs.slice(26, 52), nextPageToken: 'p3' }, p3: { messages: refs.slice(52, 78), nextPageToken: 'p4' }, p4: { messages: refs.slice(78) } };
    h.setFixture(f);
    await workflow.poll();
    assert.equal(workflow.status().messages.ignored, 104, 'no three-page or 25-message production cap');
    assert.equal(workflow.status().messages.pending, undefined);
  } finally { await workflow.stop(); }
}));

test('a large old-mail cycle uses configured concurrency, one wake across threads, and no daily budget', async () => withHarness(async h => {
  const messages = Array.from({ length: 251 }, (_, i) => {
    const m = message((0xaa00 + i).toString(16), 'Actionable backlog', { received: Date.now() - 86400000 });
    m.threadId = (0xbb00 + i).toString(16); return m;
  });
  // Dedicated responder regressions probe SQLite locking. Parallel fake Gmail
  // processes must not manufacture competing SQLite writers in this load test.
  h.setFixture({ ...separateThreads(messages), probeWritableDb: false });
  let active = 0, peak = 0, calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: { wake: 1 } } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, options) => {
    active++; calls++; peak = Math.max(peak, active);
    if (calls === 50) release();
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
  try {
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.equal(peak, 50); assert.equal(calls, 251);
    assert.equal(wakes.length, 1); assert.equal(wakes[0].length, 251);
    await workflow.poll(); assert.equal(calls, 251); assert.equal(wakes.length, 1);
    const cutoff = workflow.status().triage!.backlogBefore;
    await workflow.stop();
    workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
      run: async () => { throw new Error('completed cycle must not repeat'); }, waitForRun: async () => ({ status: 'ok' }),
    } });
    await workflow.start(); assert.equal(workflow.status().triage!.backlogBefore, cutoff);
    assert.equal(calls, 251);
  } finally { release(); await workflow.stop(); }
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
  const subagent = {
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
    const fresh = message('aa02', 'New mail is not triaged', { sender: 'other@outside.test' });
    h.setFixture(fixture([old, fresh]));
    await workflow.poll(); assert.equal(provider.calls(), 1); assert.equal(wakes.length, 0);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    workflow.policyUpdate({ ...policy, queueMinutes: 30 }, 1, 'delegated-agent');
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01']]); assert.equal(provider.calls(), 1);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); assert.equal(workflow.policyGet().document.queueMinutes, 30);
    assert.equal(wakes.length, 1); assert.equal(provider.calls(), 1);
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
  workflow = createMailWorkflow({ config: triageConfig(h.config, { concurrency: 1, policy: { ...defaultPolicy, labels } }), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      wakes++;
      const jobId = jobIdFromPrompt(prompt); workflow.complete({ jobId, sessionKey, reason: 'Handled before labeling' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); await waitFor(() => labelAttempts === 1 && !workflow.status().working);
    assert.equal(wakes, 1); assert.equal(workflow.status().triage!.labeling, true);
    const pending = h.db(); pending.prepare("UPDATE messages SET due=0 WHERE id='aa02'").run(); pending.close();
    retryPoll = workflow.poll();
    await waitFor(() => wakes === 2);
    await retryPoll;
    assert.equal(workflow.status().triage!.labeling, true, 'later-cycle wake does not wait for the earlier label request');
    release(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.match(String(workflow.inspect('aa01')[0].labels?.reason), /transport/);
    const db = h.db(); db.prepare('UPDATE label_work SET due=0').run(); db.close();
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(actionCalls, 3); assert.equal(labelAttempts, 3); assert.equal(wakes, 2);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    const creates = h.calls().filter(args => args.includes('create'));
    assert.deepEqual(creates.map(args => args.at(-1)).sort(), labels.map(label => label.name).sort());
  } finally { release(); await retryPoll; await workflow.stop(); }
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
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Receipts', description: 'Purchase receipts' }] } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'pending');
    // Gmail assigns a new ID when a user deletes and recreates a label.
    h.setFixture({ ...fixture([target]), labels: [{ id: 'Label_2', name: 'Receipts', type: 'user' }] });
    const db = h.db(); db.prepare('UPDATE label_work SET due=0').run(); db.close();
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

test('date-range scans traverse all pages, delete matches only, and never queue, wake or label', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const deletePrompt = 'Delete expired promotions only.';
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'aa00' ? 'keep' : 'delete', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    assert.equal(opts.purpose, 'gog-email-watch.delete-scan');
    assert.ok(JSON.stringify(batch.questions).includes(deletePrompt));
    assert.ok(!JSON.stringify(batch.questions).includes('Bring to the agent'));
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt, labels: [{ name: 'Never here', description: 'anything' }] } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: { run: async () => { throw new Error('historical scan woke'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start();
    const messages = Array.from({ length: 61 }, (_, i) => message((0xaa00 + i).toString(16), 'Promotion', { received: Date.parse('2025-04-01') }));
    const outside = message('ff01', 'Outside exact range', { received: Date.parse('2026-01-01') });
    const f = fixture([...messages, outside]); f.probeWritableDb = false; const refs = f.search.messages;
    f.search = { messages: refs.slice(0, 20), nextPageToken: 'p2' };
    f.pages = { p2: { messages: refs.slice(20, 40), nextPageToken: 'p3' }, p3: { messages: refs.slice(40, 60), nextPageToken: 'p4' }, p4: { messages: refs.slice(60) } };
    h.setFixture(f);
    const report = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(report.deleted, 60); assert.equal(report.results.length, 61); assert.equal(report.failed, 0);
    assert.equal(provider.calls(), 61); assert.deepEqual(workflow.status().messages, {}); assert.deepEqual(workflow.status().jobs, {});
    const calls = h.calls(), firstModify = calls.findIndex(args => args.includes('modify'));
    assert.ok(calls.findLastIndex(args => args.includes('search')) < firstModify, 'enumerate before mutations');
    assert.ok(calls.some(args => args.some(value => value.includes('before:1767225600'))));
    assert.ok(!calls.some(args => args.includes('create') || args.includes('send')));
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.ok(thread.messages.find(m => m.id === 'aa00')!.labelIds.includes('INBOX'));
    assert.equal(thread.messages.filter(m => m.labelIds.includes('TRASH')).length, 60);
    // Restoring mail invalidates the old effect receipt, not its classification.
    thread.messages.find(m => m.id === 'aa01')!.labelIds = ['INBOX'];
    h.setFixture({ ...fixture(thread.messages), probeWritableDb: false });
    const repeated = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(repeated.deleted, 1); assert.equal(repeated.failed, 0);
    assert.ok((await new GogMailClient(h.config).getThread('bb01')).messages.find(m => m.id === 'aa01')!.labelIds.includes('TRASH'));
    assert.equal(provider.calls(), 61, 'unchanged scan instructions and evidence reuse classification');
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 61);
  } finally { await workflow.stop(); }
}));

test('scan progress and per-message outcomes remain inspectable after the response and restart', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'aa01' ? 'delete' : 'keep', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    entered = true;
    await blocked;
    if ((batch.state as { targetMessageId: string }).targetMessageId === 'aa03') return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig(h.config, { concurrency: 1, policy: { ...defaultPolicy, deletePrompt: 'Delete promotions.' } });
  const options = { config, stateDir: h.stateDir, ...provider, decisions,
    subagent: { run: async () => { throw new Error('scan must not wake'); }, waitForRun: async () => ({ status: 'ok' }) } };
  let workflow = createMailWorkflow(options);
  let scan: ReturnType<typeof workflow.scan> | undefined;
  try {
    await workflow.start();
    const messages = ['aa01', 'aa02', 'aa03'].map(id => message(id, 'Historical mail', { received: Date.parse('2025-04-01') }));
    h.setFixture(fixture(messages));
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

test('plaintext excerpts and attachments are classified without review vetoes; uncertain deletion reconciles on retry', async () => withHarness(async h => {
  const target = message('aa02', '', { received: Date.now() - 60000 });
  target.payload = { mimeType: 'multipart/alternative', headers: [...target.payload.headers!, { name: 'DKIM-Signature', value: 'DKIM_BLOAT'.repeat(2000) }], parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('CURRENT_PROMOTION\n' + '😀'.repeat(20000) + 'UNSENT_TAIL').toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML_ONLY</p>'.repeat(20000)).toString('base64url') } },
    { mimeType: 'application/pdf', filename: 'offer.pdf', body: { attachmentId: 'not-downloaded' } },
  ] };
  const sibling = message('aa01', 'Leave this sibling alone', { received: Date.now() - 86400000 });
  h.setFixture({ ...fixture([sibling, target], [target]), modifyUncertain: true });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'delete', probabilities: { delete: 0.51 } } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    const encoded = JSON.stringify(batch.state);
    assert.ok(Buffer.byteLength(encoded) < 18000);
    assert.ok(encoded.includes('CURRENT_PROMOTION'));
    assert.ok(!encoded.includes('DKIM_BLOAT') && !encoded.includes('HTML_ONLY') && !encoded.includes('UNSENT_TAIL'));
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt: 'Delete promotions' } });
  const subagent = { run: async () => { throw new Error('deletion woke'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start(); assert.equal(workflow.status().messages.pending, 1);
    const inspected = workflow.inspect('aa02')[0];
    assert.deepEqual(inspected.plan, { action: 'delete' });
    assert.equal((inspected.coverage as { truncated: boolean }).truncated, true);
    await workflow.stop();
    const db = h.db(); db.prepare('UPDATE messages SET due=0').run(); db.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); assert.equal(workflow.status().messages.done, 1); assert.equal(provider.calls(), 1);
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 1);
    assert.equal(workflow.inspect('aa02')[0].effects[0].status, 'confirmed');
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.ok(thread.messages.find(m => m.id === 'aa01')!.labelIds.includes('INBOX'));
  } finally { await workflow.stop(); }
}));

test('provider failures stay pending beyond three attempts and are not cached as classifications', async () => withHarness(async h => {
  h.setFixture(fixture([message('aa01', 'Retry this', { received: Date.now() - 60000 })]));
  let calls = 0;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    calls++;
    if (calls < 5) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async () => { throw new Error('queued mail wakes later'); }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    for (let attempt = 1; attempt < 5; attempt++) {
      assert.equal(workflow.status().messages.pending, 1);
      const pending = workflow.inspect('aa01')[0];
      assert.ok(pending, 'first-attempt failures must be inspectable');
      assert.equal(pending.message?.status, 'pending');
      assert.match(pending.message.reason, /transport/);
      assert.equal(pending.message.attempts, attempt);
      assert.ok(pending.message.due > 0);
      assert.equal(pending.plan, undefined);
      const db = h.db(); db.prepare('UPDATE messages SET due=0').run(); db.close();
      await workflow.poll();
    }
    assert.equal(calls, 5); assert.equal(workflow.status().messages.queue, 1);
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
  const subagent = {
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
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt: 'Delete expired items', queueMinutes: 1 } }),
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
    await workflow.poll(); await workflow.processNext();
    assert.deepEqual(workflow.status().jobs, {}); assert.equal(workflow.status().messages.done, 1);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'cancelled');
  } finally { await workflow.stop(); }
}));

test('legacy unexecuted triage states migrate without replaying completed or uncertain jobs', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const subagent = { run: async () => { throw new Error('no immediate wake'); }, waitForRun: async () => ({ status: 'ok' }) };
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
  db.prepare("INSERT INTO replies VALUES ('aa05','old-uncertain','uncertain',1,'')").run();
  db.close();
  h.setFixture({ ...fixture(messages), probeWritableDb: false });
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(provider.calls(), 4);
    assert.equal(workflow.status().messages.queue, 4); assert.equal(workflow.status().messages.done, 1);
    assert.equal(workflow.status().messages.needs_review, 1);
    workflow.resolve('old-uncertain', 'Confirmed prior external outcome; do not resend');
    const check = h.db(); assert.equal(check.prepare("SELECT status FROM replies WHERE target_id='aa05'").get()?.status, 'uncertain'); check.close();
    await workflow.poll(); assert.equal(provider.calls(), 4);
  } finally { await workflow.stop(); }
}));

test('changing policy while a wake waits behind another run replaces its reservation without losing it', async () => withHarness(async h => {
  const first = message('aa01', 'First old item', { received: Date.now() - 60000 });
  const second = message('aa02', 'Second old item', { received: Date.now() - 60000 }); second.threadId = 'bb02';
  h.setFixture({ ...separateThreads([first, second]), probeWritableDb: false });
  let secondAttempts = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: { wake: 1 } } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if ((batch.state as { targetMessageId: string }).targetMessageId === 'aa02' && secondAttempts++ === 0) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      wakes.push(workflow.context(jobId, sessionKey).messages.map(row => row.id));
      if (wakes.length === 1) await gate;
      workflow.complete({ jobId, sessionKey, reason: 'Done' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); assert.deepEqual(wakes, [['aa01']]);
    const db = h.db(); db.prepare("UPDATE messages SET due=0 WHERE id='aa02'").run(); db.close();
    await workflow.poll(); assert.equal(workflow.status().jobs.queued, 1);
    workflow.policyUpdate({ ...defaultPolicy, prompt: 'Revised wake instructions' }, 1, 'main');
    await workflow.poll();
    release(); await waitFor(() => !workflow.status().working && workflow.status().jobs.completed === 2);
    assert.deepEqual(wakes, [['aa01'], ['aa02']]);
  } finally { release(); await workflow.stop(); }
}));

test('external conversation wakes require opt-in, fresh authenticated human replies and retain send restrictions', async (t) => withHarness(async (h) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const provider = assessments(id => ({ actionable: { type: 'boolean', probabilityTrue: 0.01 },
    ...(id === 'aa07' ? { credential_fraud: { type: 'boolean' as const, probabilityTrue: 0.9 } } : {}) }));
  const disabled = triageConfig(h.config);
  const enabled = triageConfig(h.config, { wakeOnExternalReplies: true });
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
    assert.deepEqual(targets, ['aa02', 'aa07']); assert.equal(provider.calls(), 0, 'new mail never enters backlog classification');
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
    assert.deepEqual(targets, ['aa02', 'aa07', 'aa09'], 're-enabling does not replay the disabled period');
  } finally { await workflow.stop(); }
}));
