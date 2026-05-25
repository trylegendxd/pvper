// server/middleware/validate.js — tiny ad-hoc validators
function asPositiveInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}
function asInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}
function asString(v, max = 255) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s.length || s.length > max) return null;
  return s;
}
module.exports = { asPositiveInt, asInt, asString };
