// server/routes/friendsRoutes.js
// REST endpoints for the social layer (friends list + requests).
// Real-time delivery of accepted/online events is handled by chatSocket.
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { pool } = require('../db');

const router = express.Router();
router.use(requireAuth);

// Helpers — canonical pair so the UNIQUE(user_a,user_b) index does its job.
function pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// ── GET /api/friends ───────────────────────────────────────────────────────
// Returns three lists: friends (accepted), incoming (requests *to* me),
// outgoing (requests *from* me).
router.get('/', async (req, res) => {
  const me = req.session.userId;
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.user_a, f.user_b, f.requester_id, f.status, f.created_at,
              ua.username AS user_a_name, ub.username AS user_b_name
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
      const otherId   = r.user_a === me ? r.user_b   : r.user_a;
      const otherName = r.user_a === me ? r.user_b_name : r.user_a_name;
      const entry = { id: r.id, userId: otherId, username: otherName, createdAt: r.created_at };
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
