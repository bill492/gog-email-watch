import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GogMailClient, parseConfig, type GmailMessage } from '../src/mail.js';
import { createMailWorkflow } from '../src/workflow.js';

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
  search: { messages: Array<{ id: string; threadId: string }> };
  threads: Record<string, { thread: { id: string; messages: unknown[] } }>;
  send?: { id: string };
  sendFailure?: boolean;
  probeWritableDb?: boolean;
};

function fixture(messages: GmailMessage[], search = messages): Fixture {
  return {
    search: { messages: search.map(({ id, threadId }) => ({ id, threadId })) },
    threads: { bb01: { thread: { id: 'bb01', messages } } },
    send: { id: 'cc01' },
    probeWritableDb: true,
  };
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

test('rejects an unapproved sender and retries a failed Gmail thread read without partial queueing', async () => withHarness(async (h) => {
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
  await assert.rejects(workflow.poll());
  const db = h.db();
  assert.equal(db.prepare("SELECT id FROM messages WHERE id='aa02'").get(), undefined);
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
