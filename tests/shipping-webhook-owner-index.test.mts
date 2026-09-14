import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { registerWebhook } from '../server/worldmonitor/shipping/v2/register-webhook';
import { listWebhooks } from '../server/worldmonitor/shipping/v2/list-webhooks';
import { callerFingerprint, ownerIndexKey, webhookKey } from '../server/worldmonitor/shipping/v2/webhook-shared';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const request = new Request('https://worldmonitor.app/api/v2/shipping/webhooks', { headers: { 'X-WorldMonitor-Key': 'pro-test-key' } });
const ctx = { request, pathParams: {}, headers: {} };
beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

for (const action of ['list', 'register'] as const) {
  test(`${action} removes confirmed stale members and preserves live records`, async () => {
    const ownerTag = await callerFingerprint(request, 'pro-test-key');
    const members = new Set(['wh_expired', 'wh_live']);
    const record = { subscriberId: 'wh_live', ownerTag, callbackUrl: 'https://8.8.8.8/hook', chokepointIds: [], alertThreshold: 50, createdAt: '2026-09-01', active: true, secret: 'private' };
    const records = new Map([[webhookKey('wh_live'), JSON.stringify(record)]]);
    globalThis.fetch = async (_url, init) => {
      const commands = JSON.parse(String(init?.body)) as string[][];
      return Response.json(commands.map(([verb, key, ...args]) => {
        if (verb === 'SMEMBERS') { assert.equal(key, ownerIndexKey(ownerTag)); return { result: [...members] }; }
        if (verb === 'GET') return { result: records.get(key) ?? null };
        if (verb === 'EVAL') {
          const [, ownerKey, recordKey, id] = args;
          assert.equal(ownerKey, ownerIndexKey(ownerTag));
          return { result: records.has(recordKey) ? 0 : Number(members.delete(id)) };
        }
        if (verb === 'SET') { records.set(key, args[0]); return { result: 'OK' }; }
        if (verb === 'SADD') { members.add(args[0]); return { result: 1 }; }
        if (verb === 'EXPIRE') return { result: 1 };
        throw new Error(`Unexpected Redis command ${verb}`);
      }));
    };
    if (action === 'list') {
      const result = await listWebhooks(ctx, {});
      assert.deepEqual(result.webhooks.map((hook) => hook.subscriberId), ['wh_live']);
      assert.equal('secret' in result.webhooks[0], false);
    } else {
      const result = await registerWebhook(ctx, { callbackUrl: 'https://8.8.8.8/hook', chokepointIds: [], alertThreshold: 50 });
      assert.equal(members.has(result.subscriberId), true);
    }
    assert.equal(members.has('wh_expired'), false);
    assert.equal(members.has('wh_live'), true);
  });
}
