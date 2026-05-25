// server/sockets/index.js — attach all socket namespaces
const shooterSocket = require('./shooterSocket');
const rpsSocket     = require('./rpsSocket');

function attachAll(io) {
  shooterSocket.attach(io);
  rpsSocket.attach(io);
}

module.exports = { attachAll };
