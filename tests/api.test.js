const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApi(response) {
  const calls = [];
  const context = {
    window: {}, Headers,
    fetch: async (...args) => { calls.push(args); return response; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8'), context);
  return { api: context.window.api, calls };
}

test('API wrapper merges custom headers without losing JSON content type', async () => {
  const { api, calls } = loadApi(new Response('{"ok":true}'));
  await api('/api/example', { method: 'POST', headers: { 'X-Request-ID': '123' }, body: { answer: 42 } });
  const options = calls[0][1];
  assert.equal(options.headers.get('content-type'), 'application/json');
  assert.equal(options.headers.get('x-request-id'), '123');
  assert.equal(options.body, '{"answer":42}');
  assert.equal(options.credentials, 'same-origin');
});

test('API wrapper preserves explicit headers and serializes falsy JSON bodies', async () => {
  for (const body of [false, 0, '', null]) {
    const { api, calls } = loadApi(new Response(null, { status: 204 }));
    assert.equal(await api('/api/example', {
      method: 'PATCH', headers: new Headers({ 'Content-Type': 'application/merge-patch+json' }), body,
    }), null);
    assert.equal(calls[0][1].body, JSON.stringify(body));
    assert.equal(calls[0][1].headers.get('content-type'), 'application/merge-patch+json');
  }
});

test('API wrapper retains HTTP status and server error details', async () => {
  const { api } = loadApi(new Response('{"error":"rate_limited"}', { status: 429 }));
  await assert.rejects(api('/api/example'), (error) => {
    assert.equal(error.message, 'rate_limited');
    assert.equal(error.status, 429);
    assert.equal(error.data.error, 'rate_limited');
    return true;
  });
});
