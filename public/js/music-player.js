// public/js/music-player.js
// ============================================================================
//  Menu-page music player.
//
//  Loaded on every page outside /games/* so the player hears the lobby
//  playlist while browsing the hub, leaderboard, profile, wallet, etc.
//  Skipped inside game pages so the in-game audio (gunshots, dealer
//  cards, etc.) isn't competing with looping music.
//
//  Settings UI: a floating 🎵 button in the bottom-left opens a popover
//  with a volume slider + track picker. Both persist via the same
//  fps_settings localStorage key shared with the shooter's AudioManager
//  so a track / volume pick made in either place follows the user.
//
//  Drop into <head> after auth.js; works without any HTML changes.
// ============================================================================

(function () {
  if (location.pathname.startsWith('/games/')) return;
  if (location.pathname === '/login.html' || location.pathname === '/register.html') {
    // No music on the auth pages — quieter feel, plus we won't have
    // unlocked autoplay yet anyway.
    return;
  }

  // ── State ──────────────────────────────────────────────────────────────
  let audio          = null;
  let playlist       = [];
  let trackIndex     = 0;
  let selectedTrack  = null;
  let musicVol       = 0.45;
  let unlocked       = false;
  let started        = false;

  // ── localStorage glue ──────────────────────────────────────────────────
  try {
    const s = JSON.parse(localStorage.getItem('fps_settings') || '{}');
    if (typeof s.musicVol === 'number')     musicVol      = s.musicVol;
    if (typeof s.selectedTrack === 'string') selectedTrack = s.selectedTrack;
  } catch (_) {}

  function saveSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('fps_settings') || '{}');
      s.musicVol = musicVol;
      s.selectedTrack = selectedTrack;
      localStorage.setItem('fps_settings', JSON.stringify(s));
    } catch (_) {}
  }

  function prettyName(file) {
    if (!file) return '';
    return file.replace(/\.[^.]+$/, '').replace(/_/g, ' ')
               .replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Audio engine ───────────────────────────────────────────────────────
  async function loadPlaylist() {
    try {
      const res = await fetch('/audio-files');
      playlist = await res.json();
      if (!Array.isArray(playlist) || !playlist.length) return;
      let idx = 0;
      if (selectedTrack) {
        const i = playlist.indexOf(selectedTrack);
        if (i >= 0) idx = i;
        else selectedTrack = null;
      }
      trackIndex = idx;
      loadTrack(idx, unlocked);
      refreshUI();
    } catch (_) {}
  }

  function loadTrack(idx, autoplay) {
    if (!playlist.length) return;
    if (idx < 0 || idx >= playlist.length) idx = 0;
    trackIndex = idx;
    if (audio) {
      try { audio.pause(); } catch (_) {}
      audio.onended = null;
      audio.src = '';
    }
    const file = playlist[idx];
    audio = new Audio('/audio/' + encodeURIComponent(file));
    audio.loop = false;
    audio.volume = musicVol;
    audio.onended = () => {
      // Always advance — pinned track just controls where rotation
      // starts, not what loops.
      loadTrack((trackIndex + 1) % playlist.length, true);
    };
    if (autoplay) {
      audio.play().then(() => { started = true; refreshUI(); }).catch(() => {});
    }
  }

  function setTrack(filename) {
    if (filename && playlist.includes(filename)) {
      selectedTrack = filename;
      loadTrack(playlist.indexOf(filename), unlocked);
    } else {
      selectedTrack = null;
    }
    saveSettings();
    refreshUI();
  }
  function setVolume(v) {
    musicVol = Math.max(0, Math.min(1, v));
    if (audio) audio.volume = musicVol;
    saveSettings();
  }

  // Browser autoplay policies block audio until the first user
  // interaction. Watch globally and start playback on the first one.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (audio && !started) {
      audio.play().then(() => { started = true; refreshUI(); }).catch(() => {});
    }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown',     unlock);
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown',     unlock);

  // ── Floating settings UI ───────────────────────────────────────────────
  function injectUI() {
    if (document.getElementById('music-fab')) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', injectUI, { once: true });
      return;
    }
    const style = document.createElement('style');
    style.textContent = `
      #music-fab {
        position: fixed; bottom: 18px; left: 18px; z-index: 9000;
        width: 46px; height: 46px; border-radius: 50%;
        background: rgba(30, 255, 74, 0.12);
        border: 1px solid rgba(30, 255, 74, 0.4);
        color: #1eff4a;
        font-size: 22px; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        transition: background 0.15s, transform 0.1s;
        display: flex; align-items: center; justify-content: center;
        padding: 0; line-height: 1;
      }
      #music-fab:hover { background: rgba(30, 255, 74, 0.22); }
      #music-fab.playing { animation: musicFabPulse 1.6s ease-in-out infinite; }
      @keyframes musicFabPulse {
        0%,100% { box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 0 0 0 rgba(30,255,74,0.0); }
        50%     { box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 0 0 8px rgba(30,255,74,0.08); }
      }
      #music-modal {
        position: fixed; bottom: 76px; left: 18px; z-index: 9001;
        background: #161c25; border: 1px solid #2a3548; border-radius: 8px;
        padding: 18px 20px; min-width: 300px; max-width: 360px; display: none;
        box-shadow: 0 8px 32px rgba(0,0,0,0.7);
        font-family: 'Rajdhani', sans-serif;
      }
      #music-modal.open { display: block; }
      #music-modal label {
        display:block; font-size:11px; letter-spacing:2px; color:#7a8aa5; margin-bottom:6px;
      }
      #music-modal input[type=range] { width:100%; }
      #music-modal select {
        width:100%; background: rgba(0,0,0,.4); border: 1px solid #444;
        color: #fff; padding: 8px 10px; font-family: inherit; font-size: 13px;
        border-radius: 3px;
      }
      #music-modal .row { margin-bottom: 14px; }
      #music-modal .now {
        font-size:11px; color:#7a8aa5; margin-top:8px; letter-spacing:1px;
      }
      #music-modal .title {
        font-size:11px; letter-spacing:3px; color:#7a8aa5; margin-bottom:12px;
        text-transform: uppercase;
      }
    `;
    document.head.appendChild(style);

    const fab = document.createElement('button');
    fab.id = 'music-fab';
    fab.innerHTML = '🎵';
    fab.title = 'Music settings';
    fab.addEventListener('click', () => {
      const m = document.getElementById('music-modal');
      if (m) m.classList.toggle('open');
    });
    document.body.appendChild(fab);

    const modal = document.createElement('div');
    modal.id = 'music-modal';
    modal.innerHTML = `
      <div class="title">Music</div>
      <div class="row">
        <label>Volume <span id="mp-vol-val">45%</span></label>
        <input type="range" id="mp-vol" min="0" max="100" step="1" value="45">
      </div>
      <div class="row">
        <label>Track</label>
        <select id="mp-track">
          <option value="">— Auto (next song after this one) —</option>
        </select>
        <div class="now" id="mp-now">—</div>
      </div>
    `;
    document.body.appendChild(modal);

    // Wire up controls.
    const volEl   = document.getElementById('mp-vol');
    const volVal  = document.getElementById('mp-vol-val');
    const trackEl = document.getElementById('mp-track');
    volEl.value = Math.round(musicVol * 100);
    volVal.textContent = volEl.value + '%';
    volEl.addEventListener('input', e => {
      setVolume(+e.target.value / 100);
      volVal.textContent = e.target.value + '%';
    });
    trackEl.addEventListener('change', e => setTrack(e.target.value));

    // Close popover when clicking outside.
    document.addEventListener('click', e => {
      if (!modal.classList.contains('open')) return;
      if (modal.contains(e.target) || e.target === fab) return;
      modal.classList.remove('open');
    });

    refreshUI();
  }

  function refreshUI() {
    const trackEl = document.getElementById('mp-track');
    const nowEl   = document.getElementById('mp-now');
    const fab     = document.getElementById('music-fab');
    if (trackEl) {
      while (trackEl.options.length > 1) trackEl.remove(1);
      for (const f of playlist) {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = prettyName(f);
        trackEl.appendChild(opt);
      }
      trackEl.value = selectedTrack || '';
    }
    if (nowEl) {
      const cur = playlist[trackIndex];
      nowEl.textContent = selectedTrack ? 'Pinned: ' + prettyName(selectedTrack)
                        : cur ? 'Now: ' + prettyName(cur)
                        : '—';
    }
    if (fab) {
      if (started) fab.classList.add('playing');
      else         fab.classList.remove('playing');
    }
  }

  // Pause music while the tab is hidden — keeps the player polite.
  document.addEventListener('visibilitychange', () => {
    if (!audio) return;
    if (document.hidden) {
      try { audio.pause(); } catch (_) {}
    } else if (unlocked) {
      audio.play().catch(() => {});
    }
  });

  injectUI();
  loadPlaylist();
})();
