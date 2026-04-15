const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractLoginToken,
  extractSliderToken,
  normalizeSignInfo,
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
          available_traffic: 5368709120,
          signed_today: true,
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
  assert.match(result.message, /今天已经签到过了/);
  assert.match(result.message, /累计签到 12 天/);
  assert.deepEqual(calls, [
    ['login', { username: 'user', password: 'pass' }],
    ['setToken', 'token-1'],
    ['getSignInfo'],
  ]);
});

test('runCheckIn completes the sign flow and reports success details', async () => {
  const calls = [];
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
      if (calls.filter(([name]) => name === 'getSignInfo').length === 1) {
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
        message: '签到成功',
        data: {
          total_sign_days: 5,
          available_traffic: 3221225472,
          reward_traffic: 2147483648,
        },
      };
    },
  };

  const result = await runCheckIn(api, { username: 'user', password: 'pass' });

  assert.equal(result.status, 'success');
  assert.match(result.message, /签到成功/);
  assert.match(result.message, /累计签到 5 天/);
  assert.match(result.message, /本次获得 2.00 GB/);
  assert.match(result.message, /可用流量 3.00 GB/);
  assert.deepEqual(calls, [
    ['login', { username: 'user', password: 'pass' }],
    ['setToken', 'token-2'],
    ['getSignInfo'],
    ['getSignSliderToken'],
    ['signIn', 'slider-token'],
    ['getSignInfo'],
  ]);
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
