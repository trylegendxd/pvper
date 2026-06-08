// server/sockets/index.js — attach all socket namespaces
const shooterSocket = require('./shooterSocket');
const rpsSocket     = require('./rpsSocket');
const chatSocket    = require('./chatSocket');
const wheelSocket   = require('./wheelSocket');
const rrSocket      = require('./rrSocket');
const liarsBarSocket = require('./liarsBarSocket');
const paperioSocket = require('./paperioSocket');

function attachAll(io) {
  shooterSocket.attach(io);
  rpsSocket.attach(io);
  chatSocket.attach(io);
  wheelSocket.attach(io);
  rrSocket.attach(io);          // legacy /rr namespace (kept for safety)
  liarsBarSocket.attach(io);    // /lb — Liar's Bar (replaces Russian Roulette)
  paperioSocket.attach(io);
}

module.exports = { attachAll };
