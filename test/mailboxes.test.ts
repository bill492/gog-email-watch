import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { GogMailClient, parseConfig, parsePluginConfig, PluginConfigSchema } from '../src/mail.js';
import plugin from '../src/index.js';

test('mailbox configuration normalizes legacy and multi-account inputs without ambiguous routing', () => {
  const legacy = { account: 'Agent@Example.com', domains: ['example.com'] };
  assert.equal(parsePluginConfig(legacy).mailboxes[0].account, 'agent@example.com');
  const validate = new Ajv({ strict: false }).compile(PluginConfigSchema);
  const input = { mailboxes: [legacy, { account: 'other@example.com', settings: { wakeFrom: ['example.com'] } }] };
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  assert.deepEqual(parsePluginConfig(input).mailboxes.map(mailbox => mailbox.account), ['agent@example.com', 'other@example.com']);
  for (const invalid of [{ mailboxes: [] }, { ...legacy, mailboxes: [legacy] }, { mailboxes: [{ mailboxes: [legacy] }] }]) {
    assert.throws(() => parsePluginConfig(invalid));
    assert.equal(validate(invalid), false);
  }
  assert.throws(() => parsePluginConfig({ mailboxes: [legacy, { ...legacy, account: 'agent@example.com' }] }), /duplicate/);
});

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for mailbox work');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('mailbox adapter isolates failed startup, state, dispatch identities and trusted-session tool routing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gog-email-watch-mailboxes-'));
  const fixturePath = join(dir, 'mail.json'), callsPath = join(dir, 'calls.jsonl'), gogPath = join(dir, 'gog.mjs');
  const accounts = ['first@example.com', 'second@example.com'];
  const broken = 'broken@example.com';
  const stateRoot = join(dir, 'state');
  const mailboxDir = (account: string) => join(stateRoot, 'gog-email-watch', createHash('sha256').update(account).digest('hex').slice(0, 16));
  mkdirSync(join(stateRoot, 'gog-email-watch'), { recursive: true });
  writeFileSync(mailboxDir(broken), 'controlled startup failure: this path is not a directory');
  writeFileSync(fixturePath, '{}');
  writeFileSync(callsPath, '');
  writeFileSync(gogPath, `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2), account=args[args.indexOf('--account')+1], command=args.slice(args.indexOf('gmail'));
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({account,args})+'\\n');
const messages=JSON.parse(readFileSync(${JSON.stringify(fixturePath)},'utf8'))[account]??[];
const result=command[1]==='messages'?{messages:messages.map(({id,threadId})=>({id,threadId}))}
  :command[1]==='thread'?{thread:{id:command[3],messages:messages.filter(message=>message.threadId===command[3])}}
  :command[1]==='labels'?{labels:[]}:undefined;
if(!result)throw new Error('unexpected mailbox mutation or unsupported command');
process.stdout.write(JSON.stringify(result));
`);
  chmodSync(gogPath, 0o755);
  let service: Parameters<OpenClawPluginApi['registerService']>[0] | undefined;
  let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
  const runs: Array<{ sessionKey: string; idempotencyKey: string }> = [], startupErrors: string[] = [];
  const toolsFor = (sessionKey: string) => {
    assert.equal(typeof factory, 'function');
    if (typeof factory !== 'function') throw new Error('missing registered tool factory');
    const tools = factory({ agentId: 'main', sessionKey });
    assert.ok(Array.isArray(tools));
    return tools as AnyAgentTool[];
  };
  const tool = (name: string, sessionKey = 'agent:main:main') => {
    const found = toolsFor(sessionKey).find(value => value.name === name);
    assert.ok(found, `registered ${name}`);
    return found;
  };
  const api = {
    pluginConfig: { mailboxes: [broken, ...accounts].map(account => ({ account, domains: ['example.com'], gogPath,
      pollIntervalSeconds: 1, settings: { reconcileIntervalSeconds: 1 } })) },
    runtime: { config: { current: () => ({}) }, subagent: {
      async run(input: { sessionKey: string; idempotencyKey: string; message: string }) {
        runs.push(input);
        const jobId = /^Job ID: ([a-f0-9]{24})$/m.exec(input.message)?.[1];
        assert.ok(jobId);
        const account = accounts.find(value => input.sessionKey.includes(`:${value}:`));
        assert.ok(account);
        const otherAccount = accounts.find(value => value !== account)!;
        await assert.rejects(tool('gog_email_skip', input.sessionKey).execute('conflict', { account: otherAccount, jobId, reason: 'must not cross mailboxes' }), /conflicts/);
        const context = await tool('gog_email_context', input.sessionKey).execute('context', { jobId });
        assert.ok(context.details && typeof context.details === 'object' && 'messages' in context.details);
        await tool('gog_email_skip', input.sessionKey).execute('skip', { jobId, reason: 'Handled by the right account' });
        return { runId: input.idempotencyKey, sessionKey: input.sessionKey };
      },
      async waitForRun() { return { status: 'ok' }; },
    } },
    registerService(value: Parameters<OpenClawPluginApi['registerService']>[0]) { service = value; },
    registerTool(value: Parameters<OpenClawPluginApi['registerTool']>[0]) { factory = value; },
    registerCommand() {}, registerGatewayMethod() {}, registerCli() {},
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  assert.ok(service);
  const serviceContext = { config: {}, stateDir: stateRoot, logger: { info() {}, warn() {}, debug() {}, error(value: string) { startupErrors.push(value); } } };
  const status = async () => (await tool('gog_email_status').execute('status', {})).details as { running: boolean; mailboxes: Array<{ account: string; running: boolean; startupError?: string; lastPoll: number }> };
  try {
    await service.start(serviceContext);
    await waitFor(async () => (await status()).mailboxes.filter(value => accounts.includes(value.account)).every(value => value.lastPoll > 0));
    const health = await status();
    assert.equal(health.running, true);
    assert.equal(health.mailboxes.find(value => value.account === broken)?.running, false);
    assert.ok(health.mailboxes.find(value => value.account === broken)?.startupError);
    assert.equal(startupErrors.length, 1);
    await assert.rejects(tool('gog_email_policy_get').execute('ambiguous', {}), /account is required/);
    await tool('gog_email_policy_update').execute('edit', { account: accounts[0], expectedVersion: 1, settings: { wakePrompt: 'First mailbox only' } });
    const settingsFor = async (account: string) => (await tool('gog_email_policy_get').execute('settings', { account })).details as { settings: { wakePrompt: string } };
    assert.equal((await settingsFor(accounts[0])).settings.wakePrompt, 'First mailbox only');
    assert.equal((await settingsFor(accounts[1])).settings.wakePrompt, '');
    const mail = Object.fromEntries(accounts.map(account => [account, [{ id: 'aa01', threadId: 'bb01', internalDate: String(Date.now() + 1000), labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'bek@example.com' }, { name: 'To', value: account },
        { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=example.com' }], body: { data: Buffer.from('Please handle this request').toString('base64url') } } }]]));
    writeFileSync(fixturePath, JSON.stringify(mail));
    await waitFor(() => runs.length === 2);
    for (const account of accounts) {
      await waitFor(async () => {
        const result = await tool('gog_email_inspect').execute('inspect', { account, id: 'aa01' });
        return (result.details as Array<{ job?: { status: string }; message: { status: string } }>)[0]?.job?.status === 'skipped';
      });
      const db = new DatabaseSync(join(mailboxDir(account), 'mail.sqlite'));
      try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()?.count, 1); }
      finally { db.close(); }
    }
    assert.equal(new Set(runs.map(value => value.idempotencyKey)).size, 2, 'same Gmail IDs across accounts must not collide at host dispatch');
    assert.equal(new Set(runs.map(value => value.sessionKey)).size, 2);
  } finally {
    await service.stop?.(serviceContext);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native Gmail query selection replaces inbox/approved selection while retaining independent date and exclusion constraints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gog-email-watch-query-'));
  const gogPath = join(dir, 'gog.mjs'), queryPath = join(dir, 'query.json');
  writeFileSync(gogPath, `#!${process.execPath}
import{writeFileSync}from'node:fs';
const args=process.argv.slice(2);writeFileSync(${JSON.stringify(queryPath)},JSON.stringify(args));
process.stdout.write(JSON.stringify({messages:[{id:'aa01',threadId:'bb01'}]}));
`);
  chmodSync(gogPath, 0o755);
  try {
    const mail = new GogMailClient(parseConfig({ account: 'agent@example.com', settings: { wakeFrom: ['example.com'] }, gogPath }));
    assert.deepEqual((await mail.searchPage(100, 'next-page', 'approved', 200, 'label:Priority OR is:starred')).messages, [{ id: 'aa01', threadId: 'bb01' }]);
    const args: string[] = JSON.parse(readFileSync(queryPath, 'utf8'));
    const query = args[args.indexOf('search') + 1];
    assert.ok(query.includes('(label:Priority OR is:starred)'));
    assert.ok(query.includes('after:100') && query.includes('before:200'));
    for (const excluded of ['spam', 'trash', 'sent', 'drafts']) assert.ok(query.includes(`-in:${excluded}`));
    assert.ok(!query.includes('in:inbox') && !query.includes('from:'));
    assert.equal(args[args.indexOf('--page') + 1], 'next-page');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
