// public/js/auth.js — fetches /me, fills the topbar, logs out
async function loadMe() {
  try {
    const { user } = await api('/api/auth/me');
    return user;
  } catch (e) {
    return null;
  }
}

async function renderTopbar({ requireUser = true } = {}) {
  const user = await loadMe();
  if (!user && requireUser) {
    location.href = '/login.html';
    return null;
  }
  const tb = document.getElementById('topbar');
  if (!tb) return user;
  tb.innerHTML = `
    <div class="brand"><span class="accent">FPS</span> ARENA</div>
    <div class="nav">
      <a href="/dashboard.html">Hub</a>
      <a href="/games/shooter.html">Shooter</a>
      <a href="/games/rps.html">RPS</a>
      <a href="/games/roulette.html">Roulette</a>
      <a href="/games/blackjack.html">Blackjack</a>
      <a href="/games/mines.html">Mines</a>
      <a href="/games/wheel.html">Wheel</a>
      <a href="/games/russian-roulette.html">Russian RL</a>
      <a href="/leaderboard.html">Leaderboard</a>
      <a href="/friends.html">Friends</a>
      <a href="/achievements.html">Achievements</a>
      <a href="/my-matches.html">My Matches</a>
      <a href="/profile-edit.html">Profile</a>
      <a href="/wallet.html">Wallet</a>
      ${user?.is_admin ? '<a href="/admin.html" style="color:var(--gold)">Admin</a>' : ''}
    </div>
    <div class="user">
      ${user ? `
        <a href="/profile-edit.html" class="user-chip" title="Edit profile" style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:inherit;">
          ${avatarChip(user)}
          <span class="username">${escapeHtml(user.display_name || user.username)}</span>
        </a>
        <span class="balance">${fmtCredits(user.balance)}</span>
        <a href="/wallet.html" id="deposit-btn" title="Add funds / deposit"
           style="display:inline-flex;align-items:center;gap:5px;text-decoration:none;
                  background:linear-gradient(180deg,#1fcf5b,#169c46);color:#04220e;
                  font-weight:700;font-size:12px;letter-spacing:1px;padding:6px 13px;
                  border-radius:4px;">＋ DEPOSIT</a>
        <button id="logout-btn">Logout</button>
      ` : `<a href="/login.html">Login</a>`}
    </div>
  `;
  const lb = document.getElementById('logout-btn');
  if (lb) lb.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });
  return user;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Small avatar bubble for the topbar. Falls back to the first
// initial of the username when no avatar is uploaded.
function avatarChip(user) {
  if (!user) return '';
  const initial = (user.display_name || user.username || '?')[0].toUpperCase();
  if (user.avatar) {
    return `<img class="avatar-chip" src="${user.avatar}" alt="" referrerpolicy="no-referrer"
              style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.18);">`;
  }
  return `<span class="avatar-chip"
            style="width:28px;height:28px;border-radius:50%;background:#2a3548;color:#cdd4dc;
                   display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;border:1px solid rgba(255,255,255,0.12);">
            ${escapeHtml(initial)}
          </span>`;
}

window.loadMe = loadMe;
window.renderTopbar = renderTopbar;
window.escapeHtml = escapeHtml;
window.avatarChip = avatarChip;
