const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { clickSignButton, checkSignedToday, inferSignStateFromRequest, extractSignStats, extractDashboardStats, buildResultTemplate, trafficTextToBytes, formatTrafficCompact } = require('../src/browser');

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(500);

  try {
    await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

test('clickSignButton dismisses a blocking announcement overlay before clicking sign-in', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <style>
        body { margin: 0; font-family: sans-serif; }
        .container { padding-top: 240px; display: flex; justify-content: center; }
        .announcement-fullscreen-overlay {
          position: fixed;
          inset: 0;
          z-index: 9999;
        }
        .announcement-fullscreen-mask {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
        }
        .announcement-fullscreen-body {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
        }
        .announcement-dialog {
          background: #fff;
          padding: 16px;
          border-radius: 8px;
        }
        .el-button { padding: 12px 20px; }
      </style>
      <div class="container">
        <button class="el-button el-button--primary el-button--large" onclick="window.__signClicked = true">立即签到</button>
      </div>
      <div class="announcement-fullscreen-overlay">
        <div class="announcement-fullscreen-mask"></div>
        <div class="announcement-fullscreen-body">
          <div class="announcement-dialog">
            <p>站内公告</p>
            <button class="el-button" onclick="document.querySelector('.announcement-fullscreen-overlay').remove()">我知道了</button>
          </div>
        </div>
      </div>
    `);

    const result = await clickSignButton(page);

    assert.equal(result.clicked, true);
    assert.equal(await page.evaluate(() => window.__signClicked === true), true);
  });
});

test('checkSignedToday treats today\'s last sign date as already signed', async () => {
  await withPage(async (page) => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    await page.setContent(`
      <div>
        <div>累计签到</div>
        <div>7 天</div>
        <div>上次签到</div>
        <div>${today}</div>
        <div>签到记录</div>
      </div>
    `);

    const result = await checkSignedToday(page);

    assert.equal(result.signed, true);
  });
});

test('inferSignStateFromRequest treats API success copy as signed', () => {
  const result = inferSignStateFromRequest({
    seen: true,
    text: JSON.stringify({ msg: '签到成功' }),
    json: { msg: '签到成功' },
  });

  assert.equal(result.signed, true);
});

test('inferSignStateFromRequest does not treat success=false JSON field name as signed', () => {
  const result = inferSignStateFromRequest({
    seen: true,
    text: JSON.stringify({ success: false, message: '签到失败，请稍后重试' }),
    json: { success: false, message: '签到失败，请稍后重试' },
  });

  assert.equal(result.signed, false);
});

test('extractSignStats extracts total reward from “累计签到 X.XX GB” format', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div>
        <div>累计签到 2.12 GB</div>
        <div>签到获得 595.31 MB</div>
        <div>可用流量 172.42 MB</div>
      </div>
    `);

    const stats = await extractSignStats(page);

    assert.equal(stats.totalRewardText, '2.12GB');
    assert.ok(stats.totalRewardBytes > 0);
  });
});

test('extractSignStats extracts actual sign page line-before-label format', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div>
        <div>9 天</div>
        <div>累计签到</div>
        <div>2.97 GB</div>
        <div>签到获得</div>
        <div>1.21 GB</div>
        <div>可用流量</div>
        <div>上次签到</div>
        <div>2026-04-29</div>
      </div>
    `);

    const stats = await extractSignStats(page);

    assert.equal(stats.totalSignDays, 9);
    assert.equal(stats.totalRewardText, '2.97GB');
  });
});

test('buildResultTemplate handles missing values with placeholders', () => {
  const signStats = { totalSignDays: null, totalRewardBytes: 2.12 * 1024 ** 3 };
  const dashboardStats = { todayRewardBytes: null, remainingBytes: 101 * 1024 ** 3 };

  const template = buildResultTemplate(signStats, dashboardStats);

  // Should use 'x' for missing days, 'xM' for missing today reward
  assert.ok(template.startsWith('x:'));
  assert.ok(template.includes('xM'));
});