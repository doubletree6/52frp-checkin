# 52frp-checkin

基于 GitHub Actions 的 52frp 自动签到脚本。

当前实现采用两段式流程：

1. 先用账号密码调用登录接口获取 token
2. 再启动浏览器打开 52frp 面板，进入签到页并真实点击“立即签到”

目标站点：<https://www.52frp.com/user/#/auth/login>

1. `POST /api/user/login` 登录
2. 浏览器通过 `admin_token` 进入面板登录态
3. 打开 `#/welfare/sign`
4. 模拟真实点击页面上的“立即签到”按钮

## 功能

- 使用账号密码自动登录 52frp
- 检查今天是否已签到
- 通过真实页面点击完成签到，避免直接调用签到接口不稳定
- 可选 PushPlus 推送结果
- 支持 GitHub Actions 定时运行和手动触发

## Secrets 配置

在仓库 `Settings` → `Secrets and variables` → `Actions` 里添加：

| 名称 | 说明 |
| --- | --- |
| `FRP_USERNAME` | 52frp 账号 / 手机号 / 邮箱 |
| `FRP_PASSWORD` | 52frp 密码 |
| `PUSHPLUS_TOKEN` | 可选，PushPlus 推送 token |
| `FRP_BASE_URL` | 可选，默认 `https://www.52frp.com/api` |

> 注意：旧域名 `https://frp.80cn.cn` 已失效。脚本会自动把它兼容到当前域名 `https://www.52frp.com/api`，但新配置建议直接使用新域名。

## 使用方式

### 1. Fork 仓库

把这个仓库 Fork 到你自己的 GitHub 账号。

### 2. 配置 Secrets

至少配置：

- `FRP_USERNAME`
- `FRP_PASSWORD`

如果你想收到微信推送，再加：

- `PUSHPLUS_TOKEN`

### 3. 启用 GitHub Actions

进入仓库的 `Actions` 页面，启用工作流。

### 4. 运行

- 手动运行：`Actions` → `Daily 52frp Check-in` → `Run workflow`
- 定时运行：默认每天北京时间 **11:15** 执行

## 本地运行

```bash
cp .env.example .env
# 手动填入账号密码
node checkin.js
```

或者直接：

```bash
FRP_USERNAME='your_username' FRP_PASSWORD='your_password' node checkin.js
```

## 输出示例

```text
签到成功，累计签到 5 天，本次获得 2.00 GB，可用流量 3.00 GB
CHECKIN_RESULT: 签到成功，累计签到 5 天，本次获得 2.00 GB，可用流量 3.00 GB
```

如果今天已经签到过了：

```text
今天已经签到过了，累计签到 12 天，可用流量 5.00 GB
CHECKIN_RESULT: 今天已经签到过了，累计签到 12 天，可用流量 5.00 GB
```

## 项目结构

```text
.
├── .github/workflows/daily-checkin.yml
├── src/
│   ├── api.js
│   └── core.js
├── test/core.test.js
├── checkin.js
├── push_notification.js
├── .env.example
└── README.md
```

## 开发

```bash
npm test
```

首次本地跑浏览器版签到前，如果 Playwright 浏览器还没装，可以执行：

```bash
npx playwright install chromium
```

## License

MIT
