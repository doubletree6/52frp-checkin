/**
 * 绾祻瑙堝櫒绛惧埌妯″潡 - 涓嶈皟鐢ㄤ换浣?API
 *
 * 娴佺▼锛? * 1. 鎵撳紑鐧诲綍椤碉紝鑷姩濉处鍙峰瘑鐮? * 2. 鐐瑰嚮鐧诲綍鍚庢娴嬫粦鍧楅獙璇侊紝鑷姩瀹屾垚婊戝潡
 * 3. 鐧诲綍鎴愬姛鍚庤烦杞鍒伴〉
 * 4. 鐐瑰嚮"绔嬪嵆绛惧埌"鎸夐挳
 * 5. 妫€鏌ョ鍒扮粨鏋滃苟杩斿洖
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const LOGIN_PAGE = 'https://www.52frp.com/user/#/auth/login';
const SIGN_PAGE = 'https://www.52frp.com/user/#/welfare/sign';
const DEFAULT_TIMEOUT_MS = 60_000;
const SIGN_DATE_TIMEZONE = 'Asia/Shanghai';
const LOGIN_PAGE_RENDER_PATTERNS = [
  { source: '鐧诲綍|璐﹀彿|璐︽埛' },
  { source: 'Account\\s*Login', flags: 'i' },
  { source: 'Please enter (?:account|your password)', flags: 'i' },
  { source: 'Please slide to verify', flags: 'i' },
  { source: '\\bRemember password\\b', flags: 'i' },
  { source: '\\bForgot password\\b', flags: 'i' },
  { source: '\\bLogin\\b', flags: 'i' },
];

// ---------------------------------------------------------------------------
// 绋冲畾鎬у寮?//
// GitHub Actions 鐨?runner 浣嶄簬娴峰鏈烘埧锛岃闂?52frp 鍥藉唴鐨?CDN 杈圭紭鑺傜偣鏃?// 缁忓父鎾炰笂鍒嗛挓绾х殑鍥炴簮鏁呴殰锛?22 / 524 / 525锛夈€備竴鏃?JS bundle 鎷夊彇澶辫触锛?// SPA 灏辨病鏈夊彲鎵ц鐨勪唬鐮侊紝椤甸潰鍏ㄧ櫧锛坆ody 鏂囨湰闀垮害 = 0锛夈€?//
// 搴斿鎬濊矾涓嶆槸璁╁崟娆¤姹傚彉寰楁洿寮猴紝鑰屾槸锛?//   1) 鍦ㄤ竴娆¤繍琛屽唴澶氭潵鍑犺疆锛屾瘡杞兘鏄叏鏂扮殑娴忚鍣ㄥ疄渚嬶紙New browser per round锛?//   2) 灏芥棭璇嗗埆鍥炴簮鏁呴殰锛屽埆鍌荤瓑鍒拌秴鏃?//   3) 鐮嶆帀涓庣鍒版棤鍏崇殑绗笁鏂硅姹傦紝缂╁皬澶辫触闈?// ---------------------------------------------------------------------------

/** CDN / 婧愮珯鍥炴簮绫婚敊璇爜锛氬懡涓嵆鍙垽瀹氫负銆岀珯鐐逛晶鏁呴殰锛屽彲鑷剤銆?*/
const UPSTREAM_ERROR_CODES = [
  500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530,
];

/** 鐧诲綍椤碉細鍗曡疆鍐呯殑閲嶈瘯娆℃暟涓庨€€閬垮簭鍒楋紙ms锛?*/
const LOGIN_PAGE_MAX_ATTEMPTS = 3;
const LOGIN_PAGE_BACKOFF_MS = [0, 6_000, 12_000];
const LOGIN_GOTO_ATTEMPTS = 2;

/** 鐧诲綍椤碉細鍚勯」绛夊緟鐨勪笂闄愶紙ms锛夈€傚埢鎰忔敹绱э紝鎶婃椂闂寸暀缁欍€屾暣杞噸鏉ャ€?*/
const LOGIN_GOTO_TIMEOUT_MS = 30_000;
const LOGIN_NETWORKIDLE_TIMEOUT_MS = 15_000;
const LOGIN_RENDER_TIMEOUT_MS = 20_000;

/** 娓叉煋妫€娴嬬殑杞闂撮殧锛坢s锛?*/
const LOGIN_RENDER_POLL_MS = 500;

/** 姣忚疆瀹屾暣娴佺▼涔嬮棿鐨勯棿闅旓紙ms锛夛細缁欐簮绔欑暀鍑烘仮澶嶆椂闂?*/
const ROUND_BACKOFF_MS = [45_000, 75_000];

/** 涓庣鍒版棤鍏炽€佸嵈瑕佽法娲嬭姹傜殑绗笁鏂硅祫婧?*/
const THIRD_PARTY_HOST_PATTERNS = [
  /^api\.iconify\.design$/i,
  /^api\.unisvg\.com$/i,
  /^api\.simplesvg\.com$/i,
  /^fonts\.googleapis\.com$/i,
  /^fonts\.gstatic\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)baidu\.com$/i,
  /(^|\.)bdstatic\.com$/i,
  /(^|\.)yandex\.(ru|com)$/i,
];

/** 鏃犺浠€涔堟ā寮忛兘鏀捐鐨勫煙鍚嶏紙鍚悓婧愶級 */
const FIRST_PARTY_HOST_PATTERNS = [
  /(^|\.)52frp\.com$/i,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 绗笁鏂硅祫婧愬睆钄芥ā寮忥細off | safe锛堥粯璁わ級| strict */
function resolveBlockThirdPartyMode() {
  const raw = (process.env.FRP_BLOCK_THIRD_PARTY || 'safe').trim().toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'strict' || raw === 'whitelist') return 'strict';

  return 'safe';
}

function isUpstreamError(status) {
  return UPSTREAM_ERROR_CODES.includes(Number(status));
}

function getUrlHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null; // data: / blob: 绛夐潪鏍囧噯鍦板潃
  }
}

/** host + pathname锛岀敤浜庢棩蹇?鎶ラ敊閲屽畾浣嶅叿浣撴槸鍝釜璧勬簮鎸傚湪鍥炴簮涓婏紙涓嶅甫 query锛岄伩鍏嶅埛灞忥級 */
function getUrlPath(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return String(rawUrl || '');
  }
}

function shouldBlockUrl(rawUrl, mode) {
  if (mode === 'off') return false;

  const host = getUrlHost(rawUrl);
  if (!host) return false; // 瑙ｆ瀽涓嶄簡鐨勪竴寰嬫斁琛岋紝閬垮厤璇激

  if (FIRST_PARTY_HOST_PATTERNS.some((re) => re.test(host))) return false;
  if (mode === 'strict') return true; // 涓ユ牸妯″紡锛氶潪 52frp 鍩熷悕涓€寰嬫嫤

  return THIRD_PARTY_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * 灞忚斀涓庣鍒版棤鍏崇殑绗笁鏂硅祫婧愩€? * 姣忎竴娆¤法娲嬭姹傞兘鏄竴涓彲鑳芥嫋鍨灞忕殑澶辫触鐐癸紝鑳界爫灏辩爫銆? */
async function installResourceBlocker(page, mode) {
  if (mode === 'off') {
    console.log('[缃戠粶] 绗笁鏂硅祫婧愬睆钄斤細宸插叧闂?);
    return;
  }

  const blocked = { count: 0 };

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (shouldBlockUrl(url, mode)) {
      blocked.count += 1;
      route.abort().catch(() => {});
      return;
    }
    route.continue().catch(() => {});
  });

  console.log(`[缃戠粶] 绗笁鏂硅祫婧愬睆钄斤細宸插惎鐢?(mode=${mode})`);
  page.once('close', () => {
    if (blocked.count > 0) {
      console.log(`[缃戠粶] 鏈疆鍏辨嫤鎴?${blocked.count} 涓涓夋柟璇锋眰`);
    }
  });
}

/** 鍏抽棴娴忚鍣ㄧ紦瀛橈紝閬垮厤閲嶈瘯鏃跺弽澶嶆嬁鍒?CDN 缂撳瓨鐨勫悓涓€涓敊璇搷搴?*/
async function setBrowserCacheDisabled(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    return true;
  } catch (error) {
    console.log(`[缃戠粶] 鏃犳硶鍏抽棴娴忚鍣ㄧ紦瀛橈紙${error.message}锛夛紝缁х画`);
    return false;
  }
}

function isLoginPageRenderedText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 20) return false;

  return LOGIN_PAGE_RENDER_PATTERNS.some(({ source, flags = '' }) => (
    new RegExp(source, flags).test(normalized)
  ));
}

/**
 * 杞绛夊緟鐧诲綍椤垫覆鏌撳畬鎴愩€? *
 * 鐩告瘮鏃х殑 `page.waitForFunction`锛? * - 涓€鏃︽娴嬪埌鍥炴簮閿欒绔嬪埢杩斿洖锛屼笉鍐嶇櫧绛夊埌瓒呮椂锛堟棫鐗堟瘡娆″偦绛?25s锛? * - 鏂囨娌″懡涓椂锛岄€€鍖栦负妫€鏌ヨ处鍙?瀵嗙爜杈撳叆妗嗘槸鍚﹀瓨鍦紙鍏滃簳鍒ゆ嵁锛屾姉鏀圭増锛? */
async function waitForLoginPageRendered(page, { timeoutMs, upstreamErrors }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (upstreamErrors && upstreamErrors.length > 0) {
      return { rendered: false, abortedByUpstream: true };
    }

    try {
      const textMatched = await page.evaluate((patterns) => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length <= 20) return false;

        return patterns.some(({ source, flags = '' }) => (
          new RegExp(source, flags).test(text)
        ));
      }, LOGIN_PAGE_RENDER_PATTERNS);

      if (textMatched) return { rendered: true };

      // 鍏滃簳锛氭枃妗堟敼浜嗘病鍏崇郴锛屽彧瑕佺櫥褰曡〃鍗曠殑缁撴瀯鍦紝灏辫涓洪〉闈㈠凡缁忓彲鐢?      const inputs = await page.evaluate(() => ({
        password: document.querySelectorAll('input[type="password"]').length,
        others: document.querySelectorAll('input:not([type="password"])').length,
      }));

      if (inputs.password > 0 && inputs.others > 0) {
        console.log('[椤甸潰] 鏂囨鏈懡涓紝浣嗗凡瀛樺湪璐﹀彿/瀵嗙爜杈撳叆妗?鈫?鍏滃簳鍒ゅ畾涓哄凡娓叉煋');
        return { rendered: true, viaFallback: true };
      }
    } catch {
      // 椤甸潰姝ｅ湪瀵艰埅锛宔valuate 浼氭姏閿欙紝涓嬩竴杞疆璇㈠啀鏉?    }

    await sleep(LOGIN_RENDER_POLL_MS);
  }

  return { rendered: false };
}

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

function cleanBodyLine(line) {
  return String(line || '')
    .replace(/\[MT\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBodyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(cleanBodyLine)
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

function parseTrafficAtLine(lines, index) {
  const line = lines[index] || '';
  const trafficMatch = line.match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
  if (trafficMatch) {
    return normalizeTrafficText(`${trafficMatch[1]}${trafficMatch[2]}`);
  }

  const numberOnly = line.match(/^([\d.]+)$/);
  const nextUnit = lines[index + 1]?.match(/^(TB|GB|MB|KB|B)$/i);
  if (numberOnly && nextUnit) {
    return normalizeTrafficText(`${numberOnly[1]}${nextUnit[1]}`);
  }

  const unitOnly = line.match(/^(TB|GB|MB|KB|B)$/i);
  const previousNumber = lines[index - 1]?.match(/^([\d.]+)$/);
  if (unitOnly && previousNumber) {
    return normalizeTrafficText(`${previousNumber[1]}${unitOnly[1]}`);
  }

  return null;
}

function lineMatchesAny(line, patterns) {
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(line);
    }
    return line.includes(pattern);
  });
}

function findNumberNearLabel(lines, labelPatterns, order = ['after', 'before']) {
  const offsets = [1, 2, 3];
  for (let index = 0; index < lines.length; index++) {
    if (!lineMatchesAny(lines[index], labelPatterns)) continue;

    for (const direction of order) {
      for (const offset of offsets) {
        const targetIndex = direction === 'after' ? index + offset : index - offset;
        const match = lines[targetIndex]?.match(/(\d+)\s*(?:澶﹟day|days)?\b/i);
        if (match) return Number(match[1]);
      }
    }
  }

  return null;
}

function findTrafficNearLabel(lines, labelPatterns, order = ['after', 'before']) {
  const offsets = [1, 2, 3];
  const candidates = [];

  for (let index = 0; index < lines.length; index++) {
    if (!lineMatchesAny(lines[index], labelPatterns)) continue;

    for (const direction of order) {
      for (const offset of offsets) {
        const targetIndex = direction === 'after' ? index + offset : index - offset;
        const traffic = parseTrafficAtLine(lines, targetIndex);
        if (traffic) {
          candidates.push(traffic);
        }
      }
      if (candidates.length > 0) break;
    }
  }

  return candidates;
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

  console.log(`[璋冭瘯] 宸蹭繚瀛橀〉闈㈣皟璇曟枃浠? ${base}.{png,html,txt,url.txt}`);
}

async function extractSignStats(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const lines = getBodyLines(bodyText);

  // 绱绛惧埌澶╂暟锛堝绉嶆牸寮忥級
  const daysMatch = bodyText.match(/绱绛惧埌\s*[:锛歖?\s*(\d+)\s*澶?) ||
                    bodyText.match(/绱\s*(\d+)\s*澶?) ||
                    bodyText.match(/绛惧埌\s*(\d+)\s*澶?);
  const daysBeforeLabel = getValueBeforeLabel(bodyText, '绱绛惧埌');
  const daysBeforeLabelMatch = daysBeforeLabel ? daysBeforeLabel.match(/(\d+)\s*澶?/) : null;
  const daysNearLabel = findNumberNearLabel(lines, [/绱(?:绛惧埌|Check-in)/i], ['after', 'before']);
  
  // 绱绛惧埌鑾峰緱鐨勬祦閲忥紙浼樺厛鍖归厤锛?  const totalRewardMatch = bodyText.match(/绱绛惧埌\s*[:锛歖?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i) ||
                          bodyText.match(/绛惧埌鑾峰緱\s*[:锛歖?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i) ||
                          bodyText.match(/绱\s*[:锛歖?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i);
  const rewardBeforeLabel = getValueBeforeLabel(bodyText, '绛惧埌鑾峰緱');
  const rewardBeforeLabelMatch = rewardBeforeLabel ? rewardBeforeLabel.match(/([\d.]+\s*(?:TB|GB|MB|KB|B))/i) : null;
  const rewardNearLabel = findTrafficNearLabel(lines, [/^(?:绛惧埌鑾峰緱|Check-in鑾峰緱)$/i], ['before', 'after'])[0];

  const totalSignDays = daysMatch ? Number(daysMatch[1]) : (daysBeforeLabelMatch ? Number(daysBeforeLabelMatch[1]) : daysNearLabel);
  const totalRewardText = normalizeTrafficText(totalRewardMatch ? totalRewardMatch[1] : (rewardBeforeLabelMatch ? rewardBeforeLabelMatch[1] : rewardNearLabel));

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
  const lines = getBodyLines(bodyText);

  const todayRewardMatch = bodyText.match(/鏈(?:绛惧埌|Check-in)鑾峰緱\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i);
  const todayRewardNearLabel = findTrafficNearLabel(lines, [/鏈(?:绛惧埌|Check-in)鑾峰緱/i], ['after', 'before'])[0];
  const remainingCandidates = [
    ...Array.from(bodyText.matchAll(/([\d.]+\s*(?:TB|GB|MB|KB|B))\s*鍓╀綑娴侀噺/ig)).map((match) => match[1]),
    ...Array.from(bodyText.matchAll(/鍓╀綑娴侀噺\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/ig)).map((match) => match[1]),
    ...findTrafficNearLabel(lines, [/鍓╀綑(?:娴侀噺|Traffic)/i], ['before', 'after']),
  ];

  const todayRewardText = todayRewardMatch ? todayRewardMatch[1].replace(/\s+/g, '') : todayRewardNearLabel;
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
        const text = (document.body?.innerText || '').replace(/\[MT\]/g, '');
        return (
          /鏈(?:绛惧埌|Check-in)鑾峰緱/i.test(text) &&
          /鍓╀綑(?:娴侀噺|Traffic)/i.test(text)
        );
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

  console.log('[涓婚〉] 棣栨鎻愬彇缁熻涓嶅畬鏁达紝鍒锋柊涓汉涓婚〉鍚庨噸璇?..');

  if (dashboardUrl) {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForDashboardStats(page);
    stats = await extractDashboardStats(page);
  }

  if (stats.todayRewardBytes && stats.remainingBytes) {
    return stats;
  }

  console.log('[涓婚〉] 浠〃鐩樹粛鏈彁鍙栧畬鏁达紝缁х画浣跨敤褰撳墠鍙緱鏁版嵁');
  return stats;
}

/**
 * 鐢熸垚绛惧埌缁撴灉鏂囨銆? *
 * @param {'success'|'already'} kind
 *   success 鈥斺€?鐢辨湰娆¤繍琛屽畬鎴愮鍒? *   already 鈥斺€?鑴氭湰鐐圭鍒颁箣鍓嶄粖鏃ョ鍒板氨宸插畬鎴愶紙鐢ㄦ埛鎵嬪姩绛剧殑锛屾垨褰撳ぉ鏇存棭鐨勪竴娆¤繍琛岀鐨勶級
 */
function buildResultTemplate(signStats, dashboardStats, kind = 'success') {
  const days = Number.isFinite(signStats?.totalSignDays) ? signStats.totalSignDays : '鏈彇鍒?;
  const todayReward = Number.isFinite(dashboardStats?.todayRewardBytes) && dashboardStats.todayRewardBytes > 0
    ? formatTrafficCompact(dashboardStats.todayRewardBytes)
    : '鏈彇鍒?;
  const totalReward = signStats?.totalRewardText ? signStats.totalRewardText.replace(/B$/, '') : '鏈彇鍒?;
  const remaining = dashboardStats?.remainingText ? dashboardStats.remainingText.replace(/B$/, '') : '鏈彇鍒?;

  const isAlready = kind === 'already';

  const lines = [
    isAlready ? '52frp浠婃棩宸茬鍒帮紙鏃犻渶閲嶅绛惧埌锛? : '52frp绛惧埌鎴愬姛',
    '',
    `绛惧埌澶╂暟锛?{days} 澶ー,
    `鏈鑾峰緱锛?{todayReward}`,
    `绱鑾峰緱锛?{totalReward}`,
    `鍓╀綑娴侀噺锛?{remaining}`,
  ];

  if (isAlready) {
    lines.push('', '绛惧埌鏂瑰紡锛氭湰娆¤繍琛屽墠宸插畬鎴愶紙鎵嬪姩绛惧埌鎴栧綋澶╂洿鏃╃殑涓€娆¤繍琛岋級锛岃剼鏈湭閲嶅绛惧埌');
  } else {
    lines.push('', '绛惧埌鏂瑰紡锛氭湰娆¤繍琛岃嚜鍔ㄧ鍒版垚鍔?);
  }

  return lines.join('\n');
}

/** 浠庛€屽凡绛惧埌銆嶅垽瀹氱殑鏉ユ簮鎻忚堪閲岋紝鍒ゆ柇杩欎竴澶╁埌搴曟槸涓嶆槸鏈杩愯鎵嶇涓婄殑 */
function resolveSignKind(signInfo) {
  return /宸茬粡绛惧埌|宸茬鍒?i.test(String(signInfo || '')) ? 'already' : 'success';
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
 * 妫€娴嬪苟瀹屾垚婊戝潡楠岃瘉
 *
 * 甯歌婊戝潡绫诲瀷锛? * - 鑷畾涔夋嫋鍔ㄦ粦鍧? .drag_verify, .dv_handler (52frp 浣跨敤杩欑)
 * - TencentCaptcha: .tcaptcha, #tcaptcha
 * - GeeTest: .geetest_slider, ._geetest_slide_handle
 * - Aliyun: #aliyun-captcha
 */
async function handleSliderVerification(page, timeoutMs = 30_000) {
  console.log('[婊戝潡] 妫€娴嬫粦鍧楅獙璇?..');

  // 绛夊緟婊戝潡鍏冪礌鍑虹幇
  let sliderBox = null;
  let sliderHandle = null;

  // 浼樺厛妫€娴?52frp 浣跨敤鐨勬粦鍧楃被鍨?  const sliderPatterns = [
    { container: '.drag_verify', handler: '.dv_handler' },  // 52frp 绫诲瀷
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
        console.log(`[婊戝潡] 鎵惧埌婊戝潡瀹瑰櫒: ${pattern.container}`);

        // 灏濊瘯鎵炬妸鎵?        if (pattern.handler) {
          const handleLocator = sliderBox.locator(pattern.handler);
          if (await handleLocator.count() > 0) {
            sliderHandle = handleLocator.first();
            console.log(`[婊戝潡] 鎵惧埌婊戝潡鎶婃墜: ${pattern.handler}`);
          }
        }

        // 濡傛灉娌℃壘鍒版寚瀹氭妸鎵嬶紝灏濊瘯甯歌鎶婃墜閫夋嫨鍣?        if (!sliderHandle) {
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
              console.log(`[婊戝潡] 鎵惧埌婊戝潡鎶婃墜: ${hSel}`);
              break;
            }
          }
        }

        // 濡傛灉杩樻病鎵惧埌锛屽皾璇曚粠瀹瑰櫒鐩存帴鎷栧姩
        if (!sliderHandle) {
          sliderHandle = sliderBox;
          console.log('[婊戝潡] 浣跨敤瀹瑰櫒鏈韩浣滀负鎷栧姩鐩爣');
        }

        break;
      }
    } catch {
      continue;
    }
  }

  if (!sliderBox || await sliderBox.count() === 0) {
    console.log('[婊戝潡] 鏈娴嬪埌婊戝潡锛屽彲鑳戒笉闇€瑕侀獙璇?);
    return { handled: false, reason: 'no_slider_detected' };
  }

  // 鑾峰彇婊戝潡浣嶇疆
  const boxBounds = await sliderBox.boundingBox();
  if (!boxBounds) {
    return { handled: false, reason: 'cannot_get_bounds' };
  }

  console.log(`[婊戝潡] 婊戝潡浣嶇疆: x=${boxBounds.x.toFixed(1)}, y=${boxBounds.y.toFixed(1)}, w=${boxBounds.width}, h=${boxBounds.height}`);

  // 璁＄畻鎷栧姩璺濈鍜岃捣鐐?  let startX, startY, endX, endY;

  if (sliderHandle) {
    const handleBounds = await sliderHandle.boundingBox();
    if (handleBounds) {
      // 浠庢妸鎵嬩腑蹇冨紑濮?      startX = handleBounds.x + handleBounds.width / 2;
      startY = handleBounds.y + handleBounds.height / 2;
      // 鎷栧姩鍒板鍣ㄦ渶鍙充晶锛堢‘淇濇嫋鍒板簳锛屽鐣?5px 鍐椾綑锛?      endX = boxBounds.x + boxBounds.width - 5;
      endY = startY;
      console.log(`[婊戝潡] 鎶婃墜浣嶇疆: x=${handleBounds.x.toFixed(1)}, y=${handleBounds.y.toFixed(1)}`);
    } else {
      // 鏃犳硶鑾峰彇鎶婃墜浣嶇疆锛屼娇鐢ㄥ鍣?      startX = boxBounds.x + 20;
      startY = boxBounds.y + boxBounds.height / 2;
      endX = boxBounds.x + boxBounds.width - 5;  // 鎷栧埌鏈€鍙宠竟
      endY = startY;
    }
  } else {
    startX = boxBounds.x + 20;
    startY = boxBounds.y + boxBounds.height / 2;
    endX = boxBounds.x + boxBounds.width - 5;  // 鎷栧埌鏈€鍙宠竟
    endY = startY;
  }

  console.log(`[婊戝潡] 鎷栧姩璺緞: (${startX.toFixed(1)}, ${startY.toFixed(1)}) 鈫?(${endX.toFixed(1)}, ${endY.toFixed(1)})`);

  // 浣跨敤 Playwright 鐨勭湡瀹為紶鏍囦簨浠惰繘琛屾嫋鍔?  // 鍏抽敭锛氬繀椤讳娇鐢?page.mouse API锛屼笉鑳界敤 JS 妯℃嫙浜嬩欢
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.waitForTimeout(150);

  // 鍒嗘绉诲姩锛屾ā鎷熶汉绫昏涓猴紙鏈夎交寰姈鍔級
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // 娣诲姞闅忔満鍨傜洿鎶栧姩妯℃嫙浜烘墜涓嶇ǔ
    const jitterY = (Math.random() - 0.5) * 4;
    const currentX = startX + (endX - startX) * progress;
    const currentY = startY + jitterY;

    await page.mouse.move(currentX, currentY);
    // 姣忔闂撮殧妯℃嫙浜虹被鎿嶄綔閫熷害锛?0-80ms锛?    await page.waitForTimeout(40 + Math.random() * 40);
  }

  await page.mouse.up();

  console.log('[婊戝潡] 鎷栨嫿瀹屾垚锛岀瓑寰呴獙璇佺粨鏋?..');
  await page.waitForTimeout(2000);

  // 妫€鏌ユ粦鍧楁槸鍚︽秷澶辨垨楠岃瘉鎴愬姛
  const stillVisible = await sliderBox.count().catch(() => 0);
  if (stillVisible === 0) {
    console.log('[婊戝潡] 婊戝潡宸叉秷澶憋紝楠岃瘉鎴愬姛');
    return { handled: true, success: true };
  }

  // 妫€鏌ユ粦鍧楁槸鍚︽樉绀轰负閫氳繃鐘舵€侊紙渚嬪杩涘害鏉″凡婊★級
  try {
    const progressBar = sliderBox.locator('.dv_progress_bar, .progress_bar, [class*="progress"]');
    if (await progressBar.count() > 0) {
      const progressWidth = await progressBar.first().evaluate(el => {
        const style = window.getComputedStyle(el);
        return parseFloat(style.width) || el.offsetWidth;
      });
      if (progressWidth > boxBounds.width * 0.8) {
        console.log(`[婊戝潡] 杩涘害鏉″凡婊?(${progressWidth}px)锛岄獙璇佹垚鍔焋);
        return { handled: true, success: true };
      }
    }
  } catch {}

  // 妫€鏌ユ垚鍔熸彁绀?  const successToast = await page.locator('.el-message--success, .success, [class*="success"]').count();
  if (successToast > 0) {
    console.log('[婊戝潡] 妫€娴嬪埌鎴愬姛鎻愮ず');
    return { handled: true, success: true };
  }

  console.log('[婊戝潡] 婊戝潡浠嶇劧鏄剧ず锛屽皾璇曢噸璇?..');
  return { handled: true, success: false, reason: 'slider_still_visible' };
}

async function clickLoginButton(page) {
  console.log('[鐧诲綍] 鏌ユ壘鐧诲綍鎸夐挳...');

  const buttonName = /^(鐧诲綍|Login)$/i;
  const strategies = [
    { name: 'role鎸夐挳', locator: page.getByRole('button', { name: buttonName }) },
    { name: 'button鏂囨湰', locator: page.locator('button').filter({ hasText: buttonName }) },
    { name: 'Element Plus涓绘寜閽?, locator: page.locator('.el-button.el-button--primary').filter({ hasText: buttonName }) },
  ];

  for (const strategy of strategies) {
    const count = await strategy.locator.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = strategy.locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;

      const text = await candidate.innerText().catch(() => '');
      console.log(`[鐧诲綍] 鎵惧埌鎸夐挳 (${strategy.name}): "${text.trim()}"`);
      await candidate.click();
      console.log('[鐧诲綍] 宸茬偣鍑荤櫥褰曟寜閽?);
      return { clicked: true, strategy: strategy.name, text: text.trim() };
    }
  }

  console.log('[鐧诲綍] 鏈壘鍒扮櫥褰曟寜閽?);
  return { clicked: false, reason: 'login_button_not_found' };
}

/**
 * 绛夊緟绛惧埌椤电湡姝ｆ覆鏌撳嚭鍙垽瀹氱殑鍐呭銆? *
 * 鍙瓑 networkidle + 鍥哄畾 sleep 鏄笉澶熺殑锛氳法澧冮摼璺笂椤甸潰甯稿父鍙覆鏌撲竴鍗婏紝
 * 姝ゆ椂銆屼笂娆＄鍒版棩鏈熴€嶃€岀珛鍗崇鍒版寜閽€嶉兘杩樻病鏈夛紝鍚庣画鍒ゅ畾灏辨槸鍦ㄦ畫缂烘暟鎹笂鍋氬垽鏂? * 锛?026-09-19 鐨勮鎶ユ鏄繖涔堟潵鐨勶級銆傝繖閲屾樉寮忕瓑鍒颁簩鑰呬箣涓€鍑虹幇涓烘銆? */
async function waitForSignPageReady(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => ({
        text: document.body?.innerText || '',
        hasSignButton: [...document.querySelectorAll('button')].some((b) =>
          /绔嬪嵆\s*(?:绛惧埌|Check-in)/i.test(String(b.textContent || '').trim())
        ),
      }));

      if (/涓婃(?:绛惧埌|Check-in)\s*[:锛歖?\s*\d/i.test(state.text) || state.hasSignButton) {
        return { ready: true };
      }
    } catch {
      // 椤甸潰姝ｅ湪瀵艰埅锛屼笅涓€杞啀鏉?    }

    await sleep(500);
  }

  return { ready: false };
}

/**
 * 绛夊緟鐧诲綍鎴愬姛
 */
async function waitForLoginSuccess(page, timeoutMs = 30_000) {
  console.log('[鐧诲綍] 绛夊緟鐧诲綍瀹屾垚...');

  try {
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        // 鐧诲綍鎴愬姛鍚?URL 浼氬彉鍖栵紝涓嶅啀鍖呭惈 /auth/login
        return url.includes('/user/') && !url.includes('/auth/login');
      },
      { timeout: timeoutMs }
    );
    console.log('[鐧诲綍] URL 宸插彉鍖栵紝鐧诲綍鎴愬姛');
    return true;
  } catch {
    // 妫€鏌ユ槸鍚︽湁閿欒鎻愮ず
    const errorToast = await page.locator('.el-message--error, .error, [class*="error"]').count();
    if (errorToast > 0) {
      const errorText = await page.locator('.el-message--error').first().innerText().catch(() => '鏈煡閿欒');
      console.log(`[鐧诲綍] 閿欒鎻愮ず: ${errorText}`);
      return false;
    }

    console.log('[鐧诲綍] 瓒呮椂锛屾湭妫€娴嬪埌鐧诲綍鎴愬姛');
    return false;
  }
}

/**
 * 妫€鏌ユ槸鍚﹀凡绛惧埌銆? *
 * 鏇剧粡韪╄繃鐨勫潙锛?026-09-19锛夛細`successPatterns` 閲岀殑銆岀鍒版垚鍔熴€嶆槸**缁撴灉鎻愮ず**锛? * 涓嶆槸**鐘舵€佽瘉鎹?*銆傜鍒伴〉鍝€曟病绛惧埌锛岄〉闈笂涔熷彲鑳藉嚭鐜拌繖鍥涗釜瀛楋紙娈嬬己娓叉煋鐨勯〉闈€? * 璇存槑鏂囨銆佸巻鍙茶褰曠瓑閮戒細鍛戒腑锛夈€傛妸瀹冪敤鍦ㄣ€岀偣鍑诲墠鏄惁宸茬鍒般€嶇殑鍒ゆ柇涓婏紝
 * 浼氳鑴氭湰璁や负浠婂ぉ宸茬鍒拌€岃烦杩囩偣鍑?鈥斺€?缁撴灉鏄帹閫?宸茬鍒?浣嗗疄闄呮牴鏈病绛俱€? *
 * 鍥犳鍒ゅ畾鍒嗕袱绾э細
 * - reliable锛堢‖璇佹嵁锛夛細涓婃绛惧埌鏃ユ湡 == 浠婂ぉ銆侀〉闈㈡槑纭啓銆屾偍浠婂ぉ宸茬粡绛惧埌杩囦簡銆嶃€? *   鎺ュ彛杩斿洖宸茬鍒?鈥斺€?鍙湁杩欎簺鑳戒綔涓恒€屼粖澶╁凡绛惧埌銆嶇殑缁撹
 * - 杞瘉鎹細鎸夐挳绂佺敤/涓嶅彲瑙併€佸嚭鐜般€岀鍒版垚鍔熴€嶇瓑妯＄硦鏂囨 鈥斺€?鍙兘鍙槸椤甸潰娌℃覆鏌撳畬锛? *   涓嶈兘鎹璺宠繃绛惧埌锛屽繀椤荤户缁蛋鐐瑰嚮娴佺▼锛岃绛惧埌鎺ュ彛缁欏嚭鏈€缁堢瓟妗? *
 * @param {Object} [options]
 * @param {boolean} [options.allowSuccessPatterns=false]
 *   鏄惁鎶娿€岀鍒版垚鍔熴€嶃€屾伃鍠滆幏寰椼€嶈涓哄凡绛惧埌銆傚彧鏈?*鐐瑰嚮绛惧埌涔嬪悗**鎵嶅簲寮€鍚€? */
async function checkSignedToday(page, options = {}) {
  const { allowSuccessPatterns = false } = options;

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalizedBodyText = cleanBodyLine(bodyText);

  // 纭瘉鎹?1锛氫笂娆＄鍒版棩鏈熷氨鏄粖澶╋紙鏈€鍙潬锛?  const today = getTodaySignDate();
  const lastSignMatch = normalizedBodyText.match(/涓婃(?:绛惧埌|Check-in)\s*[:锛歖?\s*(\d{4}-\d{2}-\d{2}|\d{4}\.\d{2}\.\d{2}|\d{2}-\d{2}|\d{2}\.\d{2})/i);
  if (lastSignMatch) {
    let lastSignDate = lastSignMatch[1];
    // 澶勭悊涓嶅悓鏃ユ湡鏍煎紡
    if (lastSignDate.length === 5) {
      // MM-DD 鎴?MM.DD 鏍煎紡锛岄渶瑕佽ˉ骞翠唤
      const year = new Date().toLocaleDateString('en-CA', { timeZone: SIGN_DATE_TIMEZONE }).split('-')[0];
      lastSignDate = `${year}-${lastSignDate.replace('.', '-')}`;
    } else if (lastSignDate.includes('.')) {
      // YYYY.MM.DD 鏍煎紡锛岃浆鎹负 YYYY-MM-DD
      lastSignDate = lastSignDate.replace('.', '-').replace('.', '-');
    }
    if (lastSignDate === today) {
      console.log(`[绛惧埌鍒ゆ柇] 涓婃绛惧埌鏃ユ湡涓轰粖澶?(${today})锛屽垽鏂负宸茬鍒帮紙纭瘉鎹級`);
      return { signed: true, reliable: true, pattern: `涓婃绛惧埌鏃ユ湡: ${today}` };
    }

    // 鏈夋棩鏈熶絾涓嶆槸浠婂ぉ 鈫?鏄庣‘鏈鍒帮紝杩欐槸纭瘉鎹紝鍙互缁堢粨鍒ゆ柇
    console.log(`[绛惧埌鍒ゆ柇] 涓婃绛惧埌鏃ユ湡涓?${lastSignDate}锛屼笉鏄粖澶?(${today})`);
  }

  // 纭瘉鎹?2锛氶〉闈㈡槑纭啓浜嗐€屼粖澶╁凡缁忕鍒拌繃銆?  const explicitPatterns = [
    '鎮ㄤ粖澶╁凡缁忕鍒拌繃浜?,
    '浠婂ぉ宸茬粡绛惧埌杩囦簡',
    '鎮ㄤ粖澶╁凡缁廋heck-in杩囦簡',
    '浠婂ぉ宸茬粡Check-in杩囦簡',
  ];
  for (const pattern of explicitPatterns) {
    if (normalizedBodyText.includes(pattern)) {
      return { signed: true, reliable: true, pattern: `椤甸潰鎻愮ず: ${pattern}` };
    }
  }

  // 杞瘉鎹細缁撴灉绫绘彁绀烘枃妗堛€傚彧鍦ㄧ偣鍑荤鍒颁箣鍚庢墠璁わ紙allowSuccessPatterns锛?  if (allowSuccessPatterns) {
    const successPatterns = ['绛惧埌鎴愬姛', '鎭枩鑾峰緱'];
    for (const pattern of successPatterns) {
      if (normalizedBodyText.includes(pattern)) {
        return { signed: true, reliable: false, pattern: `鎴愬姛鎻愮ず: ${pattern}` };
      }
    }
  }

  // 妫€娴嬬鍒版寜閽槸鍚﹀瓨鍦ㄤ笖鍙
  const signButton = page.getByRole('button', { name: /绔嬪嵆(?:绛惧埌|Check-in)/i });
  const buttonVisible = await signButton.isVisible().catch(() => false);
  const buttonCount = await signButton.count().catch(() => 0);
  const buttonEnabled = buttonCount > 0 ? await signButton.first().isEnabled().catch(() => true) : false;

  if (buttonVisible && buttonCount > 0 && buttonEnabled) {
    // 绛惧埌鎸夐挳鍙涓斿彲鐐?鈫?鏈鍒帮紙纭瘉鎹級
    console.log('[绛惧埌鍒ゆ柇] 妫€娴嬪埌銆岀珛鍗崇鍒般€嶆寜閽彲瑙侊紝鍒ゆ柇涓烘湭绛惧埌');
    return { signed: false, reliable: true };
  }

  if (buttonVisible && buttonCount > 0 && !buttonEnabled) {
    console.log('[绛惧埌鍒ゆ柇] 绛惧埌鎸夐挳宸茬鐢紝鐤戜技宸茬鍒帮紙杞瘉鎹紝浠嶉渶鎺ュ彛纭锛?);
    return { signed: true, reliable: false, pattern: '绛惧埌鎸夐挳宸茬鐢? };
  }

  // 绛惧埌鎸夐挳涓嶅彲瑙佹垨涓嶅瓨鍦?  if (normalizedBodyText.includes('宸茬鍒?) || normalizedBodyText.includes('宸茬粡绛惧埌') || normalizedBodyText.includes('浠婃棩宸茬')) {
    console.log('[绛惧埌鍒ゆ柇] 绛惧埌鎸夐挳涓嶅彲瑙侊紝椤甸潰鏄剧ず宸茬鍒扮姸鎬侊紙杞瘉鎹紝浠嶉渶鎺ュ彛纭锛?);
    return { signed: true, reliable: false, pattern: '鎸夐挳涓嶅彲瑙佷笖椤甸潰鏄剧ず宸茬鍒? };
  }

  // 鎸夐挳涓嶅彲瑙佷笖鏃犳槑纭姸鎬侊細澶氬崐鏄〉闈㈣繕娌℃覆鏌撳畬锛屽睘浜庛€屼笉鐭ラ亾銆嶈€岄潪銆屽凡绛惧埌銆?  console.log('[绛惧埌鍒ゆ柇] 鏈彇鍒颁换浣曞凡绛惧埌璇佹嵁锛堥〉闈㈠彲鑳藉皻鏈覆鏌撳畬鏁达級锛屼繚瀹堝垽鏂负鏈鍒?);
  return { signed: false, reliable: false };
}

/**
 * 鍏抽棴鍙兘闃绘尅鐐瑰嚮鐨勫叕鍛婇伄缃╁眰
 *
 * 52frp 鐧诲綍鍚庡彲鑳戒細鏄剧ず鍏ㄥ睆鍏憡寮圭獥锛屾嫤鎴墍鏈夌偣鍑讳簨浠躲€? * 姝ゅ嚱鏁版娴嬪苟鍏抽棴杩欑被閬僵灞傦紝纭繚鍚庣画鎿嶄綔鑳芥甯告墽琛屻€? */
async function dismissBlockingOverlays(page) {
  // 妫€娴嬪父瑙佺殑閬僵灞傞€夋嫨鍣?  const overlaySelectors = [
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
      console.log(`[閬僵] 妫€娴嬪埌閬僵灞? ${selector}`);

      // 灏濊瘯澶氱鏂瑰紡鍏抽棴
      const closeStrategies = [
        // 1. 鐐瑰嚮閬僵灞傚唴鐨勫叧闂寜閽?        { name: '鎴戠煡閬撲簡', locator: overlay.locator('button:has-text("鎴戠煡閬撲簡")').first() },
        { name: '纭畾', locator: overlay.locator('button:has-text("纭畾")').first() },
        { name: '鍏抽棴', locator: overlay.locator('button:has-text("鍏抽棴")').first() },
        { name: 'OK', locator: overlay.locator('button:has-text("OK")').first() },
        { name: '鍏抽棴鍥炬爣', locator: overlay.locator('.el-dialog__close, [aria-label="Close"], .close-btn').first() },
      ];

      for (const strategy of closeStrategies) {
        const btnCount = await strategy.locator.count().catch(() => 0);
        if (btnCount > 0) {
          console.log(`[閬僵] 灏濊瘯鐐瑰嚮: ${strategy.name}`);
          await strategy.locator.click().catch(() => {});
          await page.waitForTimeout(500);

          // 妫€鏌ラ伄缃╁眰鏄惁娑堝け
          const remaining = await overlay.count().catch(() => 0);
          if (remaining === 0) {
            console.log(`[閬僵] 宸查€氳繃 ${strategy.name} 鍏抽棴`);
            return true;
          }
        }
      }

      // 2. 灏濊瘯 Escape 閿?      console.log('[閬僵] 灏濊瘯 Escape 閿?);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const afterEscape = await overlay.count().catch(() => 0);
      if (afterEscape === 0) {
        console.log('[閬僵] 宸查€氳繃 Escape 鍏抽棴');
        return true;
      }

      // 3. 鏈€鍚庢墜娈碉細寮哄埗绉婚櫎 DOM 鍏冪礌
      console.log('[閬僵] 寮哄埗绉婚櫎閬僵灞?DOM');
      await overlay.evaluate(el => el.remove()).catch(() => {});
      return true;
    }
  }

  return false;
}

/**
 * 鏌ユ壘骞剁偣鍑荤鍒版寜閽? */
async function clickSignButton(page) {
  console.log('[绛惧埌] 鏌ユ壘绛惧埌鎸夐挳...');

  // 鍏堝叧闂彲鑳介樆鎸＄偣鍑荤殑閬僵灞?  await dismissBlockingOverlays(page);

  // 澶氱鏂瑰紡鏌ユ壘鎸夐挳
  const strategies = [
    { name: 'role鎸夐挳', locator: page.getByRole('button', { name: '绔嬪嵆绛惧埌' }) },
    { name: '鏂囨湰杩囨护', locator: page.locator('button').filter({ hasText: '绔嬪嵆绛惧埌' }) },
    { name: 'primary鎸夐挳', locator: page.locator('button.el-button--primary').first() },
    { name: 'sign绫绘寜閽?, locator: page.locator('button[class*="sign"]') },
    { name: '浠绘剰绛惧埌鏂囨湰', locator: page.locator('button, [role="button"]').filter({ hasText: '绛惧埌' }) },
  ];

  for (const strategy of strategies) {
    try {
      const count = await strategy.locator.count();
      if (count > 0) {
        const button = strategy.locator.first();
        const text = await button.innerText().catch(() => '');
        console.log(`[绛惧埌] 鎵惧埌鎸夐挳 (${strategy.name}): "${text.trim()}"`);

        // 灏濊瘯澶氱鐐瑰嚮鏂瑰紡锛屼紭鍏堜娇鐢?Playwright 鐪熷疄鎸囬拡鐐瑰嚮銆?        // 52frp 鐨勭鍒颁細渚濊禆椤甸潰鍏堣幏鍙?slider-token锛屽啀鐢辩湡瀹炴寜閽簨浠舵彁浜ゃ€?        // JS evaluate click() 鍦?GitHub Actions 涓浘瑙﹀彂 /user/sign锛屼絾鏈嶅姟绔繑鍥?        // 鈥滅鍒板け璐ワ紝璇风◢鍚庨噸璇曗€濓紝鎵€浠ュ彧鑳戒綔涓烘渶鍚?fallback銆?        let clicked = false;
        
        // 鏂瑰紡1: 鐪熷疄鐐瑰嚮
        try {
          await button.scrollIntoViewIfNeeded().catch(() => {});
          await button.click({ timeout: 30_000 });
          console.log('[绛惧埌] 宸茬偣鍑荤鍒版寜閽紙鐪熷疄鐐瑰嚮锛?);
          clicked = true;
        } catch (e) {
          console.log('[绛惧埌] 鐪熷疄鐐瑰嚮澶辫触锛屽皾璇?force click:', e.message);
        }

        // 鏂瑰紡2: force click
        if (!clicked) {
          try {
            await button.click({ force: true });
            console.log('[绛惧埌] 宸茬偣鍑荤鍒版寜閽紙force妯″紡锛?);
            clicked = true;
          } catch (e) {
            console.log('[绛惧埌] force click 澶辫触锛屽皾璇?JS evaluate:', e.message);
          }
        }

        // 鏂瑰紡3: 鐩存帴璋冪敤 JavaScript click()锛屽彧浣滀负鏈€鍚庡厹搴?        if (!clicked) {
          try {
            await button.evaluate(el => el.click());
            console.log('[绛惧埌] 宸茬偣鍑荤鍒版寜閽紙JS evaluate锛?);
            clicked = true;
          } catch (e) {
            console.log('[绛惧埌] JS evaluate 澶辫触锛屽皾璇?dispatchEvent');
            // 鏂瑰紡4: dispatchEvent
            try {
              await button.dispatchEvent('click');
              console.log('[绛惧埌] 宸茬偣鍑荤鍒版寜閽紙dispatchEvent锛?);
              clicked = true;
            } catch (e2) {
              console.log('[绛惧埌] dispatchEvent 涔熷け璐?', e2.message);
            }
          }
        }

        return { clicked, buttonText: text.trim() };
      }
    } catch (e) {
      console.log(`[绛惧埌] 绛栫暐 ${strategy.name} 澶辫触: ${e.message}`);
    }
  }

  return { clicked: false };
}

/**
 * 绛夊緟绛惧埌缁撴灉
 */
async function waitForSignResult(page, timeoutMs = 30_000) {
  console.log('[绛惧埌] 绛夊緟绛惧埌缁撴灉...');

  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return (
          text.includes('鎮ㄤ粖澶╁凡缁忕鍒拌繃浜?) ||
          text.includes('浠婂ぉ宸茬粡绛惧埌杩囦簡') ||
          text.includes('绛惧埌鎴愬姛') ||
          text.includes('鎭枩') ||
          Boolean(document.querySelector('.el-message, .el-notification'))
        );
      },
      { timeout: timeoutMs }
    );
  } catch {
    // 缁х画妫€鏌ユ渶缁堢姸鎬?  }

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

    console.log(`[绛惧埌] 鎹曡幏绛惧埌璇锋眰: ${response.status()} ${response.url()}`);
    console.log(`[绛惧埌] 鍝嶅簲鍘熸枃锛堝墠500瀛楃锛? ${text.slice(0, 500)}`);
    if (json) {
      console.log(`[绛惧埌] 鍝嶅簲 JSON: ${JSON.stringify(json).slice(0, 500)}`);
      const message = json.message || json.msg || json.error || json.detail || json.info || json.result;
      if (message) {
        console.log(`[绛惧埌] 鎺ュ彛杩斿洖娑堟伅: ${message}`);
      }
    } else {
      console.log(`[绛惧埌] 鍝嶅簲鏃犳硶瑙ｆ瀽涓?JSON锛屽師鏂囧墠200瀛楃: ${text.slice(0, 200)}`);
    }

    return {
      seen: true,
      status: response.status(),
      url: response.url(),
      text,
      json,
    };
  } catch {
    console.log('[绛惧埌] 鏈崟鑾峰埌绛惧埌璇锋眰');
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

  if (/绛惧埌澶辫触|澶辫触|绋嶅悗閲嶈瘯|閿欒|error/i.test(raw)) {
    return { signed: false, reliable: true, pattern: '鎺ュ彛杩斿洖澶辫触' };
  }

  if (/浠婂ぉ宸茬粡绛惧埌杩囦簡|鎮ㄤ粖澶╁凡缁忕鍒拌繃浜唡宸茬鍒皘宸茬粡绛惧埌/i.test(raw)) {
    return { signed: true, reliable: true, pattern: '鎺ュ彛杩斿洖宸茬鍒? };
  }

  if (/绛惧埌鎴愬姛|鎴愬姛|鎭枩/i.test(raw)) {
    return { signed: true, reliable: true, pattern: '鎺ュ彛杩斿洖绛惧埌鎴愬姛' };
  }

  // 濡傛灉鍝嶅簲鐮佷负 200 涓旀湁 data 瀛楁锛屼笖鏃犳槑纭け璐ユ秷鎭紝瑙嗕负鍙兘鎴愬姛
  // 娉ㄦ剰锛氳繖閲屽師鏈鐢ㄤ簡鏈畾涔夌殑 `text` 鍙橀噺锛堝簲涓?raw锛夛紝浼氭姏 ReferenceError
  if (signRequest.status === 200 && json && json.data && !/澶辫触|error|閿欒|绋嶅悗閲嶈瘯/i.test(raw)) {
    console.log(`[绛惧埌] 妫€娴嬪埌 200 + data 瀛楁锛岃涓哄彲鑳芥垚鍔焋);
    return { signed: true, reliable: true, pattern: '鎺ュ彛杩斿洖 200 涓旀湁 data 瀛楁' };
  }

  return { signed: false, reliable: false };
}

/**
 * 绾祻瑙堝櫒绛惧埌涓诲嚱鏁? *
 * @param {Object} options
 * @param {string} options.username - 璐﹀彿
 * @param {string} options.password - 瀵嗙爜
 * @param {number} options.timeoutMs - 瓒呮椂鏃堕棿
 * @param {Object} options.launchOptions - Playwright 鍚姩閫夐」
 * @returns {Promise<{status: string, message: string, details?: Object}>}
 */
async function attemptCheckInOnce({
  username,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  launchOptions = {},
  round = 1,
}) {
  if (!username || !password) {
    const err = new Error('缂哄皯璐﹀彿鎴栧瘑鐮侊紝璇烽厤缃?FRP_USERNAME 鍜?FRP_PASSWORD');
    err.retryable = false;
    throw err;
  }

  const blockMode = resolveBlockThirdPartyMode();
  const debugLabel = (label) => `round${round}-${label}`;

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

  // 鐮嶆帀涓庣鍒版棤鍏崇殑绗笁鏂硅姹傦紝缂╁皬璺ㄥ閾捐矾涓婄殑澶辫触闈?  await installResourceBlocker(page, blockMode);

  // 鏀堕泦 JS 鎺у埗鍙伴敊璇紝鐢ㄤ簬璇婃柇 Vue SPA 娓叉煋澶辫触
  const jsErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      jsErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    jsErrors.push(`[pageerror] ${err.message}`);
  });

  const steps = [];
  let loginSuccess = false;
  let sliderHandled = false;
  let dashboardUrl = null;
  let dashboardStats = null;
  let beforeStats = null;

  /**
   * 鍔犺浇鐧诲綍椤靛苟绛夊緟 Vue SPA 瀹屾垚娓叉煋銆?   *
   * 鐩告瘮鏃х増鐨勪笁澶勬敼鍔細
   * 1. 鐩戝惉鍝嶅簲鐘舵€佺爜锛屽懡涓洖婧愰敊璇紙522/524/525 绛夛級绔嬪嵆鏀惧純鏈绛夊緟锛屼笉鍐嶅偦绛夎秴鏃?   * 2. 姣忔閲嶈瘯鍓嶆竻绌?cookie銆佸苟鍏抽棴娴忚鍣ㄧ紦瀛橈紝閬垮厤鍙嶅鎷垮埌 CDN 缂撳瓨鐨勫悓涓€涓敊璇搷搴?   * 3. 娓叉煋鍒ゆ嵁甯﹀厹搴曪紙瑙?waitForLoginPageRendered锛?   */
  async function loadLoginPageWithRetry(maxRetries = LOGIN_PAGE_MAX_ATTEMPTS) {
    /**
     * 涓や唤鏁扮粍锛岃亴璐ｄ笉鍚岋細
     * - upstreamErrorsAll锛氳法 attempt 绱Н锛岀敤浜庢渶缁堢殑鎶ラ敊璇︽儏
     *   鏈€鍚庝竴娆?attempt 寰堝彲鑳戒竴涓搷搴旈兘鏀朵笉鍒帮紙鏁翠釜椤甸潰鏍规湰娌″姞杞借捣鏉ワ級锛?     *   濡傛灉鍙敤褰撴鐨勬暟鎹紝鎶ラ敊閲屽氨浼氬嚭鐜般€岋紙鏈煡锛夈€嶁€斺€旀伆濂藉湪璇婃柇鏈€闇€瑕佷俊鎭殑鏃跺€欎涪鎺夌嚎绱€?     * - upstreamErrors锛氫粎褰撴 attempt锛岀敤浜?waitForLoginPageRendered 鐨勩€屾彁鍓嶄腑鏂瓑寰呫€?     *   蹇呴』姣忔娓呯┖锛屽惁鍒欎細鎶婁笂涓€娆＄殑閿欒鐘舵€佸甫鍒版柊涓€杞€?     */
    const upstreamErrorsAll = [];
    const upstreamErrors = [];

    const onResponse = (response) => {
      if (isUpstreamError(response.status())) {
        const entry = `${response.status()} ${getUrlPath(response.url())}`;
        upstreamErrors.push(entry);
        if (!upstreamErrorsAll.includes(entry)) upstreamErrorsAll.push(entry);
      }
    };
    page.on('response', onResponse);

    try {
      await setBrowserCacheDisabled(context, page);

      let sawUpstreamError = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        upstreamErrors.length = 0;

        if (attempt > 1) {
          const backoffMs = LOGIN_PAGE_BACKOFF_MS[attempt - 1]
            ?? LOGIN_PAGE_BACKOFF_MS[LOGIN_PAGE_BACKOFF_MS.length - 1];
          console.log(`[椤甸潰] 绗?${attempt} 娆￠噸璇曞姞杞界櫥褰曢〉锛堢瓑寰?${Math.round(backoffMs / 1000)}s锛?..`);
          await sleep(backoffMs);
          // 閲嶇疆鐜锛氭竻鎺変笂涓€杞殑 cookie锛岄厤鍚堜笂闈㈢殑鍏抽棴缂撳瓨锛岀‘淇濋噸鏂板彂璧风湡瀹炶姹?          await context.clearCookies().catch(() => {});
        }

        // 绗竴姝ワ細鍔犺浇椤甸潰 HTML
        let gotoOk = false;
        for (let gt = 1; gt <= LOGIN_GOTO_ATTEMPTS; gt++) {
          try {
            await page.goto(LOGIN_PAGE, {
              waitUntil: 'domcontentloaded',
              timeout: LOGIN_GOTO_TIMEOUT_MS,
            });
            gotoOk = true;
            break;
          } catch (gotoErr) {
            console.log(`[椤甸潰] goto 澶辫触 (灏濊瘯 ${gt}/${LOGIN_GOTO_ATTEMPTS}): ${String(gotoErr.message).split('\n')[0]}`);
            if (gt < LOGIN_GOTO_ATTEMPTS) await sleep(2000);
          }
        }

        if (!gotoOk) {
          if (attempt < maxRetries) continue;
          const err = new Error('鐧诲綍椤靛姞杞藉け璐ワ細澶氭 goto 鍧囧け璐ワ紙绔欑偣/CDN 涓嶅彲杈撅級');
          err.kind = 'upstream';
          throw err;
        }

        // 绗簩姝ワ細绛夊緟缃戠粶绌洪棽
        await page
          .waitForLoadState('networkidle', { timeout: LOGIN_NETWORKIDLE_TIMEOUT_MS })
          .catch(() => {});

        // 绗笁姝ワ細绛夊緟 Vue 娓叉煋锛堝懡涓洖婧愰敊璇細鎻愬墠杩斿洖锛?        const renderResult = await waitForLoginPageRendered(page, {
          timeoutMs: LOGIN_RENDER_TIMEOUT_MS,
          upstreamErrors,
        });

        if (renderResult.rendered) {
          console.log(`[椤甸潰] 鐧诲綍椤垫覆鏌撴垚鍔?(attempt ${attempt}/${maxRetries})`);
          await sleep(1000);
          return;
        }

        // 鏈覆鏌?鈥斺€?璁板綍璇婃柇淇℃伅骞堕噸璇?        const hitUpstream = upstreamErrors.length > 0;
        if (hitUpstream) sawUpstreamError = true;

        const bodyLen = (await page.locator('body').innerText().catch(() => '')).length;
        console.log(`[椤甸潰] 鐧诲綍椤垫湭娓叉煋 (body 鏂囨湰闀垮害=${bodyLen}, attempt ${attempt}/${maxRetries})`);

        if (hitUpstream) {
          console.log(
            `[椤甸潰] 涓婃父鍥炴簮閿欒 (鏈疆绱 ${upstreamErrorsAll.length} 鏉? 鍘婚噸鍓?): `
            + `${[...new Set(upstreamErrorsAll)].slice(0, 5).join(' | ')}`
          );
        } else if (jsErrors.length > 0) {
          console.log(`[椤甸潰] JS 閿欒 (${jsErrors.length} 鏉? 鍘婚噸鍓?): ${[...new Set(jsErrors)].slice(0, 5).join(' | ')}`);
        }

        if (attempt < maxRetries) continue;

        await saveDebugArtifacts(page, debugLabel(`login-not-rendered-attempt${attempt}`));

        if (sawUpstreamError) {
          const err = new Error(
            `绔欑偣/CDN 涓婃父鏁呴殰锛氱櫥褰曢〉璧勬簮杩斿洖 5xx锛?{[...new Set(upstreamErrorsAll)].slice(0, 3).join('; ') || '鏈煡'}锛夛紝绋嶅悗閲嶈瘯閫氬父鍙嚜鎰坄
          );
          err.kind = 'upstream';
          throw err;
        }

        const err = new Error(
          `椤甸潰缁撴瀯鍙兘宸插彉鍖栵細鐧诲綍椤垫湭娓叉煋涓旀湭妫€娴嬪埌璧勬簮閿欒锛圝S 閿欒: ${[...new Set(jsErrors)].slice(0, 3).join('; ') || '鏃?}锛塦
        );
        err.kind = 'structure';
        throw err;
      }
    } finally {
      page.off('response', onResponse);
    }
  }

  try {
    // 姝ラ 1: 鎵撳紑鐧诲綍椤碉紙鍚?Vue 娓叉煋妫€娴嬪拰鑷姩閲嶈瘯锛?    console.log('[1/5] 鎵撳紑鐧诲綍椤?..');
    steps.push('open_login');
    await loadLoginPageWithRetry();

    // 姝ラ 2: 杈撳叆璐﹀彿瀵嗙爜
    console.log('[2/5] 杈撳叆璐﹀彿瀵嗙爜...');
    steps.push('fill_credentials');

    // 澶氱鏂瑰紡鏌ユ壘杈撳叆妗嗭紙鏇寸ǔ鍋ワ級
    const usernameStrategies = [
      page.getByPlaceholder(/璐︽埛|鎵嬫満鍙穦閭|鐢ㄦ埛鍚峾璐﹀彿/),
      page.locator('input[type="text"]').first(),
      page.locator('input:not([type="password"])').first(),
      page.locator('input').first(),
    ];
    const passwordStrategies = [
      page.getByPlaceholder(/瀵嗙爜/),
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
      await saveDebugArtifacts(page, debugLabel('login-inputs-not-found'));
      throw new Error('鏈壘鍒扮櫥褰曡緭鍏ユ锛岄〉闈㈠彲鑳芥湭姝ｇ‘鍔犺浇');
    }

    await usernameInput.fill(username);
    await passwordInput.fill(password);
    console.log(`[杈撳叆] 璐﹀彿宸插～鍏ワ紝瀵嗙爜宸插～鍏);

    // 姝ラ 3: 鐐瑰嚮鐧诲綍骞跺鐞嗘粦鍧?    console.log('[3/5] 鐐瑰嚮鐧诲綍...');
    steps.push('click_login');

    const loginClickResult = await clickLoginButton(page);
    if (!loginClickResult.clicked) {
      await saveDebugArtifacts(page, 'login-button-not-found');
      throw new Error('鏈壘鍒扮櫥褰曟寜閽?);
    }

    // 绛夊緟涓€涓嬭婊戝潡鍙兘鍑虹幇
    await page.waitForTimeout(1500);

    // 妫€娴嬪苟澶勭悊婊戝潡
    const sliderResult = await handleSliderVerification(page, 30_000);
    sliderHandled = sliderResult.handled;

    if (sliderResult.handled && !sliderResult.success) {
      // 婊戝潡鎷栨嫿鍚庝粛鏈€氳繃锛屽彲鑳介渶瑕侀噸璇?      console.log('[婊戝潡] 绗竴娆℃嫋鎷芥湭閫氳繃锛屽皾璇曠浜屾...');

      // 鏈変簺婊戝潡闇€瑕佺瓑寰呴噸缃?      await page.waitForTimeout(1000);

      const retryResult = await handleSliderVerification(page, 20_000);
      if (retryResult.handled && !retryResult.success) {
        console.log('[婊戝潡] 閲嶈瘯浠嶆湭閫氳繃锛屽彲鑳介渶瑕佹墜鍔ㄤ粙鍏?);
      }
    }

    // 婊戝潡楠岃瘉閫氳繃鍚庯紝鍐嶆鐐瑰嚮鐧诲綍鎸夐挳瀹屾垚鐧诲綍
    if (sliderResult.handled && sliderResult.success) {
      console.log('[鐧诲綍] 婊戝潡楠岃瘉閫氳繃锛屽啀娆＄偣鍑荤櫥褰?..');
      const retryLoginClickResult = await clickLoginButton(page);
      if (!retryLoginClickResult.clicked) {
        await saveDebugArtifacts(page, debugLabel('login-button-not-found-after-slider'));
        throw new Error('婊戝潡楠岃瘉閫氳繃鍚庢湭鎵惧埌鐧诲綍鎸夐挳');
      }
      await page.waitForTimeout(2000);
    }

    // 绛夊緟鐧诲綍鎴愬姛
    loginSuccess = await waitForLoginSuccess(page, 20_000);

    if (!loginSuccess) {
      // 妫€鏌ユ槸鍚︿粛鍦ㄧ櫥褰曢〉
      const currentUrl = page.url();
      if (currentUrl.includes('/auth/login')) {
        // 鍑瘉闂閲嶈瘯澶氬皯娆￠兘娌＄敤锛岀洿鎺ョ粓姝紝鐪佷笅鍚庨潰鐨勬椂闂?        const err = new Error('鐧诲綍澶辫触锛氬彲鑳借处鍙峰瘑鐮侀敊璇垨婊戝潡楠岃瘉鏈€氳繃');
        err.retryable = false;
        err.kind = 'credentials';
        throw err;
      }
    }

    dashboardUrl = page.url();
    dashboardStats = await loadDashboardStats(page, dashboardUrl);

    // 姝ラ 4: 璺宠浆绛惧埌椤?    console.log('[4/5] 璺宠浆绛惧埌椤?..');
    steps.push('goto_sign');

    await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await waitForSignPageReady(page).then(({ ready }) => {
      if (!ready) {
        console.log('[绛惧埌] 璀﹀憡锛氱鍒伴〉鍏抽敭鍐呭鏈嚭鐜帮紝椤甸潰鍙兘鏈覆鏌撳畬鏁达紙鍒ゅ畾缁撴灉鍙俊搴︿笅闄嶏級');
      }
    });
    await page.waitForTimeout(1000);
    beforeStats = await extractSignStats(page);

    // 妫€鏌ユ槸鍚﹀凡绛惧埌
    const beforeCheck = await checkSignedToday(page);
    if (beforeCheck.signed && beforeCheck.reliable) {
      const template = buildResultTemplate(beforeStats, dashboardStats, 'already');
      console.log(`[绛惧埌] ${beforeCheck.pattern}`);
      console.log('[绛惧埌] 浠婃棩绛惧埌鍦ㄦ湰杞繍琛屼箣鍓嶅氨宸插瓨鍦紝鎸夈€屽凡绛惧埌銆嶄笂鎶?);
      return {
        status: 'already_signed',
        message: template,
        details: {
          steps,
          loginSuccess,
          sliderHandled,
          signStats: beforeStats,
          dashboardStats,
          template,
          signedBy: 'already',
          signKind: 'already',
        },
      };
    }

    if (beforeCheck.signed) {
      // 鍙湁杞瘉鎹紙鎸夐挳绂佺敤 / 椤甸潰鍑虹幇銆岀鍒版垚鍔熴€嶇瓑妯＄硦鏂囨锛夆€斺€?      // 寰堝彲鑳芥槸椤甸潰娌℃覆鏌撳畬鏁达紝涓嶈兘鎹璺宠繃绛惧埌锛屽惁鍒欎細璇姤銆屽凡绛惧埌銆嶈€屽疄闄呮紡绛俱€?      // 缁х画寰€涓嬭蛋鐐瑰嚮娴佺▼锛岀敱绛惧埌鎺ュ彛缁欏嚭鏈€缁堢粨璁恒€?      console.log(`[绛惧埌] 鐤戜技宸茬鍒颁絾璇佹嵁涓嶈冻锛?{beforeCheck.pattern}锛夛紝涓嶈烦杩囷紝缁х画灏濊瘯鐐瑰嚮绛惧埌`);
    }

    // 姝ラ 5: 鐐瑰嚮绛惧埌锛堝惈閲嶈瘯閫昏緫锛屽簲瀵?API 杩斿洖 "绛惧埌澶辫触锛岃绋嶅悗閲嶈瘯"锛?    console.log('[5/5] 鐐瑰嚮绛惧埌鎸夐挳...');
    steps.push('click_sign');

    const MAX_SIGN_RETRIES = 3;
    let signRequest = { seen: false };
    let afterCheck = { signed: false };
    let requestCheck = { signed: false };
    let afterStats = beforeStats;
    let signRetries = 0;

    while (signRetries < MAX_SIGN_RETRIES) {
      if (signRetries > 0) {
        console.log(`[绛惧埌] 绗?${signRetries + 1}/${MAX_SIGN_RETRIES} 娆￠噸璇曠鍒?..`);
        // 閲嶆柊鍔犺浇绛惧埌椤佃幏鍙栨柊鐨?slider_token
        await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await waitForSignPageReady(page).catch(() => ({ ready: false }));
        await page.waitForTimeout(1000);
        await dismissBlockingOverlays(page);
        // 閲嶆柊妫€鏌ユ槸鍚﹀凡绛惧埌锛堝悓鏍疯姹傜‖璇佹嵁锛氫笂涓€杞彧鏄偣鍑诲け璐ワ紝涓嶇瓑浜庡凡绛惧埌锛?        const retryBeforeCheck = await checkSignedToday(page);
        if (retryBeforeCheck.signed && retryBeforeCheck.reliable) {
          console.log(`[绛惧埌] 閲嶈瘯鏃跺彂鐜板凡绛惧埌: ${retryBeforeCheck.pattern}`);
          afterStats = await extractSignStats(page);
          const retryTemplate = buildResultTemplate(afterStats, dashboardStats, 'already');
          return {
            status: 'already_signed',
            message: retryTemplate,
            details: {
              steps,
              loginSuccess,
              sliderHandled,
              signStats: afterStats,
              dashboardStats,
              template: retryTemplate,
              signedBy: 'already',
              signKind: 'already',
            },
          };
        }
      }

      const signRequestPromise = waitForSignRequest(page);
      const clickResult = await clickSignButton(page);

      if (!clickResult.clicked) {
        if (signRetries + 1 < MAX_SIGN_RETRIES) {
          console.log('[绛惧埌] 鏈壘鍒扮鍒版寜閽紝灏嗛噸璇?..');
          signRetries++;
          continue;
        }
        const bodyText = await page.locator('body').innerText().catch(() => '');
        console.log('[绛惧埌] 椤甸潰鍐呭棰勮:', bodyText.substring(0, 500));
        throw new Error('鏈壘鍒扮鍒版寜閽?);
      }

      // 鐐瑰嚮鎴愬姛鍚庯紝妫€娴嬪苟澶勭悊鍙兘鍑虹幇鐨勭鍒版粦鍧楅獙璇?      console.log('[绛惧埌] 鍑嗗妫€娴嬬鍒版粦鍧?..');
      await page.waitForTimeout(1500);
      const signSliderResult = await handleSliderVerification(page, 20_000);
      console.log('[绛惧埌] 婊戝潡妫€娴嬪畬鎴? handled:', signSliderResult.handled, 'success:', signSliderResult.success);
      if (signSliderResult.handled) {
        console.log('[绛惧埌婊戝潡] 澶勭悊缁撴灉:', signSliderResult.success ? '楠岃瘉閫氳繃' : '楠岃瘉澶辫触');
        if (signSliderResult.success) {
          await page.waitForTimeout(2000);
          const stillHasSignButton = await page.getByRole('button', { name: '绔嬪嵆绛惧埌' }).count();
          if (stillHasSignButton > 0) {
            console.log('[绛惧埌] 婊戝潡楠岃瘉鍚庡啀娆＄偣鍑荤鍒版寜閽?..');
            await dismissBlockingOverlays(page);
            await page.getByRole('button', { name: '绔嬪嵆绛惧埌' }).first().click().catch(() => {});
            await page.waitForTimeout(1500);
          }
        }
      }

      await dismissBlockingOverlays(page);
      await page.waitForTimeout(1000);

      signRequest = await signRequestPromise;
      await waitForSignResult(page);

      // 鐐瑰嚮涔嬪悗鎵嶈鍙€岀鍒版垚鍔熴€嶈繖绫荤粨鏋滄彁绀烘枃妗堬紙姝ゆ椂瀹冪‘瀹炴槸鏈鎿嶄綔鐨勭粨鏋滐級
      afterCheck = await checkSignedToday(page, { allowSuccessPatterns: true });
      requestCheck = inferSignStateFromRequest(signRequest);
      afterStats = await extractSignStats(page);

      // 鍒ゆ柇鏄惁闇€瑕侀噸璇?      if (afterCheck.signed || requestCheck.signed) {
        break; // 鎴愬姛锛岄€€鍑洪噸璇曞惊鐜?      }

      // 妫€鏌?API 鏄惁杩斿洖浜嗗彲閲嶈瘯鐨勯敊璇?      const apiMsg = signRequest?.json?.message || '';
      if (/绛惧埌澶辫触|绋嶅悗閲嶈瘯|澶辫触/i.test(apiMsg)) {
        console.log(`[绛惧埌] API 杩斿洖: "${apiMsg}"锛屽噯澶囬噸璇?(${signRetries + 1}/${MAX_SIGN_RETRIES})`);
        signRetries++;
        continue;
      }

      // 鏈娴嬪埌鏄庣‘鎴愬姛/澶辫触 鈫?涔熼噸璇?      console.log(`[绛惧埌] 鏈娴嬪埌鏄庣‘缁撴灉锛屽噯澶囬噸璇?(${signRetries + 1}/${MAX_SIGN_RETRIES})`);
      signRetries++;
    }

    let afterDashboardStats = dashboardStats;
    if (dashboardUrl) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      afterDashboardStats = await loadDashboardStats(page, dashboardUrl);
    }

    if (afterCheck.signed || requestCheck.signed) {
      // 鍒ゅ畾鏉ユ簮浼樺厛绾э細鎺ュ彛鍝嶅簲 > 椤甸潰鏂囨銆傛帴鍙ｆ墠鏄敮涓€鍙俊鐨勮瘉鎹紝
      // 椤甸潰涓婄殑銆岀鍒版垚鍔熴€嶅彲鑳藉彧鏄病娓叉煋瀹屾暣鏃舵畫鐣欑殑闈欐€佹枃妗堛€?      const signInfo = requestCheck.pattern || afterCheck.pattern;
      const signKind = resolveSignKind(signInfo);
      if (signKind === 'already') {
        console.log(`[绛惧埌] 绛惧埌璇锋眰杩斿洖宸茬鍒帮紙${signInfo}锛夛紝鎸夈€屽凡绛惧埌銆嶄笂鎶);
      }
      const template = buildResultTemplate(afterStats, afterDashboardStats, signKind);

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
          signInfo,
          signedBy: signKind === 'already' ? 'already' : 'script',
          signKind,
        },
      };
    }

    // 妫€鏌ユ槸鍚︽湁 toast 鎻愮ず
    const toastLocator = page.locator('.el-message, .el-notification').last();
    const toastCount = await toastLocator.count();
    if (toastCount > 0) {
      const toastText = await toastLocator.innerText().catch(() => '');
      if (toastText.includes('鎴愬姛')) {
        const template = buildResultTemplate(afterStats, afterDashboardStats, 'success');
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
            signedBy: 'script',
            signKind: 'success',
          },
        };
      }

      throw new Error(`绛惧埌澶辫触: ${toastText}`);
    }

    const bodyPreview = await page.locator('body').innerText().catch(() => '');
    console.log('[绛惧埌] 鏈€缁堥〉闈㈠唴瀹归瑙?', bodyPreview.substring(0, 1000));
    throw new Error('鏈娴嬪埌绛惧埌鎴愬姛鎴栧け璐ユ彁绀?);

  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log(`[娓呯悊] 绗?${round} 杞祻瑙堝櫒宸插叧闂璥);
  }
}

/**
 * 瀵瑰鍏ュ彛锛氬湪**涓€娆¤繍琛屽唴**鍋氬杞畬鏁撮噸璇曘€? *
 * 涓轰粈涔堟槸銆屾暣杞噸鏉ャ€嶈€屼笉鏄€岃皟澶у崟娆￠噸璇曟鏁般€嶏細
 * runner 鍦ㄦ捣澶栨満鎴匡紝璁块棶鍥藉唴 CDN 鏃堕亣鍒扮殑鏄垎閽熺骇鍥炴簮鏁呴殰锛? * 鍗曡疆鍐呯殑閲嶈瘯鍙細鍙嶅鎾炰笂鍚屼竴娆℃晠闅滐紱鎷夊紑鏃堕棿闂撮殧銆佹崲鍏ㄦ柊娴忚鍣ㄥ疄渚嬶紝
 * 鎵嶇湡姝ｇ粰鑷繁澶氫竴娆℃満浼氥€傝€屼笖鎴愬姛鏃剁涓€杞氨杩斿洖锛屼笉棰濆鑺辨椂闂淬€? *
 * 鐜鍙橀噺锛? *   FRP_ROUNDS              鏈€澶ц疆鏁帮紙榛樿 3锛? *   FRP_TOTAL_BUDGET_MS     鎬婚绠楋紝瓒呮椂鍒欎笉鍐嶅紑鏂拌疆锛堥粯璁?18 鍒嗛挓锛? *   FRP_BLOCK_THIRD_PARTY   绗笁鏂硅祫婧愬睆钄芥ā寮?off|safe|strict锛堥粯璁?safe锛? */
async function pureBrowserCheckIn(options = {}) {
  const {
    username,
    password,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    launchOptions = {},
  } = options;

  const maxRounds = resolveEnvInt('FRP_ROUNDS', 3);
  const totalBudgetMs = resolveEnvInt('FRP_TOTAL_BUDGET_MS', 18 * 60 * 1000);
  const startedAt = Date.now();
  let lastError = null;

  console.log('='.repeat(50));
  console.log('52frp 绾祻瑙堝櫒绛惧埌锛堟棤 API锛?);
  console.log('='.repeat(50));
  console.log(`[閰嶇疆] 鏈€澶ц疆鏁?${maxRounds} 鎬婚绠?${Math.round(totalBudgetMs / 60_000)}鍒嗛挓`);
  console.log('');

  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      const elapsed = Date.now() - startedAt;
      const remainingMs = totalBudgetMs - elapsed;

      if (remainingMs <= 0) {
        console.log(`[閲嶈瘯] 鎬婚绠楀凡鐢ㄥ敖锛?{Math.round(elapsed / 1000)}s锛夛紝涓嶅啀寮€濮嬬 ${round} 杞甡);
        break;
      }

      const plannedMs = ROUND_BACKOFF_MS[round - 2] ?? ROUND_BACKOFF_MS[ROUND_BACKOFF_MS.length - 1];
      // 鍓╀綑棰勭畻涓嶅鏃朵笉蹇呭偦绛夋弧锛岀洿鎺ュ紑濮嬭繖涓€杞?      const waitMs = Math.min(plannedMs, remainingMs);
      if (waitMs < plannedMs) {
        console.log(`[閲嶈瘯] 鍓╀綑棰勭畻涓嶈冻浠ョ瓑寰?${Math.round(plannedMs / 1000)}s锛岀缉鐭负 ${Math.round(waitMs / 1000)}s`);
      } else {
        console.log(`[閲嶈瘯] 绛夊緟 ${Math.round(waitMs / 1000)}s 鍚庡紑濮嬬 ${round}/${maxRounds} 杞?..`);
      }
      await sleep(waitMs);
    }

    console.log(`===== 绗?${round}/${maxRounds} 杞?=====`);

    try {
      const result = await attemptCheckInOnce({
        username,
        password,
        timeoutMs,
        launchOptions,
        round,
      });

      if (round > 1) {
        console.log(`[閲嶈瘯] 绗?${round} 杞垚鍔焋);
      }

      if (result?.details) {
        result.details.rounds = round;
      }

      return result;
    } catch (error) {
      lastError = error;
      console.log(`[閲嶈瘯] 绗?${round}/${maxRounds} 杞け璐? ${error.message}`);

      if (error?.retryable === false) {
        console.log('[閲嶈瘯] 璇ラ敊璇笉鍙噸璇曪紝宸茬粓姝㈠悗缁疆娆?);
        throw error;
      }
    }
  }

  const finalError = lastError ?? new Error('绛惧埌澶辫触锛氭墍鏈夎疆娆″潎鏈垚鍔?);
  finalError.rounds = maxRounds;
  throw finalError;
}

module.exports = {
  pureBrowserCheckIn,
  attemptCheckInOnce,
  shouldBlockUrl,
  waitForLoginPageRendered,
  waitForSignPageReady,
  handleSliderVerification,
  clickLoginButton,
  checkSignedToday,
  clickSignButton,
  dismissBlockingOverlays,
  extractDashboardStats,
  extractSignStats,
  buildResultTemplate,
  resolveSignKind,
  getUrlPath,
  loadDashboardStats,
  waitForDashboardStats,
  formatTrafficCompact,
  isLoginPageRenderedText,
  trafficTextToBytes,
  waitForLoginSuccess,
  waitForSignResult,
  waitForSignRequest,
  inferSignStateFromRequest,
};
