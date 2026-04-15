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

function extractRewardBytes(payload) {
  const root = unwrapData(payload);
  const data = unwrapData(root) || {};

  return toNumber(
    data.reward_traffic ??
      data.traffic_reward ??
      data.sign_reward_traffic ??
      data.sign_traffic ??
      data.traffic_bytes,
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

function buildAlreadySignedMessage(info) {
  const parts = ['今天已经签到过了'];

  if (info.totalSignDays > 0) parts.push(`累计签到 ${info.totalSignDays} 天`);
  if (info.availableTrafficBytes > 0) {
    parts.push(`可用流量 ${formatBytes(info.availableTrafficBytes)}`);
  }

  return parts.join('，');
}

function buildSuccessMessage(signResponse, info, rewardBytes) {
  const message = extractMessage(signResponse, '签到成功');
  const parts = [message];

  if (info.totalSignDays > 0) parts.push(`累计签到 ${info.totalSignDays} 天`);
  if (rewardBytes > 0) parts.push(`本次获得 ${formatBytes(rewardBytes)}`);
  if (info.availableTrafficBytes > 0) {
    parts.push(`可用流量 ${formatBytes(info.availableTrafficBytes)}`);
  }

  return parts.join('，');
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

  const beforeInfo = normalizeSignInfo(await api.getSignInfo());
  if (beforeInfo.signedToday) {
    return {
      status: 'already_signed',
      message: buildAlreadySignedMessage(beforeInfo),
      details: beforeInfo,
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

  const rewardBytes = extractRewardBytes(signResponse);

  return {
    status: 'success',
    message: buildSuccessMessage(signResponse, finalInfo, rewardBytes),
    details: {
      ...finalInfo,
      rewardBytes,
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
  runCheckIn,
};
