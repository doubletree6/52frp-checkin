const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractLoginToken,
  extractSliderToken,
  normalizeSignInfo,
  normalizeUserInfo,
  formatBytes,
  runCheckIn,
} = require('../src/core');

test('extractLoginToken supports common response shapes', () => {
  assert.equal(extractLoginToken({ data: { token: 'abc' } }), 'abc');
  assert.equal(extractLoginToken({ token: 'def' }), 'def');
  assert.equal(extractLoginToken({ data: { Token: 'ghi' } }), 'ghi');
  assert.equal(extractLoginToken({}), '');
});

test('extractSliderToken supports nested token payloads', () => {
  assert.equal(extractSliderToken({ data: { token: 'slider-1' } }), 'slider-1');
  assert.equal(extractSliderToken({ token: 'slider-2' }), 'slider-2');
  assert.equal(extractSliderToken({}), '');
});

test('normalizeSignInfo reads the panel response shape', () => {
  const info = normalizeSignInfo({
    data: {
      total_sign_days: 7,
      total_traffic: 3221225472,
      available_traffic: 2147483648,
      signed_today: true,
      signdate: 1713139200,
      min_traffic: 1073741824,
      max_traffic: 3221225472,
    },
  });

  assert.deepEqual(info, {
    totalSignDays: 7,
    totalTrafficBytes: 3221225472,
    availableTrafficBytes: 2147483648,
    signedToday: true,
    lastSignTime: 1713139200,
    minTrafficBytes: 1073741824,
    maxTrafficBytes: 3221225472,
  });
});

test('normalizeUserInfo extracts remaining traffic', () => {
  const info = normalizeUserInfo({
    data: {
      total_traffic: 107374182400,
      used_traffic: 6205216,
      remaining_traffic: 107367977184,
    },
  });

  assert.deepEqual(info, {
    totalTrafficBytes: 107374182400,
    usedTrafficBytes: 6205216,
    remainingTrafficBytes: 107367977184,
  });
});

test('formatBytes handles various sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1048576), '1.00 MB');
  assert.equal(formatBytes(1073741824), '1.00 GB');
  assert.equal(formatBytes(1099511627776), '1.00 TB');
  assert.equal(formatBytes(2147483648), '2.00 GB');
});

test('runCheckIn short-circuits when already signed today', async () => {
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
          total_sign_days: 12,
          total_traffic: 5368709120,
          available_traffic: 5368709120,
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
    async getSignSliderToken() {
      calls.push(['getSignSliderToken']);
      throw new Error('should not be called');
    },
    async signIn() {
      calls.push(['signIn']);
      throw new Error('should not be called');
    },
  };

  const result = await runCheckIn(api, { username: 'user', password: 'pass' });

  assert.equal(result.status, 'already_signed');
  assert.match(result.message, /累签:12 天/);
  assert.match(result.message, /获得:5.00 GB/);
  assert.match(result.message, /剩余:99\.99 GB/);
  assert.deepEqual(calls, [
    ['login', { username: 'user', password: 'pass' }],
    ['setToken', 'token-1'],
    ['getUserInfo'],
    ['getSignInfo'],
  ]);
});

test('runCheckIn completes the sign flow and reports success details', async () => {
  const calls = [];
  let signInfoCallCount = 0;

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
      signInfoCallCount++;
      if (signInfoCallCount === 1) {
        return {
          data: {
            total_sign_days: 4,
            available_traffic: 1073741824,
            signed_today: false,
            min_traffic: 1073741824,
            max_traffic: 2147483648,
          },
        };
      }
      return {
        data: {
          total_sign_days: 5,
          available_traffic: 3221225472,
          signed_today: true,
          total_traffic: 3221225472,
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
    async getSignSliderToken() {
      calls.push(['getSignSliderToken']);
      return { data: { token: 'slider-token' } };
    },
    async signIn(sliderToken) {
      calls.push(['signIn', sliderToken]);
      return {
        data: {
          last_traffic: 2147483648,
          total_sign_days: 5,
        },
      };
    },
  };

  const result = await runCheckIn(api, { username: 'user', password: 'pass' });

  assert.equal(result.status, 'success');
  assert.match(result.message, /累签:5 天/);
  assert.match(result.message, /获得:2.00 GB/);
  assert.match(result.message, /剩余:99\.99 GB/);
});

test('runCheckIn fails fast when login token is missing', async () => {
  const api = {
    async login() {
      return { data: {} };
    },
    setToken() {},
    async getSignInfo() {
      throw new Error('should not be called');
    },
    async getUserInfo() {
      throw new Error('should not be called');
    },
    async getSignSliderToken() {
      throw new Error('should not be called');
    },
    async signIn() {
      throw new Error('should not be called');
    },
  };

  await assert.rejects(
    () => runCheckIn(api, { username: 'user', password: 'pass' }),
    /登录成功但未拿到 token/
  );
});