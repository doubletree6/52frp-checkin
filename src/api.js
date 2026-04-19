const DEFAULT_BASE_URL = 'https://www.52frp.com/api';
const DEPRECATED_HOSTS = new Set(['frp.80cn.cn']);

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return DEFAULT_BASE_URL;
  const trimmed = url.trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return DEFAULT_BASE_URL;
  }

  try {
    const parsed = new URL(trimmed);

    if (DEPRECATED_HOSTS.has(parsed.hostname)) {
      return DEFAULT_BASE_URL;
    }

    const normalizedPath = parsed.pathname.startsWith('/user') ? '' : parsed.pathname;
    parsed.pathname = normalizedPath.replace(/\/api\/?$/, '').replace(/\/$/, '') + '/api';
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function extractMessage(payload, fallback = '请求失败') {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return fallback;

  return (
    payload.message ||
    payload.msg ||
    payload?.data?.message ||
    payload?.data?.msg ||
    fallback
  );
}

function isPayloadFailure(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (payload.success === false) return true;
  if (typeof payload.code === 'number' && payload.code !== 200) return true;
  if (typeof payload.status === 'number' && payload.status !== 200) return true;

  return false;
}

class FrpApiClient {
  constructor({ baseUrl, fetchImpl = global.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前 Node 环境没有 fetch，请使用 Node.js 20+');
    }

    this.baseUrl = normalizeBaseUrl(baseUrl || process.env.FRP_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.token = '';
  }

  setToken(token) {
    this.token = String(token || '').replace(/^Bearer\s+/i, '');
  }

  buildUrl(path) {
    return `${this.baseUrl}/${String(path || '').replace(/^\/+/, '')}`;
  }

  buildHeaders(extraHeaders = {}) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      ...extraHeaders,
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    return headers;
  }

  async request(method, path, { body, headers } = {}) {
    const init = {
      method,
      headers: this.buildHeaders(headers),
    };

    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(this.buildUrl(path), init);
    const rawText = await response.text();

    let payload = rawText;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = rawText;
      }
    }

    if (!response.ok || isPayloadFailure(payload)) {
      throw new Error(extractMessage(payload, `请求失败 (${response.status})`));
    }

    return payload;
  }

  login({ username, password }) {
    return this.request('POST', 'user/login', {
      body: { username, password },
    });
  }

  getSignInfo() {
    return this.request('GET', 'user/sign/info');
  }

  getSignSliderToken() {
    return this.request('GET', 'user/slider-token');
  }

  signIn(sliderToken) {
    return this.request('POST', 'user/sign', {
      body: { slider_token: sliderToken },
    });
  }

  getUserInfo() {
    return this.request('GET', 'user/info');
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  FrpApiClient,
};
