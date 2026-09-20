const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { clickSignButton, clickLoginButton, checkSignedToday, inferSignStateFromRequest, extractSignStats, extractDashboardStats, buildResultTemplate, trafficTextToBytes, formatTrafficCompact, isLoginPageRenderedText } = require('../src/browser');

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

test('checkSignedToday treats mixed MT Check-in already-signed copy as signed', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div>
        <div>[MT] 您今天已经Check-in过了噢</div>
        <div>[MT] 继续保持Check-in就可以获得更多的Traffic</div>
        <button class="el-button el-button--primary is-disabled" disabled>[MT] 立即Check-in</button>
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

test('isLoginPageRenderedText accepts English 52frp login page copy', () => {
  const text = `
    52frp Panel
    Login
    AccountLogin
    Please slide to verify
    Remember password
    Forgot password
    Login
    No account yet?Register
  `;

  assert.equal(isLoginPageRenderedText(text), true);
});

test('clickLoginButton clicks English login button', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <button type="button" class="el-button el-button--primary" onclick="window.__loginClicked = true">
        <span>Login</span>
      </button>
    `);

    const result = await clickLoginButton(page);

    assert.equal(result.clicked, true);
    assert.equal(await page.evaluate(() => window.__loginClicked === true), true);
  });
});

test('login flow does not reference stale loginButton locator after slider', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/browser.js'), 'utf8');

  assert.doesNotMatch(source, /loginButton\.click\(/);
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

test('extractSignStats extracts mixed MT Check-in labels from current sign page', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div>
        <div>[MT] 累计Check-in</div>
        <div>44 [MT] 天</div>
        <div>[MT] Check-in获得</div>
        <div>13.48 GB</div>
        <div>[MT] 可用Traffic</div>
        <div>1011.32 MB</div>
        <div>[MT] 上次Check-in</div>
        <div>2026-06-23</div>
      </div>
    `);

    const stats = await extractSignStats(page);

    assert.equal(stats.totalSignDays, 44);
    assert.equal(stats.totalRewardText, '13.48GB');
  });
});

test('extractDashboardStats extracts split traffic values from mixed MT dashboard labels', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div>
        <div>100.99</div>
        <div>GB</div>
        <div>[MT] 剩余Traffic</div>
        <div>[MT] 本次Check-in获得</div>
        <div>286.24 MB</div>
        <div>[MT] 今日已Check-in</div>
      </div>
    `);

    const stats = await extractDashboardStats(page);

    assert.equal(stats.todayRewardText, '286.24MB');
    assert.equal(stats.remainingText, '100.99GB');
  });
});

test('buildResultTemplate handles missing values with placeholders', () => {
  const signStats = { totalSignDays: null, totalRewardBytes: 2.12 * 1024 ** 3 };
  const dashboardStats = { todayRewardBytes: null, remainingBytes: 101 * 1024 ** 3 };

  const template = buildResultTemplate(signStats, dashboardStats);

  // 取不到的字段统一用「未取到」占位，不要编造数字
  assert.ok(template.startsWith('52frp签到成功'));
  assert.ok(template.includes('签到天数：未取到 天'));
  assert.ok(template.includes('本次获得：未取到'));
  assert.ok(template.includes('签到方式：本次运行自动签到成功'));
  assert.ok(!template.includes('xM'));
});

test('buildResultTemplate marks already-signed runs as not signed by this run', () => {
  const signStats = { totalSignDays: 10, totalRewardText: '2.97GB' };
  const dashboardStats = { todayRewardBytes: 286 * 1024 ** 2, remainingText: '100.99GB' };

  const template = buildResultTemplate(signStats, dashboardStats, 'already');

  assert.ok(template.startsWith('52frp今日已签到（无需重复签到）'));
  assert.ok(template.includes('签到方式：本次运行前已完成'));
});

// ---- 以下为 2026-09-19 误报事故的回归测试 ----
// 事故：页面出现「签到成功」四个字就被当成"今天已签到"，脚本跳过点击，
//       推送"已签到"但实际没签。根因是把"结果提示"当成了"状态证据"。

test('checkSignedToday does NOT treat "签到成功" copy as signed before clicking', async () => {
  // 复现 9/19 现场：页面残缺渲染，出现「签到成功」字样，但今天其实没签
  await withPage(async (page) => {
    await page.setContent(`
      <div>
        <div>签到成功</div>
        <div>累计签到</div>
        <div>2 天</div>
      </div>
    `);

    const result = await checkSignedToday(page);

    assert.equal(result.signed, false);
    assert.equal(result.reliable, false); // 拿不到硬证据，必须继续走点击流程
  });
});

test('checkSignedToday DOES treat "签到成功" copy as signed after clicking', async () => {
  await withPage(async (page) => {
    await page.setContent(`<div>签到成功</div>`);

    const result = await checkSignedToday(page, { allowSuccessPatterns: true });

    assert.equal(result.signed, true);
  });
});

test('checkSignedToday treats visible enabled sign button as hard evidence of not signed', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div>签到成功</div>
      <button class="el-button el-button--primary">立即签到</button>
    `);

    const result = await checkSignedToday(page);

    assert.equal(result.signed, false);
    assert.equal(result.reliable, true);
  });
});

test('checkSignedToday treats last sign date other than today as hard evidence of not signed', async () => {
  await withPage(async (page) => {
    const yesterday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));

    await page.setContent(`
      <div>
        <div>累计签到</div>
        <div>9 天</div>
        <div>上次签到</div>
        <div>${yesterday}</div>
      </div>
    `);

    const result = await checkSignedToday(page);

    assert.equal(result.signed, false);
    assert.equal(result.reliable, true);
  });
});

test('checkSignedToday marks today\'s last sign date as reliable evidence', async () => {
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
      </div>
    `);

    const result = await checkSignedToday(page);

    assert.equal(result.signed, true);
    assert.equal(result.reliable, true);
  });
});

test('checkSignedToday marks explicit already-signed copy as reliable evidence', async () => {
  await withPage(async (page) => {
    await page.setContent(`<div>[MT] 您今天已经Check-in过了噢</div>`);

    const result = await checkSignedToday(page);

    assert.equal(result.signed, true);
    assert.equal(result.reliable, true);
  });
});

test('checkSignedToday marks a disabled sign button as soft evidence only', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <button class="el-button is-disabled" disabled>立即签到</button>
    `);

    const result = await checkSignedToday(page);

    assert.equal(result.signed, true);
    assert.equal(result.reliable, false); // 可能是页面没渲染完，不能据此跳过签到
  });
});
