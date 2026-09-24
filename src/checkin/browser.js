'use strict';

/**
 * 签到方法 B：浏览器自动化（本项目原有实现）
 *
 * 这一层只是**适配器**，不含任何签到逻辑：
 * 它调用 src/browser.js 的 pureBrowserCheckIn（现有的多轮重试 + 滑块 + 证据分级都在那里），
 * 再把返回值归一化成本项目统一的签到结果结构。
 *
 * 之所以要包一层而不是直接用：调度器需要所有策略返回同一种结构，
 * 并且失败时不能抛异常（否则调度器没法继续回退/汇总）。
 */

const { STATUS, createResult } = require('./result');

/** 浏览器方案的错误原因分类，供上层给提示 */
function classifyBrowserFailure(error) {
  const text = String(error?.message || error || '');

  if (/Cannot find module|MODULE_NOT_FOUND/i.test(text)) {
    return {
      reason: `浏览器依赖未安装（${text}），请先执行 npm ci 并安装 Playwright 浏览器`,
      kind: 'dependency',
    };
  }
  if (error?.kind === 'upstream' || /522|524|525|回源|CDN|Bad gateway/i.test(text)) {
    return { reason: `站点/CDN 侧临时故障：${text}`, kind: 'upstream' };
  }
  if (error?.kind === 'credentials' || /账号密码|滑块验证未通过/i.test(text)) {
    return { reason: `登录失败：${text}`, kind: 'auth' };
  }
  if (error?.kind === 'structure' || /未找到签到按钮|页面结构/i.test(text)) {
    return { reason: `页面结构变化或按钮未找到：${text}`, kind: 'structure' };
  }
  if (/timeout|Timeout/i.test(text)) {
    return { reason: `执行超时：${text}`, kind: 'timeout' };
  }
  return { reason: text || '浏览器签到失败（未知原因）', kind: 'unknown' };
}

function toMetrics(details = {}) {
  const signStats = details.signStats || {};
  const dashboardStats = details.dashboardStats || {};

  return {
    totalSignDays: signStats.totalSignDays ?? null,
    totalRewardBytes: signStats.totalRewardBytes ?? null,
    todayRewardBytes: dashboardStats.todayRewardBytes ?? null,
    remainingBytes: dashboardStats.remainingBytes ?? null,
  };
}

async function runBrowserCheckIn(options = {}) {
  const {
    username,
    password,
    timeoutMs,
    launchOptions,
    log = (...args) => console.log(...args),
  } = options;

  const strategy = 'browser';

  if (!username || !password) {
    return createResult({
      status: STATUS.SKIPPED,
      strategy,
      message: '方法 B 未执行',
      reason: '缺少 FRP_USERNAME / FRP_PASSWORD',
    });
  }

  // 惰性加载：只在真正要走浏览器方案时才 require，
  // 这样纯 API 成功的路径完全不会碰 playwright（省下依赖和启动开销）
  let pureBrowserCheckIn;
  try {
    ({ pureBrowserCheckIn } = require('../browser'));
  } catch (error) {
    const { reason, kind } = classifyBrowserFailure(error);
    log(`[方法B] ${reason}`);
    return createResult({
      status: STATUS.ERROR,
      strategy,
      message: '52frp签到失败',
      reason,
      raw: { kind },
    });
  }

  log('[方法B] 开始浏览器自动化签到（含多轮重试，耗时较长）');

  try {
    const raw = await pureBrowserCheckIn({ username, password, timeoutMs, launchOptions });
    const details = raw?.details || {};

    // 浏览器侧的状态映射：
    //   already_signed            → 今日已签到
    //   success + signKind=already → 签到接口明确回了「已签到」，同样是"本次运行前就签过了"
    //   success                    → 本次运行签到成功
    const isAlready = raw?.status === 'already_signed' || details.signKind === 'already';

    if (raw?.status === 'success' || raw?.status === 'already_signed') {
      log(`[方法B] 完成：${isAlready ? '今日已签到' : '本次运行签到成功'}（判定来源: ${details.signInfo || '未取到'}）`);
      return createResult({
        status: isAlready ? STATUS.ALREADY : STATUS.SUCCESS,
        strategy,
        message: isAlready ? '52frp今日已签到（无需重复签到）' : '52frp签到成功',
        metrics: toMetrics(details),
        raw: {
          rounds: details.rounds ?? null,
          signInfo: details.signInfo ?? null,
          template: raw?.message ?? null,
          signedBy: details.signedBy ?? null,
        },
      });
    }

    const { reason, kind } = classifyBrowserFailure(new Error(raw?.message || '浏览器签到未返回成功状态'));
    log(`[方法B] ${reason}`);
    return createResult({
      status: STATUS.ERROR,
      strategy,
      message: '52frp签到失败',
      reason,
      raw: { kind, rawStatus: raw?.status ?? null },
    });
  } catch (error) {
    const { reason, kind } = classifyBrowserFailure(error);
    log(`[方法B] ${reason}`);
    if (error?.rounds > 1) {
      log(`[方法B] 已重试 ${error.rounds} 轮仍失败`);
    }
    return createResult({
      status: STATUS.ERROR,
      strategy,
      message: '52frp签到失败',
      reason,
      raw: { kind, rounds: error?.rounds ?? null },
    });
  }
}

module.exports = {
  runBrowserCheckIn,
  classifyBrowserFailure,
  toMetrics,
};
