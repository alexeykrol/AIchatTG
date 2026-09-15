// Preloaded into the Node test coordinator and every historical test subprocess.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const denyNetwork = () => { throw new Error('FROZEN_ROUTING_NETWORK_FORBIDDEN'); };
globalThis.fetch = denyNetwork;
for (const name of ['node:http', 'node:https']) {
  const module = require(name); module.request = denyNetwork; module.get = denyNetwork;
}
const net = require('node:net');
net.connect = denyNetwork; net.createConnection = denyNetwork;
net.Socket.prototype.connect = denyNetwork; net.Server.prototype.listen = denyNetwork;
require('node:tls').connect = denyNetwork;
require('node:dgram').createSocket = denyNetwork;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) {
  require('node:dns')[name] = denyNetwork;
  require('node:dns').promises[name] = denyNetwork;
}
const checkPath = (value) => {
  if (typeof value === 'number') return;
  const text = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  if (typeof text === 'string' && path.resolve(text).split(path.sep).some((part) => /^\.env(?:\.|$)/u.test(part))) {
    throw new Error('FROZEN_ROUTING_CREDENTIAL_READ_FORBIDDEN');
  }
};
for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) {
  const original = fs[name];
  fs[name] = function (file, ...args) { checkPath(file); return original.call(this, file, ...args); };
}
for (const name of ['readFile', 'open']) {
  const original = fs.promises[name];
  fs.promises[name] = async function (file, ...args) { checkPath(file); return original.call(this, file, ...args); };
}
require('node:module').syncBuiltinESMExports();
