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
      title: `52frp:${message}`,
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
};
