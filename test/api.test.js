const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_BASE_URL, FrpApiClient } = require('../src/api');

test('FrpApiClient defaults to the current 52frp API domain', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://www.52frp.com/api');

  const client = new FrpApiClient({ fetchImpl: async () => ({ ok: true, text: async () => '{}' }) });
  assert.equal(client.baseUrl, 'https://www.52frp.com/api');
});

test('FrpApiClient rewrites the deprecated frp.80cn.cn host to the current API domain', () => {
  const client = new FrpApiClient({
    baseUrl: 'https://frp.80cn.cn/api',
    fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
  });

  assert.equal(client.baseUrl, 'https://www.52frp.com/api');
});
