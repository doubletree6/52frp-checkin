const { FrpApiClient } = require('./src/api');
const { runBrowserBackedCheckIn } = require('./src/core');

async function main() {
  const username = process.env.FRP_USERNAME;
  const password = process.env.FRP_PASSWORD;

  if (!username || !password) {
    throw new Error('请先配置 FRP_USERNAME 和 FRP_PASSWORD');
  }

  const api = new FrpApiClient({
    baseUrl: process.env.FRP_BASE_URL,
  });

  const result = await runBrowserBackedCheckIn(api, { username, password });
  console.log(result.message);
  console.log(`CHECKIN_RESULT: ${result.message}`);
}

main().catch((error) => {
  const message = `签到失败: ${error.message}`;
  console.error(message);
  console.log(`CHECKIN_RESULT: ${message}`);
  process.exitCode = 1;
});
