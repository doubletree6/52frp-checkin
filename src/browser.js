/**
 * 纯浏览器签到模块 - 不调用任何 API
 *
 * 流程：
 * 1. 打开登录页，自动填账号密码
 * 2. 点击登录后检测滑块验证，自动完成滑块
 * 3. 登录成功后跳转签到页
 * 4. 点击"立即签到"按钮
 * 5. 检查签到结果并返回
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const LOGIN_PAGE = 'https://www.52frp.com/user/#/auth/login';
const SIGN_PAGE = 'https://www.52frp.com/user/#/welfare/sign';
const DEFAULT_TIMEOUT_MS = 60_000;
const SIGN_DATE_TIMEZONE = 'Asia/Shanghai';

function getTodaySignDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SIGN_DATE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function trafficTextToBytes(value) {
  if (!value) return null;

  const match = String(value).trim().match(/^([\d.]+)\s*(TB|GB|MB|KB|B)$/i);
  if (!match) return null;

  const number = Number(match[1]);
  const unit = match[2].toUpperCase();
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Math.round(number * 1024 ** powers[unit]);
}

function formatTrafficCompact(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';

  const trim = (value) => value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');

  if (bytes >= 1024 ** 4) return `${trim((bytes / 1024 ** 4).toFixed(2))}T`;
  if (bytes >= 1024 ** 3) return `${trim((bytes / 1024 ** 3).toFixed(2))}G`;
  if (bytes >= 1024 ** 2) return `${trim((bytes / 1024 ** 2).toFixed(2))}M`;
  if (bytes >= 1024) return `${trim((bytes / 1024).toFixed(2))}K`;
  return `${Math.round(bytes)}B`;
}

function getBodyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getValueBeforeLabel(text, label) {
  const lines = getBodyLines(text);
  const labelIndex = lines.findIndex((line) => line === label || line.includes(label));
  if (labelIndex > 0) {
    return lines[labelIndex - 1];
  }
  return null;
}

function normalizeTrafficText(value) {
  return value ? String(value).replace(/\s+/g, '') : null;
}

async function saveDebugArtifacts(page, label) {
  const dir = process.env.FRP_DEBUG_DIR || 'debug-artifacts';
  await fs.mkdir(dir, { recursive: true }).catch(() => {});

  const safeLabel = String(label || 'debug').replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const base = path.join(dir, safeLabel);

  const url = page.url();
  const html = await page.content().catch((error) => `<!-- failed to read content: ${error.message} -->`);
  const text = await page.locator('body').innerText().catch((error) => `failed to read body text: ${error.message}`);

  await fs.writeFile(`${base}.url.txt`, `${url}\n`).catch(() => {});
  await fs.writeFile(`${base}.html`, html).catch(() => {});
  await fs.writeFile(`${base}.txt`, text).catch(() => {});
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

  console.log(`[调试] 已保存页面调试文件: ${base}.{png,html,txt,url.txt}`);
}

async function extractSignStats(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');

  // 累计签到天数（多种格式）
  const daysMatch = bodyText.match(/累计签到\s*[:：]?\s*(\d+)\s*天/) ||
                    bodyText.match(/累计\s*(\d+)\s*天/) ||
                    bodyText.match(/签到\s*(\d+)\s*天/);
  const daysBeforeLabel = getValueBeforeLabel(bodyText, '累计签到');
  const daysBeforeLabelMatch = daysBeforeLabel ? daysBeforeLabel.match(/(\d+)\s*天?/) : null;
  
  // 累计签到获得的流量（优先匹配）
  const totalRewardMatch = bodyText.match(/累计签到\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i) ||
                          bodyText.match(/签到获得\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i) ||
                          bodyText.match(/累计\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i);
  const rewardBeforeLabel = getValueBeforeLabel(bodyText, '签到获得');
  const rewardBeforeLabelMatch = rewardBeforeLabel ? rewardBeforeLabel.match(/([\d.]+\s*(?:TB|GB|MB|KB|B))/i) : null;

  const totalSignDays = daysMatch ? Number(daysMatch[1]) : (daysBeforeLabelMatch ? Number(daysBeforeLabelMatch[1]) : null);
  const totalRewardText = normalizeTrafficText(totalRewardMatch ? totalRewardMatch[1] : (rewardBeforeLabelMatch ? rewardBeforeLabelMatch[1] : null));

  return {
    totalSignDays,
    totalRewardText,
    totalRewardBytes: trafficTextToBytes(totalRewardText),
    rawText: bodyText,
  };
}

function pickLargestTrafficText(candidates) {
  const normalized = candidates
    .filter(Boolean)
    .map((value) => String(value).replace(/\s+/g, ''))
    .map((value) => ({ text: value, bytes: trafficTextToBytes(value) }))
    .filter((item) => Number.isFinite(item.bytes) && item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  return normalized[0] || { text: null, bytes: null };
}

async function extractDashboardStats(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');

  const todayRewardMatch = bodyText.match(/本次签到获得\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i);
  const remainingCandidates = [
    ...Array.from(bodyText.matchAll(/([\d.]+\s*(?:TB|GB|MB|KB|B))\s*剩余流量/ig)).map((match) => match[1]),
    ...Array.from(bodyText.matchAll(/剩余流量\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/ig)).map((match) => match[1]),
  ];

  const todayRewardText = todayRewardMatch ? todayRewardMatch[1].replace(/\s+/g, '') : null;
  const remainingBest = pickLargestTrafficText(remainingCandidates);

  return {
    todayRewardText,
    todayRewardBytes: trafficTextToBytes(todayRewardText),
    remainingText: remainingBest.text,
    remainingBytes: remainingBest.bytes,
    remainingCandidates,
    rawText: bodyText,
  };
}

async function waitForDashboardStats(page, timeoutMs = 15_000) {
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => {});

  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return text.includes('本次签到获得') && text.includes('剩余流量');
      },
      { timeout: timeoutMs }
    );
  } catch {}

  await page.waitForTimeout(1200);
}

async function loadDashboardStats(page, dashboardUrl) {
  await waitForDashboardStats(page);
  let stats = await extractDashboardStats(page);

  if (stats.todayRewardBytes && stats.remainingBytes) {
    return stats;
  }

  console.log('[主页] 首次提取统计不完整，刷新个人主页后重试...');

  if (dashboardUrl) {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForDashboardStats(page);
    stats = await extractDashboardStats(page);
  }

  if (stats.todayRewardBytes && stats.remainingBytes) {
    return stats;
  }

  console.log('[主页] 仪表盘仍未提取完整，继续使用当前可得数据');
  return stats;
}

function buildResultTemplate(signStats, dashboardStats) {
  const days = Number.isFinite(signStats?.totalSignDays) ? signStats.totalSignDays : 'x';
  const todayReward = Number.isFinite(dashboardStats?.todayRewardBytes) && dashboardStats.todayRewardBytes > 0
    ? formatTrafficCompact(dashboardStats.todayRewardBytes)
    : 'xM';
  const totalReward = signStats?.totalRewardText ? signStats.totalRewardText.replace(/B$/, '') : 'xG';
  const remaining = dashboardStats?.remainingText ? dashboardStats.remainingText.replace(/B$/, '') : 'xG';

  return `${days}:${todayReward};${totalReward};${remaining}`;
}

function resolveHeadless() {
  if (typeof process.env.FRP_BROWSER_HEADLESS === 'string') {
    return process.env.FRP_BROWSER_HEADLESS === 'true';
  }

  return Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
}

function resolveChannel() {
  if (process.env.FRP_BROWSER_CHANNEL) {
    return process.env.FRP_BROWSER_CHANNEL;
  }

  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    return 'chromium';
  }

  return 'msedge';
}

/**
 * 检测并完成滑块验证
 *
 * 常见滑块类型：
 * - 自定义拖动滑块: .drag_verify, .dv_handler (52frp 使用这种)
 * - TencentCaptcha: .tcaptcha, #tcaptcha
 * - GeeTest: .geetest_slider, ._geetest_slide_handle
 * - Aliyun: #aliyun-captcha
 */
async function handleSliderVerification(page, timeoutMs = 30_000) {
  console.log('[滑块] 检测滑块验证...');

  // 等待滑块元素出现
  let sliderBox = null;
  let sliderHandle = null;

  // 优先检测 52frp 使用的滑块类型
  const sliderPatterns = [
    { container: '.drag_verify', handler: '.dv_handler' },  // 52frp 类型
    { container: '.tcaptcha', handler: '.tcaptcha-slider-btn' },
    { container: '.geetest_slider', handler: '.geetest_slider_button' },
    { container: '#aliyun-captcha', handler: '' },
    { container: '.slider', handler: '' },
    { container: '[class*="slider"]', handler: '' },
  ];

  for (const pattern of sliderPatterns) {
    try {
      const containerLocator = page.locator(pattern.container);
      if (await containerLocator.count() > 0) {
        sliderBox = containerLocator.first();
        console.log(`[滑块] 找到滑块容器: ${pattern.container}`);

        // 尝试找把手
        if (pattern.handler) {
          const handleLocator = sliderBox.locator(pattern.handler);
          if (await handleLocator.count() > 0) {
            sliderHandle = handleLocator.first();
            console.log(`[滑块] 找到滑块把手: ${pattern.handler}`);
          }
        }

        // 如果没找到指定把手，尝试常见把手选择器
        if (!sliderHandle) {
          const handleSelectors = [
            '.dv_handler',
            '.tcaptcha-slider-btn',
            '.geetest_slider_button',
            '[class*="handler"]',
            '[class*="drag"]',
            'div[role="slider"]',
          ];
          for (const hSel of handleSelectors) {
            const hLoc = sliderBox.locator(hSel);
            if (await hLoc.count() > 0) {
              sliderHandle = hLoc.first();
              console.log(`[滑块] 找到滑块把手: ${hSel}`);
              break;
            }
          }
        }

        // 如果还没找到，尝试从容器直接拖动
        if (!sliderHandle) {
          sliderHandle = sliderBox;
          console.log('[滑块] 使用容器本身作为拖动目标');
        }

        break;
      }
    } catch {
      continue;
    }
  }

  if (!sliderBox || await sliderBox.count() === 0) {
    console.log('[滑块] 未检测到滑块，可能不需要验证');
    return { handled: false, reason: 'no_slider_detected' };
  }

  // 获取滑块位置
  const boxBounds = await sliderBox.boundingBox();
  if (!boxBounds) {
    return { handled: false, reason: 'cannot_get_bounds' };
  }

  console.log(`[滑块] 滑块位置: x=${boxBounds.x.toFixed(1)}, y=${boxBounds.y.toFixed(1)}, w=${boxBounds.width}, h=${boxBounds.height}`);

  // 计算拖动距离和起点
  let startX, startY, endX, endY;

  if (sliderHandle) {
    const handleBounds = await sliderHandle.boundingBox();
    if (handleBounds) {
      // 从把手中心开始
      startX = handleBounds.x + handleBounds.width / 2;
      startY = handleBounds.y + handleBounds.height / 2;
      // 拖动到容器最右侧（确保拖到底，多留 5px 冗余）
      endX = boxBounds.x + boxBounds.width - 5;
      endY = startY;
      console.log(`[滑块] 把手位置: x=${handleBounds.x.toFixed(1)}, y=${handleBounds.y.toFixed(1)}`);
    } else {
      // 无法获取把手位置，使用容器
      startX = boxBounds.x + 20;
      startY = boxBounds.y + boxBounds.height / 2;
      endX = boxBounds.x + boxBounds.width - 5;  // 拖到最右边
      endY = startY;
    }
  } else {
    startX = boxBounds.x + 20;
    startY = boxBounds.y + boxBounds.height / 2;
    endX = boxBounds.x + boxBounds.width - 5;  // 拖到最右边
    endY = startY;
  }

  console.log(`[滑块] 拖动路径: (${startX.toFixed(1)}, ${startY.toFixed(1)}) → (${endX.toFixed(1)}, ${endY.toFixed(1)})`);

  // 使用 Playwright 的真实鼠标事件进行拖动
  // 关键：必须使用 page.mouse API，不能用 JS 模拟事件
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.waitForTimeout(150);

  // 分段移动，模拟人类行为（有轻微抖动）
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // 添加随机垂直抖动模拟人手不稳
    const jitterY = (Math.random() - 0.5) * 4;
    const currentX = startX + (endX - startX) * progress;
    const currentY = startY + jitterY;

    await page.mouse.move(currentX, currentY);
    // 每步间隔模拟人类操作速度（40-80ms）
    await page.waitForTimeout(40 + Math.random() * 40);
  }

  await page.mouse.up();

  console.log('[滑块] 拖拽完成，等待验证结果...');
  await page.waitForTimeout(2000);

  // 检查滑块是否消失或验证成功
  const stillVisible = await sliderBox.count().catch(() => 0);
  if (stillVisible === 0) {
    console.log('[滑块] 滑块已消失，验证成功');
    return { handled: true, success: true };
  }

  // 检查滑块是否显示为通过状态（例如进度条已满）
  try {
    const progressBar = sliderBox.locator('.dv_progress_bar, .progress_bar, [class*="progress"]');
    if (await progressBar.count() > 0) {
      const progressWidth = await progressBar.first().evaluate(el => {
        const style = window.getComputedStyle(el);
        return parseFloat(style.width) || el.offsetWidth;
      });
      if (progressWidth > boxBounds.width * 0.8) {
        console.log(`[滑块] 进度条已满 (${progressWidth}px)，验证成功`);
        return { handled: true, success: true };
      }
    }
  } catch {}

  // 检查成功提示
  const successToast = await page.locator('.el-message--success, .success, [class*="success"]').count();
  if (successToast > 0) {
    console.log('[滑块] 检测到成功提示');
    return { handled: true, success: true };
  }

  console.log('[滑块] 滑块仍然显示，尝试重试...');
  return { handled: true, success: false, reason: 'slider_still_visible' };
}

/**
 * 等待登录成功
 */
async function waitForLoginSuccess(page, timeoutMs = 30_000) {
  console.log('[登录] 等待登录完成...');

  try {
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        // 登录成功后 URL 会变化，不再包含 /auth/login
        return url.includes('/user/') && !url.includes('/auth/login');
      },
      { timeout: timeoutMs }
    );
    console.log('[登录] URL 已变化，登录成功');
    return true;
  } catch {
    // 检查是否有错误提示
    const errorToast = await page.locator('.el-message--error, .error, [class*="error"]').count();
    if (errorToast > 0) {
      const errorText = await page.locator('.el-message--error').first().innerText().catch(() => '未知错误');
      console.log(`[登录] 错误提示: ${errorText}`);
      return false;
    }

    console.log('[登录] 超时，未检测到登录成功');
    return false;
  }
}

/**
 * 检查是否已签到
 */
async function checkSignedToday(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');

  // 优先检查上次签到日期是否为今天（最可靠）
  const today = getTodaySignDate();
  const lastSignMatch = bodyText.match(/上次签到\s*[:：]?\s*(\d{4}-\d{2}-\d{2}|\d{4}\.\d{2}\.\d{2}|\d{2}-\d{2}|\d{2}\.\d{2})/);
  if (lastSignMatch) {
    let lastSignDate = lastSignMatch[1];
    // 处理不同日期格式
    if (lastSignDate.length === 5) {
      // MM-DD 或 MM.DD 格式，需要补年份
      const year = new Date().toLocaleDateString('en-CA', { timeZone: SIGN_DATE_TIMEZONE }).split('-')[0];
      lastSignDate = `${year}-${lastSignDate.replace('.', '-')}`;
    } else if (lastSignDate.includes('.')) {
      // YYYY.MM.DD 格式，转换为 YYYY-MM-DD
      lastSignDate = lastSignDate.replace('.', '-').replace('.', '-');
    }
    if (lastSignDate === today) {
      console.log(`[签到判断] 上次签到日期为今天 (${today})，判断为已签到`);
      return { signed: true, pattern: `上次签到日期: ${today}` };
    }
  }

  // 明确文字提示（可靠）
  const explicitPatterns = [
    '您今天已经签到过了',
    '今天已经签到过了',
  ];
  for (const pattern of explicitPatterns) {
    if (bodyText.includes(pattern)) {
      return { signed: true, pattern: `页面提示: ${pattern}` };
    }
  }

  // 签到成功提示（执行后出现）
  const successPatterns = ['签到成功', '恭喜获得'];
  for (const pattern of successPatterns) {
    if (bodyText.includes(pattern)) {
      return { signed: true, pattern: `成功提示: ${pattern}` };
    }
  }

  // 检测签到按钮是否存在且可见（关键判断）
  const signButton = page.getByRole('button', { name: '立即签到' });
  const buttonVisible = await signButton.isVisible().catch(() => false);
  const buttonCount = await signButton.count().catch(() => 0);

  if (buttonVisible && buttonCount > 0) {
    // 签到按钮可见 → 未签到
    console.log('[签到判断] 检测到「立即签到」按钮可见，判断为未签到');
    return { signed: false };
  }

  // 签到按钮不可见或不存在
  // 检查是否有替代的「已签到」相关状态文字
  if (bodyText.includes('已签到') || bodyText.includes('已经签到') || bodyText.includes('今日已签')) {
    console.log('[签到判断] 签到按钮不可见，页面显示已签到状态');
    return { signed: true, pattern: '按钮不可见且页面显示已签到' };
  }

  // 默认：按钮不可见但无明确状态，保守判断为未签到，尝试点击
  console.log('[签到判断] 签到按钮不可见，无明确已签到提示，保守判断为未签到');
  return { signed: false };
}

/**
 * 关闭可能阻挡点击的公告遮罩层
 *
 * 52frp 登录后可能会显示全屏公告弹窗，拦截所有点击事件。
 * 此函数检测并关闭这类遮罩层，确保后续操作能正常执行。
 */
async function dismissBlockingOverlays(page) {
  // 检测常见的遮罩层选择器
  const overlaySelectors = [
    '.announcement-fullscreen-overlay',
    '.announcement-overlay',
    '.fullscreen-overlay',
    '[class*="announcement-fullscreen"]',
    '[class*="announcement"][class*="overlay"]',
  ];

  for (const selector of overlaySelectors) {
    const overlay = page.locator(selector);
    const count = await overlay.count().catch(() => 0);

    if (count > 0) {
      console.log(`[遮罩] 检测到遮罩层: ${selector}`);

      // 尝试多种方式关闭
      const closeStrategies = [
        // 1. 点击遮罩层内的关闭按钮
        { name: '我知道了', locator: overlay.locator('button:has-text("我知道了")').first() },
        { name: '确定', locator: overlay.locator('button:has-text("确定")').first() },
        { name: '关闭', locator: overlay.locator('button:has-text("关闭")').first() },
        { name: 'OK', locator: overlay.locator('button:has-text("OK")').first() },
        { name: '关闭图标', locator: overlay.locator('.el-dialog__close, [aria-label="Close"], .close-btn').first() },
      ];

      for (const strategy of closeStrategies) {
        const btnCount = await strategy.locator.count().catch(() => 0);
        if (btnCount > 0) {
          console.log(`[遮罩] 尝试点击: ${strategy.name}`);
          await strategy.locator.click().catch(() => {});
          await page.waitForTimeout(500);

          // 检查遮罩层是否消失
          const remaining = await overlay.count().catch(() => 0);
          if (remaining === 0) {
            console.log(`[遮罩] 已通过 ${strategy.name} 关闭`);
            return true;
          }
        }
      }

      // 2. 尝试 Escape 键
      console.log('[遮罩] 尝试 Escape 键');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const afterEscape = await overlay.count().catch(() => 0);
      if (afterEscape === 0) {
        console.log('[遮罩] 已通过 Escape 关闭');
        return true;
      }

      // 3. 最后手段：强制移除 DOM 元素
      console.log('[遮罩] 强制移除遮罩层 DOM');
      await overlay.evaluate(el => el.remove()).catch(() => {});
      return true;
    }
  }

  return false;
}

/**
 * 查找并点击签到按钮
 */
async function clickSignButton(page) {
  console.log('[签到] 查找签到按钮...');

  // 先关闭可能阻挡点击的遮罩层
  await dismissBlockingOverlays(page);

  // 多种方式查找按钮
  const strategies = [
    { name: 'role按钮', locator: page.getByRole('button', { name: '立即签到' }) },
    { name: '文本过滤', locator: page.locator('button').filter({ hasText: '立即签到' }) },
    { name: 'primary按钮', locator: page.locator('button.el-button--primary').first() },
    { name: 'sign类按钮', locator: page.locator('button[class*="sign"]') },
    { name: '任意签到文本', locator: page.locator('button, [role="button"]').filter({ hasText: '签到' }) },
  ];

  for (const strategy of strategies) {
    try {
      const count = await strategy.locator.count();
      if (count > 0) {
        const button = strategy.locator.first();
        const text = await button.innerText().catch(() => '');
        console.log(`[签到] 找到按钮 (${strategy.name}): "${text.trim()}"`);

        // 尝试多种点击方式，优先使用 Playwright 真实指针点击。
        // 52frp 的签到会依赖页面先获取 slider-token，再由真实按钮事件提交。
        // JS evaluate click() 在 GitHub Actions 中曾触发 /user/sign，但服务端返回
        // “签到失败，请稍后重试”，所以只能作为最后 fallback。
        let clicked = false;
        
        // 方式1: 真实点击
        try {
          await button.scrollIntoViewIfNeeded().catch(() => {});
          await button.click({ timeout: 30_000 });
          console.log('[签到] 已点击签到按钮（真实点击）');
          clicked = true;
        } catch (e) {
          console.log('[签到] 真实点击失败，尝试 force click:', e.message);
        }

        // 方式2: force click
        if (!clicked) {
          try {
            await button.click({ force: true });
            console.log('[签到] 已点击签到按钮（force模式）');
            clicked = true;
          } catch (e) {
            console.log('[签到] force click 失败，尝试 JS evaluate:', e.message);
          }
        }

        // 方式3: 直接调用 JavaScript click()，只作为最后兜底
        if (!clicked) {
          try {
            await button.evaluate(el => el.click());
            console.log('[签到] 已点击签到按钮（JS evaluate）');
            clicked = true;
          } catch (e) {
            console.log('[签到] JS evaluate 失败，尝试 dispatchEvent');
            // 方式4: dispatchEvent
            try {
              await button.dispatchEvent('click');
              console.log('[签到] 已点击签到按钮（dispatchEvent）');
              clicked = true;
            } catch (e2) {
              console.log('[签到] dispatchEvent 也失败:', e2.message);
            }
          }
        }

        return { clicked, buttonText: text.trim() };
      }
    } catch (e) {
      console.log(`[签到] 策略 ${strategy.name} 失败: ${e.message}`);
    }
  }

  return { clicked: false };
}

/**
 * 等待签到结果
 */
async function waitForSignResult(page, timeoutMs = 30_000) {
  console.log('[签到] 等待签到结果...');

  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return (
          text.includes('您今天已经签到过了') ||
          text.includes('今天已经签到过了') ||
          text.includes('签到成功') ||
          text.includes('恭喜') ||
          Boolean(document.querySelector('.el-message, .el-notification'))
        );
      },
      { timeout: timeoutMs }
    );
  } catch {
    // 继续检查最终状态
  }

  await page.waitForTimeout(1000);
}

async function waitForSignRequest(page, timeoutMs = 15_000) {
  try {
    const response = await page.waitForResponse(
      (res) => res.request().method() === 'POST' && /\/user\/sign(?:\?|$)/.test(res.url()),
      { timeout: timeoutMs }
    );

    const text = await response.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    console.log(`[签到] 捕获签到请求: ${response.status()} ${response.url()}`);
    console.log(`[签到] 响应原文（前500字符）: ${text.slice(0, 500)}`);
    if (json) {
      console.log(`[签到] 响应 JSON: ${JSON.stringify(json).slice(0, 500)}`);
      const message = json.message || json.msg || json.error || json.detail || json.info || json.result;
      if (message) {
        console.log(`[签到] 接口返回消息: ${message}`);
      }
    } else {
      console.log(`[签到] 响应无法解析为 JSON，原文前200字符: ${text.slice(0, 200)}`);
    }

    return {
      seen: true,
      status: response.status(),
      url: response.url(),
      text,
      json,
    };
  } catch {
    console.log('[签到] 未捕获到签到请求');
    return { seen: false };
  }
}

function inferSignStateFromRequest(signRequest) {
  if (!signRequest?.seen) return { signed: false };

  const json = signRequest.json || null;
  const message = json
    ? String(json.message || json.msg || json.error || json.detail || '')
    : '';
  const raw = message || String(signRequest.text || '');

  if (/签到失败|失败|稍后重试|错误|error/i.test(raw)) {
    return { signed: false, pattern: '接口返回失败' };
  }

  if (/今天已经签到过了|您今天已经签到过了|已签到|已经签到/i.test(raw)) {
    return { signed: true, pattern: '接口返回已签到' };
  }

  if (/签到成功|成功|恭喜/i.test(raw)) {
    return { signed: true, pattern: '接口返回签到成功' };
  }

  // 如果响应码为 200 且有 data 字段，且无明确失败消息，视为可能成功
  if (signRequest.status === 200 && json && json.data && !/失败|error|错误|稍后重试/i.test(text)) {
    console.log(`[签到] 检测到 200 + data 字段，视为可能成功`);
    return { signed: true, pattern: '接口返回 200 且有 data 字段' };
  }

  return { signed: false };
}

/**
 * 纯浏览器签到主函数
 *
 * @param {Object} options
 * @param {string} options.username - 账号
 * @param {string} options.password - 密码
 * @param {number} options.timeoutMs - 超时时间
 * @param {Object} options.launchOptions - Playwright 启动选项
 * @returns {Promise<{status: string, message: string, details?: Object}>}
 */
async function pureBrowserCheckIn({
  username,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  launchOptions = {},
}) {
  if (!username || !password) {
    throw new Error('缺少账号或密码，请配置 FRP_USERNAME 和 FRP_PASSWORD');
  }

  console.log('='.repeat(50));
  console.log('52frp 纯浏览器签到（无 API）');
  console.log('='.repeat(50));
  console.log('');

  const browser = await chromium.launch({
    headless: resolveHeadless(),
    channel: resolveChannel(),
    args: process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : [],
    ...launchOptions,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const steps = [];
  let loginSuccess = false;
  let sliderHandled = false;
  let dashboardUrl = null;
  let dashboardStats = null;
  let beforeStats = null;

  try {
    // 步骤 1: 打开登录页
    console.log('[1/5] 打开登录页...');
    steps.push('open_login');
    
    // 多次尝试加载页面（应对 HTTP 响应异常）
    let gotoAttempts = 0;
    const maxGotoAttempts = 3;
    while (gotoAttempts < maxGotoAttempts) {
      try {
        await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        break;
      } catch (gotoErr) {
        gotoAttempts++;
        console.log(`[页面] 加载失败 (尝试 ${gotoAttempts}/${maxGotoAttempts}): ${gotoErr.message}`);
        if (gotoAttempts >= maxGotoAttempts) {
          throw gotoErr;
        }
        await page.waitForTimeout(3000);
      }
    }
    
    // Vue SPA 需要额外等待页面渲染完成
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    // 等待登录表单渲染（Vue 组件加载）
    await page.waitForFunction(
      () => {
        // 检查是否存在登录相关的输入框或表单元素
        const inputs = document.querySelectorAll('input');
        return inputs.length >= 2;
      },
      { timeout: 20_000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // 步骤 2: 输入账号密码
    console.log('[2/5] 输入账号密码...');
    steps.push('fill_credentials');

    // 多种方式查找输入框（更稳健）
    const usernameStrategies = [
      page.getByPlaceholder(/账户|手机号|邮箱|用户名|账号/),
      page.locator('input[type="text"]').first(),
      page.locator('input:not([type="password"])').first(),
      page.locator('input').first(),
    ];
    const passwordStrategies = [
      page.getByPlaceholder(/密码/),
      page.locator('input[type="password"]').first(),
      page.locator('input').filter({ has: page.locator('[class*="password"]') }).first(),
    ];

    let usernameInput = null;
    let passwordInput = null;

    for (const strategy of usernameStrategies) {
      try {
        if (await strategy.count() > 0) {
          usernameInput = strategy;
          break;
        }
      } catch {}
    }
    for (const strategy of passwordStrategies) {
      try {
        if (await strategy.count() > 0) {
          passwordInput = strategy;
          break;
        }
      } catch {}
    }

    if (!usernameInput || !passwordInput) {
      await saveDebugArtifacts(page, 'login-inputs-not-found');
      throw new Error('未找到登录输入框，页面可能未正确加载');
    }

    await usernameInput.fill(username);
    await passwordInput.fill(password);
    console.log(`[输入] 账号已填入，密码已填入`);

    // 步骤 3: 点击登录并处理滑块
    console.log('[3/5] 点击登录...');
    steps.push('click_login');

    const loginButton = page.getByRole('button', { name: '登录' }).or(
      page.locator('button').filter({ hasText: '登录' })
    );

    await loginButton.click();
    console.log('[登录] 已点击登录按钮');

    // 等待一下让滑块可能出现
    await page.waitForTimeout(1500);

    // 检测并处理滑块
    const sliderResult = await handleSliderVerification(page, 30_000);
    sliderHandled = sliderResult.handled;

    if (sliderResult.handled && !sliderResult.success) {
      // 滑块拖拽后仍未通过，可能需要重试
      console.log('[滑块] 第一次拖拽未通过，尝试第二次...');

      // 有些滑块需要等待重置
      await page.waitForTimeout(1000);

      const retryResult = await handleSliderVerification(page, 20_000);
      if (retryResult.handled && !retryResult.success) {
        console.log('[滑块] 重试仍未通过，可能需要手动介入');
      }
    }

    // 滑块验证通过后，再次点击登录按钮完成登录
    if (sliderResult.handled && sliderResult.success) {
      console.log('[登录] 滑块验证通过，再次点击登录...');
      await loginButton.click();
      await page.waitForTimeout(2000);
    }

    // 等待登录成功
    loginSuccess = await waitForLoginSuccess(page, 20_000);

    if (!loginSuccess) {
      // 检查是否仍在登录页
      const currentUrl = page.url();
      if (currentUrl.includes('/auth/login')) {
        throw new Error('登录失败：可能账号密码错误或滑块验证未通过');
      }
    }

    dashboardUrl = page.url();
    dashboardStats = await loadDashboardStats(page, dashboardUrl);

    // 步骤 4: 跳转签到页
    console.log('[4/5] 跳转签到页...');
    steps.push('goto_sign');

    await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    beforeStats = await extractSignStats(page);

    // 检查是否已签到
    const beforeCheck = await checkSignedToday(page);
    if (beforeCheck.signed) {
      const template = buildResultTemplate(beforeStats, dashboardStats);
      console.log(`[签到] ${beforeCheck.pattern}`);
      return {
        status: 'already_signed',
        message: template,
        details: { steps, loginSuccess, sliderHandled, signStats: beforeStats, dashboardStats, template },
      };
    }

    // 步骤 5: 点击签到
    console.log('[5/5] 点击签到按钮...');
    steps.push('click_sign');

    const signRequestPromise = waitForSignRequest(page);
    const clickResult = await clickSignButton(page);

    if (!clickResult.clicked) {
      // 打印页面内容用于调试
      const bodyText = await page.locator('body').innerText().catch(() => '');
      console.log('[签到] 页面内容预览:', bodyText.substring(0, 500));
      throw new Error('未找到签到按钮');
    }

    // 点击成功后，检测并处理可能出现的签到滑块验证
    console.log('[签到] 准备检测签到滑块...');
    await page.waitForTimeout(1500);
    const signSliderResult = await handleSliderVerification(page, 20_000);
    console.log('[签到] 滑块检测完成, handled:', signSliderResult.handled, 'success:', signSliderResult.success);
    if (signSliderResult.handled) {
      console.log('[签到滑块] 处理结果:', signSliderResult.success ? '验证通过' : '验证失败');
      // 滑块验证通过后，可能需要再次触发签到（某些站点设计）
      if (signSliderResult.success) {
        await page.waitForTimeout(2000);
        // 检查是否还有签到按钮需要再次点击
        const stillHasSignButton = await page.getByRole('button', { name: '立即签到' }).count();
        if (stillHasSignButton > 0) {
          console.log('[签到] 滑块验证后再次点击签到按钮...');
          await dismissBlockingOverlays(page);
          await page.getByRole('button', { name: '立即签到' }).first().click().catch(() => {});
          await page.waitForTimeout(1500);
        }
      }
    }

    // 关闭签到成功后可能弹出的公告遮罩
    await dismissBlockingOverlays(page);
    await page.waitForTimeout(1000);

    const signRequest = await signRequestPromise;

    // 等待结果
    await waitForSignResult(page);

    // 检查最终状态
    const afterCheck = await checkSignedToday(page);
    const requestCheck = inferSignStateFromRequest(signRequest);
    const afterStats = await extractSignStats(page);

    let afterDashboardStats = dashboardStats;
    if (dashboardUrl) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      afterDashboardStats = await loadDashboardStats(page, dashboardUrl);
    }

    if (afterCheck.signed || requestCheck.signed) {
      const template = buildResultTemplate(afterStats, afterDashboardStats);

      return {
        status: 'success',
        message: template,
        details: {
          steps,
          loginSuccess,
          sliderHandled,
          signStats: afterStats,
          dashboardStats: afterDashboardStats,
          template,
          signRequest,
          signInfo: afterCheck.pattern || requestCheck.pattern,
        },
      };
    }

    // 检查是否有 toast 提示
    const toastLocator = page.locator('.el-message, .el-notification').last();
    const toastCount = await toastLocator.count();
    if (toastCount > 0) {
      const toastText = await toastLocator.innerText().catch(() => '');
      if (toastText.includes('成功')) {
        const template = buildResultTemplate(afterStats, afterDashboardStats);
        return {
          status: 'success',
          message: template,
          details: { steps, loginSuccess, sliderHandled, signStats: afterStats, dashboardStats: afterDashboardStats, template },
        };
      }

      throw new Error(`签到失败: ${toastText}`);
    }

    const bodyPreview = await page.locator('body').innerText().catch(() => '');
    console.log('[签到] 最终页面内容预览:', bodyPreview.substring(0, 1000));
    throw new Error('未检测到签到成功或失败提示');

  } finally {
    console.log('');
    console.log('[清理] 关闭浏览器...');
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  pureBrowserCheckIn,
  handleSliderVerification,
  checkSignedToday,
  clickSignButton,
  dismissBlockingOverlays,
  extractDashboardStats,
  extractSignStats,
  buildResultTemplate,
  loadDashboardStats,
  waitForDashboardStats,
  formatTrafficCompact,
  trafficTextToBytes,
  waitForLoginSuccess,
  waitForSignResult,
  waitForSignRequest,
  inferSignStateFromRequest,
};
