# 52frp-checkin

基于 GitHub Actions 的 52frp 自动签到脚本（纯浏览器自动化，不调用任何 API）。

## 工作原理

全程浏览器自动化，模拟真实用户操作：

1. 打开登录页 → 自动填账号密码
2. 点击登录 → 检测滑块验证 → 自动拖动滑块到最右边
3. 滑块验证通过 → 再次点击登录完成登录
4. 登录成功 → 自动跳转签到页
5. 点击"立即签到"按钮 → 检查签到结果

**为什么不用 API？**
- 直接调用签到 API 不稳定（容易触发限流）
- 滑块验证难以通过 API 完成
- 浏览器自动化更接近真实用户行为

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
node checkin.js
```

或者直接：

```bash
FRP_USERNAME='your_username' FRP_PASSWORD='your_password' node checkin.js
```

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

若某一轮遇到站点/CDN 临时故障、靠后面几轮才成功，推送里会多一行 `备注：第 N 轮才成功，前几轮遇到临时故障`。

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
├── checkin.js           # 入口脚本
├── src/browser.js       # 纯浏览器签到核心模块
├── push_notification.js # PushPlus 推送通知
├── .env.example
└── README.md
```

## 开发

首次运行前需要安装 Playwright：

```bash
npm install
npx playwright install chromium
```

## License

MIT