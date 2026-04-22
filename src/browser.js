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

const { chromium } = require('playwright');

const LOGIN_PAGE = 'https://www.52frp.com/user/#/auth/login';
const SIGN_PAGE = 'https://www.52frp.com/user/#/welfare/sign';
const DEFAULT_TIMEOUT_MS = 60_000;

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
  const patterns = [
    '您今天已经签到过了',
    '今天已经签到过了',
    '签到成功',
    '恭喜',
  ];

  for (const pattern of patterns) {
    if (bodyText.includes(pattern)) {
      return { signed: true, pattern };
    }
  }

  return { signed: false };
}

/**
 * 查找并点击签到按钮
 */
async function clickSignButton(page) {
  console.log('[签到] 查找签到按钮...');

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

        await button.click();
        console.log('[签到] 已点击签到按钮');
        return { clicked: true, buttonText: text.trim() };
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
async function waitForSignResult(page, timeoutMs = 10_000) {
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
    // 继检查最终状态
  }

  await page.waitForTimeout(1000);
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
    headless: process.env.FRP_BROWSER_HEADLESS === 'true',
    channel: process.env.FRP_BROWSER_CHANNEL || 'msedge',
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    ...launchOptions,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const steps = [];
  let loginSuccess = false;
  let sliderHandled = false;

  try {
    // 步骤 1: 打开登录页
    console.log('[1/5] 打开登录页...');
    steps.push('open_login');
    await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // 步骤 2: 输入账号密码
    console.log('[2/5] 输入账号密码...');
    steps.push('fill_credentials');

    const usernameInput = page.getByPlaceholder(/账户|手机号|邮箱|用户名/).or(
      page.locator('input[type="text"]').first()
    );
    const passwordInput = page.getByPlaceholder(/密码/).or(
      page.locator('input[type="password"]').first()
    );

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

    // 步骤 4: 跳转签到页
    console.log('[4/5] 跳转签到页...');
    steps.push('goto_sign');

    await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // 检查是否已签到
    const beforeCheck = await checkSignedToday(page);
    if (beforeCheck.signed) {
      console.log(`[签到] ${beforeCheck.pattern}`);
      return {
        status: 'already_signed',
        message: beforeCheck.pattern,
        details: { steps, loginSuccess, sliderHandled },
      };
    }

    // 步骤 5: 点击签到
    console.log('[5/5] 点击签到按钮...');
    steps.push('click_sign');

    const clickResult = await clickSignButton(page);

    if (!clickResult.clicked) {
      // 打印页面内容用于调试
      const bodyText = await page.locator('body').innerText().catch(() => '');
      console.log('[签到] 页面内容预览:', bodyText.substring(0, 500));
      throw new Error('未找到签到按钮');
    }

    // 等待结果
    await waitForSignResult(page, 10_000);

    // 检查最终状态
    const afterCheck = await checkSignedToday(page);

    if (afterCheck.signed) {
      // 尝试获取更多信息
      let signInfo = '';
      try {
        // 查找累计签到天数等信息
        const infoElements = await page.locator('[class*="sign"], .info, .statistics').allInnerTexts();
        signInfo = infoElements.join(' ').trim();
      } catch {
        signInfo = '';
      }

      return {
        status: 'success',
        message: afterCheck.pattern || '签到成功',
        details: {
          steps,
          loginSuccess,
          sliderHandled,
          signInfo,
        },
      };
    }

    // 检查是否有 toast 提示
    const toastLocator = page.locator('.el-message, .el-notification').last();
    const toastCount = await toastLocator.count();
    if (toastCount > 0) {
      const toastText = await toastLocator.innerText().catch(() => '');
      if (toastText.includes('成功')) {
        return {
          status: 'success',
          message: toastText,
          details: { steps, loginSuccess, sliderHandled },
        };
      }

      throw new Error(`签到失败: ${toastText}`);
    }

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
  waitForLoginSuccess,
  waitForSignResult,
};