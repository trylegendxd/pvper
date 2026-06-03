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
      <a href="/leaderboard.html">Leaderboard</a>
      <a href="/achievements.html">Achievements</a>
      <a href="/my-matches.html">My Matches</a>
      <a href="/wallet.html">Wallet</a>
      ${user?.is_admin ? '<a href="/admin.html" style="color:var(--gold)">Admin</a>' : ''}
    </div>
    <div class="user">
      ${user ? `
        <span class="username">${escapeHtml(user.username)}</span>
        <span class="balance">${fmtCredits(user.balance)}</span>
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

window.loadMe = loadMe;
window.renderTopbar = renderTopbar;
window.escapeHtml = escapeHtml;
