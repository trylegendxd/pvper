// server/server.js — HTTP + Socket.IO entry
require('dotenv').config();
const http        = require('http');
const { Server }  = require('socket.io');
const { app, sessionMiddleware } = require('./app');
const { attachAll } = require('./sockets');
const { runMigrations } = require('./migrate');

const PORT = Number(process.env.PORT || 3000);

(async () => {
  // Auto-run migrations on every boot — idempotent (tracked in schema_migrations).
  // This means the free Render tier (no shell) can still get a fresh schema.
  try {
    const applied = await runMigrations();
    if (applied > 0) console.log(`[boot] applied ${applied} new migration(s)`);
  } catch (e) {
    console.error('[boot] migration failed:', e.message);
    process.exit(1);
  }

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: process.env.CORS_ORIGIN
      ? { origin: process.env.CORS_ORIGIN, credentials: true }
      : undefined,
  });

  // Share express-session with Socket.IO so we can read req.session.userId
  io.engine.use(sessionMiddleware);

  attachAll(io);

  server.listen(PORT, () => {
    console.log(`▶  FPS Arena Platform   →  http://localhost:${PORT}`);
    console.log(`   Shooter         /games/shooter`);
    console.log(`   RPS             /games/rps`);
    console.log(`   Roulette        /games/roulette`);
    console.log(`   Blackjack       /games/blackjack`);
    console.log(`   Admin (admins)  /admin`);
  });
})();
