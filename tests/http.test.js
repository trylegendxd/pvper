const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const session = require('express-session');

// Exercise the actual app and its middleware order with an isolated session
// store. Auth operations are stubbed; these tests never contact a database.
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGIN = '';
require('connect-pg-simple');
let sessionStore;
require.cache[require.resolve('connect-pg-simple')].exports = () => class extends session.MemoryStore {
  constructor() { super(); sessionStore = this; }
};
const auth = require('../server/auth');
const wallet = require('../server/wallet');
const { app } = require('../server/app');
const originals = { ...auth };
let server;
let base;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));
test.afterEach(() => Object.assign(auth, originals));

async function request(route, { body, headers = {}, ...options } = {}) {
  return fetch(base + route, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login() {
  auth.login = async () => ({ id: 'u1', username: 'player', is_admin: false });
  const res = await request('/api/auth/login', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  await res.json();
  return res.headers.get('set-cookie').split(';')[0];
}

test('profile upload accepts an avatar larger than the general 100 KB limit', async () => {
  const cookie = await login();
  const avatar = 'data:image/png;base64,' + 'A'.repeat(150 * 1024);
  auth.updateProfile = async (id, updates) => {
    assert.equal(id, 'u1');
    assert.equal(updates.avatar, avatar);
    return { id, avatar: updates.avatar };
  };
  const res = await request('/api/auth/me', { method: 'PATCH', headers: { cookie }, body: { avatar } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.avatar, avatar);
});

test('body limits and malformed JSON return predictable JSON errors', async () => {
  for (const [route, method, size] of [
    ['/api/auth/login', 'POST', 110 * 1024],
    ['/api/auth/me', 'PATCH', 310 * 1024],
  ]) {
    const res = await request(route, { method, body: { avatar: 'A'.repeat(size) } });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'payload_too_large' });
  }
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_json' });
});

test('database failure on /me returns a safe error and the server remains available', async (t) => {
  const cookie = await login();
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  auth.currentUser = async () => { throw new Error('private database connection detail'); };
  const res = await request('/api/auth/me', { headers: { cookie } });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal_error' });
  assert.equal(logs.length, 1);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('login errors preserve validation codes but conceal infrastructure details', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [error, status, code] of [
    [Object.assign(new Error('invalid_credentials'), { status: 401 }), 401, 'invalid_credentials'],
    [new Error('private database connection detail'), 500, 'internal_error'],
  ]) {
    auth.login = async () => { throw error; };
    const res = await request('/api/auth/login', { method: 'POST', body: {} });
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error: code });
  }
});

test('logout clears the authenticated session', async () => {
  const cookie = await login();
  const res = await request('/api/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /^fps\.sid=;/);
  assert.deepEqual(await res.json(), { ok: true });
  const me = await request('/api/auth/me', { headers: { cookie } });
  assert.deepEqual(await me.json(), { user: null });
});

test('failed session destruction does not claim a successful logout', async (t) => {
  const cookie = await login();
  t.mock.method(console, 'error', () => {});
  t.mock.method(sessionStore, 'destroy', (_sid, callback) => callback(new Error('store unavailable')));
  const res = await request('/api/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal_error' });
  assert.equal(res.headers.get('set-cookie'), null);
});

test('wallet read failures are handled without terminating the server', async (t) => {
  const cookie = await login();
  t.mock.method(console, 'error', () => {});
  for (const method of ['getBalance', 'getHistory']) {
    t.mock.method(wallet, method, async () => { throw new Error('database unavailable'); });
  }
  for (const route of ['/api/wallet/balance', '/api/wallet/history']) {
    const res = await request(route, { headers: { cookie } });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
  }
});

test('cross-origin state changes remain forbidden', async () => {
  const res = await request('/api/auth/login', {
    method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: {},
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'bad_origin' });
});
