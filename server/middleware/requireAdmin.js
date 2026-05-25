// server/middleware/requireAdmin.js
const { pool } = require('../db');

module.exports = async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT is_admin FROM users WHERE id = $1', [req.session.userId]
    );
    if (!rows.length || !rows[0].is_admin) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  } catch (e) {
    next(e);
  }
};
