'use strict';
// Prueba de extremo a extremo contra el servidor HTTP real (datos demo, sin claves).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-'));
for (const k of ['FINNHUB_API_KEY', 'ALPHAVANTAGE_API_KEY', 'TELEGRAM_BOT_TOKEN', 'NTFY_TOPIC', 'NOTIFY_WEBHOOK_URL']) delete process.env[k];
const { server, loadState, saveState, sendDailyRadar } = require('../server.js');

let base;
const user = 'test_user_123';
const api = async (method, p, body, u = user) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user-id': u }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test.before(() => new Promise((res) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; res(); })));
test.after(() => new Promise((res) => server.close(res)));

test('rechaza peticiones sin usuario', async () => {
  const r = await api('GET', '/api/state', null, '');
  assert.equal(r.status, 401);
});

test('estado inicial con lista de seguimiento y ejecución real desactivada', async () => {
  const r = await api('GET', '/api/state');
  assert.deepEqual(r.body.watchlist, ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'QQQ']);
  assert.equal(r.body.settings.realExecution, false);
  assert.equal(r.body.server.realExecutionAvailable, false);
  assert.equal(r.body.sentKeys, undefined, 'no expone claves internas');
  const s = await api('PUT', '/api/settings', { settings: { realExecution: true } });
  assert.equal(s.body.settings.realExecution, false, 'no se puede activar desde la API');
});

test('flujo real completo: registrar → alerta al tocar 220 → cerrar solo con la ejecución', async () => {
  const add = await api('POST', '/api/positions', { ticker: 'NVDA', avgPrice: 200, shares: 5, mode: 'real' });
  assert.equal(add.status, 200);
  const id = add.body.id;
  const hit = await api('POST', `/api/positions/${id}/price`, { price: 220 });
  assert.equal(hit.body.notifications.length, 1);
  assert.equal(hit.body.notifications[0].type, 'objetivo');
  assert.equal(hit.body.notifications[0].channels[0].status, 'enviada');
  let st = (await api('GET', '/api/state')).body;
  let p = st.positions.find((x) => x.id === id);
  assert.equal(p.status, 'objetivo_alcanzado');
  const again = await api('POST', `/api/positions/${id}/price`, { price: 225 });
  assert.equal(again.body.notifications.length, 0, 'sin alertas duplicadas');
  const bad = await api('POST', `/api/positions/${id}/close`, {});
  assert.equal(bad.status, 400);
  const ok = await api('POST', `/api/positions/${id}/close`, { price: 221.1, source: 'integracion' });
  assert.equal(ok.body.status, 'cerrada');
  assert.equal(ok.body.close.source, 'manual', 'la interfaz no puede fingir una integración');
  assert.equal(ok.body.realizedPnl, 105.5);
  st = (await api('GET', '/api/state')).body;
  p = st.positions.find((x) => x.id === id);
  assert.equal(p.status, 'cerrada');
});

test('flujo de práctica: compra virtual a 200 → cierre automático en 220', async () => {
  const add = await api('POST', '/api/positions', { ticker: 'AAPL', avgPrice: 200, capital: 1000, mode: 'simulacion' });
  const r = await api('POST', `/api/positions/${add.body.id}/price`, { price: 220.5 });
  assert.deepEqual(r.body.notifications.map((n) => n.type), ['objetivo', 'cierre_simulado']);
  const p = (await api('GET', '/api/state')).body.positions.find((x) => x.id === add.body.id);
  assert.equal(p.status, 'cerrada');
  assert.equal(p.close.price, 220);
  assert.equal(p.realizedPnl, 100);
});

test('radar diario: una sola alerta por día', async () => {
  const n1 = await sendDailyRadar(user);
  assert.ok(n1 && n1.type === 'radar');
  const n2 = await sendDailyRadar(user);
  assert.equal(n2, null, 'deduplicada');
  const s = loadState(user);
  assert.ok(s.lastRadar.evaluated.length === 8);
});

test('endpoints públicos de mercado, cotizaciones e historial', async () => {
  const m = await api('GET', '/api/market');
  assert.ok(m.body.state && m.body.nextAlert.at);
  const q = await api('GET', '/api/quotes?symbols=NVDA,QQQ');
  assert.equal(q.body.NVDA.type, 'simulada');
  const h = await api('GET', '/api/history?symbol=QQQ&sessions=252');
  assert.equal(h.body.bars.length, 252);
  assert.equal(h.body.adjusted, true);
});

test('guardado persistente por usuario', async () => {
  const other = 'otro_usuario_456';
  await api('PUT', '/api/settings', { watchlist: ['spy', 'bad ticker!', 'AMD'] }, other);
  assert.deepEqual(loadState(other).watchlist, ['SPY', 'AMD']);
  assert.equal(loadState(user).watchlist.length, 8, 'no mezcla usuarios');
  saveState(other, loadState(other));
});
