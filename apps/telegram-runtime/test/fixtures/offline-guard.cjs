// Preload in every test process, including subprocesses. Fail BEFORE opening a socket.
const deny = () => { throw new Error('OFFLINE_GUARD_NETWORK_FORBIDDEN'); };
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) { const mod = require(name); mod.request = deny; mod.get = deny; }
const net = require('node:net'); net.connect = deny; net.createConnection = deny;
net.Socket.prototype.connect = deny; net.Server.prototype.listen = deny;
require('node:tls').connect = deny;
require('node:dgram').createSocket = deny;
require('node:module').syncBuiltinESMExports();
