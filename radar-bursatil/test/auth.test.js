'use strict';
// Inicio de sesión: protege toda la app y comparte los datos del usuario entre dispositivos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
let base, child;
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test.before(async () => {
  const port = 3800 + Math.floor(Math.random() * 500);
  child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'radar-auth-')), APP_USERS: 'ana:clave-ana,beto:clave:con:dos-puntos' },
    stdio: 'ignore',
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => child.kill());

test('sin credenciales: página y API piden inicio de sesión; health queda libre', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 401);
  assert.match(page.headers.get('www-authenticate'), /^Basic/);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/quotes?symbols=NVDA')).status, 401);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('contraseña incorrecta o usuario inexistente: rechazado', async () => {
  assert.equal((await fetch(base + '/', { headers: { authorization: basic('ana', 'mala') } })).status, 401);
  assert.equal((await fetch(base + '/', { headers: { authorization: basic('nadie', 'clave-ana') } })).status, 401);
});

test('mismo login en dos dispositivos comparte las operaciones; otro login no las ve', async () => {
  const h = (u, p, dev) => ({ 'content-type': 'application/json', authorization: basic(u, p), 'x-user-id': dev });
  assert.equal((await fetch(base + '/', { headers: h('ana', 'clave-ana', 'x') })).status, 200);
  const add = await fetch(base + '/api/positions', { method: 'POST', headers: h('ana', 'clave-ana', 'celular_123'), body: JSON.stringify({ ticker: 'NVDA', avgPrice: 200, shares: 1 }) });
  assert.equal(add.status, 200);
  const pc = await (await fetch(base + '/api/state', { headers: h('ana', 'clave-ana', 'computador_456') })).json();
  assert.equal(pc.positions.length, 1, 'visible desde otro dispositivo');
  assert.equal(pc.server.auth, true);
  const other = await (await fetch(base + '/api/state', { headers: h('beto', 'clave:con:dos-puntos', 'celular_123') })).json();
  assert.equal(other.positions.length, 0, 'otro usuario no ve los datos de ana');
});

test('en Render no arranca sin contraseña', () => {
  const r = spawnSync(process.execPath, [SERVER], { env: { PATH: process.env.PATH, RENDER: 'true', PORT: '0', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'radar-r-')) }, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /APP_PASSWORD/);
});
