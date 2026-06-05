// public/js/friends.js
// Friends list + DM panel for the dashboard.
//
// Depends on:
//   - api()           from /js/api.js (cookie-credentialed fetch wrapper)
//   - escapeHtml()    from /js/auth.js
//   - socket.io client served at /socket.io/socket.io.js
//
// Renders into #friends-root which is injected into the dashboard.
(function () {
  const STATE = {
    me: null,
    friends: [],         // [{ userId, username, displayName, avatar }]
    incoming: [],        // [{ id, userId, username, displayName, avatar }]
    outgoing: [],        // [{ id, userId, username, displayName, avatar }]
    activeChat: null,    // userId currently open
    presence: new Set(), // userIds currently online
    socket: null,
    messageCache: {},    // userId → array of {from_user_id, body, created_at}
  };

  async function load() {
    try {
      const r = await api('/api/friends');
      STATE.friends  = r.friends  || [];
      STATE.incoming = r.incoming || [];
      STATE.outgoing = r.outgoing || [];
      render();
    } catch (e) {
      console.error('[friends] load failed', e);
    }
  }

  function connectSocket() {
    if (STATE.socket) return;
    if (!window.io) return;
    const s = io('/chat', { withCredentials: true, transports: ['websocket','polling'] });
    STATE.socket = s;
    s.on('presence_snapshot', d => {
      STATE.presence = new Set(d?.online || []);
      render();
    });
    s.on('presence_update', d => {
      if (!d) return;
      if (d.online) STATE.presence.add(d.userId);
      else STATE.presence.delete(d.userId);
      render();
    });
    s.on('dm', msg => {
      const other = msg.from_user_id === STATE.me?.id ? msg.to_user_id : msg.from_user_id;
      const arr = STATE.messageCache[other] = STATE.messageCache[other] || [];
      arr.push(msg);
      if (STATE.activeChat === other) renderMessages();
      else flashUnread(other);
    });

    // ── Real-time friend updates — refresh lists without a page reload ──
    s.on('friend_request_received', d => {
      load();
      notify(`${d?.fromUsername || 'Someone'} sent you a friend request.`);
    });
    s.on('friend_added',            () => { load(); });
    s.on('friend_request_rejected', () => { load(); });
    s.on('friend_removed',          d => {
      if (STATE.activeChat === d?.userId) STATE.activeChat = null;
      load();
    });
  }

  // Small in-page toast (no external CSS needed).
  function notify(text) {
    let host = document.getElementById('friend-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'friend-toast-host';
      host.style.cssText = 'position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:9999;';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.style.cssText = 'background:rgba(20,24,32,.95);border:1px solid #4b9eff;color:#fff;padding:10px 14px;border-radius:5px;font-size:13px;letter-spacing:1px;box-shadow:0 8px 18px rgba(0,0,0,.45);opacity:0;transition:opacity .2s ease;';
    t.textContent = text;
    host.appendChild(t);
    setTimeout(() => t.style.opacity = '1', 10);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 4500);
  }

  function flashUnread(userId) {
    const el = document.querySelector(`[data-friend="${userId}"]`);
    if (el) el.classList.add('has-unread');
  }

  // Small round avatar (display picture). Falls back to the first initial
  // of the display name when the user hasn't uploaded one.
  function avatarHtml(f) {
    const name = f.displayName || f.username || '?';
    const base = 'width:22px;height:22px;border-radius:50%;flex-shrink:0;object-fit:cover;'
               + 'border:1px solid rgba(255,255,255,0.16);';
    if (f.avatar) {
      return `<img src="${f.avatar}" alt="" referrerpolicy="no-referrer" style="${base}">`;
    }
    const initial = escapeHtml(String(name)[0].toUpperCase());
    return `<span style="${base}display:inline-flex;align-items:center;justify-content:center;`
         + `background:#2a3548;color:#cdd4dc;font-size:11px;font-weight:700;">${initial}</span>`;
  }

  function render() {
    const root = document.getElementById('friends-root');
    if (!root) return;
    const friendItems = STATE.friends.map(f => {
      const isOnline = STATE.presence.has(f.userId);
      return `
        <li class="friend-row${STATE.activeChat === f.userId ? ' active' : ''}"
            data-friend="${f.userId}">
          <button class="friend-link" data-open="${f.userId}">
            <span class="dot ${isOnline ? 'on' : 'off'}"></span>
            ${avatarHtml(f)}
            <span class="name">${escapeHtml(f.displayName || f.username)}</span>
          </button>
          <button class="x" title="Unfriend" data-unfriend="${f.userId}">×</button>
        </li>
      `;
    }).join('') || '<li class="empty">No friends yet.</li>';

    const incomingItems = STATE.incoming.map(r => `
      <li class="req-row">
        ${avatarHtml(r)}
        <span>${escapeHtml(r.displayName || r.username)}</span>
        <button class="ok" data-accept="${r.id}">Accept</button>
        <button class="no" data-reject="${r.id}">×</button>
      </li>
    `).join('') || '<li class="empty">No incoming requests.</li>';

    const outgoingItems = STATE.outgoing.map(r => `
      <li class="req-row out">
        ${avatarHtml(r)}
        <span>${escapeHtml(r.displayName || r.username)}</span>
        <span class="status">Pending…</span>
        <button class="no" data-reject="${r.id}">×</button>
      </li>
    `).join('') || '';

    root.innerHTML = `
      <div class="friends-panel">
        <div class="fp-header">
          <h3>FRIENDS</h3>
          <form class="add-form" id="add-friend-form">
            <input type="text" id="add-friend-username" maxlength="24" placeholder="username">
            <button type="submit">+ Add</button>
          </form>
        </div>
        ${STATE.incoming.length ? `<div class="fp-sub">Incoming requests</div><ul class="req-list">${incomingItems}</ul>` : ''}
        ${STATE.outgoing.length ? `<div class="fp-sub">Outgoing requests</div><ul class="req-list">${outgoingItems}</ul>` : ''}
        <div class="fp-sub">Your friends</div>
        <ul class="friend-list">${friendItems}</ul>
      </div>
      <div class="chat-panel" id="chat-panel">
        ${STATE.activeChat ? `
          <div class="cp-header">
            <span>${escapeHtml((STATE.friends.find(f => f.userId === STATE.activeChat) || {}).displayName || '?')}</span>
            <button id="close-chat">×</button>
          </div>
          <div class="cp-log" id="cp-log"></div>
          <form class="cp-form" id="cp-form">
            <input type="text" id="cp-input" maxlength="500" placeholder="Message…" autocomplete="off">
            <button type="submit">Send</button>
          </form>
        ` : `<div class="cp-empty">Select a friend to chat.</div>`}
      </div>
    `;
    wireEvents();
    if (STATE.activeChat) renderMessages();
  }

  function wireEvents() {
    const addForm = document.getElementById('add-friend-form');
    if (addForm) addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('add-friend-username');
      const username = (input.value || '').trim();
      if (!username) return;
      try {
        const r = await api('/api/friends/request', { method: 'POST', body: { username } });
        input.value = '';
        if (r.status === 'already_friends') alert('Already friends.');
        else if (r.status === 'accepted')   alert('Request auto-accepted (they had already sent you one).');
        await load();
      } catch (e) {
        const friendly = ({
          user_not_found:         'No user with that name.',
          cannot_befriend_self:   'You cannot befriend yourself.',
          missing_username:       'Enter a username first.',
          blocked:                'You cannot send a request to that user.',
        })[e.message] || (e.message || 'Could not send request.');
        alert(friendly);
      }
    });

    document.querySelectorAll('[data-open]').forEach(b => {
      b.addEventListener('click', () => openChat(b.dataset.open));
    });
    document.querySelectorAll('[data-accept]').forEach(b => {
      b.addEventListener('click', async () => {
        await api('/api/friends/accept', { method: 'POST', body: { requestId: b.dataset.accept } }).catch(() => {});
        load();
      });
    });
    document.querySelectorAll('[data-reject]').forEach(b => {
      b.addEventListener('click', async () => {
        await api('/api/friends/reject', { method: 'POST', body: { requestId: b.dataset.reject } }).catch(() => {});
        load();
      });
    });
    document.querySelectorAll('[data-unfriend]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('Unfriend?')) return;
        await api('/api/friends/' + b.dataset.unfriend, { method: 'DELETE' }).catch(() => {});
        if (STATE.activeChat === b.dataset.unfriend) STATE.activeChat = null;
        load();
      });
    });
    const closeBtn = document.getElementById('close-chat');
    if (closeBtn) closeBtn.addEventListener('click', () => { STATE.activeChat = null; render(); });
    const form = document.getElementById('cp-form');
    if (form) form.addEventListener('submit', sendMessage);
  }

  async function openChat(userId) {
    STATE.activeChat = userId;
    document.querySelector(`[data-friend="${userId}"]`)?.classList.remove('has-unread');
    try {
      const r = await api('/api/friends/chat/' + userId);
      STATE.messageCache[userId] = r.messages || [];
    } catch (_) {
      STATE.messageCache[userId] = [];
    }
    render();
  }

  function renderMessages() {
    const log = document.getElementById('cp-log');
    if (!log) return;
    const msgs = STATE.messageCache[STATE.activeChat] || [];
    log.innerHTML = msgs.map(m => {
      const mine = m.from_user_id === STATE.me?.id;
      return `<div class="msg ${mine ? 'mine' : 'theirs'}">${escapeHtml(m.body)}</div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  async function sendMessage(e) {
    e.preventDefault();
    const input = document.getElementById('cp-input');
    const text = (input.value || '').trim();
    if (!text || !STATE.activeChat) return;
    input.value = '';
    STATE.socket?.emit('dm', { toUserId: STATE.activeChat, body: text }, (res) => {
      if (res?.error) alert(res.error);
    });
  }

  async function init() {
    STATE.me = await loadMe();
    if (!STATE.me) return;
    connectSocket();
    await load();
  }

  window.FriendsPanel = { init, load };
})();
