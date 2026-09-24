'use strict';

/**
 * 签到调度器：按配置的顺序依次尝试各个签到方法，第一个"成功/已签到"的结果即终止。
 *
 * 设计要点：
 * 1. 策略之间彼此独立，任一策略失败都不会中断整个流程（失败只是换下一种方式）；
 * 2. 每个策略必须返回统一结构（见 result.js），不允许抛异常穿过调度器；
 * 3. 每个尝试都留痕（耗时 + 原因），全部失败时把这些痕迹汇总成一条可读原因，
 *    杜绝静默失败。
 */

const { STATUS, createResult, isOkResult } = require('./result');
const { runApiCheckIn } = require('./api');
const { runBrowserCheckIn } = require('./browser');

const STRATEGIES = {
  api: {
    id: 'api',
    label: 'API 直签（方法A）',
    run: runApiCheckIn,
  },
  browser: {
    id: 'browser',
    label: '浏览器自动化（方法B）',
    run: runBrowserCheckIn,
  },
};

const DEFAULT_ORDER = ['api', 'browser'];

/**
 * 解析执行顺序配置。
 *   auto                默认：方法A 优先，失败回退方法B
 *   api / browser       只用一种
 *   browser,api / api,browser  自定义顺序
 */
function resolveOrder(raw) {
  const input = String(raw ?? 'auto').trim().toLowerCase();
  if (!input || input === 'auto' || input === 'a+b' || input === 'both') return [...DEFAULT_ORDER];

  const parts = input
    .split(/[,;+\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return [...DEFAULT_ORDER];

  // 去重但保留顺序
  return [...new Set(parts)];
}

async function runCheckin(options = {}) {
  const {
    username,
    password,
    order = 'auto',
    timeoutMs,
    launchOptions,
    strategies = STRATEGIES,
    log = (...args) => console.log(...args),
    env = process.env,
  } = options;

  const sequence = resolveOrder(order);
  const attempts = [];

  log(`[调度] 执行顺序：${sequence.map((id) => strategies[id]?.label || `${id}(未知)`).join(' → ')}`);

  for (const id of sequence) {
    const strategy = strategies[id];

    if (!strategy || typeof strategy.run !== 'function') {
      const reason = `未注册的签到方法: ${id}`;
      log(`[调度] ${reason}，跳过`);
      attempts.push({ strategy: id, status: STATUS.SKIPPED, reason, durationMs: 0 });
      continue;
    }

    log('');
    log(`===== 尝试：${strategy.label} =====`);
    const startedAt = Date.now();

    let result;
    try {
      result = await strategy.run({ username, password, timeoutMs, launchOptions, log, env });
    } catch (error) {
      // 策略实现不应抛异常；这里兜底，保证一个策略崩溃不会拖垮整个调度
      result = createResult({
        status: STATUS.ERROR,
        strategy: id,
        message: '52frp签到失败',
        reason: `${strategy.label} 内部异常：${error?.message || error}`,
        raw: { kind: 'crash' },
      });
      log(`[调度] ${strategy.label} 内部异常：${error?.message || error}`);
    }

    const durationMs = Date.now() - startedAt;
    attempts.push({
      strategy: id,
      status: result.status,
      reason: result.reason,
      durationMs,
    });

    log(`[调度] ${strategy.label} 结束：${result.status}（耗时 ${Math.round(durationMs / 1000)}s）`);

    if (isOkResult(result)) {
      const failedBefore = attempts.filter((a) => a.status === STATUS.ERROR);
      if (failedBefore.length > 0) {
        log(`[调度] 前 ${failedBefore.length} 种方式失败，最终由「${strategy.label}」完成`);
      }
      return { ...result, attempts, usedFallback: failedBefore.length > 0 };
    }

    log(`[调度] 「${strategy.label}」未成功：${result.reason || result.status}`);

    if (attempts.length < sequence.length) {
      log('[调度] 继续尝试下一个方式...');
    }
  }

  // 全部失败：把每一步的原因拼成一条可读汇总
  const reasonParts = attempts.map((a) => {
    const label = strategies[a.strategy]?.label || a.strategy;
    return `【${label}】${a.reason || a.status}`;
  });

  return {
    ...createResult({
      status: STATUS.ERROR,
      strategy: null,
      message: '52frp签到失败',
      reason: `所有方式均失败：${reasonParts.join('；')}`,
      raw: { attempts },
    }),
    attempts,
    usedFallback: true,
  };
}

module.exports = {
  runCheckin,
  resolveOrder,
  STRATEGIES,
  DEFAULT_ORDER,
};
