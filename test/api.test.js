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

test('FrpApiClient primes the panel page before login so anti-bot cookies are available to the API session', async () => {
  const requests = [];
  const responses = [
    {
      ok: true,
      text: async () => '<html></html>',
      headers: {
        getSetCookie() {
          return [
            'acw_tc=prime-cookie; Path=/; HttpOnly',
            'cdn_sec_tc=prime-sec; Path=/; HttpOnly',
          ];
        },
      },
    },
    {
      ok: true,
      text: async () => JSON.stringify({ data: { token: 'abc' } }),
      headers: {
        getSetCookie() {
          return [];
        },
      },
    },
    {
      ok: true,
      text: async () => JSON.stringify({ data: { signed_today: false } }),
      headers: {
        getSetCookie() {
          return [];
        },
      },
    },
  ];

  const client = new FrpApiClient({
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });

  await client.login({ username: 'user', password: 'pass' });
  client.setToken('abc');
  await client.getSignInfo();

  assert.equal(requests[0].url, 'https://www.52frp.com/user/');
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[1].url, 'https://www.52frp.com/api/user/login');
  assert.match(requests[1].init.headers.Cookie, /acw_tc=prime-cookie/);
  assert.match(requests[1].init.headers.Cookie, /cdn_sec_tc=prime-sec/);
  assert.match(requests[2].init.headers.Cookie, /acw_tc=prime-cookie/);
});
