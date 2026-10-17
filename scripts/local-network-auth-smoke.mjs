import { networkInterfaces, tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { networkWriteAuth } from '../packages/daemon/dist/middleware/network-write-auth.js';

// Standalone local socket proof. Every URL is this process's ephemeral test
// listener on an address enumerated on this machine. No production HTTP route,
// user database, tmux command, provider executable or Telegram API is involved.
const home = fs.mkdtempSync(path.join(tmpdir(), 'openrig-auth-smoke-'));
const ownAddresses = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i.address);
const address = ownAddresses.find(ip => /^100\./.test(ip)) ?? ownAddresses[0];
if (!address) throw new Error('No local non-loopback IPv4 interface available for the socket proof.');
const app = new Hono(); let writes = 0;
app.use('*', networkWriteAuth({ home, operatorTokens: ['synthetic-test-only-operator'] }));
app.post('/write', c => { writes++; return c.json({ ok: true }, 201); });
const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: 0 });
if (!server.listening) await once(server, 'listening');
const port = server.address().port;
try {
  const post = (host, headers = {}) => fetch(`http://${host}:${port}/write`, { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
  const loopback = (await post('127.0.0.1')).status;
  const remoteWithoutCredential = (await post(address)).status;
  const forgedLocalHeaders = (await post(address, { Host: '127.0.0.1', 'X-Forwarded-For': '127.0.0.1', 'X-OpenRig-Session': 'human@kernel' })).status;
  const remoteWithCredential = (await post(address, { Authorization: 'Bearer synthetic-test-only-operator' })).status;
  const result = { loopback, remoteWithoutCredential, forgedLocalHeaders, remoteWithCredential, testWrites: writes, localInterface: address };
  console.log(JSON.stringify(result));
  if (loopback !== 201 || remoteWithoutCredential !== 401 || forgedLocalHeaders !== 401 || remoteWithCredential !== 201 || writes !== 2) process.exitCode = 1;
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(home, { recursive: true, force: true });
}
