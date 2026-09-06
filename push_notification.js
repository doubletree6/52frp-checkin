async function sendPushPlus(message) {
  const token = process.env.PUSHPLUS_TOKEN || process.env.token;
  const channel = process.env.PUSHPLUS_CHANNEL || process.env.channel;

  if (!token) {
    console.log('PushPlus: 未配置 PUSHPLUS_TOKEN，跳过推送');
    return null;
  }

  const payload = {
    token,
    title: `Q:${message}`,
    content: message,
  };

  if (channel) {
    payload.channel = channel;
  }

  const response = await fetch('http://www.pushplus.plus/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  console.log(`PushPlus: ${text}`);
  return text;
}

async function sendTelegram(message) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

  if (!token || !chatId) {
    console.log('Telegram: 未同时配置 TG_BOT_TOKEN 和 TG_CHAT_ID，跳过推送');
    return null;
  }

  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
    }),
  });

  const text = await response.text();
  console.log(`Telegram: ${text}`);
  return text;
}

async function sendNotification(message) {
  const results = await Promise.allSettled([
    sendPushPlus(message),
    sendTelegram(message),
  ]);

  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || String(result.reason));

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }

  return results.map((result) => result.value);
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
  sendPushPlus,
  sendTelegram,
};
