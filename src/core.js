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

function buildAlreadySignedMessage(info, userInfo) {
  const parts = [];

  if (info.totalSignDays > 0) parts.push(`累签:${info.totalSignDays} 天`);
  const rewardBytes = info.totalTrafficBytes || 0;
  if (rewardBytes > 0) parts.push(`获得:${formatBytes(rewardBytes)}`);
  if (userInfo && userInfo.remainingTrafficBytes > 0) {
    parts.push(`剩余:${formatBytes(userInfo.remainingTrafficBytes)}`);
  }

  return parts.join('|') || '今天已经签到过了';
}

function buildSuccessMessage(info, rewardBytes, userInfo) {
  const parts = [];

  if (info.totalSignDays > 0) parts.push(`累签:${info.totalSignDays} 天`);
  if (rewardBytes > 0) parts.push(`获得:${formatBytes(rewardBytes)}`);
  if (userInfo && userInfo.remainingTrafficBytes > 0) {
    parts.push(`剩余:${formatBytes(userInfo.remainingTrafficBytes)}`);
  }

  return parts.join('|') || '签到成功';
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

module.exports = {
  extractLoginToken,
  extractMessage,
  extractRewardBytes,
  extractSliderToken,
  formatBytes,
  normalizeSignInfo,
  normalizeUserInfo,
  runCheckIn,
};