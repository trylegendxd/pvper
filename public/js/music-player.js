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
  // The shooter is the ONLY page that suppresses menu music — its own
  // AudioManager handles in-game audio (gunshots, voice, spatial SFX)
  // and looping music there would fight with it. Every other page,
  // including the other casino games (rps, roulette, blackjack, mines,
  // wheel), gets the lobby playlist.
  if (location.pathname.startsWith('/games/shooter')) return;
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

  // Cross-page playback continuity. Browsers tear down the JS context on
  // navigation, so the only way to keep music from restarting is to
  // periodically save where we were and resume from there on the next
  // page. Resume is skipped if the snapshot is stale (older than
  // RESUME_TTL_MS) so closing the tab for hours doesn't drop the user
  // mid-song much later.
  const RESUME_KEY     = 'fps_music_state';
  const RESUME_TTL_MS  = 5 * 60 * 1000;  // 5 minutes
  let   saveTimer      = null;
  let   pendingResumeTime = null;        // currentTime to seek to once Audio is ready

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

  function saveResumeState() {
    if (!audio || !playlist.length) return;
    try {
      const payload = {
        track: playlist[trackIndex] || null,
        time:  audio.currentTime || 0,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(RESUME_KEY, JSON.stringify(payload));
      // Also mirror to localStorage as a fallback — sessionStorage is
      // tab-scoped, but localStorage carries between same-origin tabs
      // and survives a full close → reopen within the TTL window.
      localStorage.setItem(RESUME_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function readResumeState() {
    try {
      // sessionStorage first — it scopes to this tab, so different
      // tabs each get their own current-position resume.
      const ss = sessionStorage.getItem(RESUME_KEY);
      if (ss) return JSON.parse(ss);
      const ls = localStorage.getItem(RESUME_KEY);
      if (ls) {
        const p = JSON.parse(ls);
        if (p && Date.now() - (p.savedAt || 0) < RESUME_TTL_MS) return p;
      }
    } catch (_) {}
    return null;
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

      // Resume from where the previous page left off if the snapshot is
      // recent and matches a track still in the playlist. Otherwise
      // honour the user's pinned pick or fall through to track 0.
      const resume = readResumeState();
      let idx = 0;
      if (resume?.track && playlist.includes(resume.track)
          && Date.now() - (resume.savedAt || 0) < RESUME_TTL_MS) {
        idx = playlist.indexOf(resume.track);
        pendingResumeTime = resume.time || 0;
      } else if (selectedTrack) {
        const i = playlist.indexOf(selectedTrack);
        if (i >= 0) idx = i;
        else selectedTrack = null;
      }
      trackIndex = idx;
      // Always attempt optimistic playback. Chrome's MEI auto-allows
      // playback on origins where the user has previously engaged with
      // audio, so after the first interaction on the site future
      // navigations resume without needing another click. The play()
      // rejection on locked browsers is caught inside loadTrack(); the
      // unlock-on-gesture path then takes over.
      loadTrack(idx, true);
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
    // Cross-page resume: seek to the previously-saved currentTime
    // once the browser has enough metadata to do so. canplay fires
    // earlier than loadedmetadata on some platforms — both are safe
    // to seek from.
    if (pendingResumeTime != null) {
      const seekTo = pendingResumeTime;
      pendingResumeTime = null;
      const trySeek = () => {
        try { audio.currentTime = seekTo; } catch (_) {}
      };
      audio.addEventListener('loadedmetadata', trySeek, { once: true });
      audio.addEventListener('canplay',        trySeek, { once: true });
    }
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
  // interaction on the new document. Listen on every trusted gesture
  // event so the smallest interaction (a click, key, touch, scroll
  // wheel) is enough to unlock playback. Chrome's MEI sometimes lets
  // playback start without any interaction at all — we try the optimistic
  // play first and only fall back to the unlock listener if it fails.
  const UNLOCK_EVENTS = ['pointerdown','pointerup','click','mousedown',
                         'keydown','keyup','touchstart','touchend','wheel'];
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (audio && !started) {
      audio.play().then(() => { started = true; refreshUI(); }).catch(() => {});
    }
    for (const ev of UNLOCK_EVENTS) {
      window.removeEventListener(ev, unlock, { capture: true });
    }
  }
  for (const ev of UNLOCK_EVENTS) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }

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
        /* Bumped up well above the legal-footer (which lives near the
           bottom edge) so the icon is always obviously clickable. */
        position: fixed; bottom: 80px; left: 22px; z-index: 9000;
        width: 50px; height: 50px; border-radius: 50%;
        background: rgba(30, 255, 74, 0.12);
        border: 1px solid rgba(30, 255, 74, 0.4);
        color: #1eff4a;
        font-size: 24px; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        transition: background 0.15s, transform 0.1s;
        display: flex; align-items: center; justify-content: center;
        padding: 0; line-height: 1;
      }
      #music-fab:hover { background: rgba(30, 255, 74, 0.22); transform: translateY(-1px); }
      #music-fab.playing { animation: musicFabPulse 1.6s ease-in-out infinite; }
      @keyframes musicFabPulse {
        0%,100% { box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 0 0 0 rgba(30,255,74,0.0); }
        50%     { box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 0 0 9px rgba(30,255,74,0.08); }
      }
      #music-modal {
        /* Anchored just above the FAB. */
        position: fixed; bottom: 142px; left: 22px; z-index: 9001;
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
  // Also snapshot the resume state so reopening the tab or navigating
  // away mid-song doesn't lose the position.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveResumeState();
      if (audio) { try { audio.pause(); } catch (_) {} }
    } else if (audio && unlocked) {
      audio.play().catch(() => {});
    }
  });

  // Save whenever the page is about to be torn down. pagehide fires on
  // both reload and cross-document navigation; beforeunload is the
  // belt-and-suspenders fallback.
  window.addEventListener('pagehide',     saveResumeState);
  window.addEventListener('beforeunload', saveResumeState);

  // Cheap periodic snapshot while playing so even a sudden tab close
  // (kill, crash) loses at most ~2 s of position. setInterval is fine
  // here — JSON serialise is microseconds.
  saveTimer = setInterval(() => {
    if (audio && !audio.paused) saveResumeState();
  }, 2000);

  injectUI();
  loadPlaylist();
})();
