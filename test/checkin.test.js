const test = require('node:test');
const assert = require('node:assert');

const {
  STATUS,
  createResult,
  isOkResult,
  buildNotice,
  formatTrafficCompact,
} = require('../src/checkin/result');
const {
  runApiCheckIn,
  readSignedFlag,
  classifyFailure,
  ApiError,
} = require('../src/checkin/api');
const { resolveOrder, runCheckin, STRATEGIES } = require('../src/checkin/runner');
const { classifyBrowserFailure, toMetrics } = require('../src/checkin/browser');

// ---- 测试用工具 ----

function mockResponse(status, body, setCookies = []) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === 'set-cookie' ? setCookies.join(', ') : null),
    },
  };
}

function noopLog() {}

const CREDENTIALS = { username: 'tester', password: 'secret' };

// ---- result.js ----

test('createResult 归一化指标并拒绝未知状态', () => {
  const ok = createResult({
    status: STATUS.SUCCESS,
    strategy: 'api',
    message: 'ok',
    metrics: { totalSignDays: '12', todayRewardBytes: null },
  });

  assert.strictEqual(ok.status, 'success');
  assert.strictEqual(ok.metrics.totalSignDays, 12);
  assert.strictEqual(ok.metrics.todayRewardBytes, null);
  assert.strictEqual(ok.reason, null);

  assert.throws(() => createResult({ status: 'weird', message: 'x' }), /未知的签到状态/);
});

test('只有 success / already_signed 才算签到完成', () => {
  assert.ok(isOkResult({ status: STATUS.SUCCESS }));
  assert.ok(isOkResult({ status: STATUS.ALREADY }));
  assert.ok(!isOkResult({ status: STATUS.ERROR }));
  assert.ok(!isOkResult({ status: STATUS.SKIPPED }));
  assert.ok(!isOkResult(null));
});

test('formatTrafficCompact 缺值显示未取到', () => {
  assert.strictEqual(formatTrafficCompact(null), '未取到');
  assert.strictEqual(formatTrafficCompact(2.5 * 1024 ** 3), '2.50GB');
});

test('buildNotice 失败时列出每种方式的原因，不静默', () => {
  const result = createResult({
    status: STATUS.ERROR,
    strategy: null,
    message: '52frp签到失败',
    reason: '所有方式均失败',
  });
  const notice = buildNotice(result, {
    attempts: [
      { strategy: 'api', status: 'error', reason: '登录：站点要求滑块验证' },
      { strategy: 'browser', status: 'error', reason: '执行超时' },
    ],
    strategyLabels: { api: 'API 直签（方法A）', browser: '浏览器自动化（方法B）' },
  });

  assert.ok(notice.includes('失败原因'));
  assert.ok(notice.includes('API 直签（方法A）'));
  assert.ok(notice.includes('浏览器自动化（方法B）'));
  assert.ok(notice.includes('请手动签到一次'));
});

// ---- api.js：状态判据 ----

test('readSignedFlag 只认明确的布尔值，缺失返回 null', () => {
  assert.strictEqual(readSignedFlag({ data: { signed_today: true } }), true);
  assert.strictEqual(readSignedFlag({ data: { signed_today: false } }), false);
  assert.strictEqual(readSignedFlag({ data: { signed_today: 1 } }), true);
  assert.strictEqual(readSignedFlag({ data: { signed_today: 'false' } }), false);
  // 2026-09-19 事故的根源就是"字段没取到却当成已签到"，这里必须返回 null
  assert.strictEqual(readSignedFlag({ data: {} }), null);
  assert.strictEqual(readSignedFlag(null), null);
  assert.strictEqual(readSignedFlag('不是 JSON'), null);
});

test('classifyFailure 把常见失败翻译成可读原因', () => {
  const slider = classifyFailure(new ApiError('需要滑块验证', { status: 400 }), '登录');
  assert.match(slider.reason, /滑块/);
  assert.strictEqual(slider.kind, 'risk-control');

  const limited = classifyFailure(new ApiError('too many requests', { status: 429 }), '提交签到');
  assert.strictEqual(limited.kind, 'rate-limit');

  const upstream = classifyFailure(new ApiError('Bad gateway', { status: 502 }), '登录');
  assert.strictEqual(upstream.kind, 'upstream');

  const network = classifyFailure(new Error('fetch failed'), '登录');
  assert.strictEqual(network.kind, 'network');
});

// ---- api.js：完整流程 ----

test('方法A 全流程成功（未签到 → 提交 → 复查已签到）', async () => {
  const requested = [];
  let signInfoCalls = 0;

  const fetchImpl = async (url, init) => {
    requested.push({ url, method: init.method, headers: init.headers, body: init.body });

    if (url === 'https://www.52frp.com/user/') {
      return mockResponse(200, '<html></html>', ['hzfrp_user_csrf=csrf-123; Path=/']);
    }
    if (url.includes('/api/user/login')) {
      return mockResponse(200, { code: 200, data: { token: 'jwt-token' } });
    }
    if (url.includes('/api/user/sign/info')) {
      signInfoCalls++;
      // 第一次未签到，复查时已签到
      return mockResponse(200, {
        code: 200,
        data: { signed_today: signInfoCalls > 1, total_sign_days: 13, available_traffic: 12 * 1024 ** 3 },
      });
    }
    if (url.includes('/api/user/slider-token')) {
      return mockResponse(200, { data: { token: 'slider-abc' } });
    }
    if (url.includes('/api/user/sign')) {
      return mockResponse(200, { code: 200, message: '签到成功' });
    }
    throw new Error(`未预期的请求: ${url}`);
  };

  const result = await runApiCheckIn({ ...CREDENTIALS, fetchImpl, log: noopLog });

  assert.strictEqual(result.status, STATUS.SUCCESS);
  assert.strictEqual(result.strategy, 'api');
  assert.strictEqual(result.metrics.totalSignDays, 13);
  assert.strictEqual(result.metrics.remainingBytes, 12 * 1024 ** 3);

  // CSRF：预热拿到的 cookie 必须回传到后续 POST
  const loginCall = requested.find((r) => r.url.includes('/api/user/login'));
  assert.strictEqual(loginCall.headers['X-CSRF-Token'], 'csrf-123');
  assert.ok(loginCall.headers.Cookie.includes('hzfrp_user_csrf=csrf-123'));

  // 登录后必须带 Bearer token
  const signCall = requested.find((r) => r.url.includes('/api/user/sign') && r.method === 'POST');
  assert.strictEqual(signCall.headers.Authorization, 'Bearer jwt-token');
  assert.strictEqual(JSON.parse(signCall.body).slider_token, 'slider-abc');

  // 提交后必须复查，且复查是判据
  assert.strictEqual(signInfoCalls, 2);
});

test('方法A 签到前已签到时不重复提交', async () => {
  let signPosts = 0;
  const fetchImpl = async (url, init) => {
    if (url === 'https://www.52frp.com/user/') return mockResponse(200, '<html></html>');
    if (url.includes('/api/user/login')) return mockResponse(200, { data: { token: 't' } });
    if (url.includes('/api/user/sign/info')) {
      return mockResponse(200, { data: { signed_today: true, total_sign_days: 9 } });
    }
    if (url.includes('/api/user/slider-token')) return mockResponse(200, { data: { token: 's' } });
    if (url.includes('/api/user/sign') && init.method === 'POST') {
      signPosts++;
      return mockResponse(200, { message: 'ok' });
    }
    throw new Error(`未预期的请求: ${url}`);
  };

  const result = await runApiCheckIn({ ...CREDENTIALS, fetchImpl, log: noopLog });

  assert.strictEqual(result.status, STATUS.ALREADY);
  assert.strictEqual(signPosts, 0, '已签到时不应该再提交签到请求（会占站点额度）');
  assert.strictEqual(result.metrics.totalSignDays, 9);
});

test('方法A 登录被拒时返回可读原因，不当成成功', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://www.52frp.com/user/') return mockResponse(200, '<html></html>');
    if (url.includes('/api/user/login')) {
      return mockResponse(400, { code: 400, msg: '请先完成滑块验证' });
    }
    throw new Error(`未预期的请求: ${url}`);
  };

  const result = await runApiCheckIn({ ...CREDENTIALS, fetchImpl, log: noopLog });

  assert.strictEqual(result.status, STATUS.ERROR);
  assert.match(result.reason, /登录/);
  assert.match(result.reason, /滑块|HTTP 400/);
  assert.strictEqual(result.raw.kind, 'risk-control');
});

test('方法A 签到请求成功但复查未签上，必须判失败', async () => {
  let signInfoCalls = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.52frp.com/user/') return mockResponse(200, '<html></html>');
    if (url.includes('/api/user/login')) return mockResponse(200, { data: { token: 't' } });
    if (url.includes('/api/user/sign/info')) {
      signInfoCalls++;
      return mockResponse(200, { data: { signed_today: false } });
    }
    if (url.includes('/api/user/slider-token')) return mockResponse(200, { data: { token: 's' } });
    if (url.includes('/api/user/sign')) return mockResponse(200, { message: '签到成功' });
    throw new Error(`未预期的请求: ${url}`);
  };

  const result = await runApiCheckIn({ ...CREDENTIALS, fetchImpl, log: noopLog });

  assert.strictEqual(result.status, STATUS.ERROR, '签到接口返回 200 不等于真的签上了');
  assert.match(result.reason, /复查/);
  assert.strictEqual(signInfoCalls, 2);
});

test('方法A 缺账号密码时跳过而不是崩溃', async () => {
  const result = await runApiCheckIn({ username: '', password: '', fetchImpl: async () => mockResponse(200, {}), log: noopLog });
  assert.strictEqual(result.status, STATUS.SKIPPED);
  assert.match(result.reason, /FRP_USERNAME/);
});

// ---- runner.js ----

test('resolveOrder 解析各种配置', () => {
  assert.deepStrictEqual(resolveOrder('auto'), ['api', 'browser']);
  assert.deepStrictEqual(resolveOrder(undefined), ['api', 'browser']);
  assert.deepStrictEqual(resolveOrder('api'), ['api']);
  assert.deepStrictEqual(resolveOrder('browser'), ['browser']);
  assert.deepStrictEqual(resolveOrder('browser,api'), ['browser', 'api']);
  assert.deepStrictEqual(resolveOrder('api,api,browser'), ['api', 'browser']);
});

test('方法A 成功时不再执行方法B', async () => {
  let browserRuns = 0;

  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'auto',
    log: noopLog,
    strategies: {
      api: { id: 'api', label: 'A', run: async () => createResult({ status: STATUS.SUCCESS, strategy: 'api', message: 'ok' }) },
      browser: {
        id: 'browser',
        label: 'B',
        run: async () => {
          browserRuns++;
          return createResult({ status: STATUS.SUCCESS, strategy: 'browser', message: 'ok' });
        },
      },
    },
  });

  assert.strictEqual(result.status, STATUS.SUCCESS);
  assert.strictEqual(result.strategy, 'api');
  assert.strictEqual(browserRuns, 0);
  assert.strictEqual(result.usedFallback, false);
});

test('方法A 失败后回退到方法B，并标记 usedFallback', async () => {
  const calls = [];

  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'auto',
    log: noopLog,
    strategies: {
      api: {
        id: 'api',
        label: 'A',
        run: async () => {
          calls.push('api');
          return createResult({
            status: STATUS.ERROR,
            strategy: 'api',
            message: 'fail',
            reason: '登录：站点要求滑块验证',
          });
        },
      },
      browser: {
        id: 'browser',
        label: 'B',
        run: async () => {
          calls.push('browser');
          return createResult({
            status: STATUS.SUCCESS,
            strategy: 'browser',
            message: 'ok',
            metrics: { totalSignDays: 14 },
          });
        },
      },
    },
  });

  assert.deepStrictEqual(calls, ['api', 'browser']);
  assert.strictEqual(result.status, STATUS.SUCCESS);
  assert.strictEqual(result.strategy, 'browser');
  assert.strictEqual(result.usedFallback, true);
  assert.strictEqual(result.metrics.totalSignDays, 14);
  assert.strictEqual(result.attempts.length, 2);
  assert.strictEqual(result.attempts[0].status, 'error');
});

test('全部方式失败时汇总原因，不丢任何一条', async () => {
  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'auto',
    log: noopLog,
    strategies: {
      api: { id: 'api', label: 'A', run: async () => createResult({ status: STATUS.ERROR, strategy: 'api', reason: '网络异常' }) },
      browser: { id: 'browser', label: 'B', run: async () => createResult({ status: STATUS.ERROR, strategy: 'browser', reason: '执行超时' }) },
    },
  });

  assert.strictEqual(result.status, STATUS.ERROR);
  assert.strictEqual(result.strategy, null);
  assert.match(result.reason, /网络异常/);
  assert.match(result.reason, /执行超时/);
  assert.strictEqual(result.attempts.length, 2);
});

test('未知策略被跳过且不影响后续方式', async () => {
  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'sms,browser',
    log: noopLog,
    strategies: {
      browser: { id: 'browser', label: 'B', run: async () => createResult({ status: STATUS.ALREADY, strategy: 'browser' }) },
    },
  });

  assert.strictEqual(result.status, STATUS.ALREADY);
  assert.strictEqual(result.attempts[0].status, STATUS.SKIPPED);
  assert.match(result.attempts[0].reason, /未注册/);
});

test('策略内部抛异常不会拖垮调度', async () => {
  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'api,browser',
    log: noopLog,
    strategies: {
      api: {
        id: 'api',
        label: 'A',
        run: async () => {
          throw new Error('boom');
        },
      },
      browser: { id: 'browser', label: 'B', run: async () => createResult({ status: STATUS.SUCCESS, strategy: 'browser' }) },
    },
  });

  assert.strictEqual(result.status, STATUS.SUCCESS);
  assert.strictEqual(result.strategy, 'browser');
  assert.match(result.attempts[0].reason, /boom/);
});

// ---- browser.js 适配器 ----

test('浏览器结果映射成统一结构', () => {
  const metrics = toMetrics({
    signStats: { totalSignDays: 16, totalRewardBytes: 3 * 1024 ** 3 },
    dashboardStats: { todayRewardBytes: 250 * 1024 ** 2, remainingBytes: 11 * 1024 ** 3 },
  });

  assert.deepStrictEqual(metrics, {
    totalSignDays: 16,
    totalRewardBytes: 3 * 1024 ** 3,
    todayRewardBytes: 250 * 1024 ** 2,
    remainingBytes: 11 * 1024 ** 3,
  });
});

test('浏览器失败原因分类', () => {
  assert.strictEqual(classifyBrowserFailure(Object.assign(new Error('Cannot find module playwright'), {})).kind, 'dependency');
  assert.strictEqual(classifyBrowserFailure(Object.assign(new Error('登录失败：账号密码错误'), { kind: 'credentials' })).kind, 'auth');
  assert.strictEqual(classifyBrowserFailure(Object.assign(new Error('页面结构变化'), { kind: 'structure' })).kind, 'structure');
  assert.strictEqual(classifyBrowserFailure(new Error('something else')).kind, 'unknown');
});

test('默认策略注册表包含 api 与 browser', () => {
  assert.ok(STRATEGIES.api);
  assert.ok(STRATEGIES.browser);
  assert.strictEqual(typeof STRATEGIES.api.run, 'function');
  assert.strictEqual(typeof STRATEGIES.browser.run, 'function');
});
