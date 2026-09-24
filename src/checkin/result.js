'use strict';

/**
 * 统一签到结果结构。
 *
 * 之所以要抽这一层：项目里现在有两条完全不同的签到实现（纯 API / 浏览器自动化），
 * 它们各自的"成功"长得不一样（一个是 JSON 里的 signed_today，一个是页面文案），
 * 但上层（推送、退出码、日志）不该关心这些差异。所有策略都必须把结果归一化成这里的结构，
 * 调度器才能只认 status 一个字段做判断。
 *
 * status 取值：
 *   success        本次运行成功完成签到
 *   already_signed 服务端确认今天已签到（本次运行没有重复签到）
 *   error          失败（reason 里给出可读原因）
 *   skipped        该策略不具备执行条件（调度器会继续尝试下一个策略）
 */

const STATUS = Object.freeze({
  SUCCESS: 'success',
  ALREADY: 'already_signed',
  ERROR: 'error',
  SKIPPED: 'skipped',
});

/** 视为"这一天已经签到了"的状态 —— 调度器遇到它们就停止，不再回退 */
const OK_STATUS = new Set([STATUS.SUCCESS, STATUS.ALREADY]);

const STATUS_LABEL = Object.freeze({
  [STATUS.SUCCESS]: '签到成功',
  [STATUS.ALREADY]: '今日已签到（无需重复签到）',
  [STATUS.ERROR]: '签到失败',
  [STATUS.SKIPPED]: '跳过',
});

const MISSING_TEXT = '未取到';

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;

  const normalized = {
    totalSignDays: toNumberOrNull(metrics.totalSignDays),
    todayRewardBytes: toNumberOrNull(metrics.todayRewardBytes),
    totalRewardBytes: toNumberOrNull(metrics.totalRewardBytes),
    remainingBytes: toNumberOrNull(metrics.remainingBytes),
  };

  const hasAny = Object.values(normalized).some((v) => v !== null);
  return hasAny ? normalized : null;
}

/**
 * 创建一个归一化结果。策略实现不要自己拼对象，统一走这里，
 * 避免某个策略漏字段导致上层 undefined。
 */
function createResult({ status, strategy = null, message, reason = null, metrics = null, raw = null }) {
  if (!OK_STATUS.has(status) && status !== STATUS.ERROR && status !== STATUS.SKIPPED) {
    throw new Error(`未知的签到状态: ${status}`);
  }

  return {
    status,
    strategy,
    message: message || STATUS_LABEL[status] || '签到结束',
    reason: reason || null,
    metrics: normalizeMetrics(metrics),
    raw: raw || null,
  };
}

function isOkResult(result) {
  return OK_STATUS.has(result?.status);
}

/** 与 src/browser.js 的 formatTrafficCompact 保持一致的输出风格 */
function formatTrafficCompact(bytes) {
  const value = toNumberOrNull(bytes);
  if (value === null || value < 0) return MISSING_TEXT;
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)}TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)}GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)}KB`;
  return `${value.toFixed(0)}B`;
}

function metricsLines(metrics) {
  if (!metrics) return [];
  return [
    `签到天数：${metrics.totalSignDays ?? MISSING_TEXT} 天`,
    `本次获得：${formatTrafficCompact(metrics.todayRewardBytes)}`,
    `累计获得：${formatTrafficCompact(metrics.totalRewardBytes)}`,
    `剩余流量：${formatTrafficCompact(metrics.remainingBytes)}`,
  ];
}

/**
 * 把结果拼成推送文案。
 * @param {object} result
 * @param {{attempts?: Array, strategyLabels?: Record<string,string>}} options
 */
function buildNotice(result, options = {}) {
  const { attempts = [], strategyLabels = {} } = options;
  const lines = [];

  lines.push(`52frp${STATUS_LABEL[result.status] || result.status}`);

  if (result.status === STATUS.ALREADY) {
    lines.push('', '签到方式：本次运行前服务端已确认今天签过，脚本未重复签到');
  } else if (result.status === STATUS.SUCCESS) {
    lines.push('', '签到方式：本次运行自动签到成功');
  }

  const metrics = metricsLines(result.metrics);
  if (metrics.length > 0) {
    lines.push('', ...metrics);
  }

  if (result.strategy) {
    lines.push('', `执行方式：${strategyLabels[result.strategy] || result.strategy}`);
  }

  // 走过回退时说明一下，便于判断方法A是不是长期失效了
  const failedBefore = attempts.filter((a) => a.status === STATUS.ERROR);
  if (result.strategy && failedBefore.length > 0) {
    const names = failedBefore.map((a) => strategyLabels[a.strategy] || a.strategy).join('、');
    lines.push('', `备注：${names}失败后，回退到上述方式完成`);
  }

  if (result.status === STATUS.ERROR) {
    lines.push('', `失败原因：${result.reason || '未知原因'}`);
    for (const attempt of attempts) {
      const label = strategyLabels[attempt.strategy] || attempt.strategy;
      lines.push(`- ${label}：${attempt.reason || attempt.status}`);
    }
    lines.push('', '请手动签到一次，避免断签');
  }

  return lines.join('\n');
}

module.exports = {
  STATUS,
  OK_STATUS,
  STATUS_LABEL,
  MISSING_TEXT,
  createResult,
  isOkResult,
  normalizeMetrics,
  toNumberOrNull,
  formatTrafficCompact,
  metricsLines,
  buildNotice,
};
