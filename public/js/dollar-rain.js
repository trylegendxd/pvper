// public/js/dollar-rain.js
// ============================================================================
//  Subtle falling green $ background. Big readable dollar signs falling
//  cleanly top-to-bottom, no trails. Sparse columns, low opacity, sits
//  behind every menu container. Skipped inside the shooter game.
//
//  Drop into <head> after auth.js; works without any HTML changes.
// ============================================================================

(function () {
  // Skip inside the shooter game — it has its own scene.
  if (location.pathname.startsWith('/games/shooter')) return;
  if (document.getElementById('game-canvas')) return;

  // Honour reduced-motion users.
  const prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;

  // ── Canvas setup ────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.id = 'dollar-rain';
  canvas.style.cssText = [
    'position:fixed', 'inset:0', 'width:100%', 'height:100%',
    // z-index:0 paints above body background, beneath every menu
    // container (which gets z-index:1 via styles.css).
    'z-index:0', 'pointer-events:none',
    'background:transparent',
    // Subtle overall — the canvas is just a vibe, not the focal point.
    'opacity:0.22',
  ].join(';');

  function injectCanvas() {
    if (document.body) {
      document.body.appendChild(canvas);
    } else {
      document.addEventListener('DOMContentLoaded', injectCanvas, { once: true });
    }
  }
  injectCanvas();

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // ── Drops ──────────────────────────────────────────────────────────────
  // Each drop is a single big bright $ glyph falling cleanly to the
  // bottom. No trail glyphs above, no wash behind — we clearRect the
  // whole canvas every frame so the only thing visible is each glyph
  // at its current y. This is what makes the effect read as "dollars
  // dripping" instead of "streaks of light".
  const FONT_SIZE   = 30;
  const COL_GAP     = 90;  // bigger gap = sparser screen
  const COLOR       = '#1eff4a';
  const GLOW_COLOR  = '#9eff9e';
  let drops = [];
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
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const n = Math.max(2, Math.ceil(width / COL_GAP));
    const old = drops;
    drops = new Array(n);
    for (let i = 0; i < n; i++) {
      drops[i] = old[i] || spawnDrop(i, /*initial*/true);
    }
  }

  function spawnDrop(colIdx, initial) {
    return {
      x: colIdx * COL_GAP + COL_GAP / 2,
      // Initial run staggers the drops across the visible viewport so
      // we don't get a synchronized wave on first paint. Otherwise a
      // respawned drop starts above the top edge.
      y: initial ? Math.random() * height : -FONT_SIZE - Math.random() * 200,
      // 70..160 px/sec keeps them readable.
      speed: 70 + Math.random() * 90,
    };
  }

  resize();
  window.addEventListener('resize', resize);

  // ── Main draw loop ──────────────────────────────────────────────────────
  let raf = 0;
  let running = !document.hidden;
  let lastTs = performance.now();

  function draw(ts) {
    if (!running) { raf = 0; return; }
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;

    // Wipe — no trails, no streaks. The opacity:0.22 on the canvas
    // element does the "behind the content" feel; the glyphs
    // themselves are full alpha for crispness.
    ctx.clearRect(0, 0, width, height);

    // Tiny glow for a touch of presence without dominating.
    ctx.shadowColor = GLOW_COLOR;
    ctx.shadowBlur  = 4;
    ctx.fillStyle   = COLOR;

    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      d.y += d.speed * dt;
      // Respawn at top with a new random delay so columns don't
      // synchronise. The drop is drawn only while inside the viewport.
      if (d.y > height + FONT_SIZE) {
        drops[i] = spawnDrop(i, false);
        continue;
      }
      if (d.y < -FONT_SIZE) continue;
      ctx.fillText('$', d.x, d.y);
    }
    ctx.shadowBlur = 0;

    raf = requestAnimationFrame(draw);
  }

  // Pause on hidden tab.
  document.addEventListener('visibilitychange', () => {
    const wasRunning = running;
    running = !document.hidden;
    if (running && !wasRunning) {
      lastTs = performance.now();
      raf = requestAnimationFrame(draw);
    }
  });

  raf = requestAnimationFrame(draw);
})();
