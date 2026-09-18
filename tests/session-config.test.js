const test = require('node:test');
const assert = require('node:assert/strict');
const { getSessionSecret } = require('../server/sessionConfig');

test('production rejects missing, short, and example session secrets', () => {
  for (const secret of [undefined, '', 'short', 'dev_change_me', 'change_me_please_long_random_string']) {
    assert.throws(() => getSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: secret }), /SESSION_SECRET/);
  }
});

test('production accepts a configured secret and development retains its fallback', () => {
  const secret = require('node:crypto').randomBytes(32).toString('hex');
  assert.equal(getSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: secret }), secret);
  assert.equal(getSessionSecret({ NODE_ENV: 'development' }), 'dev_change_me');
});
