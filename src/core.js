function unwrapData(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function extractMessage(payload, fallback = '') {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return fallback;

  const root = unwrapData(payload);
  const nested = unwrapData(root);

  return (
    nested?.msg ||
    nested?.message ||
    root?.msg ||
    root?.message ||
    payload?.msg ||
    payload?.message ||
    fallback
  );
}

function isRateLimited(payload) {
  const msg = extractMessage(payload, '');
  const status = payload?.status || payload?.data?.status || 0;
  return status === 429 || msg.includes('次数已达上限') || msg.includes('请明天再试');
}

function extractLoginToken(payload) {
  const root = unwrapData(payload);
  const nested = unwrapData(root);

  return (
    nested?.token ||
    nested?.Token ||
    root?.token ||
    root?.Token ||
    payload?.token ||
    payload?.Token ||
    ''
  );
}

function extractSliderToken(payload) {
  const root = unwrapData(payload);
  const nested = unwrapData(root);

  return (
    nested?.token ||
    nested?.slider_token ||
    root?.token ||
    root?.slider_token ||
    payload?.token ||
    payload?.slider_token ||
    ''
  );
}

function normalizeSignInfo(payload) {
  const root = unwrapData(payload);
  const data = unwrapData(root) || {};

  return {
    totalSignDays: toNumber(data.total_sign_days ?? data.totalsign, 0),
    totalTrafficBytes: toNumber(data.total_traffic ?? data.totaltraffic, 0),
    availableTrafficBytes: toNumber(
      data.available_traffic ?? data.sign_available_traffic,
      0
    ),
    signedToday: Boolean(data.signed_today ?? data.signed),
    lastSignTime: toNumber(data.signdate ?? data.last_sign_time, 0),
    minTrafficBytes: toNumber(data.min_traffic ?? data.sign_min, 0),
    maxTrafficBytes: toNumber(data.max_traffic ?? data.sign_max, 0),
  };
}

function normalizeUserInfo(payload) {
  const root = unwrapData(payload);
  const data = unwrapData(root) || {};

  // 优先从 traffic 对象获取
  const traffic = data.traffic || {};

  return {
    totalTrafficBytes: toNumber(traffic.total ?? data.total_traffic ?? data.traffic, 0),
    usedTrafficBytes: toNumber(traffic.total_used ?? data.used_traffic, 0),
    remainingTrafficBytes: toNumber(traffic.total_remaining ?? data.remaining_traffic, 0),
  };
}

function extractRewardBytes(payload) {
  const root = unwrapData(payload);
  const data = unwrapData(root) || {};

  return toNumber(
    data.reward_traffic ?? data.traffic_reward ?? data.sign_reward_traffic ?? data.sign_traffic ?? data.traffic_bytes ?? data.last_traffic,
    0
  );
}

function formatBytes(bytes) {
  const value = toNumber(bytes, 0);

  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value.toFixed(0)} B`;
}

// 紧凑格式，无空格
function formatBytesCompact(bytes) {
  const value = toNumber(bytes, 0);

  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)}TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)}GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)}KB`;
  return `${value.toFixed(0)}B`;
}

function buildAlreadySignedMessage(info, userInfo) {
  const parts = ['frp'];

  if (info.totalSignDays > 0) parts.push(`签${info.totalSignDays}`);
  const rewardBytes = info.totalTrafficBytes || 0;
  if (rewardBytes > 0) parts.push(`得${formatBytesCompact(rewardBytes)}`);
  if (userInfo && userInfo.remainingTrafficBytes > 0) {
    parts.push(`余${formatBytesCompact(userInfo.remainingTrafficBytes)}`);
  }

  return parts.join('') || '今天已经签到过了';
}

function buildSuccessMessage(info, rewardBytes, userInfo) {
  const parts = ['frp'];

  if (info.totalSignDays > 0) parts.push(`签${info.totalSignDays}`);
  if (rewardBytes > 0) parts.push(`得${formatBytesCompact(rewardBytes)}`);
  if (userInfo && userInfo.remainingTrafficBytes > 0) {
    parts.push(`余${formatBytesCompact(userInfo.remainingTrafficBytes)}`);
  }

  return parts.join('') || '签到成功';
}

function calculateRewardBytes(beforeInfo, afterInfo, fallback = 0) {
  const candidates = [
    toNumber(fallback, 0),
    toNumber(afterInfo?.totalTrafficBytes, 0) - toNumber(beforeInfo?.totalTrafficBytes, 0),
    toNumber(afterInfo?.availableTrafficBytes, 0) - toNumber(beforeInfo?.availableTrafficBytes, 0),
  ].filter((value) => value > 0);

  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

async function runCheckIn(api, credentials) {
  const loginResponse = await api.login(credentials);
  const authToken = extractLoginToken(loginResponse);

  if (!authToken) {
    throw new Error('登录成功但未拿到 token');
  }

  if (typeof api.setToken === 'function') {
    api.setToken(authToken);
  }

  // 获取账户流量信息
  let userInfo = null;
  try {
    userInfo = normalizeUserInfo(await api.getUserInfo());
  } catch {
    userInfo = null;
  }

  const beforeInfo = normalizeSignInfo(await api.getSignInfo());
  if (beforeInfo.signedToday) {
    return {
      status: 'already_signed',
      message: buildAlreadySignedMessage(beforeInfo, userInfo),
      details: { ...beforeInfo, userInfo },
    };
  }

  const sliderResponse = await api.getSignSliderToken();
  const sliderToken = extractSliderToken(sliderResponse);

  if (!sliderToken) {
    throw new Error('签到前未拿到 slider_token');
  }

  const signResponse = await api.signIn(sliderToken);

  // 检查频率限制
  if (isRateLimited(signResponse)) {
    throw new Error('今日签到尝试次数已达上限，请明天再试');
  }

  let finalInfo = beforeInfo;

  try {
    finalInfo = normalizeSignInfo(await api.getSignInfo());
  } catch {
    finalInfo = beforeInfo;
  }

  // 重新获取账户流量信息
  try {
    userInfo = normalizeUserInfo(await api.getUserInfo());
  } catch {
    // 保持之前的信息
  }

  const rewardBytes = extractRewardBytes(signResponse) || signResponse?.data?.last_traffic || 0;

  return {
    status: 'success',
    message: buildSuccessMessage(finalInfo, rewardBytes, userInfo),
    details: {
      ...finalInfo,
      rewardBytes,
      userInfo,
    },
  };
}

async function runBrowserBackedCheckIn(api, credentials, options = {}) {
  const browserSigner =
    options.browserSigner ||
    (async (browserOptions) => {
      const { signViaBrowser } = require('./browser');
      return signViaBrowser(browserOptions);
    });

  const loginResponse = await api.login(credentials);
  const authToken = extractLoginToken(loginResponse);

  if (!authToken) {
    throw new Error('登录成功但未拿到 token');
  }

  if (typeof api.setToken === 'function') {
    api.setToken(authToken);
  }

  let userInfo = null;
  try {
    userInfo = normalizeUserInfo(await api.getUserInfo());
  } catch {
    userInfo = null;
  }

  const beforeInfo = normalizeSignInfo(await api.getSignInfo());
  if (beforeInfo.signedToday) {
    return {
      status: 'already_signed',
      message: buildAlreadySignedMessage(beforeInfo, userInfo),
      details: { ...beforeInfo, userInfo },
    };
  }

  const panelBaseUrl =
    typeof api.buildPanelUrl === 'function'
      ? api.buildPanelUrl()
      : new URL('/user/', api.baseUrl || process.env.FRP_BASE_URL || 'https://www.52frp.com/api').toString();

  const browserResult = await browserSigner({
    panelBaseUrl,
    authToken,
    timeoutMs: options.timeoutMs,
    launchOptions: options.launchOptions,
  });

  let finalInfo = beforeInfo;

  try {
    finalInfo = normalizeSignInfo(await api.getSignInfo());
  } catch {
    finalInfo = beforeInfo;
  }

  try {
    userInfo = normalizeUserInfo(await api.getUserInfo());
  } catch {
    // keep previous value
  }

  if (!finalInfo.signedToday) {
    throw new Error('页面已点击，但接口仍显示未签到');
  }

  const rewardBytes = calculateRewardBytes(beforeInfo, finalInfo, browserResult?.rewardBytes);
  const status = browserResult?.status === 'already_signed' ? 'already_signed' : 'success';

  return {
    status,
    message:
      status === 'already_signed'
        ? buildAlreadySignedMessage(finalInfo, userInfo)
        : buildSuccessMessage(finalInfo, rewardBytes, userInfo),
    details: {
      ...finalInfo,
      rewardBytes,
      userInfo,
      browserStatus: browserResult?.status || 'unknown',
    },
  };
}

module.exports = {
  calculateRewardBytes,
  extractLoginToken,
  extractMessage,
  extractRewardBytes,
  extractSliderToken,
  formatBytes,
  formatBytesCompact,
  isRateLimited,
  normalizeSignInfo,
  normalizeUserInfo,
  runBrowserBackedCheckIn,
  runCheckIn,
};
