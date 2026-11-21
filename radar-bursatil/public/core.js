/*
 * Radar Bursátil USA — núcleo compartido (navegador y servidor).
 *
 * Contiene toda la lógica que debe dar el mismo resultado en ambos lados:
 * calendario de NYSE, cálculo de objetivos, máquina de estados de las
 * posiciones, radar de oportunidades, simulador histórico y datos demo.
 *
 * Regla de diseño central: «la acción llegó al objetivo» (objetivo_alcanzado)
 * es distinto de «la venta se ejecutó» (cerrada). En modo real una posición
 * solo pasa a «cerrada» cuando el usuario registra el precio ejecutado o una
 * integración autorizada confirma la venta.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RadarCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- utilidades
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const r4 = (x) => Math.round((x + Number.EPSILON) * 10000) / 10000;
  const num = (v, d = 0) => {
    const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nfs = {};
  const fmt = (x, d = 2) => (nfs[d] || (nfs[d] = new Intl.NumberFormat('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }))).format(x);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
  const dow = (s) => parseYmd(s).getUTCDay();
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);

  // Partes de fecha/hora en una zona horaria IANA.
  function zoned(date, timeZone) {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const p = {};
    for (const x of f.formatToParts(date)) p[x.type] = x.value;
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
      minutes: Number(p.hour) * 60 + Number(p.minute),
    };
  }
  // Instante UTC correspondiente a una hora local de una zona.
  function zonedToUtc(dateStr, hh, mm, timeZone) {
    const guess = new Date(parseYmd(dateStr).getTime() + (hh * 60 + mm) * 60000);
    const z = zoned(guess, timeZone);
    const local = parseYmd(z.date).getTime() + z.minutes * 60000;
    const offset = local - guess.getTime();
    return new Date(guess.getTime() - offset);
  }

  // ------------------------------------------------------ calendario NYSE
  function easter(y) { // algoritmo anónimo gregoriano
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return `${y}-${pad(month)}-${pad(day)}`;
  }
  function nthWeekday(y, month, weekday, n) { // n=-1 → último
    if (n > 0) {
      let d = `${y}-${pad(month)}-01`;
      while (dow(d) !== weekday) d = addDays(d, 1);
      return addDays(d, 7 * (n - 1));
    }
    let d = addDays(month === 12 ? `${y + 1}-01-01` : `${y}-${pad(month + 1)}-01`, -1);
    while (dow(d) !== weekday) d = addDays(d, -1);
    return d;
  }
  function observed(d, allowSaturdayShift = true) {
    const w = dow(d);
    if (w === 6) return allowSaturdayShift ? addDays(d, -1) : null;
    if (w === 0) return addDays(d, 1);
    return d;
  }
  const holidayCache = {};
  function nyseHolidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    const h = {};
    const add = (d, name) => { if (d) h[d] = name; };
    add(observed(`${y}-01-01`, false), 'Año Nuevo'); // NYSE no traslada al viernes previo
    add(nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr.');
    add(nthWeekday(y, 2, 1, 3), 'Día de los Presidentes');
    add(addDays(easter(y), -2), 'Viernes Santo');
    add(nthWeekday(y, 5, 1, -1), 'Memorial Day');
    if (y >= 2022) add(observed(`${y}-06-19`), 'Juneteenth');
    add(observed(`${y}-07-04`), 'Día de la Independencia');
    add(nthWeekday(y, 9, 1, 1), 'Labor Day');
    add(nthWeekday(y, 11, 4, 4), 'Acción de Gracias');
    add(observed(`${y}-12-25`), 'Navidad');
    // 1 de enero del año siguiente en sábado: no se observa (regla NYSE).
    return (holidayCache[y] = h);
  }
  function earlyClose(d) { // cierre 1:00 p. m. hora NY
    const y = Number(d.slice(0, 4));
    const tg = nthWeekday(y, 11, 4, 4);
    if (d === addDays(tg, 1)) return true;
    if (d === `${y}-12-24` && dow(d) >= 1 && dow(d) <= 5) return true;
    if (d === `${y}-07-03` && dow(d) >= 1 && dow(d) <= 5 && !nyseHolidays(y)[d]) return true;
    return false;
  }
  function holidayName(d) { return nyseHolidays(Number(d.slice(0, 4)))[d] || null; }
  function isTradingDay(d) { const w = dow(d); return w !== 0 && w !== 6 && !holidayName(d); }
  function nextTradingDay(d, inclusive = false) {
    let x = inclusive ? d : addDays(d, 1);
    while (!isTradingDay(x)) x = addDays(x, 1);
    return x;
  }

  const NY = 'America/New_York';
  const BOGOTA = 'America/Bogota';

  function marketStatus(now = new Date()) {
    const z = zoned(now, NY);
    const d = z.date, t = z.minutes;
    const trading = isTradingDay(d);
    const close = earlyClose(d) ? 13 * 60 : 16 * 60;
    let state = 'cerrado', label = 'Mercado cerrado';
    if (trading) {
      if (t >= 4 * 60 && t < 9 * 60 + 30) { state = 'preapertura'; label = 'Preapertura'; }
      else if (t >= 9 * 60 + 30 && t < close) { state = 'abierto'; label = 'Mercado abierto'; }
      else if (t >= close && t < 20 * 60) { state = 'posmercado'; label = 'Posmercado'; }
    }
    let reason = null;
    if (!trading) reason = holidayName(d) ? `Festivo NYSE: ${holidayName(d)}` : 'Fin de semana';
    const nextOpenDay = state === 'abierto' || (trading && t < 9 * 60 + 30) ? d : nextTradingDay(d);
    return {
      state, label, reason, nyDate: d,
      nyTime: `${pad(z.hour)}:${pad(z.minute)}`,
      bogotaTime: (() => { const b = zoned(now, BOGOTA); return `${pad(b.hour)}:${pad(b.minute)}`; })(),
      earlyClose: trading && earlyClose(d),
      closeTimeNY: trading ? (earlyClose(d) ? '13:00' : '16:00') : null,
      nextOpen: zonedToUtc(nextOpenDay, 9, 30, NY).toISOString(),
      isTradingDay: trading,
    };
  }

  // Próxima alerta diaria: 8:00 a. m. hora de Colombia en un día hábil de NYSE.
  function nextDailyAlert(now = new Date(), hh = 8, mm = 0) {
    const b = zoned(now, BOGOTA);
    let d = b.date;
    if (!(isTradingDay(d) && b.minutes < hh * 60 + mm)) d = nextTradingDay(d);
    return { date: d, at: zonedToUtc(d, hh, mm, BOGOTA).toISOString() };
  }

  // ------------------------------------------------------- objetivos
  const DEFAULT_SETTINGS = {
    targetPct: 10,
    targetBasis: 'bruto', // 'bruto' = entrada × 1,10 ; 'neto' = 10 % después de costos
    stopPct: null, // salida por pérdida opcional (%)
    defaultBuyFee: 0,
    defaultSellFeeFixed: 0,
    defaultSellFeePct: 0,
    maxCapitalPerTrade: 1000,
    virtualCapital: 10000,
    realCash: 0,
    fxManual: null, // tasa USD/COP manual (si se fija, tiene prioridad)
    simAutoClose: true,
    alertsEnabled: true,
    alertHour: 8,
    alertMinute: 0,
    realExecution: false, // la ejecución real está desactivada por defecto y bloqueada
    browserNotifications: false,
  };
  const DEFAULT_FILTERS = {
    minPrice: 5,
    minAvgVolumeM: 1, // millones de acciones/día (promedio 20 d)
    minDollarVolumeM: 50, // millones de USD/día
    trend: 'alcista', // 'alcista' | 'cualquiera'
    excludeEarningsDays: 5, // excluir si hay resultados en ≤ N días (0 = no excluir)
    maxResults: 3,
  };
  const DEFAULT_WATCHLIST = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'QQQ'];

  function positionCost(p) { return p.avgPrice * p.shares + (p.buyFee || 0); }
  function sellFees(p, price, shares = p.shares) {
    return price * shares * ((p.sellFeePct || 0) / 100) + (p.sellFeeFixed || 0);
  }
  function targets(p) {
    const pct = (p.targetPct != null ? p.targetPct : 10) / 100;
    const gross = p.avgPrice * (1 + pct);
    const cost = positionCost(p);
    const net = (cost * (1 + pct) + (p.sellFeeFixed || 0)) / (p.shares * (1 - (p.sellFeePct || 0) / 100));
    const trigger = p.targetBasis === 'neto' ? net : gross;
    const stop = p.stopPct ? p.avgPrice * (1 - p.stopPct / 100) : null;
    return { gross: r2(gross), net: r2(net), trigger: r2(trigger), stop: stop != null ? r2(stop) : null, pct: pct * 100 };
  }
  // Capital inicial de la operación (no cambia con las ventas parciales).
  const initialCost = (p) => p.capital || positionCost(p);
  function positionMetrics(p, price) {
    const t = targets(p);
    const cost = positionCost(p); // costo de las acciones que siguen abiertas
    const realized = p.realizedPnl || 0;
    if (p.status === 'cerrada') {
      return { targets: t, cost: 0, marketValue: 0, pnl: r2(realized), pnlPct: r4(realized / initialCost(p)), realized: r2(realized), toTargetPct: 0, toTargetUsd: 0, progress: 1, exposed: 0 };
    }
    const mv = price * p.shares;
    const pnl = mv - sellFees(p, price) - cost;
    const toTargetUsd = t.trigger - price;
    const range = t.trigger - p.avgPrice;
    return {
      targets: t, cost: r2(cost), marketValue: r2(mv), pnl: r2(pnl), pnlPct: r4(pnl / cost),
      pnlGross: r2(mv - p.avgPrice * p.shares), realized: r2(realized),
      toTargetUsd: r2(toTargetUsd), toTargetPct: r4(toTargetUsd / price),
      progress: range > 0 ? Math.max(0, Math.min(1, (price - p.avgPrice) / range)) : 0,
      exposed: r2(mv),
    };
  }

  const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
  const optPct = (v, dflt) => (v === '' || v == null ? (dflt || null) : (num(v) || null));

  // Crea una posición validada a partir de los datos del formulario.
  function createPosition(input, settings = DEFAULT_SETTINGS) {
    const ticker = String(input.ticker || '').trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) throw new Error('Ticker inválido');
    const avgPrice = num(input.avgPrice);
    if (!(avgPrice > 0)) throw new Error('El precio promedio de compra debe ser mayor que 0');
    const buyFee = num(input.buyFee, settings.defaultBuyFee || 0);
    if (buyFee < 0) throw new Error('La comisión no puede ser negativa');
    let shares = num(input.shares);
    const capital = num(input.capital);
    if (!(shares > 0) && capital > 0) shares = (capital - buyFee) / avgPrice; // eToro permite fracciones
    if (!(shares > 0)) throw new Error('Indica el número de acciones o el capital invertido');
    const mode = input.mode === 'simulacion' ? 'simulacion' : 'real';
    const p = {
      id: input.id || uid('pos'),
      mode, ticker,
      broker: mode === 'real' ? (input.broker || 'eToro') : 'Simulación',
      avgPrice: r4(avgPrice), shares: r4(shares), buyFee: r2(buyFee),
      sellFeeFixed: r2(num(input.sellFeeFixed, settings.defaultSellFeeFixed || 0)),
      sellFeePct: num(input.sellFeePct, settings.defaultSellFeePct || 0),
      targetPct: num(input.targetPct, settings.targetPct || 10),
      targetBasis: input.targetBasis === 'neto' || input.targetBasis === 'bruto' ? input.targetBasis : (settings.targetBasis || 'bruto'),
      stopPct: optPct(input.stopPct, settings.stopPct),
      openedAt: input.openedAt || new Date().toISOString(),
      status: 'abierta',
      targetHitAt: null, targetHitPrice: null,
      stopHitAt: null, stopHitPrice: null,
      fills: [], close: null, realizedPnl: 0,
      edits: [],
      notes: String(input.notes || '').slice(0, 500),
    };
    p.initialShares = p.shares;
    p.capital = r2(positionCost(p));
    p.overLimit = settings.maxCapitalPerTrade > 0 && p.capital > settings.maxCapitalPerTrade;
    return p;
  }

  // Compatibilidad con posiciones guardadas antes de las ventas parciales.
  function upgradePosition(p) {
    if (!Array.isArray(p.fills)) {
      p.fills = p.close ? [{ id: uid('fill'), shares: p.shares, price: p.close.price, fee: p.close.fee, date: p.close.date, source: p.close.source, pnl: p.realizedPnl }] : [];
      if (p.close) p.shares = 0;
    }
    if (p.initialShares == null) p.initialShares = p.shares + p.fills.reduce((a, f) => a + f.shares, 0);
    if (p.realizedPnl == null) p.realizedPnl = 0;
    if (!Array.isArray(p.edits)) p.edits = [];
    return p;
  }

  /*
   * Registra una venta ejecutada, total o parcial (exec.shares; por defecto todas las que quedan).
   * En modo real solo se acepta la ejecución registrada por el usuario o confirmada por una
   * integración autorizada. La posición pasa a «cerrada» cuando ya no quedan acciones.
   */
  function closePosition(p, exec) {
    upgradePosition(p);
    if (p.status === 'cerrada') throw new Error('La posición ya está cerrada');
    const price = num(exec && exec.price);
    if (!(price > 0)) throw new Error('Para cerrar debes registrar el precio efectivamente ejecutado');
    const source = exec.source || 'manual';
    if (p.mode === 'real' && !['manual', 'integracion'].includes(source)) {
      throw new Error('Una posición real solo se cierra con la ejecución registrada por el usuario o confirmada por una integración autorizada');
    }
    const remaining = p.shares;
    let q = exec.shares === '' || exec.shares == null ? remaining : num(exec.shares);
    if (!(q > 0)) throw new Error('El número de acciones vendidas debe ser mayor que 0');
    if (q > remaining + 1e-6) throw new Error(`Solo quedan ${r4(remaining)} acciones abiertas`);
    const full = q >= remaining - 1e-6;
    if (full) q = remaining;
    const fee = exec.fee != null && exec.fee !== '' ? num(exec.fee) : sellFees(p, price, q);
    if (fee < 0) throw new Error('La comisión no puede ser negativa');
    const feeShare = full ? p.buyFee : p.buyFee * (q / remaining); // comisión de compra prorrateada
    const pnl = price * q - fee - (p.avgPrice * q + feeShare);
    const fill = { id: uid('fill'), shares: r4(q), price: r4(price), fee: r2(fee), date: exec.date || new Date().toISOString(), source, pnl: r2(pnl), buyFeeShare: r2(feeShare) };
    p.fills.push(fill);
    p.realizedPnl = r2((p.realizedPnl || 0) + pnl);
    p.shares = full ? 0 : r4(remaining - q);
    p.buyFee = full ? 0 : r2(p.buyFee - feeShare);
    if (full) {
      const sold = p.fills.reduce((a, f) => a + f.shares, 0);
      p.status = 'cerrada';
      p.close = {
        price: r4(p.fills.reduce((a, f) => a + f.price * f.shares, 0) / sold), // precio promedio de salida
        date: fill.date, fee: r2(p.fills.reduce((a, f) => a + f.fee, 0)), source, fills: p.fills.length,
      };
      p.realizedPct = r4(p.realizedPnl / initialCost(p));
    }
    return p;
  }

  // Deshace la última venta registrada (para corregir un error de captura).
  function undoLastFill(state, id) {
    const p = state.positions.find((x) => x.id === id);
    if (!p) throw new Error('Posición no encontrada');
    upgradePosition(p);
    const f = p.fills.pop();
    if (!f) throw new Error('Esta posición no tiene ventas registradas');
    p.shares = r4(p.shares + f.shares);
    p.buyFee = r2(p.buyFee + (f.buyFeeShare || 0));
    p.realizedPnl = r2(p.realizedPnl - f.pnl);
    if (p.status === 'cerrada') {
      p.status = p.targetHitAt ? 'objetivo_alcanzado' : 'abierta';
      p.close = null; p.realizedPct = null;
    }
    p.edits.push({ at: new Date().toISOString(), fields: ['venta deshecha: ' + f.shares + ' a ' + f.price] });
    return p;
  }

  /*
   * Edita una operación. Reglas:
   *  - Cerrada: solo notas (para corregir una venta, deshazla primero).
   *  - Con ventas registradas: no se puede cambiar ticker, precio de compra, acciones ni comisión de compra.
   *  - Si cambia el objetivo o el stop, se rearma su alerta (se vuelve a avisar si el precio lo toca).
   */
  const EDITABLE = ['ticker', 'avgPrice', 'shares', 'buyFee', 'sellFeeFixed', 'sellFeePct', 'targetPct', 'targetBasis', 'stopPct', 'openedAt', 'notes'];
  function editPosition(state, id, changes, settings = state.settings) {
    const p = state.positions.find((x) => x.id === id);
    if (!p) throw new Error('Posición no encontrada');
    upgradePosition(p);
    const ch = {};
    for (const k of EDITABLE) if (changes[k] !== undefined) ch[k] = changes[k];
    if (p.status === 'cerrada' && Object.keys(ch).some((k) => k !== 'notes')) {
      throw new Error('Una operación cerrada solo admite cambios en las notas. Para corregir la venta, deshazla primero.');
    }
    const locked = ['ticker', 'avgPrice', 'shares', 'buyFee'];
    const before = { ...p };
    const changed = [];
    const set = (k, v) => { if (v !== p[k]) { p[k] = v; changed.push(k); } };
    if (p.fills.length) {
      for (const k of locked) {
        if (ch[k] === undefined) continue;
        const v = k === 'ticker' ? String(ch[k]).trim().toUpperCase() : num(ch[k]);
        if (v !== p[k]) throw new Error('Con ventas parciales registradas no se puede cambiar ticker, precio de compra, acciones ni comisión de compra. Deshaz las ventas primero.');
      }
    }
    if (ch.ticker !== undefined) { const t = String(ch.ticker).trim().toUpperCase(); if (!TICKER_RE.test(t)) throw new Error('Ticker inválido'); set('ticker', t); }
    if (ch.avgPrice !== undefined) { const v = num(ch.avgPrice); if (!(v > 0)) throw new Error('El precio promedio de compra debe ser mayor que 0'); set('avgPrice', r4(v)); }
    if (ch.shares !== undefined) { const v = num(ch.shares); if (!(v > 0)) throw new Error('El número de acciones debe ser mayor que 0'); set('shares', r4(v)); }
    for (const k of ['buyFee', 'sellFeeFixed', 'sellFeePct']) if (ch[k] !== undefined) { const v = num(ch[k]); if (v < 0) throw new Error('Las comisiones no pueden ser negativas'); set(k, k === 'sellFeePct' ? v : r2(v)); }
    if (ch.targetPct !== undefined) { const v = num(ch.targetPct); if (!(v > 0)) throw new Error('El objetivo debe ser mayor que 0 %'); set('targetPct', v); }
    if (ch.targetBasis !== undefined) { if (!['bruto', 'neto'].includes(ch.targetBasis)) throw new Error('Base de objetivo inválida'); set('targetBasis', ch.targetBasis); }
    if (ch.stopPct !== undefined) set('stopPct', optPct(ch.stopPct, null));
    if (ch.openedAt !== undefined && ch.openedAt) set('openedAt', ch.openedAt);
    if (ch.notes !== undefined) set('notes', String(ch.notes).slice(0, 500));
    if (!changed.length) return p;
    if (!p.fills.length && changed.some((k) => locked.includes(k))) {
      p.initialShares = p.shares;
      p.capital = r2(positionCost(p));
      p.overLimit = settings.maxCapitalPerTrade > 0 && p.capital > settings.maxCapitalPerTrade;
    }
    // Rearmar alertas si cambió algo que mueve el objetivo o el stop.
    if (targets(p).trigger !== targets(before).trigger && p.status === 'objetivo_alcanzado') {
      p.status = 'abierta'; p.targetHitAt = null; p.targetHitPrice = null;
      delete state.sentKeys['objetivo:' + p.id];
    }
    if (targets(p).stop !== targets(before).stop && p.stopHitAt) {
      p.stopHitAt = null; p.stopHitPrice = null;
      delete state.sentKeys['perdida:' + p.id];
    }
    p.edits.push({ at: new Date().toISOString(), fields: changed });
    if (p.edits.length > 50) p.edits = p.edits.slice(-50);
    return p;
  }

  /*
   * Evalúa una posición contra una cotización y devuelve los eventos que se
   * producen. No duplica: un evento por tipo y posición (ver sentKeys).
   *  - real:       precio ≥ objetivo → «objetivo_alcanzado» + alerta (NO se cierra)
   *  - simulación: precio ≥ objetivo → cierre automático de toda la posición
   *                al precio objetivo (supuesto conservador de una orden límite)
   */
  function evaluatePosition(p, quote, settings = DEFAULT_SETTINGS, now = new Date()) {
    const events = [];
    if (p.status === 'cerrada' || !quote || !(quote.price > 0)) return events;
    const t = targets(p);
    const price = quote.price;
    const at = now.toISOString();
    if (price >= t.trigger && p.status === 'abierta') {
      p.status = 'objetivo_alcanzado';
      p.targetHitAt = at; p.targetHitPrice = r4(price);
      events.push({ type: 'objetivo', positionId: p.id, ticker: p.ticker, mode: p.mode, price, target: t.trigger, quoteType: quote.type, at });
      if (p.mode === 'simulacion' && settings.simAutoClose !== false) {
        closePosition(p, { price: t.trigger, date: at, source: 'simulacion' });
        events.push({ type: 'cierre_simulado', positionId: p.id, ticker: p.ticker, mode: p.mode, price: t.trigger, pnl: p.realizedPnl, at });
      }
    }
    if (p.status !== 'cerrada' && t.stop != null && price <= t.stop && !p.stopHitAt) {
      p.stopHitAt = at; p.stopHitPrice = r4(price);
      events.push({ type: 'perdida', positionId: p.id, ticker: p.ticker, mode: p.mode, price, stop: t.stop, quoteType: quote.type, at });
      if (p.mode === 'simulacion' && settings.simAutoClose !== false) {
        closePosition(p, { price, date: at, source: 'simulacion' }); // se asume ejecución al precio observado (≤ stop)
        events.push({ type: 'cierre_simulado', positionId: p.id, ticker: p.ticker, mode: p.mode, price, pnl: p.realizedPnl, at });
      }
    }
    return events;
  }

  // ---------------------------------------------------- estado por usuario
  function emptyState() {
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      filters: { ...DEFAULT_FILTERS },
      watchlist: [...DEFAULT_WATCHLIST],
      positions: [],
      notifications: [],
      sentKeys: {},
      lastRadar: null,
    };
  }
  function normalizeState(s) {
    const e = emptyState();
    if (!s || typeof s !== 'object') return e;
    return {
      ...e, ...s,
      settings: { ...e.settings, ...(s.settings || {}), realExecution: false },
      filters: { ...e.filters, ...(s.filters || {}) },
      watchlist: Array.isArray(s.watchlist) && s.watchlist.length ? s.watchlist : e.watchlist,
      positions: Array.isArray(s.positions) ? s.positions.map(upgradePosition) : [],
      notifications: Array.isArray(s.notifications) ? s.notifications.slice(0, 200) : [],
      sentKeys: s.sentKeys || {},
    };
  }
  const eventKey = (ev) => ev.type === 'radar' ? `radar:${ev.date}` : `${ev.type}:${ev.positionId}`;

  // Registra un evento como notificación si no se ha enviado antes. Devuelve la notificación o null.
  function recordNotification(state, ev, channels = ['app']) {
    const key = ev.key || eventKey(ev);
    if (state.sentKeys[key]) return null;
    const n = { id: uid('ntf'), key, type: ev.type, title: notificationTitle(ev), body: notificationBody(ev), ticker: ev.ticker || null, mode: ev.mode || null, channels: channels.map((c) => ({ channel: c, status: 'pendiente', sentAt: null })), createdAt: ev.at || new Date().toISOString(), read: false };
    state.sentKeys[key] = n.createdAt;
    state.notifications.unshift(n);
    state.notifications = state.notifications.slice(0, 200);
    return n;
  }
  function notificationTitle(ev) {
    switch (ev.type) {
      case 'objetivo': return `🎯 ${ev.ticker} alcanzó el objetivo${ev.mode === 'simulacion' ? ' (simulación)' : ''}`;
      case 'cierre_simulado': return `✅ ${ev.ticker} cerrada en simulación`;
      case 'perdida': return `⚠️ ${ev.ticker} tocó la salida por pérdida${ev.mode === 'simulacion' ? ' (simulación)' : ''}`;
      case 'radar': return ev.items && ev.items.length ? `📡 Radar ${ev.date}: ${ev.items.length} oportunidad(es) para evaluar` : `📡 Radar ${ev.date}: sin oportunidades`;
      default: return ev.title || 'Notificación';
    }
  }
  function notificationBody(ev) {
    switch (ev.type) {
      case 'objetivo': return ev.mode === 'real'
        ? `Precio USD ${fmt(ev.price, 2)} ≥ objetivo USD ${fmt(ev.target, 2)}. Estado: «Objetivo alcanzado». La posición sigue ABIERTA hasta que registres el precio de venta ejecutado en eToro.`
        : `Precio USD ${fmt(ev.price, 2)} ≥ objetivo USD ${fmt(ev.target, 2)}.`;
      case 'cierre_simulado': return `Cierre virtual de toda la posición a USD ${fmt(ev.price, 2)}. Resultado: USD ${fmt(ev.pnl, 2)}.`;
      case 'perdida': return `Precio USD ${fmt(ev.price, 2)} ≤ salida por pérdida USD ${fmt(ev.stop, 2)}.${ev.mode === 'real' ? ' Revisa tu posición en eToro.' : ''}`;
      case 'radar': return ev.items && ev.items.length
        ? ev.items.map((i) => `${i.ticker} USD ${fmt(i.price, 2)} · entrada ${fmt(i.entryLow, 2)}–${fmt(i.entryHigh, 2)} · objetivo ${fmt(i.target, 2)}`).join('\n')
        : 'Sin oportunidades que cumplan los criterios.';
      default: return ev.body || '';
    }
  }
  function applyQuotes(state, quotes, now = new Date()) {
    const out = [];
    for (const p of state.positions) {
      const q = quotes[p.ticker];
      if (!q) continue;
      // Una cotización simulada (demo) nunca dispara estados de una operación real.
      if (p.mode === 'real' && q.type === 'simulada') continue;
      for (const ev of evaluatePosition(p, q, state.settings, now)) {
        const n = recordNotification(state, ev);
        if (n) out.push(n);
      }
    }
    return out;
  }

  // ------------------------------------------------------ portafolio
  const SECTORS = {
    NVDA: 'Semiconductores', AMD: 'Semiconductores', AVGO: 'Semiconductores', INTC: 'Semiconductores', TSM: 'Semiconductores',
    AAPL: 'Tecnología', MSFT: 'Tecnología', ORCL: 'Tecnología', CRM: 'Tecnología', ADBE: 'Tecnología',
    GOOGL: 'Comunicación', GOOG: 'Comunicación', META: 'Comunicación', NFLX: 'Comunicación', DIS: 'Comunicación',
    AMZN: 'Consumo discrecional', TSLA: 'Consumo discrecional', NKE: 'Consumo discrecional', HD: 'Consumo discrecional',
    JPM: 'Financiero', V: 'Financiero', MA: 'Financiero', BAC: 'Financiero',
    XOM: 'Energía', CVX: 'Energía', UNH: 'Salud', LLY: 'Salud', JNJ: 'Salud',
    QQQ: 'ETF (Nasdaq-100)', SPY: 'ETF (S&P 500)', VOO: 'ETF (S&P 500)', IWM: 'ETF (Russell 2000)',
  };
  const sectorOf = (t) => SECTORS[t] || 'Otro';

  function portfolioSummary(state, quotes, mode) {
    const ps = state.positions.filter((p) => p.mode === mode);
    const open = ps.filter((p) => p.status !== 'cerrada');
    const closed = ps.filter((p) => p.status === 'cerrada');
    let invested = 0, marketValue = 0, unrealized = 0;
    const byTicker = {}, bySector = {};
    for (const p of open) {
      const q = quotes[p.ticker];
      const price = q ? q.price : p.avgPrice;
      const m = positionMetrics(p, price);
      invested += m.cost; marketValue += m.marketValue; unrealized += m.pnl;
      byTicker[p.ticker] = (byTicker[p.ticker] || 0) + m.marketValue;
      const s = sectorOf(p.ticker);
      bySector[s] = (bySector[s] || 0) + m.marketValue;
    }
    const realized = ps.reduce((a, p) => a + (p.realizedPnl || 0), 0); // incluye ventas parciales
    const cash = mode === 'simulacion'
      ? state.settings.virtualCapital - invested + realized
      : num(state.settings.realCash);
    const toList = (o) => Object.entries(o).map(([k, v]) => ({ key: k, value: r2(v), pct: marketValue ? v / marketValue : 0 })).sort((a, b) => b.value - a.value);
    const wins = closed.filter((p) => p.realizedPnl > 0).length;
    return {
      mode, openCount: open.length, closedCount: closed.length,
      invested: r2(invested), marketValue: r2(marketValue), unrealized: r2(unrealized),
      realized: r2(realized), cash: r2(cash), total: r2(cash + marketValue),
      winRate: closed.length ? wins / closed.length : null,
      byTicker: toList(byTicker), bySector: toList(bySector),
    };
  }

  // --------------------------------------------------- indicadores y radar
  const sma = (arr, n) => arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null;
  function barStats(bars) {
    const closes = bars.map((b) => b.close);
    const last = bars[bars.length - 1];
    const last20 = bars.slice(-20);
    const avgVol = last20.reduce((a, b) => a + b.volume, 0) / last20.length;
    const dollarVol = last20.reduce((a, b) => a + b.volume * b.close, 0) / last20.length;
    const atr = bars.slice(-14).reduce((a, b) => a + (b.high - b.low) / b.close, 0) / Math.min(14, bars.length);
    const ref20 = closes.length > 20 ? closes[closes.length - 21] : closes[0];
    const high20 = Math.max(...last20.map((b) => b.high));
    return {
      close: last.close, date: last.date, sma20: sma(closes, 20), sma50: sma(closes, 50),
      avgVolume: avgVol, dollarVolume: dollarVol, atrPct: atr, ret20: last.close / ref20 - 1,
      offHigh20: last.close / high20 - 1,
    };
  }

  /*
   * universe: [{ ticker, quote:{price,type,asOf,source}, bars:[...], earningsDate }]
   * Devuelve { items (≤ maxResults), evaluated (todas con condiciones), empty }
   */
  function screen(universe, filters = DEFAULT_FILTERS, settings = DEFAULT_SETTINGS, today) {
    const f = { ...DEFAULT_FILTERS, ...filters };
    const evaluated = [];
    for (const u of universe) {
      if (!u.bars || u.bars.length < 50) { evaluated.push({ ticker: u.ticker, eligible: false, conditions: [{ label: 'Historial suficiente (50 sesiones)', ok: false, detail: 'Sin datos' }] }); continue; }
      const s = barStats(u.bars);
      const price = u.quote && u.quote.price > 0 ? u.quote.price : s.close;
      const dte = u.earningsDate && today ? daysBetween(today, u.earningsDate) : null;
      const usd = (x) => 'USD ' + fmt(x, 2);
      const conditions = [
        { key: 'precio', label: `Precio ≥ USD ${f.minPrice}`, ok: price >= f.minPrice, detail: usd(price) },
        { key: 'volumen', label: `Volumen prom. 20 d ≥ ${f.minAvgVolumeM} M acciones`, ok: s.avgVolume >= f.minAvgVolumeM * 1e6, detail: fmt(s.avgVolume / 1e6, 1) + ' M' },
        { key: 'liquidez', label: `Monto negociado ≥ USD ${f.minDollarVolumeM} M/día`, ok: s.dollarVolume >= f.minDollarVolumeM * 1e6, detail: 'USD ' + fmt(s.dollarVolume / 1e6, 0) + ' M' },
      ];
      if (f.trend === 'alcista') {
        conditions.push({ key: 'tendencia', label: 'Tendencia alcista (precio > SMA20 > SMA50)', ok: price > s.sma20 && s.sma20 > s.sma50, detail: `SMA20 ${fmt(s.sma20, 2)} · SMA50 ${fmt(s.sma50, 2)}` });
      }
      if (f.excludeEarningsDays > 0) {
        conditions.push({ key: 'resultados', label: `Sin resultados en los próximos ${f.excludeEarningsDays} días`, ok: dte == null || dte < 0 || dte > f.excludeEarningsDays, detail: dte == null ? 'Fecha no disponible' : (dte >= 0 ? `en ${dte} días (${u.earningsDate})` : 'ya publicados') });
      }
      const eligible = conditions.every((c) => c.ok);
      // Puntaje: momentum moderado + cercanía a la media de 20 (preferir retrocesos frente a extensiones).
      const ext = price / s.sma20 - 1;
      const score = s.ret20 * 100 - Math.abs(ext - 0.02) * 120 - (s.atrPct > 0.04 ? 3 : 0);
      const entryHigh = price * 1.005;
      const entryLow = Math.min(entryHigh, Math.max(s.sma20, price * 0.97));
      const ref = price;
      const stopPct = settings.stopPct;
      let risk;
      if (dte != null && dte >= 0 && dte <= 14) risk = `Resultados corporativos en ${dte} días: posible salto de precio (gap) en cualquier dirección.`;
      else if (ext > 0.08) risk = `Precio ${fmt(ext * 100, 1)} % sobre su SMA20: riesgo de retroceso antes de avanzar.`;
      else if (s.atrPct > 0.035) risk = `Volatilidad alta (rango diario medio ${fmt(s.atrPct * 100, 1)} %): movimientos bruscos en contra.`;
      else if (sectorOf(u.ticker).startsWith('ETF')) risk = 'Riesgo de mercado general: depende del comportamiento del Nasdaq-100.';
      else risk = `Concentración sectorial (${sectorOf(u.ticker)}) y riesgo de mercado general.`;
      const reasons = [];
      if (price > s.sma20) reasons.push(`cotiza sobre su media de 20 sesiones (${fmt(s.sma20, 2)})`);
      if (s.sma20 > s.sma50) reasons.push('media de 20 por encima de la de 50');
      reasons.push(`rendimiento 20 sesiones ${(s.ret20 >= 0 ? '+' : '') + fmt(s.ret20 * 100, 1)} %`);
      reasons.push(`liquidez USD ${fmt(s.dollarVolume / 1e6, 0)} M/día`);
      const daysEst = s.atrPct > 0 ? Math.round(Math.pow(0.10 / (s.atrPct * 0.6), 2)) : null;
      evaluated.push({
        ticker: u.ticker, sector: sectorOf(u.ticker), eligible, conditions, score: r2(score),
        price: r2(price), quote: u.quote || null,
        reason: reasons.join('; ').replace(/^./, (c) => c.toUpperCase()) + '.',
        entryLow: r2(entryLow), entryHigh: r2(entryHigh),
        target: r2(ref * (1 + (settings.targetPct || 10) / 100)),
        stop: stopPct ? r2(ref * (1 - stopPct / 100)) : null,
        earningsDate: u.earningsDate || null, daysToEarnings: dte, risk,
        stats: { sma20: r2(s.sma20), sma50: r2(s.sma50), ret20: r4(s.ret20), atrPct: r4(s.atrPct), avgVolume: Math.round(s.avgVolume), dollarVolume: Math.round(s.dollarVolume) },
        estDaysToTarget: daysEst,
        links: sourceLinks(u.ticker),
      });
    }
    const items = evaluated.filter((e) => e.eligible).sort((a, b) => b.score - a.score).slice(0, f.maxResults);
    return { items, evaluated, empty: items.length === 0, message: items.length ? null : 'Sin oportunidades que cumplan los criterios' };
  }
  function sourceLinks(t) {
    const l = t.toLowerCase();
    return {
      precio: `https://www.nasdaq.com/market-activity/${sectorOf(t).startsWith('ETF') ? 'etf' : 'stocks'}/${l}`,
      noticias: `https://finance.yahoo.com/quote/${t}/news`,
      resultados: `https://www.nasdaq.com/market-activity/stocks/${l}/earnings`,
      etoro: `https://www.etoro.com/markets/${l}`,
    };
  }

  // -------------------------------------------------- simulador histórico
  /*
   * bars: velas diarias con precios AJUSTADOS por splits/dividendos.
   * params: { capital, entryRule, targetPct, stopPct, dipPct, commission, commissionPct, slippagePct, maxDays }
   *
   * Modelo de ejecución (documentado en la interfaz):
   *  - La señal se calcula con el cierre del día t; la compra se ejecuta en la
   *    apertura del día t+1 más deslizamiento. Se invierte todo el capital disponible.
   *  - Objetivo = precio de entrada × (1 + objetivo %). Orden límite: si la vela abre
   *    por encima, se ejecuta al precio objetivo (conservador, no se asume la mejora).
   *  - Salida por pérdida: si abre por debajo, se ejecuta a la apertura (gap);
   *    si no, al nivel de stop, en ambos casos menos deslizamiento.
   *  - Si una vela toca objetivo y stop y no se puede saber el orden, se asume
   *    que primero tocó el stop (criterio conservador) y se marca «ambigua».
   *  - El día de la compra también se evalúa (desde la apertura).
   *  - Al acabar el período, la posición abierta se valora al último cierre.
   */
  function backtest(bars, params) {
    const P = {
      capital: 10000, entryRule: 'cruce_sma20', targetPct: 10, stopPct: null, dipPct: 5,
      commission: 0, commissionPct: 0, slippagePct: 0.05, maxDays: 0, ...params,
    };
    const tp = P.targetPct / 100, sl = P.stopPct ? P.stopPct / 100 : null;
    const slip = (P.slippagePct || 0) / 100;
    const fee = (amt) => (P.commission || 0) + amt * ((P.commissionPct || 0) / 100);
    const closes = bars.map((b) => b.close);
    let cash = P.capital, pos = null;
    const trades = [], equity = [];
    let peak = P.capital, maxDD = 0;
    const signal = (i) => {
      if (P.entryRule === 'inmediata') return true;
      if (i < 50) return false;
      const s20 = sma(closes.slice(0, i + 1), 20), s20p = sma(closes.slice(0, i), 20);
      const s50 = sma(closes.slice(0, i + 1), 50);
      if (P.entryRule === 'cruce_sma20') return closes[i - 1] <= s20p && closes[i] > s20 && s20 > s50 * 0.98;
      if (P.entryRule === 'retroceso') {
        const hi = Math.max(...closes.slice(Math.max(0, i - 19), i + 1));
        return closes[i] <= hi * (1 - P.dipPct / 100) && closes[i] > s50;
      }
      return false;
    };
    const exit = (i, price, reason, ambiguous = false) => {
      const gross = price * pos.shares;
      const f = fee(gross);
      cash += gross - f;
      const pnl = gross - f - pos.cost;
      trades.push({ entryDate: pos.date, entryPrice: r4(pos.price), exitDate: bars[i].date, exitPrice: r4(price), shares: r4(pos.shares), pnl: r2(pnl), pnlPct: r4(pnl / pos.cost), days: daysBetween(pos.date, bars[i].date), bars: i - pos.i + 1, reason, ambiguous });
      pos = null;
    };
    let pendingEntry = P.entryRule === 'inmediata' ? 0 : -1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!pos && pendingEntry === i && cash > 0) {
        const price = b.open * (1 + slip);
        const f = fee(cash);
        const shares = (cash - f) / price;
        if (shares > 0) {
          pos = { i, date: b.date, price, shares, cost: cash, target: price * (1 + tp), stop: sl ? price * (1 - sl) : null };
          cash = 0;
        }
      }
      if (pos) {
        const hitT = b.high >= pos.target;
        const hitS = pos.stop != null && b.low <= pos.stop;
        const gapDown = pos.stop != null && pos.i !== i && b.open <= pos.stop;
        const gapUp = pos.i !== i && b.open >= pos.target;
        if (gapDown) exit(i, b.open * (1 - slip), 'stop (gap)');
        else if (gapUp) exit(i, pos.target, 'objetivo');
        else if (hitT && hitS) exit(i, pos.stop * (1 - slip), 'stop', true);
        else if (hitS) exit(i, pos.stop * (1 - slip), 'stop');
        else if (hitT) exit(i, pos.target, 'objetivo');
        else if (P.maxDays > 0 && i - pos.i + 1 >= P.maxDays) exit(i, b.close * (1 - slip), 'tiempo máximo');
      }
      const eq = cash + (pos ? pos.shares * b.close : 0);
      equity.push({ date: b.date, value: r2(eq) });
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, (peak - eq) / peak);
      if (!pos && pendingEntry <= i) {
        if (P.entryRule === 'inmediata') pendingEntry = i + 1;
        else if (signal(i)) pendingEntry = i + 1;
      }
    }
    let openAtEnd = null;
    if (pos) {
      const last = bars[bars.length - 1];
      openAtEnd = { entryDate: pos.date, entryPrice: r4(pos.price), lastClose: last.close, pnl: r2(pos.shares * last.close - pos.cost) };
    }
    const finalValue = equity.length ? equity[equity.length - 1].value : P.capital;
    const hits = trades.filter((t) => t.reason === 'objetivo').length;
    return {
      params: P,
      trades, equity, openAtEnd,
      metrics: {
        trades: trades.length,
        hitTargetPct: trades.length ? hits / trades.length : 0,
        hits, stops: trades.filter((t) => t.reason.startsWith('stop')).length,
        ambiguous: trades.filter((t) => t.ambiguous).length,
        netReturn: r4(finalValue / P.capital - 1),
        finalValue: r2(finalValue),
        maxDrawdown: r4(maxDD),
        avgDaysToClose: trades.length ? r2(trades.reduce((a, t) => a + t.days, 0) / trades.length) : null,
        buyHold: bars.length ? r4(bars[bars.length - 1].close / bars[0].open - 1) : 0,
      },
    };
  }

  // -------------------------------------------------- datos de demostración
  const DEMO_BASE = {
    NVDA: [182, 0.028, 230e6], TSLA: [410, 0.034, 95e6], AAPL: [262, 0.015, 52e6], MSFT: [505, 0.014, 21e6],
    AMZN: [232, 0.019, 44e6], GOOGL: [278, 0.018, 33e6], META: [690, 0.022, 13e6], QQQ: [598, 0.011, 48e6],
    AMD: [235, 0.03, 60e6], SPY: [665, 0.009, 70e6],
  };
  function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

  // Serie diaria sintética, determinista por ticker; termina en `endDate` (último día hábil ≤ endDate).
  function demoBars(ticker, endDate, sessions = 260) {
    const [base, vol, avgVol] = DEMO_BASE[ticker] || [50 + (hash(ticker) % 300), 0.022, 8e6];
    const days = [];
    let d = isTradingDay(endDate) ? endDate : (() => { let x = endDate; while (!isTradingDay(x)) x = addDays(x, -1); return x; })();
    while (days.length < sessions) { if (isTradingDay(d)) days.unshift(d); d = addDays(d, -1); }
    // Semilla anclada al primer día de un calendario fijo para que la serie sea estable en el tiempo.
    const r = rng(hash(ticker));
    const drift = ((hash(ticker + 'd') % 100) / 100 - 0.35) * 0.0016;
    const anchor = '2020-01-02';
    let steps = 0; let x = anchor; while (x < days[0]) { if (isTradingDay(x)) steps++; x = addDays(x, 1); }
    let price = base;
    for (let k = 0; k < steps; k++) { gauss(r); gauss(r); r(); r(); } // avanza el generador
    const raw = [];
    for (const day of days) {
      const ret = drift + vol * gauss(r) + 0.012 * Math.sin((steps + raw.length) / 23 + hash(ticker) % 7);
      const open = price * (1 + vol * 0.3 * gauss(r));
      const close = Math.max(1, price * (1 + ret));
      const hi = Math.max(open, close) * (1 + Math.abs(vol * 0.5 * gauss(r)));
      const lo = Math.min(open, close) * (1 - Math.abs(vol * 0.5 * gauss(r)));
      raw.push({ date: day, open, high: hi, low: lo, close, volume: Math.round(avgVol * (0.6 + r() * 0.8)) });
      price = close;
    }
    // Escala para que el último cierre ≈ precio base (precios de referencia demo).
    const k = base / raw[raw.length - 1].close;
    return raw.map((b) => ({ date: b.date, open: r2(b.open * k), high: r2(b.high * k), low: r2(b.low * k), close: r2(b.close * k), adjClose: r2(b.close * k), volume: b.volume }));
  }
  // Cotización demo: último cierre con variación intradía determinista por minuto.
  function demoQuote(ticker, now = new Date()) {
    const nyDate = zoned(now, NY).date;
    const bars = demoBars(ticker, nyDate, 60);
    const last = bars[bars.length - 1];
    const minute = Math.floor(now.getTime() / 60000);
    const r = rng(hash(ticker) ^ minute);
    const ms = marketStatus(now);
    const vol = (DEMO_BASE[ticker] || [0, 0.02])[1];
    const price = ms.state === 'abierto' ? last.close * (1 + vol * 0.25 * gauss(r)) : last.close;
    return { ticker, price: r2(price), prevClose: bars[bars.length - 2].close, type: 'simulada', source: 'Demostración', asOf: now.toISOString() };
  }
  function demoEarnings(ticker, today) {
    if (sectorOf(ticker).startsWith('ETF')) return null;
    const off = 3 + (hash(ticker + today.slice(0, 7)) % 70);
    return nextTradingDay(addDays(today, off), true);
  }

  // ------------------------------------------------ verificación de criterios
  function acceptanceChecks() {
    const res = [];
    const check = (name, fn) => { try { const d = fn(); res.push({ name, ok: true, detail: d }); } catch (e) { res.push({ name, ok: false, detail: e.message }); } };
    const assert = (c, m) => { if (!c) throw new Error(m); };
    check('Compra simulada a USD 200 → objetivo bruto USD 220 y cierre al alcanzarlo', () => {
      const p = createPosition({ ticker: 'NVDA', avgPrice: 200, shares: 5, mode: 'simulacion' });
      assert(targets(p).gross === 220, 'Objetivo bruto ' + targets(p).gross);
      const ev1 = evaluatePosition(p, { price: 219.99 });
      assert(ev1.length === 0 && p.status === 'abierta', 'No debe cerrar a 219,99');
      const ev2 = evaluatePosition(p, { price: 220 });
      assert(p.status === 'cerrada' && p.close.price === 220, 'Debe cerrar a 220');
      assert(ev2.map((e) => e.type).join(',') === 'objetivo,cierre_simulado', 'Eventos');
      assert(p.realizedPnl === 100, 'Ganancia esperada USD 100, obtuvo ' + p.realizedPnl);
      return 'Objetivo 220,00 · cierre a 220,00 · ganancia USD 100,00';
    });
    check('Operación real: llegar a USD 220 dispara la alerta sin cerrar', () => {
      const s = emptyState();
      const p = createPosition({ ticker: 'NVDA', avgPrice: 200, shares: 5, mode: 'real' });
      s.positions.push(p);
      const n1 = applyQuotes(s, { NVDA: { price: 220 } });
      assert(n1.length === 1 && n1[0].type === 'objetivo', 'Debe generar una alerta');
      assert(p.status === 'objetivo_alcanzado', 'Estado ' + p.status);
      const n2 = applyQuotes(s, { NVDA: { price: 221 } });
      assert(n2.length === 0, 'No debe duplicar la alerta');
      let blocked = false;
      try { closePosition(p, { price: 220, source: 'simulacion' }); } catch (e) { blocked = true; }
      assert(blocked && p.status !== 'cerrada', 'Una posición real no puede cerrarse sin ejecución');
      return 'Alerta única · estado «Objetivo alcanzado» · posición sigue abierta';
    });
    check('Operación real: el cierre solo se registra al ingresar la ejecución', () => {
      const p = createPosition({ ticker: 'NVDA', avgPrice: 200, shares: 5, mode: 'real' });
      evaluatePosition(p, { price: 222 });
      closePosition(p, { price: 221.4, source: 'manual' });
      assert(p.status === 'cerrada' && p.close.price === 221.4, 'Debe cerrar con el precio ejecutado');
      assert(p.realizedPnl === 107, 'Resultado basado en ejecución: ' + p.realizedPnl);
      const ev = evaluatePosition(p, { price: 250 });
      assert(ev.length === 0, 'Una posición cerrada no genera más alertas');
      return 'Cerrada a 221,40 (precio real) · ganancia USD 107,00 · alertas detenidas';
    });
    check('Objetivo neto con costos', () => {
      const p = createPosition({ ticker: 'AAPL', avgPrice: 200, shares: 10, buyFee: 2, sellFeeFixed: 2 });
      const t = targets(p);
      // costo 2002 → necesita 2202,2 + 2 de comisión de venta = 2204,2 / 10
      assert(t.net === 220.42, 'Neto ' + t.net);
      return 'Bruto 220,00 · neto 220,42';
    });
    return res;
  }

  return {
    r2, r4, num, uid, ymd, addDays, daysBetween, zoned, zonedToUtc,
    nyseHolidays, isTradingDay, nextTradingDay, holidayName, earlyClose, marketStatus, nextDailyAlert,
    DEFAULT_SETTINGS, DEFAULT_FILTERS, DEFAULT_WATCHLIST,
    targets, positionCost, positionMetrics, createPosition, closePosition, evaluatePosition, editPosition, undoLastFill, upgradePosition,
    emptyState, normalizeState, recordNotification, applyQuotes, eventKey,
    sectorOf, portfolioSummary, barStats, screen, sourceLinks, backtest,
    demoBars, demoQuote, demoEarnings, acceptanceChecks, NY, BOGOTA,
  };
});
