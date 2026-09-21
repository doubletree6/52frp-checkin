#!/usr/bin/env node
'use strict';

/**
 * 「错峰补跑」闸门。
 *
 * 同一个 workflow 挂了两个 cron：
 *   主跑 03:15 UTC（名义 11:15 北京，实测约 15:40-16:50 北京落地）
 *   补跑 10:00 UTC（名义 18:00 北京）
 *
 * 补跑时段不无条件签到，先查本 workflow 当天的 run：
 *   当天已有成功的 run → 跳过（这就是「只在失败的时候」）
 *   当天主跑仍在进行   → 跳过，不和主跑抢
 *   当天只有失败/没跑过 → 执行补跑
 *
 * 签到本身是幂等的（已签走 already_signed 并 exit 0），
 * 所以查询失败时保守放行，宁可多跑一次也不漏签。
 */

const MAIN_SCHEDULE = '15 3 * * *';
const MAKEUP_SCHEDULE = '0 10 * * *';
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
const WORKFLOW_FILE = 'daily-checkin.yml';

/** 把某个时刻换算成北京日期（YYYY-MM-DD）。 */
function beijingDate(input = new Date()) {
  const t = input instanceof Date ? input.getTime() : Date.parse(input);
  if (Number.isNaN(t)) return null;
  return new Date(t + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 纯函数：决定这次 run 要不要真的签到。
 *
 * @param {object} opts
 * @param {string} opts.eventName          github.event_name
 * @param {string} opts.schedule           github.event.schedule（cron 表达式）
 * @param {string} opts.runId              github.run_id（把自己排除掉）
 * @param {string} opts.today              北京日期 YYYY-MM-DD
 * @param {Array}  [opts.runs]             该 workflow 最近的 run 列表
 * @param {boolean} [opts.runsFetchFailed] 查询 run 列表是否失败
 * @param {string} [opts.slot]             手动触发时的 slot 输入（auto/makeup）
 * @returns {{shouldCheckin: boolean, isMakeup: boolean, reason: string}}
 */
function decideCheckin({
  eventName,
  schedule,
  runId,
  today,
  runs,
  runsFetchFailed = false,
  slot = '',
}) {
  const isScheduled = eventName === 'schedule';
  const isManual = eventName === 'workflow_dispatch';

  // 补跑判定有两条入口：定时补跑时段，或手动以 slot=makeup 触发（便于验证）。
  const isMakeupSlot =
    (isScheduled && schedule === MAKEUP_SCHEDULE) ||
    (isManual && slot === 'makeup');

  if (!isScheduled && !isManual) {
    return {
      shouldCheckin: true,
      isMakeup: false,
      reason: `非定时触发（${eventName || 'unknown'}），直接签到`,
    };
  }

  if (isManual && !isMakeupSlot) {
    return {
      shouldCheckin: true,
      isMakeup: false,
      reason: `手动触发（slot=${slot || 'auto'}），直接签到`,
    };
  }

  if (isScheduled && schedule === MAIN_SCHEDULE) {
    return {
      shouldCheckin: true,
      isMakeup: false,
      reason: '主跑时段，直接签到',
    };
  }

  if (isScheduled && !isMakeupSlot) {
    return {
      shouldCheckin: true,
      isMakeup: false,
      reason: `未知 cron（${schedule || '空'}），保守直接签到`,
    };
  }

  if (runsFetchFailed) {
    return {
      shouldCheckin: true,
      isMakeup: true,
      reason: '查询主跑历史失败，保守执行补跑',
    };
  }

  const selfId = String(runId ?? '');
  let hasSuccess = false;
  let pending = false;
  const failed = [];

  for (const run of runs || []) {
    if (String(run.id) === selfId) continue; // 排除补跑自己
    if (beijingDate(run.created_at) !== today) continue;

    if (run.status !== 'completed') {
      pending = true;
    } else if (run.conclusion === 'success') {
      hasSuccess = true;
    } else {
      failed.push(run.id);
    }
  }

  if (hasSuccess) {
    return {
      shouldCheckin: false,
      isMakeup: true,
      reason: '今日主跑已成功，跳过补跑',
    };
  }

  if (pending) {
    return {
      shouldCheckin: false,
      isMakeup: true,
      reason: '今日主跑仍在进行，跳过补跑',
    };
  }

  return {
    shouldCheckin: true,
    isMakeup: true,
    reason: `今日主跑未成功（失败 run: ${failed.join(',') || '无记录'}），执行补跑`,
  };
}

/** 拉取本 workflow 最近的 run 列表。 */
async function fetchRuns({ repo, token, workflowFile = WORKFLOW_FILE }) {
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/` +
    `${encodeURIComponent(workflowFile).replace(/%2F/g, '/')}/runs?per_page=50`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': '52frp-checkin-makeup-gate',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.workflow_runs || [];
}

async function main() {
  const eventName = process.env.EVENT_NAME || '';
  const schedule = process.env.SCHEDULE || '';
  const slot = process.env.SLOT || '';
  const runId = process.env.RUN_ID || '';
  const repo = process.env.REPO || '';
  const token = process.env.GH_TOKEN || '';
  const today = process.env.TODAY || beijingDate();

  const isMakeupSlot =
    (eventName === 'schedule' && schedule === MAKEUP_SCHEDULE) ||
    (eventName === 'workflow_dispatch' && slot === 'makeup');

  let runs = null;
  let runsFetchFailed = false;

  if (isMakeupSlot) {
    try {
      runs = await fetchRuns({ repo, token });
    } catch (error) {
      runsFetchFailed = true;
      console.error(`⚠️ 查询主跑历史失败: ${error.message}`);
    }
  }

  if (isMakeupSlot && runs) {
    const todays = runs.filter((r) => beijingDate(r.created_at) === today);
    console.error(
      `今日（北京 ${today}）本 workflow 共 ${todays.length} 次 run: ` +
        (todays.map((r) => `${r.id}:${r.status}/${r.conclusion}`).join(', ') || '无')
    );
  }

  const decision = decideCheckin({
    eventName,
    schedule,
    runId,
    today,
    runs,
    runsFetchFailed,
    slot,
  });

  console.error(decision.reason);
  console.log(`should_checkin=${decision.shouldCheckin}`);
  console.log(`is_makeup=${decision.isMakeup}`);
  console.log(`reason=${decision.reason}`);
}

if (require.main === module) {
  main().catch((error) => {
    // 闸门自身出错时不要卡住签到：保守放行。
    console.error(`闸门异常: ${error.message}`);
    console.log('should_checkin=true');
    console.log('is_makeup=true');
    console.log('reason=闸门异常，保守执行补跑');
  });
}

module.exports = {
  MAIN_SCHEDULE,
  MAKEUP_SCHEDULE,
  beijingDate,
  decideCheckin,
  fetchRuns,
};
