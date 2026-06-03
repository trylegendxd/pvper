// public/js/notifications.js
// ============================================================================
//  Cross-page notification banner.
//
//  Loaded after auth.js on every page. Connects to the /chat namespace
//  (the same one chatSocket uses for DM presence + invites), shows a
//  toast/banner when the server delivers a `team_invite_received`
//  payload regardless of which page the user is on, and on Accept
//  redirects to /games/shooter.html?inv=<teamId> so the shooter page
//  can auto-fire mm_invite_accept once it boots.
//
//  Socket.IO is loaded lazily — pages like /wallet.html don't include
//  socket.io by default, so we inject the script tag if window.io is
//  missing.
// ============================================================================

(function () {
  const STYLE_ID = 'notif-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #notif-host {
        position: fixed; top: 18px; right: 22px; z-index: 9500;
        display: flex; flex-direction: column; gap: 8px;
        max-width: 360px; pointer-events: none;
      }
      .notif-card {
        background: #161c25;
        border: 1px solid rgba(255, 206, 74, 0.45);
        border-left: 4px solid var(--gold, #ffce4a);
        border-radius: 6px;
        padding: 14px 16px;
        box-shadow: 0 8px 36px rgba(0,0,0,0.6);
        color: #fff;
        pointer-events: auto;
        transform: translateX(120%);
        opacity: 0;
        transition: transform .35s cubic-bezier(.2,1.2,.4,1), opacity .25s;
      }
      .notif-card.show { transform: translateX(0); opacity: 1; }
      .notif-eyebrow {
        font-size: 9px; letter-spacing: 3px;
        color: #ffce4a; font-weight: 700; margin-bottom: 4px;
      }
      .notif-body { font-size: 13px; line-height: 1.4; margin-bottom: 8px; color: #cdd4dc; }
      .notif-body strong { color: #fff; }
      .notif-actions { display: flex; gap: 6px; }
      .notif-btn {
        flex: 1; padding: 7px 10px; font-size: 11px; letter-spacing: 2px;
        cursor: pointer; font-family: inherit; border: 1px solid;
      }
      .notif-btn.accept { background: rgba(127, 217, 122, 0.12); border-color: rgba(127, 217, 122, 0.6); color: #7fd97a; }
      .notif-btn.accept:hover { background: rgba(127, 217, 122, 0.22); }
      .notif-btn.decline { background: transparent; border-color: rgba(255, 100, 100, 0.5); color: #ff8080; }
      .notif-btn.decline:hover { background: rgba(255, 100, 100, 0.12); }
    `;
    document.head.appendChild(s);
  }

  function ensureHost() {
    let host = document.getElementById('notif-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'notif-host';
      document.body.appendChild(host);
    }
    return host;
  }

  function showInviteCard(data, onAccept, onDecline) {
    ensureStyle();
    const host = ensureHost();
    const card = document.createElement('div');
    card.className = 'notif-card';
    const tier = (data.tier || '').toUpperCase();
    const size = data.teamSize;
    card.innerHTML = `
      <div class="notif-eyebrow">TEAM INVITE</div>
      <div class="notif-body">
        <strong>${esc(data.fromUsername || 'A friend')}</strong>
        invited you to join a <strong>${esc(tier)}</strong>
        <strong>${size}v${size}</strong>
        (${data.filled}/${size} · ${data.bet} cr).
      </div>
      <div class="notif-actions">
        <button class="notif-btn accept">ACCEPT</button>
        <button class="notif-btn decline">DECLINE</button>
      </div>
    `;
    host.appendChild(card);
    requestAnimationFrame(() => card.classList.add('show'));
    card.querySelector('.accept').addEventListener('click', () => {
      onAccept?.(); dismiss(card);
    });
    card.querySelector('.decline').addEventListener('click', () => {
      onDecline?.(); dismiss(card);
    });
    // Auto-dismiss after 88 s (just under the server's 90 s TTL).
    setTimeout(() => dismiss(card), 88000);
    return card;
  }

  function dismiss(card) {
    card.classList.remove('show');
    setTimeout(() => card.remove(), 350);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }

  async function loadSocketIO() {
    if (window.io) return window.io;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/socket.io/socket.io.js';
      s.onload = () => resolve(window.io);
      s.onerror = () => reject(new Error('socket_io_load_failed'));
      document.head.appendChild(s);
    });
  }

  async function start() {
    // Bail if the user isn't logged in — /api/auth/me returns null.
    try {
      const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.json());
      if (!me?.user) return;
    } catch (_) { return; }

    let io;
    try { io = await loadSocketIO(); }
    catch (_) { return; /* socket.io unavailable — silently skip */ }

    const sock = io('/chat', { withCredentials: true, transports: ['websocket', 'polling'] });

    sock.on('team_invite_received', (data) => {
      if (!data?.teamId) return;
      showInviteCard(data, () => {
        // Accept: navigate to the shooter page with ?inv=<teamId>; the
        // shooter page handles auto-accept on boot.
        window.location.href = data.joinUrl || ('/games/shooter.html?inv=' + encodeURIComponent(data.teamId));
      }, () => {
        sock.emit('team_invite_decline', { teamId: data.teamId, fromUserId: data.fromUserId });
      });
    });
    sock.on('team_invite_expired', () => {
      // Banner self-expires; no-op here. Could close stale cards if we
      // wanted to track them by teamId.
    });

    // Expose so other scripts (like friends.js) can avoid double-
    // connecting if they reuse the same namespace.
    window.NotificationsSocket = sock;
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(start, 0);
  } else {
    window.addEventListener('DOMContentLoaded', start);
  }
})();
