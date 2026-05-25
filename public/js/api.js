// public/js/api.js — tiny fetch wrapper for the JSON API
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `http_${res.status}`), { status: res.status, data });
  return data;
}
window.api = api;

window.fmtCredits = function (n) {
  const s = Math.abs(Number(n) || 0).toLocaleString();
  return (n < 0 ? '-' : '') + s + ' cr';
};
