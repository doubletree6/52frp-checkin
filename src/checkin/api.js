'use strict';

/**
 * 签到方法 A：纯 API 直签（不启动浏览器）
 *
 * 移植自 hugeos/52frp-checkin 的 src/lib.js，按本项目的 CommonJS 风格重写，
 * 并补齐了原实现缺失的部分：请求超时、分步日志、失败原因分类、以及"必须复查才算成功"。
 *
 * 请求链路（与上游一致）：
 *   GET  https://www.52frp.com/user/          预热，拿初始 Cookie（含 CSRF）
 *   POST https://www.52frp.com/api/user/login  账号密码登录 → Bearer token
 *   GET  https://www.52frp.com/api/user/sign/info   查询今日是否已签到
 *   GET  https://www.52frp.com/api/user/slider-token 取一次性 slider_token
 *   POST https://www.52frp.com/api/user/sign    提交签到
 *   GET  https://www.52frp.com/api/user/sign/info   复查（唯一的可信成功判据）
 *
 * 已知前提（上游 README 与提交记录都写明）：52frp 会校验请求特征（TLS 指纹 + 请求头组合），
 * Node 的 fetch 指纹不是 Chrome，可能直接被拒。所以本策略失败是**预期内**的，
 * 由调度器回退到浏览器方案，不要把它当成致命错误。
 */

const { STATUS, createResult } = require('./result');

const BASE = 'https://www.52frp.com/api';
const PANEL = 'https://www.52frp.com/user/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** 登录后服务端下发的 CSRF cookie 名，POST 必须回传 X-CSRF-Token，否则 400 */
const CSRF_COOKIE = 'hzfrp_user_csrf';

const DEFAULT_TIMEOUT_MS = 15_000;

function resolveEnvInt(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 响应解析工具（沿用上游的宽松解析，52frp 各接口包裹层数不统一）----

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return payload.data ?? payload;
}

function pickMessage(payload, fallback = '请求失败') {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return fallback;
  const inner = unwrap(unwrap(payload));
  return inner?.msg || inner?.message || payload?.msg || payload?.message || fallback;
}

function isFailPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.success === false) return true;
  if (typeof payload.code === 'number' && payload.code !== 200) return true;
  if (typeof payload.status === 'number' && payload.status !== 200) return true;
  return false;
}

/**
 * 把 signed_today 之类的字段读成严格的三态。
 *
 * 为什么必须是三态：2026-09-19 出过事故——页面没渲染完整时把「签到成功」当成"已签到"证据，
 * 结果脚本跳过点击，推送"已签到"但实际漏签。这里只认**明确的**布尔值，
 * 字段缺失/为 null 一律返回 null（"判断不了"），调用方会按"未签到"继续走，
 * 宁可多提交一次被服务端拒绝，也不能因为误判而漏签。
 */
function readSignedFlag(payload) {
  const data = unwrap(payload) || {};
  const raw = data?.signed_today ?? data?.signed ?? payload?.signed_today ?? payload?.signed;

  if (raw === true || raw === false) return raw;
  if (raw === 1 || raw === 0) return Boolean(raw);
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
  }
  return null;
}

function readNumber(payload, keys, fallback = null) {
  const data = unwrap(payload) || {};
  for (const key of keys) {
    const candidates = [data?.[key], payload?.[key]];
    for (const c of candidates) {
      if (c === null || c === undefined || c === '') continue;
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

// ---- 错误 ----

class ApiError extends Error {
  constructor(message, { status = null, payload = null, step = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.step = step;
    /** 只有传输层错误才重试；业务层拒绝（400/401/…）重试没有意义，还浪费站点额度 */
    this.retryable = false;
  }
}

function isTransportError(error) {
  const text = String(error?.message || error || '');
  return (
    /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR/i.test(
      text
    ) || error?.name === 'TimeoutError' || error?.name === 'AbortError'
  );
}

/**
 * 把错误翻译成人能看懂的中文原因，并标出是否值得换方案重试。
 * 返回 { reason, kind }，kind 供调度器/上层提示用：
 *   risk-control  站点风控（滑块 / TLS 指纹）→ 只能靠浏览器方案
 *   rate-limit    频率限制
 *   upstream      站点或 CDN 侧故障
 *   network       网络异常
 *   auth          账号密码或鉴权问题
 *   unknown       其它
 */
function classifyFailure(error, step) {
  const status = error?.status ?? null;
  const text = String(error?.message || error || '');
  const prefix = step ? `${step}：` : '';

  if (/滑块|captcha|slider|验证/i.test(text)) {
    return { reason: `${prefix}站点要求滑块验证，纯 API 无法完成（${text}）`, kind: 'risk-control' };
  }
  if (/未拿到 token|no token|未返回 token/i.test(text)) {
    return {
      reason: `${prefix}登录未返回 token，可能被风控拦截或需要滑块验证（${text}）`,
      kind: 'risk-control',
    };
  }
  if (status === 429 || /频率|过于频繁|已达上限|次数超限|rate limit|too many/i.test(text)) {
    return { reason: `${prefix}触发站点频率限制（HTTP ${status ?? '-'}，${text}）`, kind: 'rate-limit' };
  }
  if (typeof status === 'number' && status >= 500) {
    return { reason: `${prefix}站点/CDN 侧故障（HTTP ${status}，${text}）`, kind: 'upstream' };
  }
  if (status === 401 || status === 403) {
    return { reason: `${prefix}鉴权被拒绝（HTTP ${status}，${text}），检查账号密码`, kind: 'auth' };
  }
  if (status === 400) {
    return { reason: `${prefix}请求被拒绝（HTTP 400，${text}），常见原因是请求特征不符或缺 CSRF`, kind: 'risk-control' };
  }
  if (isTransportError(error)) {
    return { reason: `${prefix}网络异常（${text}）`, kind: 'network' };
  }
  return { reason: `${prefix}${text || '未知错误'}`, kind: 'unknown' };
}

// ---- API 客户端 ----

function createClient({ fetchImpl, timeoutMs, logger, retryDelayMs = 800 }) {
  const jar = new Map();
  let token = '';
  let csrf = '';

  const buildHeaders = (extra = {}) => {
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Sec-Ch-Ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Priority: 'u=1, i',
      Origin: 'https://www.52frp.com',
      Referer: PANEL,
      ...extra,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (jar.size > 0) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return headers;
  };

  const saveCookies = (response) => {
    const setCookies =
      typeof response?.headers?.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response?.headers?.get?.('set-cookie')].filter(Boolean);

    for (const raw of setCookies) {
      const pair = String(raw).split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      jar.set(key, value);
      if (key === CSRF_COOKIE) csrf = value;
    }
  };

  /**
   * @param {string} method
   * @param {string} path
   * @param {object|null} body
   * @param {{step?: string, retry?: boolean}} options
   */
  async function call(method, path, body, options = {}) {
    const { step = path, retry = true } = options;
    const url = `${BASE}/${String(path).replace(/^\/+/, '')}`;
    const maxAttempts = retry ? 2 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const init = {
        method,
        headers: buildHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      try {
        const response = await fetchImpl(url, init);
        saveCookies(response);

        const text = await response.text();
        let data = text;
        try {
          data = JSON.parse(text);
        } catch {
          /* 站点故障页会返回 HTML，保留原文便于分类 */
        }

        if (!response.ok || isFailPayload(data)) {
          const error = new ApiError(pickMessage(data, `HTTP ${response.status}`), {
            status: response.status,
            payload: typeof data === 'string' ? text.slice(0, 300) : data,
            step,
          });
          throw error;
        }

        return data;
      } catch (error) {
        lastError = error;
        // 只有传输层错误值得重试；业务拒绝重试没意义，还占站点额度
        if (!isTransportError(error) || attempt >= maxAttempts) break;
        logger(`[方法A] ${step} 网络异常，${retryDelayMs}ms 后重试（${attempt}/${maxAttempts - 1}）: ${error.message}`);
        await sleep(retryDelayMs);
      }
    }

    throw lastError;
  }

  return {
    get jar() {
      return jar;
    },
    get csrf() {
      return csrf;
    },
    setToken(value) {
      token = String(value || '').replace(/^Bearer\s+/i, '');
    },
    /** 预热：先访问面板拿初始 Cookie（含 CSRF），直接登录容易被拒 */
    async prime() {
      const response = await fetchImpl(PANEL, {
        headers: buildHeaders({ Accept: 'text/html,*/*' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      saveCookies(response);
      return response.status;
    },
    login: (username, password) => call('POST', 'user/login', { username, password }, { step: '登录' }),
    signInfo: () => call('GET', 'user/sign/info', null, { step: '查询签到状态' }),
    sliderToken: () => call('GET', 'user/slider-token', null, { step: '获取 slider_token' }),
    // 签到这一步不重试：重复提交可能撞上"签到次数超限"
    sign: (sliderToken) => call('POST', 'user/sign', { slider_token: sliderToken }, { step: '提交签到', retry: false }),
  };
}

// ---- 策略入口 ----

/**
 * 执行方法 A。
 * 约定：不抛异常，永远返回归一化结果（失败也返回 error + 可读 reason），
 * 由调度器决定是否回退。
 */
async function runApiCheckIn(options = {}) {
  const {
    username,
    password,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    log = (...args) => console.log(...args),
    env = process.env,
  } = options;

  const strategy = 'api';

  if (!username || !password) {
    return createResult({
      status: STATUS.SKIPPED,
      strategy,
      message: '方法 A 未执行',
      reason: '缺少 FRP_USERNAME / FRP_PASSWORD，无法调用登录接口',
    });
  }

  if (typeof fetchImpl !== 'function') {
    return createResult({
      status: STATUS.SKIPPED,
      strategy,
      message: '方法 A 未执行',
      reason: '当前运行环境不支持 fetch（需要 Node 18+）',
    });
  }

  const client = createClient({ fetchImpl, timeoutMs, logger: log });
  const fail = (error, step) => {
    const { reason, kind } = classifyFailure(error, step);
    log(`[方法A] ${reason}`);
    return createResult({
      status: STATUS.ERROR,
      strategy,
      message: '52frp签到失败',
      reason,
      raw: { kind, step, status: error?.status ?? null },
    });
  };

  log(`[方法A] 开始纯 API 签到（超时 ${timeoutMs}ms）`);

  // 1. 预热拿 Cookie
  try {
    const status = await client.prime();
    log(`[方法A] 预热完成：GET /user/ → HTTP ${status}，Cookie ${[...client.jar.keys()].join(', ') || '无'}`);
    log(`[方法A] CSRF：${client.csrf ? '已获取' : '未下发（POST 可能被拒）'}`);
  } catch (error) {
    // 预热失败不致命，登录本身还会再拿一次 Cookie
    log(`[方法A] 预热失败（继续尝试登录）: ${error.message}`);
  }

  // 2. 登录
  let loginPayload;
  try {
    loginPayload = await client.login(username, password);
  } catch (error) {
    return fail(error, '登录');
  }

  const authToken =
    unwrap(unwrap(loginPayload))?.token || loginPayload?.token || unwrap(loginPayload)?.access_token || '';
  if (!authToken) {
    return fail(new Error('登录未返回 token'), '登录');
  }
  client.setToken(authToken);
  log(`[方法A] 登录成功，已取得 token（长度 ${authToken.length}）`);

  // 3. 查询签到状态
  let beforePayload;
  try {
    beforePayload = await client.signInfo();
  } catch (error) {
    return fail(error, '查询签到状态');
  }

  const signedBefore = readSignedFlag(beforePayload);
  log(`[方法A] 签到前状态：signed_today = ${signedBefore === null ? '未取到' : String(signedBefore)}`);

  if (signedBefore === true) {
    const metrics = {
      totalSignDays: readNumber(beforePayload, ['total_sign_days', 'totalSignDays', 'days']),
      remainingBytes: readNumber(beforePayload, ['available_traffic', 'total_traffic', 'remaining_traffic']),
    };
    log('[方法A] 服务端确认今日已签到，不再提交签到请求');
    return createResult({
      status: STATUS.ALREADY,
      strategy,
      message: '52frp今日已签到（无需重复签到）',
      metrics,
      raw: { before: beforePayload },
    });
  }

  // 4. 取 slider_token
  //    上游注释说明：真实浏览器会连续取两次并使用最后一次，这里照做以贴近浏览器行为
  let sliderToken = '';
  try {
    for (let i = 0; i < 2; i++) {
      const payload = await client.sliderToken();
      const candidate = unwrap(payload)?.token || payload?.token || '';
      if (candidate) sliderToken = candidate;
    }
  } catch (error) {
    return fail(error, '获取 slider_token');
  }

  if (!sliderToken) {
    return fail(new Error('未拿到 slider_token'), '获取 slider_token');
  }
  log(`[方法A] 已取得 slider_token（长度 ${sliderToken.length}）`);

  // 5. 提交签到
  try {
    await client.sign(sliderToken);
    log('[方法A] 签到请求已提交');
  } catch (error) {
    return fail(error, '提交签到');
  }

  // 6. 复查 —— 唯一可信的成功判据
  //    签到接口返回 200 只代表"请求被接受"，不代表真的签上了（上游就是在这里发现没签上的）
  let afterPayload;
  try {
    afterPayload = await client.signInfo();
  } catch (error) {
    return fail(error, '复查签到状态');
  }

  const signedAfter = readSignedFlag(afterPayload);
  log(`[方法A] 复查结果：signed_today = ${signedAfter === null ? '未取到' : String(signedAfter)}`);

  if (signedAfter === true) {
    const metrics = {
      totalSignDays: readNumber(afterPayload, ['total_sign_days', 'totalSignDays', 'days']),
      remainingBytes: readNumber(afterPayload, ['available_traffic', 'total_traffic', 'remaining_traffic']),
    };
    return createResult({
      status: STATUS.SUCCESS,
      strategy,
      message: '52frp签到成功',
      metrics,
      raw: { before: beforePayload, after: afterPayload },
    });
  }

  // 明确的失败：请求发出去了但服务端没生效，绝不静默当成功
  const { reason } = classifyFailure(
    new Error('签到请求已提交，但复查显示今日仍未签到（可能被风控要求真人滑块验证）'),
    '复查签到状态'
  );
  log(`[方法A] ${reason}`);
  return createResult({
    status: STATUS.ERROR,
    strategy,
    message: '52frp签到失败',
    reason,
    raw: { kind: 'risk-control', after: afterPayload },
  });
}

module.exports = {
  runApiCheckIn,
  createClient,
  classifyFailure,
  readSignedFlag,
  readNumber,
  isFailPayload,
  pickMessage,
  unwrap,
  resolveEnvInt,
  ApiError,
  BASE,
  PANEL,
  CSRF_COOKIE,
  DEFAULT_TIMEOUT_MS,
};
