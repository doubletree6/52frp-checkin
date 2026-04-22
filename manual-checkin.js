#!/usr/bin/env node

/**
 * 全手动签到脚本
 * 
 * 使用方法：
 *   node manual-checkin.js
 * 
 * 特点：
 * - 不调用任何 signIn API，完全避免限流
 * - 浏览器打开登录页，你手动输入密码、滑块、登录
 * - 自动跳转到签到页，你手动点"立即签到"
 * - 自动检查签到结果
 */

const { manualSignViaBrowser } = require('./src/browser-manual');

async function main() {
  console.log('='.repeat(50));
  console.log('52frp 全手动签到模式');
  console.log('='.repeat(50));
  console.log('');
  console.log('流程说明：');
  console.log('  1. 浏览器会自动打开登录页');
  console.log('  2. 你手动输入账号密码、滑块验证、点击登录');
  console.log('  3. 浏览器自动跳转到签到页');
  console.log('  4. 你手动点击"立即签到"按钮');
  console.log('  5. 脚本自动检查签到结果');
  console.log('');
  console.log('提示：整个过程你需要关注浏览器窗口');
  console.log('');
  
  const result = await manualSignViaBrowser({
    timeoutMs: 180000, // 3分钟超时
  });
  
  console.log('');
  console.log('='.repeat(50));
  console.log('结果:', result.status, result.message);
  console.log('='.repeat(50));
  
  console.log(`CHECKIN_RESULT: ${result.status}: ${result.message}`);
  
  if (result.status !== 'success' && result.status !== 'already_signed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = `签到失败: ${error.message}`;
  console.error(message);
  console.log(`CHECKIN_RESULT: ${message}`);
  process.exitCode = 1;
});
