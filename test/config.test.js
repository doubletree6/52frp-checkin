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
