// PushPlus 服务端限制标题不超过 100 个字符，超长会整条推送被拒（code:999）。
const PUSHPLUS_TITLE_MAX = 100;

function buildPushTitle(message) {
  const title = `Q:${String(message ?? '')}`;
  if (title.length <= PUSHPLUS_TITLE_MAX) {
    return title;
  }
  return `${title.slice(0, PUSHPLUS_TITLE_MAX - 1)}…`;
}

async function sendNotification(message) {
  const token = process.env.PUSHPLUS_TOKEN || process.env.token;

  if (!token) {
    const tip = 'PushPlus: 未配置 PUSHPLUS_TOKEN，跳过推送';
    console.log(tip);
    return tip;
  }

  const response = await fetch('http://www.pushplus.plus/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      token,
      title: buildPushTitle(message),
      content: message,
    }),
  });

  const text = await response.text();
  console.log(text);
  return text;
}

if (require.main === module) {
  const message = process.argv.slice(2).join(' ').trim();

  if (!message) {
    console.error('Usage: node push_notification.js <checkin_message>');
    process.exit(1);
  }

  sendNotification(message).catch((error) => {
    console.error(`PushPlus 推送失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  sendNotification,
  buildPushTitle,
};
