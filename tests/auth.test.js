const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const db = require('../server/db');

let queries;
let queryResult;
db.pool.query = async (sql, params) => {
  queries.push({ sql, params });
  return queryResult;
};
const auth = require('../server/auth');

test.beforeEach(() => {
  queries = [];
  queryResult = { rows: [] };
});

test('registration rejects coerced usernames before hashing or accessing the database', async () => {
  for (const username of [undefined, null, 123456, ['player'], {}, true]) {
    await assert.rejects(auth.register(username, 'password123'), { message: 'invalid_username', status: 400 });
  }
  assert.equal(queries.length, 0);
});

test('login rejects invalid input types without querying the database', async () => {
  for (const password of [null, undefined, {}, [], 123456, true, '', 'x'.repeat(201)]) {
    await assert.rejects(auth.login('player', password), { message: 'invalid_credentials', status: 401 });
  }
  for (const username of [undefined, null, 123456, ['player'], {}]) {
    await assert.rejects(auth.login(username, 'password123'), { message: 'invalid_credentials', status: 401 });
  }
  assert.equal(queries.length, 0);
});

test('login accepts a valid bcrypt password and records last login', async () => {
  const password_hash = await bcrypt.hash('password123', 4);
  queryResult = { rows: [{ id: 'u1', username: 'player', password_hash, is_admin: false }] };
  assert.deepEqual(await auth.login('player', 'password123'), {
    id: 'u1', username: 'player', is_admin: false,
  });
  assert.match(queries[1].sql, /last_login_at/);
  await assert.rejects(auth.login('player', 'wrong-password'), { status: 401 });
});

test('bcrypt supports both $2a$ and $2b$ hash prefixes', async () => {
  const hash = await bcrypt.hash('legacy-password', 4);
  assert.equal(await bcrypt.compare('legacy-password', hash.replace('$2b$', '$2a$')), true);
});

test('profile updates reject invalid objects and field types', async () => {
  for (const updates of [null, [], 'profile', 1]) {
    await assert.rejects(auth.updateProfile('u1', updates), { message: 'invalid_profile', status: 400 });
  }
  for (const [field, error] of [['display_name', 'invalid_display_name'], ['bio', 'invalid_bio'], ['avatar', 'invalid_avatar_format']]) {
    await assert.rejects(auth.updateProfile('u1', { [field]: {} }), { message: error, status: 400 });
  }
  assert.equal(queries.length, 0);
});

test('profile avatar validation rejects stored-XSS payloads and oversized data URLs', async () => {
  await assert.rejects(auth.updateProfile('u1', {
    avatar: 'data:image/png;base64,AA" onerror="alert(1)',
  }), { message: 'invalid_avatar_format', status: 400 });
  await assert.rejects(auth.updateProfile('u1', {
    avatar: 'data:image/png;base64,' + 'A'.repeat(271 * 1024),
  }), { message: 'avatar_too_large', status: 413 });
  assert.equal(queries.length, 0);
});
