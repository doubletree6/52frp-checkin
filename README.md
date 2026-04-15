# 52frp-checkin

基于 GitHub Actions 的 52frp 自动签到脚本。

目标站点：<https://frp.80cn.cn/user/#/auth/login>

## 这个版本和参考项目的区别

参考项目 `Jiaoyuelian-autocheckin` 需要 Puppeteer + OpenCV 处理图片滑块。

52frp 这套前端我已经按页面逻辑拆过了，登录页的滑块是前端拖拽校验，不是图片验证码。真正的签到流程是：

1. `POST /api/user/login` 登录
2. `GET /api/user/sign/info` 读取今日签到状态
3. `GET /api/user/slider-token` 获取签到 token
4. `POST /api/user/sign` 完成签到

所以这个项目不需要浏览器，也不需要 OpenCV，跑在 GitHub Actions 里会更稳。

## 功能

- 使用账号密码自动登录 52frp
- 检查今天是否已签到
- 自动获取签到用 `slider_token`
- 调用签到接口完成签到
- 可选 PushPlus 推送结果
- 支持 GitHub Actions 定时运行和手动触发

## Secrets 配置

在仓库 `Settings` → `Secrets and variables` → `Actions` 里添加：

| 名称 | 说明 |
| --- | --- |
| `FRP_USERNAME` | 52frp 账号 / 手机号 / 邮箱 |
| `FRP_PASSWORD` | 52frp 密码 |
| `PUSHPLUS_TOKEN` | 可选，PushPlus 推送 token |
| `FRP_BASE_URL` | 可选，默认 `https://frp.80cn.cn/api` |

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
- 定时运行：默认每天北京时间 **10:10** 执行

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

## 备注

如果后面 52frp 改了接口结构，只需要调整 `src/api.js` 和 `src/core.js`，不需要回到浏览器自动化那条重路。

## License

MIT
