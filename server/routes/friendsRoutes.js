// server/routes/friendsRoutes.js
// REST endpoints for the social layer (friends list + requests).
// Push notifications (request received, accepted, rejected, removed) go
// out via the /chat namespace so the UI updates without a refresh.
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { pool } = require('../db');

const router = express.Router();
router.use(requireAuth);

// Helpers — canonical pair so the UNIQUE(user_a,user_b) index does its job.
function pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// Push a social-event payload to one user's chat-namespace room.
// Safe no-op if Socket.IO isn't attached (e.g. during tests).
function pushToUser(app, userId, event, data) {
  try {
    const io = app.locals.io;
    if (!io) return;
    io.of('/chat').to(`u:${userId}`).emit(event, data || {});
  } catch (e) {
    // Real-time push should never break a REST response.
    console.warn('[friends] push failed', e.message);
  }
}

// Fetch the requester's username — small helper used by push events.
async function lookupUsername(userId) {
  const { rows } = await pool.query('SELECT username FROM users WHERE id=$1', [userId]);
  return rows[0]?.username || null;
}

// ── GET /api/friends ───────────────────────────────────────────────────────
// Returns three lists: friends (accepted), incoming (requests *to* me),
// outgoing (requests *from* me).
router.get('/', async (req, res) => {
  const me = req.session.userId;
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.user_a, f.user_b, f.requester_id, f.status, f.created_at,
              ua.username AS user_a_name, ua.display_name AS user_a_dname, ua.avatar AS user_a_avatar,
              ub.username AS user_b_name, ub.display_name AS user_b_dname, ub.avatar AS user_b_avatar
         FROM friendships f
         JOIN users ua ON ua.id = f.user_a
         JOIN users ub ON ub.id = f.user_b
        WHERE (f.user_a = $1 OR f.user_b = $1)
          AND f.status IN ('pending','accepted')
     ORDER BY f.created_at DESC`,
      [me]
    );
    const friends  = [];
    const incoming = [];
    const outgoing = [];
    for (const r of rows) {
      const amA = r.user_a === me;
      const otherId     = amA ? r.user_b        : r.user_a;
      const otherName   = amA ? r.user_b_name   : r.user_a_name;
      const otherDName  = amA ? r.user_b_dname  : r.user_a_dname;
      const otherAvatar = amA ? r.user_b_avatar : r.user_a_avatar;
      const entry = {
        id: r.id, userId: otherId, username: otherName,
        // Prefer the display name for UI; fall back to the username.
        displayName: otherDName || otherName,
        avatar: otherAvatar || null,
        createdAt: r.created_at,
      };
      if (r.status === 'accepted') friends.push(entry);
      else if (r.requester_id === me) outgoing.push(entry);
      else incoming.push(entry);
    }
    res.json({ ok: true, friends, incoming, outgoing });
  } catch (e) {
    res.status(400).json({ error: e.message || 'friends_failed' });
  }
});

// ── POST /api/friends/request  { username } ──────────────────────────────
router.post('/request', async (req, res) => {
  const me = req.session.userId;
  try {
    const username = String(req.body?.username || '').trim();
    if (!username) return res.status(400).json({ error: 'missing_username' });
    const { rows: urows } = await pool.query(
      'SELECT id FROM users WHERE lower(username) = lower($1)',
      [username]
    );
    if (!urows.length) return res.status(404).json({ error: 'user_not_found' });
    const targetId = urows[0].id;
    if (targetId === me) return res.status(400).json({ error: 'cannot_befriend_self' });

    const [ua, ub] = pair(me, targetId);
    // Upsert: if already exists and is pending OR accepted, surface that state.
    const { rows: exRows } = await pool.query(
      `SELECT id, status, requester_id FROM friendships WHERE user_a=$1 AND user_b=$2`,
      [ua, ub]
    );
    if (exRows.length) {
      const r = exRows[0];
      if (r.status === 'accepted') return res.json({ ok: true, status: 'already_friends' });
      if (r.status === 'pending') {
        // If the OTHER user already sent us a request, accept it now.
        if (r.requester_id !== me) {
          await pool.query(
            `UPDATE friendships SET status='accepted', responded_at=NOW() WHERE id=$1`,
            [r.id]
          );
          const meName = await lookupUsername(me);
          // Both sides see each other as a new friend.
          pushToUser(req.app, targetId, 'friend_added',
            { userId: me, username: meName });
          pushToUser(req.app, me, 'friend_added',
            { userId: targetId, username });
          return res.json({ ok: true, status: 'accepted' });
        }
        return res.json({ ok: true, status: 'pending' });
      }
      if (r.status === 'blocked') return res.status(403).json({ error: 'blocked' });
    }
    await pool.query(
      `INSERT INTO friendships (user_a, user_b, requester_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [ua, ub, me]
    );
    // Push the new request to the target so they see it immediately.
    const meName = await lookupUsername(me);
    pushToUser(req.app, targetId, 'friend_request_received', {
      fromUserId: me, fromUsername: meName,
    });
    res.json({ ok: true, status: 'pending' });
  } catch (e) {
    res.status(400).json({ error: e.message || 'request_failed' });
  }
});

// ── POST /api/friends/accept  { requestId }  ─────────────────────────────
router.post('/accept', async (req, res) => {
  const me = req.session.userId;
  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ error: 'missing_id' });
    const { rows } = await pool.query(
      `SELECT id, user_a, user_b, requester_id, status FROM friendships WHERE id=$1`,
      [requestId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const r = rows[0];
    if (r.user_a !== me && r.user_b !== me) return res.status(403).json({ error: 'forbidden' });
    if (r.requester_id === me) return res.status(400).json({ error: 'cannot_accept_own_request' });
    if (r.status === 'accepted') return res.json({ ok: true, status: 'accepted' });
    await pool.query(
      `UPDATE friendships SET status='accepted', responded_at=NOW() WHERE id=$1`,
      [requestId]
    );
    // Notify both sides so neither needs a refresh.
    const meName       = await lookupUsername(me);
    const otherId      = r.requester_id;
    const otherName    = await lookupUsername(otherId);
    pushToUser(req.app, otherId, 'friend_added', { userId: me, username: meName });
    pushToUser(req.app, me,      'friend_added', { userId: otherId, username: otherName });
    res.json({ ok: true, status: 'accepted' });
  } catch (e) {
    res.status(400).json({ error: e.message || 'accept_failed' });
  }
});

// ── POST /api/friends/reject  { requestId }  ─────────────────────────────
router.post('/reject', async (req, res) => {
  const me = req.session.userId;
  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ error: 'missing_id' });
    const { rows } = await pool.query(
      `SELECT id, user_a, user_b, status FROM friendships WHERE id=$1`,
      [requestId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const r = rows[0];
    if (r.user_a !== me && r.user_b !== me) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM friendships WHERE id=$1`, [requestId]);
    // If I rejected an INCOMING request, tell the requester so their
    // "outgoing" list updates without a refresh.
    if (r.requester_id !== me) {
      pushToUser(req.app, r.requester_id, 'friend_request_rejected', {
        byUserId: me,
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'reject_failed' });
  }
});

// ── DELETE /api/friends/:userId — unfriend ──────────────────────────────
router.delete('/:userId', async (req, res) => {
  const me = req.session.userId;
  const otherId = req.params.userId;
  try {
    const [ua, ub] = pair(me, otherId);
    await pool.query(
      `DELETE FROM friendships WHERE user_a=$1 AND user_b=$2`,
      [ua, ub]
    );
    // Push to both sides so each friend list refreshes immediately.
    pushToUser(req.app, otherId, 'friend_removed', { userId: me });
    pushToUser(req.app, me,      'friend_removed', { userId: otherId });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'remove_failed' });
  }
});

// ── GET /api/chat/:userId — last 50 messages between me and userId ──────
router.get('/chat/:userId', async (req, res) => {
  const me = req.session.userId;
  const other = req.params.userId;
  try {
    const { rows } = await pool.query(
      `SELECT id, from_user_id, to_user_id, body, created_at, read_at
         FROM chat_messages
        WHERE (from_user_id = $1 AND to_user_id = $2)
           OR (from_user_id = $2 AND to_user_id = $1)
     ORDER BY created_at DESC
        LIMIT 50`,
      [me, other]
    );
    // Mark inbound as read.
    await pool.query(
      `UPDATE chat_messages SET read_at = NOW()
        WHERE to_user_id = $1 AND from_user_id = $2 AND read_at IS NULL`,
      [me, other]
    );
    res.json({ ok: true, messages: rows.reverse() });
  } catch (e) {
    res.status(400).json({ error: e.message || 'chat_failed' });
  }
});

module.exports = router;
