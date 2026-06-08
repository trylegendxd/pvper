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
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  // Up to 2 decimals — show them only when there's a fractional part so
  // whole balances stay clean (e.g. "1,250 cr", "1,250.50 cr").
  const hasFrac = Math.round(abs * 100) % 100 !== 0;
  const s = abs.toLocaleString(undefined, {
    minimumFractionDigits: hasFrac ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return (v < 0 ? '-' : '') + s + ' cr';
};
