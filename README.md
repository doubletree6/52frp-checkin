# 52frp-checkin

基于 GitHub Actions 的 52frp 自动签到脚本。

内置**两种**签到实现，默认先走快的方法、失败自动回退：

| | 方法A：API 直签 | 方法B：浏览器自动化 |
| --- | --- | --- |
| 代码 | `src/checkin/api.js` | `src/browser.js`（经 `src/checkin/browser.js` 适配） |
| 是否启动浏览器 | 否，直接 HTTP 调用 | 是，Playwright + Chromium |
| 典型耗时 | 数秒 | 1～3 分钟 |
| 能否过滑块 | 不能，被风控就直接失败 | 能，自动拖动滑块 |
| 成功判据 | 复查接口 `signed_today === true` | 签到接口响应 + 页面证据分级 |

默认策略 `auto` = 方法A 先跑，失败（请求异常 / 接口返回错误 / 复查判定没签上）才回退方法B。
两种方式成功都会走同一套推送（PushPlus / Telegram）。

## 工作原理

### 方法A：API 直签

```text
GET  https://www.52frp.com/user/              预热，取初始 Cookie（含 CSRF）
POST https://www.52frp.com/api/user/login      账号密码 → Bearer token
GET  https://www.52frp.com/api/user/sign/info  今日是否已签到
GET  https://www.52frp.com/api/user/slider-token  取一次性 slider_token
POST https://www.52frp.com/api/user/sign       提交签到
GET  https://www.52frp.com/api/user/sign/info  复查（唯一可信的成功判据）
```

登录后会下发 `hzfrp_user_csrf` Cookie，后续 POST 必须回传 `X-CSRF-Token`，否则 400。
**签到接口返回 200 只代表"请求被接受"，不代表真的签上了** —— 所以最后必须复查 `signed_today`，
复查不到 `true` 就判失败并回退方法B，绝不静默当成功。

### 方法B：浏览器自动化

模拟真实用户操作：

1. 打开登录页 → 自动填账号密码
2. 点击登录 → 检测滑块验证 → 自动拖动滑块到最右边
3. 滑块验证通过 → 再次点击登录完成登录
4. 登录成功 → 自动跳转签到页
5. 点击"立即签到"按钮 → 检查签到结果
6. 一次运行内最多 3 轮完整重试（每轮换全新浏览器实例，退避 45s / 75s）

**为什么还需要方法B？**
- 52frp 会校验请求特征（TLS 指纹 + 请求头组合），Node 的 `fetch` 指纹不是 Chrome，可能被直接拒
- 登录环节的滑块验证纯 API 过不了
- 浏览器方案更接近真实用户行为，是方法A 失效时的兜底

## Secrets 配置

在仓库 `Settings` → `Secrets and variables` → `Actions` 里添加：

| 名称 | 说明 |
| --- | --- |
| `FRP_USERNAME` | 52frp 账号 / 手机号 / 邮箱 |
| `FRP_PASSWORD` | 52frp 密码 |
| `PUSHPLUS_TOKEN` | 可选，PushPlus 推送 token |
| `PUSHPLUS_CHANNEL` | 可选，PushPlus 发送渠道，例如 `wechat` 或 `webhook` |
| `TG_BOT_TOKEN` | 可选，Telegram Bot token |
| `TG_CHAT_ID` | 可选，Telegram 接收消息的 chat ID；需与 `TG_BOT_TOKEN` 同时配置 |

## 使用方式

### 1. Fork 仓库

把这个仓库 Fork 到你自己的 GitHub 账号。

### 2. 配置 Secrets

至少配置：

- `FRP_USERNAME`
- `FRP_PASSWORD`

如果你想收到微信推送，再加：

- `PUSHPLUS_TOKEN`

如果需要指定 PushPlus 发送渠道，在仓库 `Settings` → `Secrets and variables` → `Actions` → `Secrets` 中添加：

- `PUSHPLUS_CHANNEL`

如果需要同时接收 Telegram 推送，在同一个 `Actions` → `Secrets` 中添加：

- `TG_BOT_TOKEN`
- `TG_CHAT_ID`

PushPlus 和 Telegram 会同时发送同一条签到内容；未配置的渠道会自动跳过。

### 3. 启用 GitHub Actions

进入仓库的 `Actions` 页面，启用工作流。

### 4. 运行

- 手动运行：`Actions` → `Daily 52frp Check-in` → `Run workflow`
- 定时运行：默认每天北京时间 **11:15** 执行

## 本地运行

```bash
# 复制环境变量模板
cp .env.example .env
# 编辑 .env 填入账号密码

node checkin-v2.js               # v2：API 直签优先，失败回退浏览器（推荐）
node checkin.js                  # v1：只用浏览器
```

或者直接：

```bash
FRP_USERNAME='your_username' FRP_PASSWORD='your_password' node checkin-v2.js
```

### 选择执行方式

`CHECKIN_STRATEGY`（或 CLI 参数 `--strategy=`）：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 方法A → 失败回退方法B |
| `api` | 只用方法A，失败就直接报失败（不启动浏览器） |
| `browser` | 只用方法B，等同 v1 行为 |
| `browser,api` | 自定义顺序 |

```bash
node checkin-v2.js --strategy=api       # 只验证方法A 通不通
node checkin-v2.js --strategy=browser   # 只验证方法B
```

GitHub Actions 手动运行时，workflow 的 `strategy` 下拉框可直接选这些值；
定时运行固定用 `auto`。

### 验证两条路径都通

```bash
# 1) 只跑方法A：看是否 success / already_signed，或给出明确的失败原因
node checkin-v2.js --strategy=api

# 2) 只跑方法B：确认浏览器方案仍然可用
node checkin-v2.js --strategy=browser

# 3) 跑完整回退链路（把方法A 逼失败，看是否自动切到方法B）：
#    临时把 FRP_PASSWORD 改错再跑 auto，方法A 会在登录环节失败并回退
node checkin-v2.js
```

方法A 是否可用，取决于 52frp 当时的风控状态。判断依据看日志：

```text
[调度] 「API 直签（方法A）」未成功：登录：站点要求滑块验证，纯 API 无法完成（…）
[调度] 继续尝试下一个方式...
```

出现这行说明方法A 被风控拦了、正在回退 —— 这是预期行为，不是 bug。

## 输出示例

脚本最后会输出一行 `CHECKIN_RESULT:`，其后直到输出末尾的所有内容会被 workflow 收集并推送（PushPlus / Telegram）。

本次运行完成签到：

```text
CHECKIN_RESULT: 52frp签到成功

签到天数：42 天
本次获得：256M
累计获得：12.5G
剩余流量：100.99G

签到方式：本次运行自动签到成功
```

今天已经签到过了（手动签到，或当天更早的一次运行已签到）：

```text
CHECKIN_RESULT: 52frp今日已签到（无需重复签到）

签到天数：42 天
本次获得：256M
累计获得：12.5G
剩余流量：100.99G

签到方式：本次运行前已完成（手动签到或当天更早的一次运行），脚本未重复签到
```

签到状态通过返回值区分：

- `status: success` —— 本次运行完成签到
- `status: already_signed` —— 本轮开始时就已签到，`details.signKind = 'already'`

v2 的推送里会多一行「执行方式」，说明这次是哪一种方式签上的：

```text
CHECKIN_RESULT: 52frp签到成功

签到方式：本次运行自动签到成功

签到天数：42 天
本次获得：256M
累计获得：12.5G
剩余流量：100.99G

执行方式：浏览器自动化（方法B）

备注：API 直签（方法A）失败后，回退到上述方式完成
```

若方法B 某一轮遇到站点/CDN 临时故障、靠后面几轮才成功，日志里会有 `[重试] 第 N 轮成功`。
全部方式都失败时，推送会列出每一种方式的失败原因，并提示手动签到。

## 签到状态的判定原则

判定「今天是否已签到」分两级证据，`src/browser.js` 的 `checkSignedToday()` 返回结果里带
`reliable` 字段：

**硬证据（reliable: true）** —— 可以下结论：

- 页面上的「上次签到」日期 == 今天 → 已签到
- 页面上的「上次签到」日期不是今天 → 未签到
- 页面明确写着「您今天已经签到过了」→ 已签到
- 「立即签到」按钮可见且可点击 → 未签到
- 签到接口明确返回「已签到 / 重复签到 / 签到成功 / 签到失败」→ 以接口为准

**软证据（reliable: false）** —— 只是**嫌疑**，不能据此跳过签到：

- 签到按钮被禁用
- 按钮不可见，但页面上出现「已签到」字样
- 页面上出现「签到成功」「恭喜获得」

之所以这么分，是因为踩过一个坑：脚本曾把页面上的「签到成功」当成"今天已签到"，
直接跳过点击，结果推送"已签到"但实际上根本没签 —— 而「签到成功」是**结果提示**，
页面没渲染完整、说明文案、历史记录都可能让它出现，它不是**状态证据**。

现在的策略是：只有硬证据才允许跳过点击；拿到软证据时照样点签到按钮，
由签到接口给出最终答案。点击之后，「本次运行前就已完成」也只认接口的说法
（点完按钮页面显示「已签到」本来就是本次点击造成的，不能反推成之前就签过）。

## 项目结构

```text
.
├── .github/workflows/daily-checkin.yml
├── checkin.js                # v1 入口：只用浏览器
├── checkin-v2.js             # v2 入口：多方式 + 自动回退（默认）
├── src/
│   ├── browser.js            # 方法B：浏览器签到核心模块
│   ├── config.js             # 账号配置读取（环境变量 / .env）
│   └── checkin/
│       ├── index.js          # 统一签到层对外入口
│       ├── runner.js         # 调度器：按序尝试、失败回退、汇总原因
│       ├── result.js         # 统一返回结构 + 推送文案拼装
│       ├── api.js            # 方法A：纯 API 直签
│       └── browser.js        # 方法B 适配器（归一化返回值）
├── push_notification.js      # PushPlus / Telegram 推送
├── .env.example
└── README.md
```

## 扩展新的签到方式

所有策略都实现同一个接口，注册进 `src/checkin/runner.js` 的 `STRATEGIES` 即可，
调度器和推送层不用改：

```js
const { STATUS, createResult } = require('./result');

// ctx: { username, password, timeoutMs, launchOptions, log, env }
async function runMyStrategy(ctx) {
  // 1. 每一步都要打日志
  ctx.log('[方法C] 开始...');

  // 2. 失败不要抛异常，返回统一结果（抛了调度器也会兜住，但原因会不清晰）
  return createResult({
    status: STATUS.SUCCESS,      // success | already_signed | error | skipped
    strategy: 'mine',
    message: '52frp签到成功',
    reason: null,                // 失败时给可读原因
    metrics: {                   // 取不到就留 null，推送层显示「未取到」
      totalSignDays: null,
      todayRewardBytes: null,
      totalRewardBytes: null,
      remainingBytes: null,
    },
    raw: {},                     // 原始证据，便于事后排查
  });
}
```

约定：

- 只有 `success` / `already_signed` 会被调度器认定为"这一天已经签到了"并终止流程
- `error` / `skipped` 会让调度器继续尝试下一个策略
- 结果里必须能回答"到底签上没签上"，不允许出现"请求发出去了但不知道成没成"就算成功

## 复用方法A 的注意事项

**依赖**

- 只需要 Node 18+（用到内置 `fetch` 和 `Headers.getSetCookie()`），**不新增任何 npm 依赖**
- 不需要浏览器，方法A 成功时完全不加载 Playwright（`require('../browser')` 是惰性的）
- 方法B 仍然需要 `npm ci` + Playwright Chromium

**请求频率限制**

- 52frp 签到每天只有 1 次，重复提交会撞上"签到次数超限"；因此方法A 在提交签到这一步**不做重试**，
  且签到前先查 `sign/info`，已签到就直接返回、不再提交
- 一次完整的方法A 会发出 6～7 个请求。每天只跑一次，量级很小；但**不要**为了"提高成功率"
  反复手动触发，同一天多次触发会消耗站点额度并可能触发风控
- 撞到 429 /「已达上限」时，日志会明确标注 `rate-limit`，此时当天再试也没意义

**合规风险**

- 这是**本人账号**的自动化签到，账号密码只存在 GitHub Secrets，不要写进代码或日志
  （日志里账号已做脱敏，密码全程不打印）
- 站点侧有反爬/风控是正常的商业行为，脚本只在每天一次的频率下模拟手工操作，
  不做高频轮询、不抓取数据、不批量注册账号
- 方法A 通过伪造 Chrome 的请求头（UA / `Sec-Ch-Ua` / `Sec-Fetch-*`）贴近真实浏览器行为，
  这一点从 Cloudflare Worker 迁移到 GitHub Actions 后依然成立；
  若站点后续加强校验，方法A 会稳定失败 —— 这正是要保留方法B 兜底的原因
- 若站点服务条款明确禁止自动化访问，请自行评估后再启用

## 开发

首次运行前需要安装 Playwright：

```bash
npm install
npx playwright install chromium
```

## License

MIT