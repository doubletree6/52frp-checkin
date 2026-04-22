/**
 * 全手动签到模式
 * 
 * 完全通过浏览器页面操作，不调用任何 signIn API
 * 1. 打开登录页 → 手动输入密码、滑块、登录
 * 2. 跳转到签到页 → 手动点击"立即签到"
 * 3. 检查签到结果
 */

const { chromium } = require('playwright');

const DEFAULT_TIMEOUT_MS = 120_000; // 2分钟，给足手动操作时间
const LOGIN_PAGE = 'https://www.52frp.com/user/#/auth/login';
const SIGN_PAGE = 'https://www.52frp.com/user/#/welfare/sign';

async function readBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/user/') && !url.includes('/auth/login');
}

async function isAlreadySigned(page) {
  const bodyText = await readBodyText(page);
  return (
    bodyText.includes('您今天已经签到过了噢') ||
    bodyText.includes('今天已经签到过了') ||
    bodyText.includes('签到成功')
  );
}

async function waitForUserLogin(page, timeoutMs) {
  console.log('请在浏览器中手动登录账号...');
  
  // 等待用户登录成功（URL 变化到 /user/ 且不是登录页）
  await page.waitForFunction(
    () => {
      const url = window.location.href;
      return url.includes('/user/') && !url.includes('/auth/login');
    },
    { timeout: timeoutMs }
  );
  
  console.log('登录成功！');
}

async function waitForUserSign(page, timeoutMs) {
  console.log('请在浏览器中手动点击"立即签到"...');
  
  // 等待签到完成（页面显示已签到或者出现成功提示）
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || '';
      return (
        text.includes('您今天已经签到过了') ||
        text.includes('今天已经签到过了') ||
        text.includes('签到成功') ||
        text.includes('恭喜')
      );
    },
    { timeout: timeoutMs }
  );
  
  console.log('签到完成！');
}

/**
 * 全手动签到 - 浏览器自动化辅助
 * 
 * @param {Object} options - 选项
 * @param {number} options.timeoutMs - 超时时间，默认 120 秒
 * @param {Object} options.launchOptions - Playwright 启动选项
 * @returns {Promise<{status: string, message: string}>}
 */
async function manualSignViaBrowser({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  launchOptions = {},
} = {}) {
  console.log('启动全手动签到模式...');
  console.log('注意：整个过程需要你在浏览器中手动操作');
  console.log('');
  
  const browser = await chromium.launch({
    headless: process.env.FRP_BROWSER_HEADLESS !== 'false',
    channel: process.env.FRP_BROWSER_CHANNEL || 'msedge',
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    ...launchOptions,
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  
  try {
    // 第1步：打开登录页
    console.log(`[1/4] 打开登录页: ${LOGIN_PAGE}`);
    await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded' });
    
    // 等待用户手动登录
    await waitForUserLogin(page, timeoutMs);
    
    // 等待一下确保页面加载完成
    await page.waitForLoadState('networkidle').catch(() => {});
    
    // 第2步：自动跳转到签到页
    console.log(`[2/4] 跳转到签到页: ${SIGN_PAGE}`);
    await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    
    // 检查是否已经签到（可能之前签过了）
    if (await isAlreadySigned(page)) {
      return {
        status: 'already_signed',
        message: '今天已经签到过了（之前手动签的）',
      };
    }
    
    // 第3步：等待用户手动点击签到
    await waitForUserSign(page, timeoutMs);
    
    // 第4步：检查最终状态
    await page.waitForLoadState('networkidle').catch(() => {});
    const finalSigned = await isAlreadySigned(page);
    
    if (finalSigned) {
      return {
        status: 'success',
        message: '签到成功！',
      };
    } else {
      return {
        status: 'unknown',
        message: '未能确认签到结果，请手动检查',
      };
    }
    
  } finally {
    console.log('关闭浏览器...');
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  manualSignViaBrowser,
};
