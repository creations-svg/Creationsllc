'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/core.js');

const mk = (extra = {}) => {
  const s = C.emptyState();
  const p = C.createPosition({ ticker: 'NVDA', avgPrice: 200, shares: 10, buyFee: 2, mode: 'real', ...extra });
  s.positions.push(p);
  return { s, p };
};

test('venta parcial: realiza la parte vendida y deja el resto abierto', () => {
  const { s, p } = mk();
  C.closePosition(p, { price: 220, shares: 4, fee: 1, source: 'manual' });
  // 4 × 220 − 1 − (4 × 200 + 2 × 0,4) = 880 − 1 − 800,8 = 78,2
  assert.equal(p.realizedPnl, 78.2);
  assert.equal(p.status, 'abierta');
  assert.equal(p.shares, 6);
  assert.equal(p.buyFee, 1.2);
  assert.equal(p.capital, 2002, 'el capital inicial no cambia');
  const sum = C.portfolioSummary(s, { NVDA: { price: 210 } }, 'real');
  assert.equal(sum.invested, 1201.2);
  assert.equal(sum.realized, 78.2, 'el realizado incluye la venta parcial');
  assert.equal(sum.closedCount, 0);
  // Segunda venta: el resto. Se cierra con precio promedio de salida.
  C.closePosition(p, { price: 230, fee: 1, source: 'manual' });
  assert.equal(p.status, 'cerrada');
  assert.equal(p.shares, 0);
  // 6 × 230 − 1 − (1200 + 1,2) = 177,8 → total 256
  assert.equal(p.realizedPnl, 256);
  assert.equal(p.close.price, 226); // (4×220 + 6×230) / 10
  assert.equal(p.close.fee, 2);
  assert.equal(p.close.fills, 2);
  assert.equal(p.realizedPct, C.r4(256 / 2002));
  assert.equal(C.applyQuotes(s, { NVDA: { price: 999, type: 'tiempo_real' } }).length, 0, 'cerrada: sin alertas');
});

test('venta parcial: validaciones', () => {
  const { p } = mk();
  assert.throws(() => C.closePosition(p, { price: 220, shares: 11, source: 'manual' }), /Solo quedan 10/);
  assert.throws(() => C.closePosition(p, { price: 220, shares: 0, source: 'manual' }), /mayor que 0/);
  assert.throws(() => C.closePosition(p, { shares: 2, source: 'manual' }), /precio efectivamente ejecutado/);
  assert.throws(() => C.closePosition(p, { price: 220, shares: 2, source: 'simulacion' }), /solo se cierra/);
});

test('venta parcial después de «objetivo alcanzado» mantiene el estado sin repetir la alerta', () => {
  const { s, p } = mk();
  assert.equal(C.applyQuotes(s, { NVDA: { price: 221, type: 'tiempo_real' } }).length, 1);
  C.closePosition(p, { price: 221, shares: 5, source: 'manual' });
  assert.equal(p.status, 'objetivo_alcanzado');
  assert.equal(C.applyQuotes(s, { NVDA: { price: 225, type: 'tiempo_real' } }).length, 0);
});

test('deshacer la última venta restaura acciones, comisión y resultado', () => {
  const { s, p } = mk();
  C.closePosition(p, { price: 220, shares: 4, source: 'manual' });
  C.closePosition(p, { price: 230, source: 'manual' });
  assert.equal(p.status, 'cerrada');
  C.undoLastFill(s, p.id);
  assert.equal(p.status, 'abierta');
  assert.equal(p.shares, 6);
  assert.equal(p.buyFee, 1.2);
  assert.equal(p.realizedPnl, 79.2);
  assert.equal(p.close, null);
  C.undoLastFill(s, p.id);
  assert.equal(p.shares, 10);
  assert.equal(p.buyFee, 2);
  assert.equal(p.realizedPnl, 0);
  assert.throws(() => C.undoLastFill(s, p.id), /no tiene ventas/);
});

test('editar: corrige precio y acciones, recalcula capital y objetivo', () => {
  const { s, p } = mk();
  C.editPosition(s, p.id, { avgPrice: '190', shares: '5', notes: 'corregido' });
  assert.equal(p.avgPrice, 190);
  assert.equal(p.capital, 952);
  assert.equal(C.targets(p).gross, 209);
  assert.equal(p.notes, 'corregido');
  assert.deepEqual(p.edits[0].fields.sort(), ['avgPrice', 'notes', 'shares']);
});

test('editar el objetivo rearma la alerta', () => {
  const { s, p } = mk();
  C.applyQuotes(s, { NVDA: { price: 221, type: 'tiempo_real' } });
  assert.equal(p.status, 'objetivo_alcanzado');
  C.editPosition(s, p.id, { targetPct: 15 }); // nuevo objetivo 230
  assert.equal(p.status, 'abierta');
  assert.equal(C.applyQuotes(s, { NVDA: { price: 225, type: 'tiempo_real' } }).length, 0);
  const n = C.applyQuotes(s, { NVDA: { price: 230, type: 'tiempo_real' } });
  assert.equal(n.length, 1, 'vuelve a avisar en el nuevo objetivo');
  // Editar solo notas no rearma nada.
  C.editPosition(s, p.id, { notes: 'x' });
  assert.equal(p.status, 'objetivo_alcanzado');
});

test('editar el stop rearma la alerta de pérdida', () => {
  const { s, p } = mk({ stopPct: 5 });
  assert.equal(C.applyQuotes(s, { NVDA: { price: 189, type: 'tiempo_real' } }).length, 1);
  C.editPosition(s, p.id, { stopPct: 10 });
  assert.equal(p.stopHitAt, null);
  assert.equal(C.applyQuotes(s, { NVDA: { price: 185, type: 'tiempo_real' } }).length, 0);
  assert.equal(C.applyQuotes(s, { NVDA: { price: 179, type: 'tiempo_real' } }).length, 1);
});

test('editar: restricciones con ventas registradas y operaciones cerradas', () => {
  const { s, p } = mk();
  C.closePosition(p, { price: 220, shares: 4, source: 'manual' });
  assert.throws(() => C.editPosition(s, p.id, { avgPrice: 150 }), /Deshaz las ventas/);
  C.editPosition(s, p.id, { avgPrice: '200', targetPct: 12 }); // mismo precio: permitido
  assert.equal(p.targetPct, 12);
  C.closePosition(p, { price: 225, source: 'manual' });
  assert.throws(() => C.editPosition(s, p.id, { targetPct: 20 }), /solo admite cambios en las notas/);
  C.editPosition(s, p.id, { notes: 'vendida en dos partes' });
  assert.equal(p.notes, 'vendida en dos partes');
  assert.throws(() => C.editPosition(s, p.id, {}) && C.editPosition(s, 'nope', {}), /no encontrada/);
});

test('práctica: el cierre automático vende todo lo que queda tras una venta parcial', () => {
  const s = C.emptyState();
  const p = C.createPosition({ ticker: 'AAPL', avgPrice: 200, shares: 10, mode: 'simulacion' });
  s.positions.push(p);
  C.closePosition(p, { price: 205, shares: 5, source: 'manual' });
  C.applyQuotes(s, { AAPL: { price: 220, type: 'simulada' } });
  assert.equal(p.status, 'cerrada');
  assert.equal(p.realizedPnl, 125); // 5×5 + 5×20
  const sum = C.portfolioSummary(s, {}, 'simulacion');
  assert.equal(sum.cash, 10125);
});

test('posiciones guardadas con el formato anterior se actualizan', () => {
  const old = { id: 'pos_x', mode: 'real', ticker: 'MSFT', avgPrice: 100, shares: 2, buyFee: 0, status: 'cerrada', close: { price: 110, fee: 0, date: '2026-11-01T00:00:00Z', source: 'manual' }, realizedPnl: 20, capital: 200 };
  const s = C.normalizeState({ positions: [old] });
  const p = s.positions[0];
  assert.equal(p.fills.length, 1);
  assert.equal(p.initialShares, 2);
  assert.equal(p.shares, 0);
  C.undoLastFill(s, 'pos_x');
  assert.equal(p.shares, 2);
  assert.equal(p.status, 'abierta');
});
