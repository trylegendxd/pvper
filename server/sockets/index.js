// server/sockets/index.js — attach all socket namespaces
const shooterSocket = require('./shooterSocket');
const rpsSocket     = require('./rpsSocket');
const chatSocket    = require('./chatSocket');
const wheelSocket   = require('./wheelSocket');
const rrSocket      = require('./rrSocket');
const paperioSocket = require('./paperioSocket');

function attachAll(io) {
  shooterSocket.attach(io);
  rpsSocket.attach(io);
  chatSocket.attach(io);
  wheelSocket.attach(io);
  rrSocket.attach(io);
  paperioSocket.attach(io);
}

module.exports = { attachAll };
