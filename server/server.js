// server/server.js — HTTP + Socket.IO entry
require('dotenv').config();
const http        = require('http');
const { Server }  = require('socket.io');
const { app, sessionMiddleware } = require('./app');
const { attachAll } = require('./sockets');

const PORT = Number(process.env.PORT || 3000);

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
