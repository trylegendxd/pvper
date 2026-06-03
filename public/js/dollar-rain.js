// public/js/dollar-rain.js
// ============================================================================
//  Matrix-style green dollar-sign rain. Renders to a fixed-position canvas
//  pinned behind the rest of the page (z-index: -1, pointer-events: none).
//  Auto-resizes, pauses while the tab is hidden, and is a no-op inside the
//  shooter game canvas.
//
//  Drop into <head> after auth.js; works without any HTML changes.
// ============================================================================

(function () {
  // Don't run inside the actual shooter game — it has its own scene and
  // would just be visual noise. Detect by either the canvas id or the
  // URL path.
  if (location.pathname.startsWith('/games/shooter')) return;
  if (document.getElementById('game-canvas')) return;

  // Honour reduced-motion users who explicitly opted out.
  const prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;

  // ── Canvas setup ────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.id = 'dollar-rain';
  canvas.style.cssText = [
    'position:fixed', 'inset:0', 'width:100%', 'height:100%',
    // z-index:0 paints above the body's dark background but stays
    // beneath all menu content (which is z-index:1 via styles.css).
    'z-index:0', 'pointer-events:none',
    'background:transparent', 'opacity:0.55',
  ].join(';');

  function injectCanvas() {
    if (document.body) {
      document.body.appendChild(canvas);
    } else {
      // body isn't ready yet — wait.
      document.addEventListener('DOMContentLoaded', injectCanvas, { once: true });
    }
  }
  injectCanvas();

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // ── Column model ────────────────────────────────────────────────────────
  // Each column holds one falling stream of $ glyphs. We treat the y
  // value as the head of the stream; everything above it has already
  // been drawn and the trail fade-out is handled by the semi-transparent
  // black rectangle each frame.
  const FONT_SIZE = 18;
  const COL_GAP   = 22;     // px between columns
  const SYMBOL    = '$';
  const HEAD_COLOR = '#9eff9e';     // bright green at the leading edge
  const BODY_COLOR = '#1eff4a';     // mid green for trailing glyphs
  let columns = [];
  let width = 0, height = 0;

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    width  = window.innerWidth;
    height = window.innerHeight;
    canvas.width  = Math.floor(width  * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width  = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `bold ${FONT_SIZE}px monospace`;
    ctx.textBaseline = 'top';

    const n = Math.ceil(width / COL_GAP);
    const old = columns;
    columns = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev = old[i];
      columns[i] = prev || {
        // Stagger initial heights so we don't all start at the top.
        y: -Math.random() * height,
        // 2..6 px per frame fall speed.
        speed: 2 + Math.random() * 4,
        // Per-column trail length (number of visible glyphs above the head).
        len: 8 + Math.floor(Math.random() * 22),
      };
    }
  }

  resize();
  window.addEventListener('resize', resize);

  // ── Main draw loop ──────────────────────────────────────────────────────
  let raf = 0;
  let running = !document.hidden;
  function drawFrame() {
    if (!running) { raf = 0; return; }
    // Slight black wash so previous frames fade — this is what gives
    // the trailing-tail look without having to draw every glyph in the
    // trail ourselves.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const x = i * COL_GAP + (COL_GAP / 2) - (FONT_SIZE / 2);

      // Head glyph — brighter, with a soft glow.
      ctx.shadowColor = HEAD_COLOR;
      ctx.shadowBlur  = 6;
      ctx.fillStyle   = HEAD_COLOR;
      ctx.fillText(SYMBOL, x, c.y);
      ctx.shadowBlur  = 0;

      // A few trail glyphs above the head fade into the dimmer green.
      // (The fillRect wash above handles longer-tail fade-out.)
      ctx.fillStyle = BODY_COLOR;
      for (let k = 1; k < 4; k++) {
        const ty = c.y - k * (FONT_SIZE + 2);
        if (ty < -FONT_SIZE) break;
        ctx.fillText(SYMBOL, x, ty);
      }

      c.y += c.speed;
      // Reset off the bottom with a random delay (negative y) so columns
      // don't synchronise into bands.
      if (c.y > height + 40) {
        c.y = -FONT_SIZE - Math.random() * 200;
        c.speed = 2 + Math.random() * 4;
        c.len = 8 + Math.floor(Math.random() * 22);
      }
    }

    raf = requestAnimationFrame(drawFrame);
  }

  // Pause when the tab isn't visible so we don't burn CPU in the
  // background.
  document.addEventListener('visibilitychange', () => {
    const wasRunning = running;
    running = !document.hidden;
    if (running && !wasRunning) {
      raf = requestAnimationFrame(drawFrame);
    }
  });

  raf = requestAnimationFrame(drawFrame);
})();
