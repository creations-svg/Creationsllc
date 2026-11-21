'use strict';
// WhatsApp: se verifica lo que el servidor enviaría a Meta (WhatsApp Cloud) y a CallMeBot,
// usando un servidor falso local en lugar de las API reales.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/whatsapp.php') ? 'Message queued' : '{"messages":[{"id":"wamid.test"}]}');
  });
});

let mockUrl;
test.before(() => new Promise((r) => mock.listen(0, () => { mockUrl = `http://127.0.0.1:${mock.address().port}`; r(); })));
test.after(() => new Promise((r) => mock.close(r)));

// Arranca el servidor en un proceso aparte con las variables indicadas.
async function withServer(env, fn) {
  const port = 3300 + Math.floor(Math.random() * 500);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-wa-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir, ...env }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    await fn(base);
  } finally { child.kill(); }
}
const api = (base, method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': 'wa_user_1' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

test('WhatsApp Cloud (Meta) con plantilla: alerta de objetivo', async () => {
  received.length = 0;
  await withServer({ WHATSAPP_TOKEN: 'tok123', WHATSAPP_PHONE_NUMBER_ID: '999', WHATSAPP_TO: '+57 300 123 4567', WHATSAPP_TEMPLATE: 'alerta_radar', WHATSAPP_API_BASE: mockUrl }, async (base) => {
    const st = await api(base, 'GET', '/api/state');
    const wa = st.server.channels.find((c) => c.id === 'whatsapp');
    assert.equal(wa.active, true);
    const p = await api(base, 'POST', '/api/positions', { ticker: 'NVDA', avgPrice: 200, shares: 5, mode: 'real' });
    const r = await api(base, 'POST', `/api/positions/${p.id}/price`, { price: 220 });
    const ch = r.notifications[0].channels.find((c) => c.channel === 'whatsapp');
    assert.equal(ch.status, 'enviada');
    assert.ok(ch.sentAt);
  });
  assert.equal(received.length, 1);
  const m = received[0];
  assert.equal(m.url, '/v23.0/999/messages');
  assert.equal(m.auth, 'Bearer tok123');
  const b = JSON.parse(m.body);
  assert.equal(b.messaging_product, 'whatsapp');
  assert.equal(b.to, '573001234567');
  assert.equal(b.type, 'template');
  assert.equal(b.template.name, 'alerta_radar');
  assert.equal(b.template.language.code, 'es');
  const text = b.template.components[0].parameters[0].text;
  assert.match(text, /NVDA alcanzó el objetivo/);
  assert.ok(!text.includes('\n'), 'sin saltos de línea en parámetros de plantilla');
});

test('WhatsApp vía CallMeBot: notificación de prueba', async () => {
  received.length = 0;
  await withServer({ WHATSAPP_CALLMEBOT_PHONE: '+573001234567', WHATSAPP_CALLMEBOT_APIKEY: 'k42', CALLMEBOT_API_BASE: mockUrl }, async (base) => {
    const r = await api(base, 'POST', '/api/notifications/test');
    assert.equal(r.notification.channels.find((c) => c.channel === 'whatsapp').status, 'enviada');
  });
  assert.equal(received.length, 1);
  const u = new URL(received[0].url, 'http://x');
  assert.equal(u.pathname, '/whatsapp.php');
  assert.equal(u.searchParams.get('phone'), '+573001234567');
  assert.equal(u.searchParams.get('apikey'), 'k42');
  assert.match(u.searchParams.get('text'), /Prueba de notificación/);
});

test('sin configuración, WhatsApp aparece inactivo y no se envía nada', async () => {
  received.length = 0;
  await withServer({}, async (base) => {
    const st = await api(base, 'GET', '/api/state');
    assert.equal(st.server.channels.find((c) => c.id === 'whatsapp').active, false);
    const r = await api(base, 'POST', '/api/notifications/test');
    assert.deepEqual(r.notification.channels.map((c) => c.channel), ['app']);
  });
  assert.equal(received.length, 0);
});
