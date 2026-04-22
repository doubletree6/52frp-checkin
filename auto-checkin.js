#!/usr/bin/env node

/**
 * 52frp 全自动签到脚本（纯浏览器操作）
 * 
 * 全程自动化，不调用任何 API：
 * 1. 复用 Edge 已登录态打开签到页
 * 2. 自动点击"立即签到"按钮
 * 3. 检查签到结果
 * 
 * 使用方法：
 *   node auto-checkin.js
 */

const { chromium } = require('playwright');
const path = require('path');

const SIGN_PAGE = 'https://www.52frp.com/user/#/welfare/sign';
const EDGE_PROFILE_PATH = path.join(
  process.env.LOCALAPPDATA || process.env.HOME,
  'Library/Application Support/Microsoft Edge/Default'
);

async function readBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function checkSignedToday(page) {
  const bodyText = await readBodyText(page);
  if (
    bodyText.includes('您今天已经签到过了') ||
    bodyText.includes('今天已经签到过了') ||
    bodyText.includes('签到成功') ||
    bodyText.includes('恭喜')
  ) {
    return { signed: true, message: '今天已经签到过了' };
  }
  return { signed: false, message: '今天还未签到' };
}

async function clickSignButton(page) {
  // 通过多种方式查找签到按钮
  const strategies = [
    // 方式1: 通过按钮文本
    async () => {
      const btn = page.getByRole('button', { name: '立即签到' });
      if (await btn.count() > 0) return btn;
      return null;
    },
    // 方式2: 通过 contains text
    async () => {
      const btn = page.locator('button').filter({ hasText: '立即签到' });
      if (await btn.count() > 0) return btn;
      return null;
    },
    // 方式3: 通过 class 包含 sign
    async () => {
      const btn = page.locator('button[class*="sign"]');
      if (await btn.count() > 0) return btn;
      return null;
    },
    // 方式4: 查找所有 primary 按钮
    async () => {
      const btn = page.locator('button.el-button--primary');
      if (await btn.count() > 0) return btn.first();
      return null;
    },
  ];
  
  for (const strategy of strategies) {
    try {
      const button = await strategy();
      if (button) {
        const text = await button.innerText().catch(() => '');
        console.log(`找到按钮: "${text.trim()}"`);
        await button.click();
        return true;
      }
    } catch (e) {
      console.log('尝试下一个策略...');
    }
  }
  
  return false;
}

async function autoCheckIn() {
  console.log('启动 52frp 全自动签到...');
  console.log(`使用 Edge 配置: ${EDGE_PROFILE_PATH}`);
  
  // 使用 Edge 已有的 profile（包含登录 cookie）
  const browser = await chromium.launchPersistentContext(EDGE_PROFILE_PATH, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1280, height: 800 },
  });
  
  const page = await browser.newPage();
  
  try {
    // 第1步：直接打开签到页
    console.log(`[1/3] 打开签到页: ${SIGN_PAGE}`);
    await page.goto(SIGN_PAGE, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // 检查是否需要登录
    if (page.url().includes('/auth/login')) {
      console.log('⚠️ 未检测到登录态，尝试使用 Edge Cookies...');
      
      // 尝试直接访问主页获取 cookie
      await page.goto('https://www.52frp.com/user/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      
      // 再次检查
      if (page.url().includes('/auth/login')) {
        throw new Error('无法自动登录，请先在 Edge 中手动登录一次');
      }
    }
    
    console.log('[2/3] 检测签到状态...');
    const beforeCheck = await checkSignedToday(page);
    if (beforeCheck.signed) {
      console.log(`✅ ${beforeCheck.message}`);
      return { status: 'already_signed', message: beforeCheck.message };
    }
    
    console.log('今天还未签到，准备自动签到...');
    
    // 第3步：点击签到按钮
    console.log('[3/3] 点击"立即签到"按钮...');
    const clicked = await clickSignButton(page);
    
    if (!clicked) {
      // 打印页面内容用于调试
      const bodyText = await readBodyText(page);
      console.log('页面内容预览:', bodyText.substring(0, 800));
      throw new Error('找不到签到按钮，请手动检查页面');
    }
    
    // 等待签到结果
    console.log('等待签到结果...');
    await page.waitForTimeout(3000);
    
    // 第4步：检查最终结果
    const afterCheck = await checkSignedToday(page);
    if (afterCheck.signed) {
      console.log('✅ 签到成功！');
      return { status: 'success', message: '签到成功' };
    }
    
    // 检查 toast 提示
    const toastSelectors = ['.el-message--success', '.el-notification'];
    for (const sel of toastSelectors) {
      const toast = page.locator(sel).first();
      if (await toast.count() > 0) {
        const text = await toast.innerText().catch(() => '');
        if (text.includes('成功')) {
          console.log('✅ Toast 确认签到成功');
          return { status: 'success', message: text };
        }
      }
    }
    
    return { status: 'unknown', message: '未能确认签到结果' };
    
  } catch (error) {
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('52frp 全自动签到（纯浏览器操作）');
  console.log('='.repeat(50));
  console.log('');
  
  const result = await autoCheckIn();
  
  console.log('');
  console.log('='.repeat(50));
  console.log('最终结果:', result.status, result.message);
  console.log('='.repeat(50));
  console.log(`CHECKIN_RESULT: ${result.status}: ${result.message}`);
  
  if (result.status !== 'success' && result.status !== 'already_signed') {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = `签到失败: ${error.message}`;
  console.error(message);
  console.log(`CHECKIN_RESULT: ${message}`);
  process.exit(1);
});
