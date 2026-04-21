const DEFAULT_TIMEOUT_MS = 30_000;
const SIGN_PAGE_PATH = '/welfare/sign';

function normalizeHashPath(hashPath = SIGN_PAGE_PATH) {
  const trimmed = String(hashPath || SIGN_PAGE_PATH).trim();
  if (!trimmed) return `#${SIGN_PAGE_PATH}`;
  const normalized = trimmed.replace(/^#+/, '').replace(/^\/?/, '/');
  return `#${normalized}`;
}

function buildSignPageUrl(panelBaseUrl, hashPath = SIGN_PAGE_PATH) {
  const url = new URL(panelBaseUrl);
  url.search = '';
  url.hash = normalizeHashPath(hashPath);
  return url.toString();
}

function buildAdminTokenUrl(panelBaseUrl, authToken, hashPath = SIGN_PAGE_PATH) {
  if (!authToken) {
    throw new Error('浏览器签到缺少 authToken');
  }

  const url = new URL(panelBaseUrl);
  url.searchParams.set('admin_token', authToken);
  url.hash = normalizeHashPath(hashPath);
  return url.toString();
}

async function readBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function isAlreadySigned(page) {
  const bodyText = await readBodyText(page);
  return bodyText.includes('您今天已经签到过了噢') || bodyText.includes('今天已经签到过了');
}

async function readToastMessage(page) {
  const selectors = ['.el-message', '.el-notification', '[role="alert"]'];

  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;

    const text = (await locator.innerText().catch(() => '')).trim();
    if (text) return text;
  }

  return '';
}

async function waitForSignPage(page, timeoutMs) {
  await page.getByRole('heading', { name: '每日签到' }).waitFor({ timeout: timeoutMs });
}

async function waitForSignResult(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return (
          text.includes('您今天已经签到过了噢') ||
          text.includes('今天已经签到过了') ||
          Boolean(document.querySelector('.el-message, .el-notification, [role="alert"]'))
        );
      },
      null,
      { timeout: timeoutMs }
    );
  } catch {
    // fall through and let the caller inspect the final page state
  }
}

async function signViaBrowser({
  panelBaseUrl,
  authToken,
  hashPath = SIGN_PAGE_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  launchOptions = {},
} = {}) {
  if (!panelBaseUrl) {
    throw new Error('浏览器签到缺少 panelBaseUrl');
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: process.env.FRP_BROWSER_HEADLESS !== 'false',
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    ...launchOptions,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.setDefaultTimeout(timeoutMs);

  try {
    const bootstrapUrl = buildAdminTokenUrl(panelBaseUrl, authToken, hashPath);
    const signPageUrl = buildSignPageUrl(panelBaseUrl, hashPath);

    await page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => {});

    if (!page.url().includes(normalizeHashPath(hashPath))) {
      await page.goto(signPageUrl, { waitUntil: 'domcontentloaded' });
    }

    await waitForSignPage(page, timeoutMs);

    if (await isAlreadySigned(page)) {
      return { status: 'already_signed' };
    }

    const signButton = page.getByRole('button', { name: '立即签到' });
    await signButton.waitFor({ state: 'visible', timeout: timeoutMs });
    await signButton.click();

    await waitForSignResult(page, timeoutMs);

    if (await isAlreadySigned(page)) {
      return { status: 'success' };
    }

    const toastMessage = await readToastMessage(page);
    if (toastMessage) {
      throw new Error(toastMessage);
    }

    throw new Error('页面点击后未进入已签到状态');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  buildAdminTokenUrl,
  buildSignPageUrl,
  normalizeHashPath,
  signViaBrowser,
};
