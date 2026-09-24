#!/usr/bin/env node

/**
 * 52frp 自动签到 v2（多方式 + 自动回退）
 *
 * 与 v1（checkin.js，纯浏览器）的区别：
 *   默认先走「方法A 纯 API 直签」，几秒内完成；
 *   只有 A 失败（请求异常 / 接口返回错误 / 复查判定未签上）才回退到「方法B 浏览器自动化」。
 *   两种方式成功都会按原有渠道推送。
 *
 * 配置（沿用 v1，无需改动 GitHub Secrets）：
 *   FRP_USERNAME / FRP_PASSWORD   必填
 *   PUSHPLUS_TOKEN / PUSHPLUS_CHANNEL / TG_BOT_TOKEN / TG_CHAT_ID   推送（由 workflow 步骤发送）
 *
 * 新增可选配置：
 *   CHECKIN_STRATEGY   执行顺序，默认 auto：
 *                        auto            API 直签 → 浏览器（推荐）
 *                        api             只用 API 直签
 *                        browser         只用浏览器（等同 v1 行为）
 *                        browser,api     自定义顺序
 *   FRP_API_TIMEOUT_MS 方法A 单个请求超时，默认 15000
 *
 * 用法：
 *   node checkin-v2.js
 *   node checkin-v2.js --strategy=api        # 只验证方法A
 *   node checkin-v2.js --strategy=browser    # 只验证方法B
 */

const { getCredentials } = require('./src/config');
const { runCheckin, buildNotice, resolveOrder, STRATEGIES, STATUS } = require('./src/checkin');

function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : null;
}

function resolveStrategy() {
  return readArg('strategy') || process.env.CHECKIN_STRATEGY || 'auto';
}

function maskAccount(username) {
  if (!username) return '(未配置)';
  const head = username.substring(0, 3);
  const tail = username.length > 6 ? username.substring(username.length - 3) : '';
  return `${head}***${tail}`;
}

async function main() {
  const { username, password } = getCredentials();

  console.log('='.repeat(50));
  console.log('52frp 自动签到 v2（API 直签优先，失败回退浏览器）');
  console.log('='.repeat(50));
  console.log(`账号: ${maskAccount(username)}`);

  if (!username || !password) {
    console.error('');
    console.error('错误: 请先配置 FRP_USERNAME 和 FRP_PASSWORD');
    console.error('');
    console.error('方式1: 环境变量');
    console.error('  FRP_USERNAME=xxx FRP_PASSWORD=yyy node checkin-v2.js');
    console.error('');
    console.error('方式2: .env 文件');
    console.error('  cp .env.example .env   # 编辑填入账号密码');
    console.error('  node checkin-v2.js');
    process.exit(1);
  }

  const strategy = resolveStrategy();
  const order = resolveOrder(strategy);
  console.log(
    `[配置] 执行顺序: ${order.map((id) => STRATEGIES[id]?.label || id).join(' → ') || '(空)'}`
  );
  console.log('');

  let result;
  try {
    result = await runCheckin({
      username,
      password,
      order: strategy,
      timeoutMs: process.env.FRP_TIMEOUT_MS ? Number.parseInt(process.env.FRP_TIMEOUT_MS, 10) : undefined,
    });
  } catch (error) {
    // 调度器内部不应抛到这里；万一抛了也必须留下可读原因，不能静默退出
    console.error('');
    console.error('='.repeat(50));
    console.error(`错误: 签到调度异常: ${error?.message || error}`);
    console.error('='.repeat(50));
    console.error('');
    console.log(`CHECKIN_RESULT: 52frp签到失败\n\n失败原因：签到调度异常（${error?.message || error}）\n\n请手动签到一次，避免断签`);
    process.exit(1);
  }

  const notice = buildNotice(result, { attempts: result.attempts || [] });

  console.log('');
  console.log('='.repeat(50));
  console.log(`结果: ${result.status}`);
  console.log(`执行方式: ${result.strategy ? STRATEGIES[result.strategy]?.label || result.strategy : '无（全部失败）'}`);
  for (const attempt of result.attempts || []) {
    console.log(`  - ${STRATEGIES[attempt.strategy]?.label || attempt.strategy}: ${attempt.status}（${Math.round(attempt.durationMs / 1000)}s）${attempt.reason ? ` — ${attempt.reason}` : ''}`);
  }
  if (result.status === STATUS.ERROR) {
    console.error(`失败原因: ${result.reason}`);
  }
  console.log('='.repeat(50));
  console.log('');

  // CHECKIN_RESULT 之后的行才会被 workflow 收集进推送，推送文案必须完整放这里
  console.log(`CHECKIN_RESULT: ${notice}`);

  if (result.status === STATUS.SUCCESS || result.status === STATUS.ALREADY) {
    process.exit(0);
  }
  process.exit(1);
}

main();
