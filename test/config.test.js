const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getCredentials } = require('../src/config');

test('getCredentials loads FRP credentials from .env when shell env is absent', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-config-'));
  const envPath = path.join(tempDir, '.env');

  fs.writeFileSync(envPath, 'FRP_USERNAME=test-user\nFRP_PASSWORD=test-pass\n');

  const env = {};
  const credentials = getCredentials({ envPath, env });

  assert.deepEqual(credentials, {
    username: 'test-user',
    password: 'test-pass',
  });
  assert.equal(env.FRP_USERNAME, 'test-user');
  assert.equal(env.FRP_PASSWORD, 'test-pass');
});

test('getCredentials keeps existing shell env values over .env', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-config-'));
  const envPath = path.join(tempDir, '.env');

  fs.writeFileSync(envPath, 'FRP_USERNAME=file-user\nFRP_PASSWORD=file-pass\n');

  const env = {
    FRP_USERNAME: 'shell-user',
    FRP_PASSWORD: 'shell-pass',
  };

  const credentials = getCredentials({ envPath, env });

  assert.deepEqual(credentials, {
    username: 'shell-user',
    password: 'shell-pass',
  });
  assert.equal(env.FRP_USERNAME, 'shell-user');
  assert.equal(env.FRP_PASSWORD, 'shell-pass');
});

test('buildPushTitle keeps short titles unchanged', () => {
  const { buildPushTitle } = require('../push_notification');
  assert.equal(buildPushTitle('6:228M;1.76G;101.12G'), 'Q:6:228M;1.76G;101.12G');
});

test('buildPushTitle truncates titles over the PushPlus 100-char limit', () => {
  const { buildPushTitle } = require('../push_notification');
  const long = `error:登录页 Vue 应用未渲染，已重试 4 次（JS 错误: Failed to load resource: the server responded with a status of 522 ()）`;

  const title = buildPushTitle(long);

  assert.ok(title.length <= 100, `title length ${title.length} should be <= 100`);
  assert.ok(title.startsWith('Q:error:'));
  assert.ok(title.endsWith('…'));
});
