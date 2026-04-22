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

签到成功：

```text
CHECKIN_RESULT: success: 签到成功
```

今天已经签到过了：

```text
CHECKIN_RESULT: success: 您今天已经签到过了
```

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