// server/sockets/index.js — attach all socket namespaces
const shooterSocket = require('./shooterSocket');
const rpsSocket     = require('./rpsSocket');
const chatSocket    = require('./chatSocket');

function attachAll(io) {
  shooterSocket.attach(io);
  rpsSocket.attach(io);
  chatSocket.attach(io);
}

module.exports = { attachAll };
