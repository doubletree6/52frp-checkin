#!/usr/bin/env node

/**
 * 52frp 纯浏览器签到脚本
 *
 * 全程浏览器自动化，不调用任何 API：
 * 1. 自动填账号密码
 * 2. 自动完成滑块验证
 * 3. 自动登录
 * 4. 自动跳转签到页
 * 5. 自动点击签到按钮
 * 6. 输出签到结果
 *
 * 使用方法：
 *   FRP_USERNAME=your_username FRP_PASSWORD=your_password node checkin.js
 *
 * 或配置 .env 文件：
 *   cp .env.example .env
 *   # 编辑 .env 填入账号密码
 *   node checkin.js
 */

const { pureBrowserCheckIn } = require('./src/browser');

async function main() {
  // 从环境变量读取凭证
  const username = process.env.FRP_USERNAME;
  const password = process.env.FRP_PASSWORD;

  if (!username || !password) {
    console.error('错误: 请先配置 FRP_USERNAME 和 FRP_PASSWORD');
    console.error('');
    console.error('方式1: 环境变量');
    console.error('  FRP_USERNAME=your_username FRP_PASSWORD=your_password node checkin.js');
    console.error('');
    console.error('方式2: .env 文件');
    console.error('  cp .env.example .env');
    console.error('  # 编辑 .env 填入账号密码');
    console.error('  node checkin.js');
    process.exit(1);
  }

  console.log(`账号: ${username.substring(0, 3)}***${username.length > 6 ? username.substring(username.length - 3) : ''}`);
  console.log('');

  try {
    const result = await pureBrowserCheckIn({
      username,
      password,
      timeoutMs: process.env.FRP_TIMEOUT_MS ? parseInt(process.env.FRP_TIMEOUT_MS, 10) : 60_000,
    });

    console.log('');
    console.log('='.repeat(50));
    console.log(`结果: ${result.status}`);
    console.log(`消息: ${result.message}`);
    if (result.details?.signInfo) {
      console.log(`详情: ${result.details.signInfo}`);
    }
    console.log('='.repeat(50));
    console.log('');

    // 输出标准化结果（供 GitHub Actions / PushPlus 捕获）
    console.log(`CHECKIN_RESULT: ${result.message}`);

    // 设置退出码
    if (result.status === 'success' || result.status === 'already_signed') {
      process.exit(0);
    } else {
      process.exit(1);
    }

  } catch (error) {
    console.error('');
    console.error('='.repeat(50));
    console.error(`错误: ${error.message}`);
    console.error('='.repeat(50));
    console.error('');

    console.log(`CHECKIN_RESULT: error:${error.message}`);
    process.exit(1);
  }
}

main();
