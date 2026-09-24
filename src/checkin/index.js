'use strict';

/**
 * 统一签到层对外入口。
 *
 * 上层（CLI / workflow）只需要：
 *   const { runCheckin, buildNotice } = require('./src/checkin');
 *   const result = await runCheckin({ username, password });
 *   console.log(buildNotice(result));
 */

const { runCheckin, resolveOrder, STRATEGIES, DEFAULT_ORDER } = require('./runner');
const {
  STATUS,
  createResult,
  isOkResult,
  buildNotice: buildNoticeText,
  formatTrafficCompact,
} = require('./result');
const { runApiCheckIn } = require('./api');
const { runBrowserCheckIn } = require('./browser');

const STRATEGY_LABELS = Object.fromEntries(
  Object.values(STRATEGIES).map((s) => [s.id, s.label])
);

function buildNotice(result, options = {}) {
  return buildNoticeText(result, {
    ...options,
    strategyLabels: { ...STRATEGY_LABELS, ...(options.strategyLabels || {}) },
  });
}

module.exports = {
  runCheckin,
  buildNotice,
  resolveOrder,
  STRATEGIES,
  STRATEGY_LABELS,
  DEFAULT_ORDER,
  STATUS,
  createResult,
  isOkResult,
  formatTrafficCompact,
  runApiCheckIn,
  runBrowserCheckIn,
};
