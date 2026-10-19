import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import plugin from '../src/index.js';

test('email and delegated sessions cannot edit or inspect mailbox policy through tools', async () => {
  let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
  const api = {
    pluginConfig: { account: 'agent@example.com', domains: ['example.com'], triage: { decisionModel: 'typesafe/jev-1.13.0' } },
    registerService() {}, registerCommand() {}, registerGatewayMethod() {}, registerCli() {},
    registerTool(value: Parameters<OpenClawPluginApi['registerTool']>[0]) { factory = value; },
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  assert.equal(typeof factory, 'function');
  if (typeof factory !== 'function') throw new Error('tool factory missing');
  for (const sessionKey of ['agent:main:gog-email-watch:agent@example.com:bb01', 'agent:main:subagent:child']) {
    const tools = factory({ agentId: 'main', sessionKey, senderIsOwner: true });
    assert.ok(Array.isArray(tools));
    const get = tools.find(tool => tool.name === 'gog_email_policy_get')!;
    await assert.rejects(get.execute('test', {}), /approved editor/);
  }
  const tools = factory({ agentId: 'main', sessionKey: 'agent:main:main', senderIsOwner: false });
  assert.ok(Array.isArray(tools));
  await assert.rejects(tools.find(tool => tool.name === 'gog_email_policy_update')!.execute('test', {}), /owner context/);
});
