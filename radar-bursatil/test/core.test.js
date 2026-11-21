'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/core.js');

test('objetivo bruto: compra a USD 200 → USD 220', () => {
  const p = C.createPosition({ ticker: 'nvda', avgPrice: 200, shares: 3 });
  assert.equal(p.ticker, 'NVDA');
  assert.equal(C.targets(p).gross, 220);
  assert.equal(C.targets(p).trigger, 220);
});

test('objetivo neto incluye comisiones de compra y venta', () => {
  const p = C.createPosition({ ticker: 'AAPL', avgPrice: 200, shares: 10, buyFee: 2, sellFeeFixed: 2 });
  assert.equal(C.targets(p).net, 220.42);
  const q = C.createPosition({ ticker: 'AAPL', avgPrice: 100, shares: 10, sellFeePct: 1 });
  // 1100 / (10 × 0,99) = 111,11
  assert.equal(C.targets(q).net, 111.11);
});

test('capital invertido → acciones fraccionadas (eToro)', () => {
  const p = C.createPosition({ ticker: 'TSLA', avgPrice: 400, capital: 500 });
  assert.equal(p.shares, 1.25);
  assert.equal(p.capital, 500);
});

test('límite de capital por operación', () => {
  const p = C.createPosition({ ticker: 'MSFT', avgPrice: 500, shares: 3 }, { ...C.DEFAULT_SETTINGS, maxCapitalPerTrade: 1000 });
  assert.equal(p.overLimit, true);
});

test('simulación: 200 → toca 220 → cierre automático de toda la posición a 220', () => {
  const s = C.emptyState();
  const p = C.createPosition({ ticker: 'NVDA', avgPrice: 200, shares: 5, mode: 'simulacion' });
  s.positions.push(p);
  assert.equal(C.applyQuotes(s, { NVDA: { price: 219.99, type: 'simulada' } }).length, 0);
  assert.equal(p.status, 'abierta');
  const ns = C.applyQuotes(s, { NVDA: { price: 223, type: 'simulada' } });
  assert.deepEqual(ns.map((n) => n.type), ['objetivo', 'cierre_simulado']);
  assert.equal(p.status, 'cerrada');
  assert.equal(p.close.price, 220);
  assert.equal(p.close.source, 'simulacion');
  assert.equal(p.realizedPnl, 100);
});

test('real: tocar 220 alerta y marca «objetivo alcanzado» sin cerrar; sin duplicados', () => {
  const s = C.emptyState();
  const p = C.createPosition({ ticker: 'NVDA', avgPrice: 200, shares: 5, mode: 'real' });
  s.positions.push(p);
  const n1 = C.applyQuotes(s, { NVDA: { price: 220, type: 'tiempo_real' } });
  assert.equal(n1.length, 1);
  assert.equal(n1[0].type, 'objetivo');
  assert.equal(p.status, 'objetivo_alcanzado');
  assert.equal(p.close, null);
  assert.equal(C.applyQuotes(s, { NVDA: { price: 230, type: 'tiempo_real' } }).length, 0, 'no se duplica');
  assert.throws(() => C.closePosition(p, { price: 220, source: 'simulacion' }), /solo se cierra/);
  assert.throws(() => C.closePosition(p, { source: 'manual' }), /precio efectivamente ejecutado/);
  C.closePosition(p, { price: 219.5, source: 'manual' });
  assert.equal(p.status, 'cerrada');
  assert.equal(p.realizedPnl, 97.5); // basado en el precio real, no en el objetivo
  assert.equal(C.applyQuotes(s, { NVDA: { price: 300, type: 'tiempo_real' } }).length, 0, 'cerrada: alertas detenidas');
  assert.equal(s.positions.length, 1, 'se conserva en el historial');
});

test('real: una cotización demo nunca dispara la alerta', () => {
  const s = C.emptyState();
  const p = C.createPosition({ ticker: 'NVDA', avgPrice: 100, shares: 1, mode: 'real' });
  s.positions.push(p);
  assert.equal(C.applyQuotes(s, { NVDA: { price: 500, type: 'simulada' } }).length, 0);
  assert.equal(p.status, 'abierta');
});

test('alerta de pérdida: real avisa, simulación cierra', () => {
  const s = C.emptyState();
  const r = C.createPosition({ ticker: 'AMD', avgPrice: 100, shares: 1, stopPct: 5, mode: 'real' });
  const v = C.createPosition({ ticker: 'AMD', avgPrice: 100, shares: 1, stopPct: 5, mode: 'simulacion' });
  s.positions.push(r, v);
  const ns = C.applyQuotes(s, { AMD: { price: 94, type: 'manual' } });
  assert.deepEqual(ns.map((n) => n.type).sort(), ['cierre_simulado', 'perdida', 'perdida']);
  assert.equal(r.status, 'abierta');
  assert.equal(v.status, 'cerrada');
});

test('calendario NYSE 2026', () => {
  const h = C.nyseHolidays(2026);
  assert.equal(h['2026-04-03'], 'Viernes Santo');
  assert.equal(h['2026-07-03'], 'Día de la Independencia'); // 4 de julio cae sábado
  assert.equal(h['2026-11-26'], 'Acción de Gracias');
  assert.equal(C.isTradingDay('2026-11-27'), true);
  assert.equal(C.earlyClose('2026-11-27'), true);
  assert.equal(C.isTradingDay('2026-11-21'), false); // sábado
  assert.equal(C.nyseHolidays(2022)['2021-12-31'], undefined); // Año Nuevo en sábado no se traslada
});

test('estado del mercado y próxima alerta de las 8:00 (Colombia)', () => {
  // Lunes 23-nov-2026 10:00 NY (EST, UTC−5) → abierto
  assert.equal(C.marketStatus(new Date('2026-11-23T15:00:00Z')).state, 'abierto');
  assert.equal(C.marketStatus(new Date('2026-11-23T12:00:00Z')).state, 'preapertura');
  assert.equal(C.marketStatus(new Date('2026-11-26T15:00:00Z')).state, 'cerrado'); // Acción de Gracias
  // Sábado → lunes 8:00 Bogotá = 13:00 UTC
  assert.deepEqual(C.nextDailyAlert(new Date('2026-11-21T18:00:00Z')), { date: '2026-11-23', at: '2026-11-23T13:00:00.000Z' });
  // Miércoles 25 a las 9:00 Bogotá → la siguiente es el viernes 27 (jueves festivo)
  assert.equal(C.nextDailyAlert(new Date('2026-11-25T14:00:00Z')).date, '2026-11-27');
  // Horario de verano en NY no afecta a Bogotá (UTC−5 fijo)
  assert.equal(C.nextDailyAlert(new Date('2026-06-01T10:00:00Z')).at, '2026-06-01T13:00:00.000Z');
});

test('radar: devuelve como máximo 3, explica condiciones y respeta filtros', () => {
  const today = '2026-11-20';
  const uni = C.DEFAULT_WATCHLIST.map((t) => ({ ticker: t, bars: C.demoBars(t, today, 120), quote: null, earningsDate: C.demoEarnings(t, today) }));
  const r = C.screen(uni, C.DEFAULT_FILTERS, C.DEFAULT_SETTINGS, today);
  assert.ok(r.items.length <= 3);
  assert.equal(r.evaluated.length, 8);
  for (const i of r.items) {
    assert.ok(i.conditions.every((c) => c.ok));
    assert.equal(i.target, C.r2(i.price * 1.1));
    assert.ok(i.entryLow <= i.entryHigh);
    assert.ok(i.risk && i.reason && i.links.precio);
  }
  const none = C.screen(uni, { ...C.DEFAULT_FILTERS, minPrice: 1e6 }, C.DEFAULT_SETTINGS, today);
  assert.equal(none.empty, true);
  assert.equal(none.message, 'Sin oportunidades que cumplan los criterios');
});

test('backtest: objetivo, vela ambigua conservadora y métricas', () => {
  const day = (d, o, h, l, c) => ({ date: d, open: o, high: h, low: l, close: c, volume: 1e6 });
  // Entrada inmediata a 100 → toca 110 el día 2.
  const bars = [day('2026-01-05', 100, 101, 99, 100), day('2026-01-06', 101, 111, 100, 109), day('2026-01-07', 109, 110, 108, 109)];
  const r = C.backtest(bars, { entryRule: 'inmediata', capital: 1000, targetPct: 10, slippagePct: 0 });
  assert.equal(r.trades[0].exitPrice, 110);
  assert.equal(r.trades[0].reason, 'objetivo');
  assert.equal(r.metrics.hitTargetPct, 1);
  // Vela que toca 110 y 95 con stop 5 % → se asume la pérdida primero.
  const amb = [day('2026-01-05', 100, 101, 99, 100), day('2026-01-06', 100, 112, 94, 105)];
  const r2 = C.backtest(amb, { entryRule: 'inmediata', capital: 1000, targetPct: 10, stopPct: 5, slippagePct: 0 });
  assert.equal(r2.trades[0].reason, 'stop');
  assert.equal(r2.trades[0].ambiguous, true);
  assert.equal(r2.trades[0].exitPrice, 95);
  assert.equal(r2.metrics.ambiguous, 1);
  // Gap bajista: se vende a la apertura, no al stop.
  const gap = [day('2026-01-05', 100, 101, 99, 100), day('2026-01-06', 90, 91, 88, 90)];
  const r3 = C.backtest(gap, { entryRule: 'inmediata', capital: 1000, targetPct: 10, stopPct: 5, slippagePct: 0 });
  assert.equal(r3.trades[0].exitPrice, 90);
  assert.ok(r3.metrics.maxDrawdown >= 0.09);
});

test('criterios de aceptación integrados en la app', () => {
  for (const c of C.acceptanceChecks()) assert.ok(c.ok, c.name + ': ' + c.detail);
});
