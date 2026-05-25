// server/rng.js — crypto-secure RNG helpers (NEVER use Math.random for money decisions)
const crypto = require('crypto');

/** Uniform integer in [min, max] inclusive, via rejection sampling. */
function intInRange(min, max) {
  if (max < min) throw new Error('rng_range');
  const range = max - min + 1;
  if (range === 1) return min;
  const bytesNeeded = Math.ceil(Math.log2(range) / 8) || 1;
  const maxValid = Math.floor((256 ** bytesNeeded) / range) * range;
  while (true) {
    const buf = crypto.randomBytes(bytesNeeded);
    let val = 0;
    for (let i = 0; i < bytesNeeded; i++) val = val * 256 + buf[i];
    if (val < maxValid) return min + (val % range);
  }
}

/** Fisher-Yates shuffle with crypto RNG. Returns a new array. */
function secureShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = intInRange(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { intInRange, secureShuffle };
