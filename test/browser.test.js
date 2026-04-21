const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAdminTokenUrl, buildSignPageUrl } = require('../src/browser');
const { calculateRewardBytes, runBrowserBackedCheckIn } = require('../src/core');

test('buildAdminTokenUrl injects admin_token and sign hash path', () => {
  const url = buildAdminTokenUrl('https://www.52frp.com/user/', 'token-123');
  assert.equal(
    url,
    'https://www.52frp.com/user/?admin_token=token-123#/welfare/sign'
  );
});

test('buildSignPageUrl points at the sign page', () => {
  const url = buildSignPageUrl('https://www.52frp.com/user/');
  assert.equal(url, 'https://www.52frp.com/user/#/welfare/sign');
});

test('calculateRewardBytes prefers positive deltas', () => {
  const rewardBytes = calculateRewardBytes(
    { totalTrafficBytes: 100, availableTrafficBytes: 40 },
    { totalTrafficBytes: 250, availableTrafficBytes: 180 }
  );

  assert.equal(rewardBytes, 150);
});

test('runBrowserBackedCheckIn short-circuits when already signed', async () => {
  const calls = [];
  const api = {
    async login(credentials) {
      calls.push(['login', credentials]);
      return { data: { token: 'token-1' } };
    },
    setToken(token) {
      calls.push(['setToken', token]);
    },
    async getSignInfo() {
      calls.push(['getSignInfo']);
      return {
        data: {
          total_sign_days: 8,
          total_traffic: 1234,
          available_traffic: 2345,
          signed_today: true,
        },
      };
    },
    async getUserInfo() {
      calls.push(['getUserInfo']);
      return {
        data: {
          total_traffic: 107374182400,
          remaining_traffic: 107367977184,
        },
      };
    },
    buildPanelUrl() {
      calls.push(['buildPanelUrl']);
      return 'https://www.52frp.com/user/';
    },
  };

  const result = await runBrowserBackedCheckIn(api, { username: 'user', password: 'pass' }, {
    browserSigner: async () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(result.status, 'already_signed');
  assert.match(result.message, /frp签8/);
  assert.deepEqual(calls, [
    ['login', { username: 'user', password: 'pass' }],
    ['setToken', 'token-1'],
    ['getUserInfo'],
    ['getSignInfo'],
  ]);
});

test('runBrowserBackedCheckIn clicks through the browser and reports success', async () => {
  const calls = [];
  let signInfoCallCount = 0;
  let userInfoCallCount = 0;

  const api = {
    async login(credentials) {
      calls.push(['login', credentials]);
      return { data: { token: 'token-2' } };
    },
    setToken(token) {
      calls.push(['setToken', token]);
    },
    async getSignInfo() {
      calls.push(['getSignInfo']);
      signInfoCallCount += 1;
      if (signInfoCallCount === 1) {
        return {
          data: {
            total_sign_days: 4,
            total_traffic: 100,
            available_traffic: 400,
            signed_today: false,
          },
        };
      }
      return {
        data: {
          total_sign_days: 5,
          total_traffic: 250,
          available_traffic: 550,
          signed_today: true,
        },
      };
    },
    async getUserInfo() {
      calls.push(['getUserInfo']);
      userInfoCallCount += 1;
      if (userInfoCallCount === 1) {
        return {
          data: {
            total_traffic: 107374182400,
            remaining_traffic: 107367977184,
          },
        };
      }
      return {
        data: {
          total_traffic: 107374182400,
          remaining_traffic: 107368108256,
        },
      };
    },
    buildPanelUrl() {
      calls.push(['buildPanelUrl']);
      return 'https://www.52frp.com/user/';
    },
  };

  const result = await runBrowserBackedCheckIn(api, { username: 'user', password: 'pass' }, {
    browserSigner: async (options) => {
      calls.push(['browserSigner', options]);
      return { status: 'success' };
    },
  });

  assert.equal(result.status, 'success');
  assert.match(result.message, /frp签5/);
  assert.match(result.message, /得150B/);
  assert.match(result.message, /余99\.99GB/);
  assert.deepEqual(calls, [
    ['login', { username: 'user', password: 'pass' }],
    ['setToken', 'token-2'],
    ['getUserInfo'],
    ['getSignInfo'],
    ['buildPanelUrl'],
    [
      'browserSigner',
      {
        panelBaseUrl: 'https://www.52frp.com/user/',
        authToken: 'token-2',
        timeoutMs: undefined,
        launchOptions: undefined,
      },
    ],
    ['getSignInfo'],
    ['getUserInfo'],
  ]);
});
