// server/sockets/index.js — attach all socket namespaces
const shooterSocket = require('./shooterSocket');
const rpsSocket     = require('./rpsSocket');
const chatSocket    = require('./chatSocket');
const wheelSocket   = require('./wheelSocket');

function attachAll(io) {
  shooterSocket.attach(io);
  rpsSocket.attach(io);
  chatSocket.attach(io);
  wheelSocket.attach(io);
}

module.exports = { attachAll };
