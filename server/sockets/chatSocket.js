// server/sockets/chatSocket.js
// ============================================================================
//  /chat namespace — direct messages between friends + online presence.
//
//  Auth: cookie session (same pattern as /shooter).
//  Rooms: each user joins a personal room named after their user id, so
//  any of their devices receive incoming DMs.
//  Storage: messages are persisted to chat_messages and the recipient
//  is notified live if they are connected.
// ============================================================================
const { pool } = require('../db');

// userId → Set<socket.id> for presence tracking
const online = new Map();

function isFriend(userA, userB) {
  const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
  return pool.query(
    `SELECT 1 FROM friendships WHERE user_a=$1 AND user_b=$2 AND status='accepted'`,
    [a, b]
  ).then(r => r.rows.length > 0);
}

function attach(io) {
  const ns = io.of('/chat');
  ns.use((socket, next) => {
    const userId = socket.request?.session?.userId;
    if (!userId) return next(new Error('not_authenticated'));
    socket.data.userId = userId;
    next();
  });

  ns.on('connection', async (socket) => {
    const userId = socket.data.userId;
    socket.join(`u:${userId}`);

    // Track presence
    let set = online.get(userId);
    if (!set) { set = new Set(); online.set(userId, set); }
    set.add(socket.id);
    const wasOffline = set.size === 1;
    if (wasOffline) await broadcastPresenceToFriends(ns, userId, true);

    // Send initial presence snapshot of my friends
    try {
      const { rows } = await pool.query(
        `SELECT CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END AS friend_id
           FROM friendships f
          WHERE (f.user_a = $1 OR f.user_b = $1) AND f.status = 'accepted'`,
        [userId]
      );
      const onlineFriends = rows
        .map(r => r.friend_id)
        .filter(id => (online.get(id)?.size || 0) > 0);
      socket.emit('presence_snapshot', { online: onlineFriends });
    } catch (e) { /* swallow */ }

    // ── dm: send a direct message to a friend ─────────────────────────
    socket.on('dm', async ({ toUserId, body } = {}, cb) => {
      try {
        const text = String(body || '').trim();
        if (!toUserId || !text) return cb?.({ error: 'missing_fields' });
        if (text.length > 500) return cb?.({ error: 'too_long' });
        if (toUserId === userId) return cb?.({ error: 'cannot_dm_self' });
        if (!(await isFriend(userId, toUserId))) return cb?.({ error: 'not_friends' });

        const { rows } = await pool.query(
          `INSERT INTO chat_messages (from_user_id, to_user_id, body)
             VALUES ($1, $2, $3)
           RETURNING id, from_user_id, to_user_id, body, created_at`,
          [userId, toUserId, text]
        );
        const msg = rows[0];
        // Deliver to recipient (all their sockets) and echo back to sender.
        ns.to(`u:${toUserId}`).emit('dm', msg);
        socket.emit('dm', msg);
        cb?.({ ok: true, message: msg });
      } catch (e) {
        cb?.({ error: e.message || 'dm_failed' });
      }
    });

    // ── typing indicator (best-effort, not persisted) ─────────────────
    socket.on('typing', ({ toUserId } = {}) => {
      if (!toUserId || toUserId === userId) return;
      ns.to(`u:${toUserId}`).emit('typing', { fromUserId: userId });
    });

    // ── Team invite decline (cross-page) ──────────────────────────────
    // Friend declined via the notification banner from a non-shooter
    // page. Relay through BOTH /chat and /shooter so the inviter sees
    // a "X declined" toast wherever they happen to be sitting.
    socket.on('team_invite_decline', ({ teamId, fromUserId } = {}) => {
      if (!fromUserId || !teamId) return;
      pool.query('SELECT username FROM users WHERE id=$1', [userId])
        .then(({ rows }) => {
          const byName = rows[0]?.username || 'Friend';
          // /chat relay — anywhere notifications.js is loaded.
          ns.to(`u:${fromUserId}`).emit('team_invite_declined', {
            teamId, byUserId: userId, byUsername: byName,
          });
          // /shooter relay — the inviter is probably here. /shooter
          // doesn't use u:<userId> rooms so we walk the connected
          // sockets and emit directly.
          const shooterNs = io.of('/shooter');
          for (const [sid, sock] of shooterNs.sockets) {
            if (sock?.data?.userId === fromUserId) {
              shooterNs.to(sid).emit('mm_invite_declined', {
                userId: userId, username: byName,
              });
            }
          }
        }).catch(() => {});
    });

    socket.on('disconnect', async () => {
      const s = online.get(userId);
      if (s) {
        s.delete(socket.id);
        if (!s.size) {
          online.delete(userId);
          await broadcastPresenceToFriends(ns, userId, false).catch(() => {});
        }
      }
    });
  });
}

async function broadcastPresenceToFriends(ns, userId, isOnline) {
  try {
    const { rows } = await pool.query(
      `SELECT CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END AS friend_id
         FROM friendships f
        WHERE (f.user_a = $1 OR f.user_b = $1) AND f.status = 'accepted'`,
      [userId]
    );
    for (const r of rows) {
      ns.to(`u:${r.friend_id}`).emit('presence_update', { userId, online: isOnline });
    }
  } catch (_) { /* swallow */ }
}

module.exports = { attach };
