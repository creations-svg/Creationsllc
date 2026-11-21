/* Radar Bursátil USA — interfaz. Requiere core.js (window.RadarCore). */
(() => {
  'use strict';
  const C = window.RadarCore;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf2 = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const nf4 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 4 });
  const usd = (x) => (x == null || !isFinite(x) ? '—' : (x < 0 ? '−' : '') + 'USD ' + nf2.format(Math.abs(x)));
  const susd = (x) => (x > 0 ? '+' : '') + usd(x);
  const pct = (x, sign = true) => (x == null || !isFinite(x) ? '—' : (sign && x > 0 ? '+' : x < 0 ? '−' : '') + nf2.format(Math.abs(x * 100)) + ' %');
  const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
  const when = (iso) => iso ? new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }) : '—';
  const QTYPE = { tiempo_real: 'Tiempo real', retrasada: 'Retrasada', cierre: 'De cierre', simulada: 'Simulada (demo)', manual: 'Manual' };
  const STATUS = { abierta: ['Abierta', ''], objetivo_alcanzado: ['Objetivo alcanzado', 'hit'], cerrada: ['Cerrada', 'ok'] };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  };

  // --------------------------------------------------------- identidad
  let USER = store.get('radar_user');
  if (!USER || !/^[a-zA-Z0-9_-]{6,64}$/.test(USER)) { USER = 'u_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store.set('radar_user', USER); }

  // ----------------------------------------------------------- API remota
  async function call(method, path, body) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-user-id': USER }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Error ' + r.status);
    return j;
  }
  const remote = {
    getState: () => call('GET', '/api/state'),
    saveSettings: (b) => call('PUT', '/api/settings', b),
    addPosition: (b) => call('POST', '/api/positions', b),
    closePosition: (id, b) => call('POST', `/api/positions/${id}/close`, b),
    manualPrice: (id, price) => call('POST', `/api/positions/${id}/price`, { price }),
    deletePosition: (id) => call('DELETE', `/api/positions/${id}`),
    editPosition: (id, b) => call('PATCH', `/api/positions/${id}`, b),
    undoFill: (id) => call('POST', `/api/positions/${id}/undo-fill`),
    check: () => call('POST', '/api/check'),
    radar: () => call('GET', '/api/radar'),
    sendRadar: () => call('POST', '/api/radar/send'),
    markRead: () => call('POST', '/api/notifications/read'),
    testNotify: () => call('POST', '/api/notifications/test'),
    quotes: (s) => call('GET', '/api/quotes?symbols=' + encodeURIComponent(s.join(','))),
    history: (t, n) => call('GET', `/api/history?symbol=${encodeURIComponent(t)}&sessions=${n}`),
    market: () => call('GET', '/api/market'),
    fx: () => call('GET', '/api/fx'),
    reset: () => call('POST', '/api/reset'),
  };

  // -------------------------------- API local (sin servidor: todo en el navegador, datos demo)
  const LKEY = 'radar_state_v1';
  const lload = () => { try { return C.normalizeState(JSON.parse(store.get(LKEY))); } catch { return C.emptyState(); } };
  const lsave = (s) => store.set(LKEY, JSON.stringify(s));
  const lmut = (fn) => { const s = lload(); const r = fn(s); lsave(s); return r; };
  const today = () => C.zoned(new Date(), C.NY).date;
  const sentNow = (n) => { if (n) n.channels = [{ channel: 'app', status: 'enviada', sentAt: new Date().toISOString() }]; return n; };
  const localRadar = (s) => {
    const d = today();
    const uni = s.watchlist.map((t) => ({ ticker: t, quote: C.demoQuote(t), bars: C.demoBars(t, d, 120), earningsDate: C.demoEarnings(t, d) }));
    return { ...C.screen(uni, s.filters, s.settings, d), generatedAt: new Date().toISOString(), nyDate: d, provider: 'Demostración' };
  };
  const local = {
    getState: async () => ({ ...lload(), server: { provider: 'Demostración (local)', historyProvider: 'Demostración', realExecutionAvailable: false, channels: [{ id: 'app', name: 'Bandeja de la aplicación', active: true }, { id: 'navegador', name: 'Notificación del navegador (con la app abierta)', active: true }, { id: 'externos', name: 'WhatsApp / Telegram / ntfy / webhook', active: false, note: 'Requieren el servidor (ver GUIA.md)' }] } }),
    saveSettings: async (b) => { lmut((s) => { if (b.settings) s.settings = { ...s.settings, ...b.settings, realExecution: false }; if (b.filters) s.filters = { ...s.filters, ...b.filters }; if (b.watchlist) s.watchlist = b.watchlist; }); return local.getState(); },
    addPosition: async (b) => lmut((s) => { const p = C.createPosition(b, s.settings); s.positions.unshift(p); return p; }),
    closePosition: async (id, b) => lmut((s) => { const p = s.positions.find((x) => x.id === id); if (!p) throw new Error('Posición no encontrada'); return C.closePosition(p, { ...b, source: 'manual' }); }),
    manualPrice: async (id, price) => lmut((s) => { const p = s.positions.find((x) => x.id === id); return { notifications: C.applyQuotes(s, { [p.ticker]: { price: C.num(price), type: 'manual' } }).filter((n) => n.ticker === p.ticker).map(sentNow) }; }),
    deletePosition: async (id) => lmut((s) => { s.positions = s.positions.filter((x) => x.id !== id); return { ok: true }; }),
    editPosition: async (id, b) => lmut((s) => C.editPosition(s, id, b)),
    undoFill: async (id) => lmut((s) => C.undoLastFill(s, id)),
    check: async () => lmut((s) => {
      const q = {}; s.positions.filter((p) => p.status !== 'cerrada').forEach((p) => { q[p.ticker] = C.demoQuote(p.ticker); });
      const out = C.applyQuotes(s, q).map(sentNow);
      // Alerta diaria mientras la app esté abierta (sin servidor no hay envío en segundo plano).
      const b = C.zoned(new Date(), C.BOGOTA);
      const at = s.settings.alertHour * 60 + s.settings.alertMinute;
      if (s.settings.alertsEnabled && C.isTradingDay(b.date) && b.minutes >= at && !s.sentKeys['radar:' + b.date]) {
        const r = localRadar(s); s.lastRadar = r;
        const n = sentNow(C.recordNotification(s, { type: 'radar', date: b.date, items: r.items, at: new Date().toISOString() }));
        if (n) out.push(n);
      }
      return { notifications: out };
    }),
    radar: async () => lmut((s) => (s.lastRadar = localRadar(s))),
    sendRadar: async () => lmut((s) => { const r = localRadar(s); s.lastRadar = r; return { notification: sentNow(C.recordNotification(s, { type: 'radar', key: 'radar-manual:' + Date.now(), date: C.zoned(new Date(), C.BOGOTA).date, items: r.items, at: new Date().toISOString() })) }; }),
    markRead: async () => lmut((s) => { s.notifications.forEach((n) => { n.read = true; }); return {}; }),
    testNotify: async () => lmut((s) => ({ notification: sentNow(C.recordNotification(s, { type: 'prueba', key: 'prueba:' + Date.now(), title: '🔔 Prueba de notificación', body: 'Si ves este mensaje, el canal está funcionando.' })) })),
    quotes: async (syms) => Object.fromEntries(syms.map((t) => [t, C.demoQuote(t)])),
    history: async (t, n) => ({ bars: C.demoBars(t, today(), n), source: 'Demostración', adjusted: true, type: 'simulada' }),
    market: async () => ({ ...C.marketStatus(), nextAlert: C.nextDailyAlert(new Date(), lload().settings.alertHour, lload().settings.alertMinute) }),
    fx: async () => ({ rate: 3900, source: 'Valor de demostración', asOf: new Date().toISOString(), type: 'simulada' }),
    reset: async () => { lsave(C.emptyState()); return { ok: true }; },
  };

  let api = remote, SERVER = true;
  const S = { state: null, quotes: {}, manual: {}, fx: null, market: null, radar: null, tab: 'inicio', opsMode: 'real', bt: null, seen: new Set(), booted: false, form: { sizing: 'capital' } };

  // ------------------------------------------------------------ utilidades UI
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }
  const fxRate = () => (S.state && C.num(S.state.settings.fxManual) > 0 ? C.num(S.state.settings.fxManual) : S.fx ? S.fx.rate : null);
  const cop = (x) => { const r = fxRate(); return r && x != null && isFinite(x) ? '≈ ' + (x < 0 ? '−' : '') + '$' + nf0.format(Math.abs(x * r)) + ' COP' : ''; };
  const fxNote = () => {
    const r = fxRate(); if (!r) return 'Tasa USD/COP no disponible';
    const manual = C.num(S.state.settings.fxManual) > 0;
    return `Tasa usada: 1 USD = $${nf2.format(r)} COP · ${manual ? 'manual (Ajustes)' : esc(S.fx.source) + ' · ' + when(S.fx.asOf)} — Conversión informativa: eToro aplica su propia tasa y comisión de conversión.`;
  };
  const quoteFor = (t) => S.manual[t] || S.quotes[t] || null;
  const qTag = (q) => q ? `<span class="tag q-${q.type}" title="${esc(q.source || '')}">${QTYPE[q.type] || q.type} · ${hhmm(q.asOf)}</span>` : '<span class="tag">Sin cotización</span>';
  const field = (name, label, value = '', attrs = '', hint = '') => `<div class="field"><label for="f_${name}">${label}</label><input id="f_${name}" name="${name}" value="${esc(value)}" ${attrs}>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const numAttrs = 'type="number" step="any" inputmode="decimal"';

  function openDialog(html, onSubmit) {
    const d = $('#dialog'), f = $('#dialogForm');
    f.innerHTML = html;
    f.onsubmit = async (e) => {
      const btn = e.submitter;
      if (!btn || btn.value === 'cancel') return;
      e.preventDefault();
      try { const keep = await onSubmit(Object.fromEntries(new FormData(f)), btn.value); if (!keep) d.close(); }
      catch (err) { toast(err.message); }
    };
    d.showModal();
  }

  // ------------------------------------------------------------- datos
  async function loadState() { S.state = await api.getState(); notifyNew(); renderBadge(); }
  async function refreshMarket() {
    const syms = new Set(S.state ? S.state.watchlist : C.DEFAULT_WATCHLIST);
    if (S.state) S.state.positions.filter((p) => p.status !== 'cerrada').forEach((p) => syms.add(p.ticker));
    const fxFresh = S.fx && Date.now() - S.fxAt < 3600e3;
    const [q, m, fx] = await Promise.all([api.quotes([...syms]), api.market(), fxFresh ? S.fx : api.fx()]);
    S.quotes = q; S.market = m; S.fx = fx; if (!fxFresh) S.fxAt = Date.now();
    const pill = $('#marketPill');
    pill.dataset.state = m.state; pill.textContent = `${m.label} · NY ${m.nyTime}`;
  }
  async function cycle() {
    try {
      await refreshMarket();
      await api.check();
      await loadState();
      // No redibujar encima de un formulario a medio llenar ni con un diálogo abierto.
      if (!S.dirty && !$('#dialog').open) render(); else renderBadge();
    } catch (e) { console.warn(e); }
  }
  function notifyNew() {
    const ns = S.state.notifications || [];
    const fresh = ns.filter((n) => !S.seen.has(n.id));
    ns.forEach((n) => S.seen.add(n.id));
    if (!S.booted) return;
    for (const n of fresh.reverse()) {
      toast(n.title);
      if (S.state.settings.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(n.title, { body: n.body, icon: 'icon.svg', tag: n.key }); } catch { /* móvil sin soporte */ }
      }
    }
  }
  function renderBadge() {
    const c = (S.state.notifications || []).filter((n) => !n.read).length;
    const b = $('#bellBadge'); b.hidden = !c; b.textContent = c > 99 ? '99+' : c;
  }

  // ------------------------------------------------------------- vistas
  function render() {
    if (!S.state) return;
    S.dirty = false;
    const v = $('#view');
    const y = window.scrollY;
    v.innerHTML = ({ inicio: vInicio, radar: vRadar, operaciones: vOperaciones, simulador: vSimulador })[S.tab]() + '<p class="disclaimer">Herramienta de análisis y seguimiento. No es asesoría de inversión ni ejecuta órdenes reales. Verifica precios en eToro antes de operar.</p>';
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
    window.scrollTo(0, y);
    updateCountdown();
    updatePreviews();
  }

  // ---- Inicio
  function vInicio() {
    const m = S.market || {};
    const s = S.state;
    const open = s.positions.filter((p) => p.status !== 'cerrada');
    const near = open.map((p) => ({ p, q: quoteFor(p.ticker) })).map((x) => ({ ...x, m: C.positionMetrics(x.p, x.q ? x.q.price : x.p.avgPrice) }))
      .sort((a, b) => (b.p.status === 'objetivo_alcanzado') - (a.p.status === 'objetivo_alcanzado') || a.m.toTargetPct - b.m.toTargetPct).slice(0, 4);
    const real = C.portfolioSummary(s, mergedQuotes(), 'real');
    const r = s.lastRadar;
    const wl = s.watchlist.slice(0, 8).map((t) => { const q = quoteFor(t); const ch = q && q.prevClose ? q.price / q.prevClose - 1 : null; return `<div class="row"><span><b>${t}</b> <small>${C.sectorOf(t)}</small></span><span>${q ? usd(q.price) : '—'} <small class="${cls(ch)}">${ch != null ? pct(ch) : ''}</small></span></div>`; }).join('');
    return `
    <section class="card">
      <div class="card-head"><h2>Próxima alerta del radar</h2><span class="tag">${s.settings.alertsEnabled ? 'Activa' : 'Desactivada'}</span></div>
      <div class="countdown" id="countdown">—</div>
      <div class="muted" id="countdownWhen"></div>
      ${r ? `<div class="callout info"><b>Último radar (${when(r.generatedAt)}):</b> ${r.items.length ? r.items.map((i) => `${i.ticker} ${usd(i.price)}`).join(' · ') : esc(r.message)}</div>` : ''}
      <div class="actions"><button class="btn primary small" data-act="go" data-tab="radar">Ver radar</button><button class="btn small" data-act="sendRadar">Enviar alerta ahora</button></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Cerca del objetivo</h2><button class="btn ghost small" data-act="go" data-tab="operaciones">Todas</button></div>
      ${near.length ? near.map(({ p, q, m: mm }) => `
        <div class="row" style="align-items:center">
          <span><b>${p.ticker}</b> ${p.mode === 'simulacion' ? '<span class="tag sim">Práctica</span>' : ''} ${p.status === 'objetivo_alcanzado' ? '<span class="tag hit">Objetivo alcanzado</span>' : ''}<br><small>${q ? usd(q.price) : 'sin precio'} → objetivo ${usd(mm.targets.trigger)}</small></span>
          <span>${p.status === 'objetivo_alcanzado' && p.mode === 'real' ? `<button class="btn good small" data-act="close" data-id="${p.id}">Registrar venta</button>` : `<b>${mm.toTargetUsd > 0 ? 'faltan ' + pct(mm.toTargetPct, false) : 'en objetivo'}</b><br><small class="${cls(mm.pnl)}">${susd(mm.pnl)}</small>`}</span>
        </div>
        <div class="progress" style="margin:2px 0 8px"><i style="width:${(mm.progress * 100).toFixed(1)}%"></i></div>`).join('') : '<div class="empty">No hay operaciones abiertas. Registra una en <b>Operaciones</b> o practica en <b>Simulador</b>.</div>'}
    </section>

    <div class="cols">
    <section class="card">
      <div class="card-head"><h2>Mercado</h2>${m.reason ? `<span class="tag">${esc(m.reason)}</span>` : ''}</div>
      <div class="grid2">
        <div class="stat"><div class="k">Nueva York</div><div class="v">${m.nyTime || '—'}</div><div class="s">${m.label || ''}${m.closeTimeNY ? ' · cierre ' + m.closeTimeNY : ''}${m.earlyClose ? ' (anticipado)' : ''}</div></div>
        <div class="stat"><div class="k">Colombia</div><div class="v">${m.bogotaTime || '—'}</div><div class="s">Próx. apertura ${m.state === 'abierto' ? 'hoy' : when(m.nextOpen)}</div></div>
      </div>
      <div style="margin-top:8px">${wl}</div>
      <div class="hint">Cotizaciones: ${esc(s.server.provider)} · ${Object.values(S.quotes)[0] ? QTYPE[Object.values(S.quotes)[0].type] : ''} · actualizado ${hhmm(new Date().toISOString())}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Mis operaciones reales</h2><small>${real.openCount} abiertas</small></div>
      <div class="grid2">
        <div class="stat"><div class="k">Capital invertido</div><div class="v">${usd(real.invested)}</div><div class="s">${cop(real.invested)}</div></div>
        <div class="stat"><div class="k">No realizado</div><div class="v ${cls(real.unrealized)}">${susd(real.unrealized)}</div><div class="s">${cop(real.unrealized)}</div></div>
        <div class="stat"><div class="k">Realizado</div><div class="v ${cls(real.realized)}">${susd(real.realized)}</div><div class="s">${real.closedCount} cerradas</div></div>
        <div class="stat"><div class="k">Valor de mercado</div><div class="v">${usd(real.marketValue)}</div><div class="s">${cop(real.marketValue)}</div></div>
      </div>
      <div class="hint">${fxNote()}</div>
    </section>
    </div>

    <section class="card">
      <div class="card-head"><h2>Notificaciones recientes</h2><button class="btn ghost small" data-act="inbox">Ver todas</button></div>
      ${ntfList(s.notifications.slice(0, 4))}
    </section>`;
  }
  function ntfList(ns) {
    if (!ns.length) return '<div class="empty">Aún no hay notificaciones.</div>';
    return ns.map((n) => `<div class="ntf ${n.read ? '' : 'unread'}"><div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div><div class="m">${when(n.createdAt)} · ${n.channels.map((c) => `${esc(c.channel)}: ${esc(c.status)}${c.sentAt ? ' ' + hhmm(c.sentAt) : ''}`).join(' · ')}</div></div>`).join('');
  }
  function updateCountdown() {
    const el = $('#countdown'); if (!el || !S.market) return;
    const na = C.nextDailyAlert(new Date(), S.state.settings.alertHour, S.state.settings.alertMinute);
    const ms = new Date(na.at) - Date.now();
    const h = Math.floor(ms / 3600e3), mi = Math.floor((ms % 3600e3) / 60e3), se = Math.floor((ms % 60e3) / 1e3);
    el.textContent = ms > 0 ? `${h > 47 ? Math.floor(h / 24) + ' d ' + (h % 24) + ' h' : h + ' h ' + String(mi).padStart(2, '0') + ' min'}${h < 1 ? ' ' + String(se).padStart(2, '0') + ' s' : ''}` : 'ahora';
    const d = new Date(na.at);
    $('#countdownWhen').textContent = `${d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' })}, ${hhmm(na.at)} hora de Colombia · solo días hábiles de NYSE`;
  }
  const mergedQuotes = () => ({ ...S.quotes, ...S.manual });

  // ---- Radar
  function vRadar() {
    const s = S.state, f = s.filters, r = S.radar || s.lastRadar;
    return `
    <section class="card">
      <div class="card-head"><h2>Lista de seguimiento</h2><small>${s.watchlist.length} tickers</small></div>
      <div class="tags">${s.watchlist.map((t) => `<span class="chip">${t}<button data-act="rmTicker" data-t="${t}" aria-label="Quitar ${t}">✕</button></span>`).join('')}</div>
      <form data-form="addTicker" class="actions" style="flex-wrap:nowrap"><input name="t" placeholder="Agregar ticker (ej. AMD)" maxlength="10" autocapitalize="characters" style="margin:0"><button class="btn small">Agregar</button></form>
    </section>
    <section class="card">
      <details ${S.filtersOpen ? 'open' : ''} id="filtersBox"><summary>Filtros del radar</summary>
      <form data-form="filters" style="margin-top:10px">
        <div class="grid2">
          ${field('minPrice', 'Precio mínimo (USD)', f.minPrice, numAttrs)}
          ${field('minAvgVolumeM', 'Volumen prom. 20 d (M acciones)', f.minAvgVolumeM, numAttrs)}
          ${field('minDollarVolumeM', 'Liquidez mínima (USD M/día)', f.minDollarVolumeM, numAttrs)}
          ${field('excludeEarningsDays', 'Excluir si hay resultados en ≤ días', f.excludeEarningsDays, numAttrs, '0 = no excluir')}
          <div class="field"><label>Tendencia</label><select name="trend"><option value="alcista" ${f.trend === 'alcista' ? 'selected' : ''}>Alcista (precio > SMA20 > SMA50)</option><option value="cualquiera" ${f.trend === 'cualquiera' ? 'selected' : ''}>Cualquiera</option></select></div>
          ${field('maxResults', 'Máximo de oportunidades', f.maxResults, 'type="number" min="1" max="10"')}
        </div>
        <button class="btn primary small">Guardar filtros y analizar</button>
      </form></details>
    </section>
    <div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="runRadar">Actualizar radar</button><button class="btn" data-act="sendRadar">Enviar alerta ahora</button></div>
    ${r ? `
      <div class="muted" style="margin-bottom:8px;font-size:13px">Generado ${when(r.generatedAt)} · fuente ${esc(r.provider)} · sesión NY ${r.nyDate}</div>
      ${r.items.length ? r.items.map(oppCard).join('') : `<section class="card"><div class="empty"><b>${esc(r.message)}</b><br>Revisa la tabla para ver qué condición falló en cada acción.</div></section>`}
      <section class="card"><h2>Todas las evaluadas</h2><div class="scroll"><table>
        <thead><tr><th>Ticker</th><th class="r">Precio</th><th>Resultado</th><th>Condiciones no cumplidas</th></tr></thead>
        <tbody>${r.evaluated.map((e) => `<tr><td><b>${e.ticker}</b></td><td class="r">${e.price ? usd(e.price) : '—'}</td><td>${e.eligible ? '<span class="tag ok">Cumple</span>' : '<span class="tag">No cumple</span>'}</td><td style="white-space:normal;min-width:220px">${e.conditions.filter((c) => !c.ok).map((c) => esc(c.label) + ' (' + esc(c.detail) + ')').join('; ') || '—'}</td></tr>`).join('')}</tbody>
      </table></div></section>` : '<section class="card"><div class="empty">Pulsa «Actualizar radar» para analizar tu lista.</div></section>'}`;
  }
  function oppCard(o) {
    return `<section class="card opp">
      <div class="head"><div><span class="ticker">${o.ticker}</span> <small>${esc(o.sector)}</small></div><div style="text-align:right"><div class="big" style="font-size:1.25rem">${usd(o.price)}</div>${qTag(o.quote)}</div></div>
      <p style="margin:8px 0;font-size:14px"><b>Motivo:</b> ${esc(o.reason)}</p>
      <div class="grid3">
        <div class="stat"><div class="k">Zona de entrada</div><div class="v" style="font-size:.95rem">${nf2.format(o.entryLow)}–${nf2.format(o.entryHigh)}</div></div>
        <div class="stat"><div class="k">Objetivo (+${S.state.settings.targetPct} %)</div><div class="v pos" style="font-size:.95rem">${usd(o.target)}</div></div>
        <div class="stat"><div class="k">Salida por pérdida</div><div class="v ${o.stop ? 'neg' : ''}" style="font-size:.95rem">${o.stop ? usd(o.stop) : 'No configurada'}</div></div>
      </div>
      <div class="row"><span>Próximos resultados</span><span>${o.earningsDate ? `${o.earningsDate} (${o.daysToEarnings} días)` : 'No aplica / sin fecha'}</span></div>
      <div class="callout bad" style="margin-top:6px"><b>Principal riesgo:</b> ${esc(o.risk)}</div>
      <details><summary>Por qué aparece (condiciones)</summary><div style="margin-top:6px">${o.conditions.map((c) => `<div class="cond ${c.ok ? 'ok' : 'no'}"><span class="i">${c.ok ? '✓' : '✕'}</span><span>${esc(c.label)}</span><span class="d">${esc(c.detail)}</span></div>`).join('')}</div></details>
      <div class="hint">Fuentes: <a href="${o.links.precio}" target="_blank" rel="noopener">precio</a> · <a href="${o.links.noticias}" target="_blank" rel="noopener">noticias</a> · <a href="${o.links.resultados}" target="_blank" rel="noopener">resultados</a> · <a href="${o.links.etoro}" target="_blank" rel="noopener">ver en eToro</a></div>
      <div class="actions"><button class="btn primary small" data-act="prefill" data-mode="simulacion" data-t="${o.ticker}" data-p="${o.price}">Compra virtual</button><button class="btn small" data-act="prefill" data-mode="real" data-t="${o.ticker}" data-p="${o.price}">Registrar compra en eToro</button></div>
    </section>`;
  }

  // ---- Posiciones
  function posCard(p) {
    const q = quoteFor(p.ticker);
    const price = q ? q.price : p.avgPrice;
    const m = C.positionMetrics(p, price);
    const [sl, sc] = STATUS[p.status];
    const t = m.targets;
    const closed = p.status === 'cerrada';
    const fills = p.fills || [];
    const fillsHtml = fills.length ? `<details style="margin-top:8px" ${closed ? '' : 'open'}><summary>Ventas registradas (${fills.length}) · realizado <span class="${cls(p.realizedPnl)}">${susd(p.realizedPnl)}</span></summary><div style="margin-top:6px">${fills.map((f) => `<div class="row"><span>${when(f.date)} · ${nf4.format(f.shares)} acc. × ${usd(f.price)}<br><small>comisión ${usd(f.fee)} · ${f.source === 'simulacion' ? 'simulador' : f.source === 'integracion' ? 'integración' : 'registrada por ti'}</small></span><span class="${cls(f.pnl)}">${susd(f.pnl)}</span></div>`).join('')}</div></details>` : '';
    return `<article class="card pos-card">
      <div class="top">
        <div><span class="ticker">${p.ticker}</span> <span class="tag ${sc}">${sl}</span> ${p.mode === 'simulacion' ? '<span class="tag sim">Práctica</span>' : `<span class="tag">${esc(p.broker)}</span>`}${!closed && fills.length ? ' <span class="tag">Venta parcial</span>' : ''}<br><small>${closed ? nf4.format(p.initialShares) : nf4.format(p.shares) + (fills.length ? ' de ' + nf4.format(p.initialShares) : '')} acciones · compra ${usd(p.avgPrice)} · ${when(p.openedAt)}</small></div>
        <div style="text-align:right">${closed ? `<div class="big ${cls(p.realizedPnl)}" style="font-size:1.2rem">${susd(p.realizedPnl)}</div><small>${pct(p.realizedPct)}</small>` : `<div class="big" style="font-size:1.2rem">${usd(price)}</div>${qTag(q)}`}</div>
      </div>
      ${closed ? `<div class="callout ok">Cerrada el ${when(p.close.date)} a <b>${usd(p.close.price)}</b>${fills.length > 1 ? ` (precio promedio de ${fills.length} ventas)` : ` (${p.close.source === 'simulacion' ? 'cierre automático del simulador' : p.close.source === 'integracion' ? 'confirmado por integración' : 'precio ejecutado registrado por ti'})`}. Comisiones de venta ${usd(p.close.fee)}. Alertas detenidas. ${cop(p.realizedPnl)}</div>` : `
      <div class="progress"><i style="width:${(m.progress * 100).toFixed(1)}%"></i></div>
      <div class="muted" style="font-size:13px">${m.toTargetUsd > 0 ? `Faltan <b>${usd(m.toTargetUsd)}</b> por acción (${pct(m.toTargetPct, false)}) para el objetivo ${t.pct === 10 ? '+10 %' : '+' + t.pct + ' %'} ${p.targetBasis}` : '<b>Precio en o por encima del objetivo</b>'}</div>
      ${p.status === 'objetivo_alcanzado' ? `<div class="callout hit">🎯 <b>Objetivo alcanzado</b> el ${when(p.targetHitAt)} a ${usd(p.targetHitPrice)}. La operación sigue <b>abierta</b>: márcala como cerrada solo cuando registres el precio al que realmente vendiste en eToro.</div>` : ''}
      ${p.stopHitAt ? `<div class="callout bad">⚠️ Tocó la salida por pérdida el ${when(p.stopHitAt)} a ${usd(p.stopHitPrice)}.</div>` : ''}
      <div class="grid3" style="margin-top:8px">
        <div class="stat"><div class="k">G/P actual (neta)</div><div class="v ${cls(m.pnl)}">${susd(m.pnl)}</div><div class="s">${pct(m.pnlPct)} · ${cop(m.pnl)}</div></div>
        <div class="stat"><div class="k">Capital expuesto</div><div class="v">${usd(m.exposed)}</div><div class="s">${fills.length ? 'abierto ' + usd(m.cost) + ' de ' + usd(p.capital) : 'invertido ' + usd(m.cost)}</div></div>
        <div class="stat"><div class="k">Objetivo bruto</div><div class="v">${usd(t.gross)}</div><div class="s">neto: ${usd(t.net)}</div></div>
      </div>
      ${p.overLimit ? `<div class="callout bad">El capital de esta operación (${usd(p.capital)}) supera tu límite por operación (${usd(S.state.settings.maxCapitalPerTrade)}).</div>` : ''}
      ${t.stop ? `<div class="row"><span>Alerta de pérdida (−${p.stopPct} %)</span><span class="neg">${usd(t.stop)}</span></div>` : ''}
      ${p.mode === 'real' ? `<div class="row"><span>Take Profit sugerido en eToro</span><span><b>${usd(t.trigger)}</b> <small>(${p.targetBasis})</small></span></div>` : ''}`}
      ${fillsHtml}
      ${p.notes ? `<div class="hint">📝 ${esc(p.notes)}</div>` : ''}
      ${p.edits && p.edits.length ? `<div class="hint">Editada ${when(p.edits[p.edits.length - 1].at)}</div>` : ''}
      <div class="actions">
        ${!closed && p.mode === 'real' ? `<button class="btn ${p.status === 'objetivo_alcanzado' ? 'good' : ''} small" data-act="close" data-id="${p.id}">Registrar venta</button>` : ''}
        ${!closed && p.mode === 'simulacion' ? `<button class="btn small" data-act="close" data-id="${p.id}">Vender</button>` : ''}
        <button class="btn small" data-act="edit" data-id="${p.id}">Editar</button>
        ${fills.length && fills[fills.length - 1].source !== 'integracion' ? `<button class="btn ghost small" data-act="undo" data-id="${p.id}">Deshacer última venta</button>` : ''}
        ${!closed ? `<button class="btn small" data-act="price" data-id="${p.id}">${p.mode === 'simulacion' ? 'Mover precio' : 'Precio manual'}</button>` : ''}
        <button class="btn ghost small danger" data-act="del" data-id="${p.id}">Eliminar</button>
      </div>
    </article>`;
  }
  function summaryCard(sum, title) {
    const bars = (list) => list.length ? list.map((x) => `<div class="bar"><span>${esc(x.key)}</span><span class="t"><i style="width:${(x.pct * 100).toFixed(1)}%"></i></span><span>${nf0.format(x.pct * 100)} %</span></div>`).join('') : '<div class="muted" style="font-size:13px">Sin exposición abierta.</div>';
    return `<section class="card">
      <div class="card-head"><h2>${title}</h2><small>${sum.openCount} abiertas · ${sum.closedCount} cerradas</small></div>
      <div class="grid3">
        <div class="stat"><div class="k">Capital invertido</div><div class="v">${usd(sum.invested)}</div><div class="s">${cop(sum.invested)}</div></div>
        <div class="stat"><div class="k">Efectivo disponible</div><div class="v">${usd(sum.cash)}</div><div class="s">${sum.mode === 'real' ? 'según Ajustes' : 'capital virtual'}</div></div>
        <div class="stat"><div class="k">Valor total</div><div class="v">${usd(sum.total)}</div><div class="s">${cop(sum.total)}</div></div>
        <div class="stat"><div class="k">Rend. no realizado</div><div class="v ${cls(sum.unrealized)}">${susd(sum.unrealized)}</div><div class="s">${cop(sum.unrealized)}</div></div>
        <div class="stat"><div class="k">Rend. realizado</div><div class="v ${cls(sum.realized)}">${susd(sum.realized)}</div><div class="s">${sum.winRate != null ? 'aciertos ' + pct(sum.winRate, false) : '—'}</div></div>
        <div class="stat"><div class="k">Valor de mercado</div><div class="v">${usd(sum.marketValue)}</div><div class="s">${cop(sum.marketValue)}</div></div>
      </div>
      <div class="cols" style="margin:10px 0 0"><div><h3>Exposición por acción</h3>${bars(sum.byTicker)}</div><div><h3>Por sector</h3>${bars(sum.bySector)}</div></div>
      <div class="hint">${fxNote()}</div>
    </section>`;
  }

  // ---- Operaciones
  function vOperaciones() {
    const mode = S.opsMode;
    const s = S.state;
    const ps = s.positions.filter((p) => p.mode === mode);
    const open = ps.filter((p) => p.status !== 'cerrada'), closed = ps.filter((p) => p.status === 'cerrada');
    return `
    <div class="seg" role="tablist"><button class="${mode === 'real' ? 'on' : ''}" data-act="ops" data-m="real">Reales (eToro)</button><button class="${mode === 'simulacion' ? 'on' : ''}" data-act="ops" data-m="simulacion">Práctica</button></div>
    ${summaryCard(C.portfolioSummary(s, mergedQuotes(), mode), mode === 'real' ? 'Portafolio real' : 'Portafolio de práctica')}
    ${mode === 'real' ? etoroForm() : buyForm()}
    <h2 style="margin-top:16px">Abiertas (${open.length})</h2>
    ${open.length ? open.map(posCard).join('') : '<section class="card"><div class="empty">Sin operaciones abiertas.</div></section>'}
    <h2 style="margin-top:16px">Historial (${closed.length})</h2>
    ${closed.length ? closed.map(posCard).join('') : '<section class="card"><div class="empty">Aquí quedarán tus operaciones cerradas con el precio real de venta.</div></section>'}`;
  }
  function etoroForm() {
    const st = S.state.settings, pf = S.prefill && S.prefill.mode === 'real' ? S.prefill : {};
    return `<section class="card">
      <details ${pf.ticker || S.state.positions.filter((p) => p.mode === 'real').length === 0 ? 'open' : ''}><summary>Ficha: registrar operación de eToro</summary>
      <form data-form="position" data-mode="real" style="margin-top:10px">
        <div class="grid2">
          ${field('ticker', 'Ticker', pf.ticker || '', 'required maxlength="10" autocapitalize="characters" placeholder="NVDA"')}
          ${field('avgPrice', 'Precio promedio real de compra (USD)', pf.price || '', numAttrs + ' required min="0"', 'El «Open rate» que muestra eToro')}
        </div>
        <div class="seg" style="margin-bottom:8px"><button type="button" class="${S.form.sizing === 'capital' ? 'on' : ''}" data-act="sizing" data-v="capital">Por capital invertido</button><button type="button" class="${S.form.sizing === 'shares' ? 'on' : ''}" data-act="sizing" data-v="shares">Por nº de acciones</button></div>
        <div class="grid2">
          <div data-sizing="capital" ${S.form.sizing === 'capital' ? '' : 'hidden'}>${field('capital', 'Capital invertido (USD)', '', numAttrs + ' min="0"' + (S.form.sizing === 'capital' ? '' : ' disabled'), 'Incluye la comisión de compra; eToro permite fracciones')}</div>
          <div data-sizing="shares" ${S.form.sizing === 'shares' ? '' : 'hidden'}>${field('shares', 'Número de acciones', '', numAttrs + ' min="0"' + (S.form.sizing === 'shares' ? '' : ' disabled'))}</div>
          ${field('buyFee', 'Comisión de compra (USD)', st.defaultBuyFee, numAttrs)}
          ${field('sellFeeFixed', 'Comisión de venta fija (USD)', st.defaultSellFeeFixed, numAttrs)}
          ${field('sellFeePct', 'Comisión de venta (%)', st.defaultSellFeePct, numAttrs)}
          ${field('targetPct', 'Objetivo (%)', st.targetPct, numAttrs)}
          <div class="field"><label>Alerta al tocar</label><select name="targetBasis"><option value="bruto" ${st.targetBasis === 'bruto' ? 'selected' : ''}>Objetivo bruto (entrada × 1,10)</option><option value="neto" ${st.targetBasis === 'neto' ? 'selected' : ''}>Objetivo neto (10 % tras costos)</option></select></div>
          ${field('stopPct', 'Alerta de pérdida (%) — opcional', st.stopPct || '', numAttrs + ' min="0"')}
          ${field('openedAt', 'Fecha de compra', new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), 'type="datetime-local"')}
        </div>
        <div class="field"><label for="f_notes">Notas</label><textarea id="f_notes" name="notes" rows="2" maxlength="500" placeholder="Motivo de la compra, ID de la posición en eToro…"></textarea></div>
        <div id="preview" class="callout info">Completa precio y tamaño para ver el Take Profit.</div>
        <button class="btn primary">Guardar operación</button>
        <div class="hint">La ejecución real está <b>desactivada</b>: esta ficha solo registra y vigila. Configura el Take Profit directamente en eToro.</div>
      </form></details>
    </section>`;
  }
  function buyForm() {
    const st = S.state.settings, pf = S.prefill && S.prefill.mode === 'simulacion' ? S.prefill : {};
    const sum = C.portfolioSummary(S.state, mergedQuotes(), 'simulacion');
    const t = pf.ticker || S.state.watchlist[0];
    const q = quoteFor(t);
    return `<section class="card">
      <h2>Compra virtual</h2>
      <form data-form="position" data-mode="simulacion">
        <div class="grid2">
          ${field('ticker', 'Ticker', t, 'required maxlength="10" autocapitalize="characters" list="wl"')}
          ${field('avgPrice', 'Precio de compra (USD)', pf.price || (q ? q.price : ''), numAttrs + ' required min="0"', q ? `Cotización ${QTYPE[q.type]}: ${usd(q.price)}` : '')}
          ${field('capital', 'Monto a invertir (USD)', Math.min(st.maxCapitalPerTrade || 1000, Math.max(0, sum.cash)).toFixed(0), numAttrs + ' min="0"', `Efectivo virtual disponible: ${usd(sum.cash)}`)}
          ${field('targetPct', 'Objetivo (%)', st.targetPct, numAttrs)}
          ${field('stopPct', 'Salida por pérdida (%) — opcional', st.stopPct || '', numAttrs)}
          ${field('buyFee', 'Comisión simulada (USD)', st.defaultBuyFee, numAttrs)}
        </div>
        <datalist id="wl">${S.state.watchlist.map((x) => `<option value="${x}">`).join('')}</datalist>
        <div id="preview" class="callout info"></div>
        <button class="btn primary">Comprar (virtual)</button>
        <div class="hint">En práctica, al tocar el objetivo se cierra automáticamente toda la posición al precio objetivo${st.simAutoClose ? '' : ' (desactivado en Ajustes)'}.</div>
      </form>
    </section>`;
  }
  function updatePreviews() {
    const f = $('form[data-form="position"]'); if (!f) return;
    const box = $('#preview', f);
    const d = Object.fromEntries(new FormData(f));
    try {
      const p = C.createPosition({ ...d, ticker: d.ticker || 'X', mode: f.dataset.mode }, S.state.settings);
      const t = C.targets(p);
      const gain = t.gross * p.shares - C.positionCost(p);
      box.className = 'callout info';
      box.innerHTML = `${f.dataset.mode === 'real' ? 'Take Profit para eToro' : 'Objetivo'}: <b>${usd(t.gross)}</b> bruto (entrada × ${nf2.format(1 + t.pct / 100)}) · <b>${usd(t.net)}</b> para ${t.pct} % neto tras costos.<br>${nf4.format(p.shares)} acciones · capital ${usd(p.capital)} ${cop(p.capital)} · ganancia al objetivo bruto ≈ ${usd(gain)}${t.stop ? ` · alerta de pérdida ${usd(t.stop)}` : ''}${p.overLimit ? `<br><b>⚠️ Supera tu límite por operación (${usd(S.state.settings.maxCapitalPerTrade)}).</b>` : ''}`;
    } catch (e) {
      box.className = 'callout info'; box.textContent = d.avgPrice ? e.message : 'Completa precio y tamaño para ver el objetivo.';
    }
  }

  // ---- Simulador
  function vSimulador() {
    const s = S.state, sum = C.portfolioSummary(s, mergedQuotes(), 'simulacion');
    const open = s.positions.filter((p) => p.mode === 'simulacion' && p.status !== 'cerrada');
    const bt = S.bt;
    const P = S.btParams || { ticker: 'NVDA', sessions: 504, capital: 10000, entryRule: 'cruce_sma20', targetPct: s.settings.targetPct, stopPct: s.settings.stopPct || '', dipPct: 5, commission: 0, commissionPct: 0, slippagePct: 0.05, maxDays: 0 };
    return `
    <section class="card">
      <div class="card-head"><h2>Portafolio de práctica</h2><button class="btn small" data-act="go" data-tab="operaciones" data-m="simulacion">Abrir</button></div>
      <div class="grid3">
        <div class="stat"><div class="k">Capital virtual</div><div class="v">${usd(s.settings.virtualCapital)}</div></div>
        <div class="stat"><div class="k">Efectivo</div><div class="v">${usd(sum.cash)}</div></div>
        <div class="stat"><div class="k">Resultado</div><div class="v ${cls(sum.realized + sum.unrealized)}">${susd(sum.realized + sum.unrealized)}</div><div class="s">${open.length} abiertas</div></div>
      </div>
      <div class="hint">Cambia el capital virtual en Ajustes. Para probar el flujo completo: compra virtual → «Mover precio» al objetivo → cierre automático.</div>
    </section>
    ${buyForm()}
    ${open.map(posCard).join('')}

    <section class="card">
      <h2>Simulador histórico</h2>
      <form data-form="backtest">
        <div class="grid2">
          ${field('ticker', 'Ticker', P.ticker, 'required maxlength="10" autocapitalize="characters"')}
          <div class="field"><label>Período</label><select name="sessions">${[[126, '6 meses'], [252, '1 año'], [504, '2 años'], [756, '3 años'], [1260, '5 años']].map(([v, l]) => `<option value="${v}" ${Number(P.sessions) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${field('capital', 'Capital (USD)', P.capital, numAttrs)}
          <div class="field"><label>Regla de entrada</label><select name="entryRule">
            <option value="cruce_sma20" ${P.entryRule === 'cruce_sma20' ? 'selected' : ''}>Cierre cruza sobre SMA20 (con SMA20 ≥ SMA50)</option>
            <option value="retroceso" ${P.entryRule === 'retroceso' ? 'selected' : ''}>Retroceso X % desde máximo de 20 d, sobre SMA50</option>
            <option value="inmediata" ${P.entryRule === 'inmediata' ? 'selected' : ''}>Siempre invertido (recompra al día siguiente)</option></select></div>
          ${field('targetPct', 'Objetivo (%)', P.targetPct, numAttrs)}
          ${field('stopPct', 'Salida por pérdida (%) — opcional', P.stopPct, numAttrs)}
          ${field('dipPct', 'Retroceso para entrar (%)', P.dipPct, numAttrs, 'Solo regla de retroceso')}
          ${field('maxDays', 'Máx. sesiones por operación', P.maxDays, numAttrs, '0 = sin límite')}
          ${field('commission', 'Comisión fija por orden (USD)', P.commission, numAttrs)}
          ${field('commissionPct', 'Comisión por orden (%)', P.commissionPct, numAttrs)}
          ${field('slippagePct', 'Deslizamiento (%)', P.slippagePct, numAttrs, 'Se aplica a compras y salidas por pérdida')}
        </div>
        <button class="btn primary">Ejecutar simulación</button>
      </form>
    </section>
    ${bt ? btResults(bt) : ''}
    <section class="card">
      <details><summary>Cómo modela el simulador costos y ejecución</summary>
        <ul style="font-size:13.5px;padding-left:18px;margin:8px 0 0">
          <li>Velas diarias con <b>precios ajustados</b> por splits y dividendos (Alpha Vantage «adjusted close» cuando está configurado; en demo, serie sintética).</li>
          <li>La señal usa el cierre del día; la compra se ejecuta en la <b>apertura siguiente</b> más el deslizamiento. Se invierte todo el efectivo.</li>
          <li>Objetivo = entrada × (1 + objetivo %), como orden límite. Si la vela abre por encima, se toma el precio objetivo (no se supone mejora).</li>
          <li>Salida por pérdida: si abre por debajo del nivel, se vende a la apertura (gap); si no, al nivel; ambos menos deslizamiento.</li>
          <li><b>Vela ambigua:</b> si una misma vela toca objetivo y pérdida, con datos diarios no se conoce el orden; se asume <b>primero la pérdida</b> (criterio conservador) y se marca la operación.</li>
          <li>Comisión fija + % en cada compra y venta. La peor caída se calcula sobre el valor diario del portafolio (cierre).</li>
          <li>Rendimientos pasados o simulados no garantizan resultados futuros.</li>
        </ul>
      </details>
    </section>
    <section class="card">
      <div class="card-head"><h2>Verificación de los flujos clave</h2><button class="btn small" data-act="checks">Ejecutar</button></div>
      <div id="checks">${S.checks ? S.checks.map((c) => `<div class="cond ${c.ok ? 'ok' : 'no'}"><span class="i">${c.ok ? '✓' : '✕'}</span><span><b>${esc(c.name)}</b><br><small>${esc(c.detail)}</small></span></div>`).join('') : '<div class="muted" style="font-size:13px">Comprueba con el motor real de la app: compra a USD 200 → objetivo USD 220 → cierre (práctica) y alerta sin cierre hasta registrar la ejecución (real).</div>'}</div>
    </section>`;
  }
  function btResults(bt) {
    const m = bt.metrics;
    return `<section class="card">
      <div class="card-head"><h2>Resultados · ${esc(bt.ticker)}</h2>${qTag({ type: bt.dataType, asOf: new Date().toISOString(), source: bt.source })}</div>
      <div class="muted" style="font-size:13px;margin-bottom:8px">${bt.from} → ${bt.to} · fuente ${esc(bt.source)}${bt.error ? ' · ' + esc(bt.error) : ''}</div>
      <div class="grid3">
        <div class="stat"><div class="k">Operaciones</div><div class="v">${m.trades}</div><div class="s">${m.hits} objetivo · ${m.stops} pérdida</div></div>
        <div class="stat"><div class="k">Llegaron al +${bt.params.targetPct} %</div><div class="v">${pct(m.hitTargetPct, false)}</div><div class="s">${m.ambiguous} velas ambiguas</div></div>
        <div class="stat"><div class="k">Rendimiento neto</div><div class="v ${cls(m.netReturn)}">${pct(m.netReturn)}</div><div class="s">${usd(m.finalValue)}</div></div>
        <div class="stat"><div class="k">Peor caída</div><div class="v neg">${pct(-m.maxDrawdown)}</div><div class="s">desde máximo</div></div>
        <div class="stat"><div class="k">Tiempo prom. al cierre</div><div class="v">${m.avgDaysToClose != null ? nf2.format(m.avgDaysToClose) + ' días' : '—'}</div><div class="s">naturales</div></div>
        <div class="stat"><div class="k">Comprar y mantener</div><div class="v ${cls(m.buyHold)}">${pct(m.buyHold)}</div><div class="s">referencia</div></div>
      </div>
      ${bt.openAtEnd ? `<div class="callout info">Posición abierta al final (desde ${bt.openAtEnd.entryDate} a ${usd(bt.openAtEnd.entryPrice)}), valorada al último cierre: ${susd(bt.openAtEnd.pnl)}.</div>` : ''}
      ${equityChart(bt.equity, bt.params.capital)}
      <details><summary>Operaciones (${bt.trades.length})</summary><div class="scroll"><table>
        <thead><tr><th>Entrada</th><th class="r">Precio</th><th>Salida</th><th class="r">Precio</th><th>Motivo</th><th class="r">Resultado</th><th class="r">Días</th></tr></thead>
        <tbody>${bt.trades.map((t) => `<tr><td>${t.entryDate}</td><td class="r">${nf2.format(t.entryPrice)}</td><td>${t.exitDate}</td><td class="r">${nf2.format(t.exitPrice)}</td><td>${esc(t.reason)}${t.ambiguous ? ' <span class="tag hit" title="La vela tocó objetivo y pérdida; se asumió pérdida primero">ambigua</span>' : ''}</td><td class="r ${cls(t.pnl)}">${pct(t.pnlPct)}</td><td class="r">${t.days}</td></tr>`).join('')}</tbody>
      </table></div></details>
    </section>`;
  }
  function equityChart(eq, capital) {
    if (eq.length < 2) return '';
    const W = 600, H = 180, pl = 2, pr = 2, pt = 8, pb = 4;
    const vals = eq.map((e) => e.value);
    const lo = Math.min(capital, ...vals), hi = Math.max(capital, ...vals);
    const x = (i) => pl + (i / (eq.length - 1)) * (W - pl - pr);
    const y = (v) => pt + (1 - (v - lo) / (hi - lo || 1)) * (H - pt - pb);
    const d = eq.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e.value).toFixed(1)}`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Curva de capital">
      <path class="ar" d="${d}L${x(eq.length - 1)},${H - pb}L${pl},${H - pb}Z" opacity=".6"/>
      <line class="ax" x1="${pl}" x2="${W - pr}" y1="${y(capital)}" y2="${y(capital)}" stroke-dasharray="4 4"/>
      <path class="ln" d="${d}" vector-effect="non-scaling-stroke"/>
    </svg><div class="hint" style="display:flex;justify-content:space-between"><span>${eq[0].date}</span><span>${eq[eq.length - 1].date}</span></div><div class="hint">Curva de capital diaria · línea punteada = capital inicial (${usd(capital)}).</div>`;
  }

  // ------------------------------------------------------------- diálogos
  function closeDialog(p) {
    const t = C.targets(p);
    const isSim = p.mode === 'simulacion';
    const q = quoteFor(p.ticker);
    const def = isSim ? (q ? q.price : '') : '';
    openDialog(`<h2>${isSim ? 'Vender (práctica)' : 'Registrar venta ejecutada'} · ${p.ticker}</h2>
      ${isSim ? '' : '<div class="callout hit">Ingresa el precio al que <b>realmente</b> se ejecutó la venta en eToro (en el historial de la operación). El resultado y el historial se calculan con este precio.</div>'}
      ${field('price', 'Precio de venta ejecutado (USD)', def, numAttrs + ' required min="0" autofocus', `Objetivo: ${usd(t.trigger)}`)}
      ${field('shares', 'Acciones vendidas', C.r4(p.shares), numAttrs + ' required min="0" max="' + p.shares + '"', `Quedan ${nf4.format(p.shares)} abiertas. Si vendes menos, la operación sigue abierta con el resto (venta parcial). En eToro: «Cerrar parcialmente».`)}
      ${field('date', 'Fecha y hora de la venta', new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), 'type="datetime-local"')}
      ${field('fee', 'Comisión de venta (USD) — opcional', '', numAttrs + ' min="0"', 'Vacío = se calcula con los costos de la ficha')}
      <div class="actions"><button class="btn primary" value="ok">Registrar venta</button><button class="btn" value="cancel" formnovalidate>Cancelar</button></div>`,
    async (d) => {
      const r = await api.closePosition(p.id, { price: d.price, shares: d.shares, fee: d.fee, date: d.date ? new Date(d.date).toISOString() : undefined });
      await loadState(); render();
      toast(r.status === 'cerrada' ? `${p.ticker} cerrada · resultado ${susd(r.realizedPnl)}` : `Venta parcial registrada · quedan ${nf4.format(r.shares)} acciones de ${p.ticker}`);
    });
  }
  function editDialog(p) {
    const closed = p.status === 'cerrada';
    const locked = (p.fills || []).length > 0;
    const lk = locked || closed ? ' disabled' : '';
    const lkOther = closed ? ' disabled' : '';
    const local = (iso) => { const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    openDialog(`<h2>Editar operación · ${p.ticker}</h2>
      ${closed ? '<div class="callout info">Operación cerrada: solo puedes editar las notas. Para corregir la venta usa «Deshacer última venta».</div>' : locked ? '<div class="callout info">Tiene ventas registradas: ticker, precio de compra, acciones y comisión de compra quedan fijos. Deshaz las ventas si necesitas cambiarlos.</div>' : ''}
      <div class="grid2">
        ${field('ticker', 'Ticker', p.ticker, 'maxlength="10" autocapitalize="characters"' + lk)}
        ${field('avgPrice', 'Precio promedio de compra (USD)', p.avgPrice, numAttrs + ' min="0"' + lk)}
        ${field('shares', 'Acciones', p.shares, numAttrs + ' min="0"' + lk)}
        ${field('buyFee', 'Comisión de compra (USD)', p.buyFee, numAttrs + ' min="0"' + lk)}
        ${field('sellFeeFixed', 'Comisión de venta fija (USD)', p.sellFeeFixed, numAttrs + ' min="0"' + lkOther)}
        ${field('sellFeePct', 'Comisión de venta (%)', p.sellFeePct, numAttrs + ' min="0"' + lkOther)}
        ${field('targetPct', 'Objetivo (%)', p.targetPct, numAttrs + ' min="0"' + lkOther)}
        <div class="field"><label>Alerta al tocar</label><select name="targetBasis"${lkOther}><option value="bruto" ${p.targetBasis === 'bruto' ? 'selected' : ''}>Objetivo bruto</option><option value="neto" ${p.targetBasis === 'neto' ? 'selected' : ''}>Objetivo neto</option></select></div>
        ${field('stopPct', 'Alerta de pérdida (%)', p.stopPct || '', numAttrs + ' min="0"' + lkOther, 'Vacío = sin alerta')}
        ${field('openedAt', 'Fecha de compra', local(p.openedAt), 'type="datetime-local"' + lk)}
      </div>
      <div class="field"><label for="f_notes">Notas</label><textarea id="f_notes" name="notes" rows="2" maxlength="500">${esc(p.notes)}</textarea></div>
      <div class="hint">Si cambias el objetivo o la alerta de pérdida, la alerta se rearma y volverá a avisarte si el precio toca el nuevo nivel.</div>
      <div class="actions"><button class="btn primary" value="ok">Guardar cambios</button><button class="btn" value="cancel" formnovalidate>Cancelar</button></div>`,
    async (d) => {
      if (d.openedAt) d.openedAt = new Date(d.openedAt).toISOString();
      const r = await api.editPosition(p.id, d); // los campos deshabilitados no se envían
      await loadState(); render();
      toast(`${r.ticker} actualizada · objetivo ${usd(C.targets(r).trigger)}`);
    });
  }
  function priceDialog(p) {
    const t = C.targets(p);
    openDialog(`<h2>${p.mode === 'simulacion' ? 'Mover precio (práctica)' : 'Precio manual'} · ${p.ticker}</h2>
      <p class="muted" style="font-size:13.5px;margin-top:0">${p.mode === 'simulacion' ? 'Simula un nuevo precio de mercado para probar el cierre automático.' : 'Útil si tu proveedor de datos no está configurado: evalúa la posición con el precio que ves en eToro. La cotización queda marcada como «Manual».'}</p>
      ${field('price', 'Precio (USD)', t.trigger, numAttrs + ' required min="0" autofocus', `Objetivo ${usd(t.trigger)}${t.stop ? ' · pérdida ' + usd(t.stop) : ''}`)}
      <div class="actions"><button class="btn primary" value="ok">Aplicar</button><button class="btn" value="cancel" formnovalidate>Cancelar</button></div>`,
    async (d) => {
      const price = C.num(d.price);
      S.manual[p.ticker] = { ticker: p.ticker, price, type: 'manual', source: 'Ingreso manual', asOf: new Date().toISOString() };
      const r = await api.manualPrice(p.id, price);
      await loadState(); render();
      if (!r.notifications.length) toast(`Precio manual ${usd(price)} aplicado a ${p.ticker}`);
    });
  }
  function inboxDialog() {
    openDialog(`<h2>Notificaciones</h2>${ntfList(S.state.notifications)}<div class="actions"><button class="btn" value="cancel">Cerrar</button></div>`, async () => {});
    api.markRead().then(loadState);
  }
  function settingsDialog() {
    const st = S.state.settings;
    const ch = S.state.server.channels;
    openDialog(`<h2>Ajustes</h2>
      <h3>Estrategia</h3>
      <div class="grid2">
        ${field('targetPct', 'Objetivo por defecto (%)', st.targetPct, numAttrs)}
        <div class="field"><label>Alerta sobre</label><select name="targetBasis"><option value="bruto" ${st.targetBasis === 'bruto' ? 'selected' : ''}>Objetivo bruto</option><option value="neto" ${st.targetBasis === 'neto' ? 'selected' : ''}>Objetivo neto</option></select></div>
        ${field('stopPct', 'Alerta de pérdida por defecto (%)', st.stopPct || '', numAttrs, 'Vacío = sin alerta de pérdida')}
        ${field('maxCapitalPerTrade', 'Límite de capital por operación (USD)', st.maxCapitalPerTrade, numAttrs)}
        ${field('defaultBuyFee', 'Comisión de compra por defecto (USD)', st.defaultBuyFee, numAttrs)}
        ${field('defaultSellFeeFixed', 'Comisión de venta fija (USD)', st.defaultSellFeeFixed, numAttrs)}
        ${field('defaultSellFeePct', 'Comisión de venta (%)', st.defaultSellFeePct, numAttrs)}
        ${field('realCash', 'Efectivo disponible en eToro (USD)', st.realCash, numAttrs)}
        ${field('virtualCapital', 'Capital virtual de práctica (USD)', st.virtualCapital, numAttrs)}
        ${field('fxManual', 'Tasa USD/COP manual', st.fxManual || '', numAttrs, 'Vacío = tasa de referencia automática')}
      </div>
      <label class="switch">Cierre automático en práctica al tocar objetivo<input type="checkbox" name="simAutoClose" ${st.simAutoClose ? 'checked' : ''}></label>
      <h3 style="margin-top:12px">Alertas</h3>
      <label class="switch">Alertas activas (radar diario y posiciones)<input type="checkbox" name="alertsEnabled" ${st.alertsEnabled ? 'checked' : ''}></label>
      <div class="grid2">${field('alertTime', 'Hora del radar (Colombia)', String(st.alertHour).padStart(2, '0') + ':' + String(st.alertMinute).padStart(2, '0'), 'type="time"', 'Solo días hábiles de NYSE')}</div>
      <label class="switch">Notificaciones del navegador en este dispositivo<input type="checkbox" name="browserNotifications" ${st.browserNotifications ? 'checked' : ''}></label>
      <div class="card tight" style="margin:8px 0">${ch.map((c) => `<div class="row"><span>${esc(c.name)}${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</span><span class="tag ${c.active ? 'ok' : ''}">${c.active ? 'Activo' : 'Inactivo'}</span></div>`).join('')}</div>
      <button class="btn small" value="test" type="submit">Enviar notificación de prueba</button>
      <h3 style="margin-top:14px">Ejecución</h3>
      <label class="switch">Ejecución real de órdenes<input type="checkbox" disabled></label>
      <div class="hint" style="margin-top:-4px">Desactivada por defecto. Requiere una integración oficial del bróker disponible y tu autorización expresa; esta versión no incluye ninguna, por lo que solo registra y vigila.</div>
      <h3 style="margin-top:14px">Datos</h3>
      <div class="row"><span>Cotizaciones</span><span>${esc(S.state.server.provider)}</span></div>
      <div class="row"><span>Historial</span><span>${esc(S.state.server.historyProvider)}</span></div>
      <div class="row"><span>Modo</span><span>${SERVER ? 'Servidor (datos guardados por usuario)' : 'Local (este navegador)'}</span></div>
      <div class="row"><span>Usuario</span><span class="mono" style="font-size:12px">${S.state.server.auth ? 'Sesión con contraseña (compartida entre tus dispositivos)' : esc(USER)}</span></div>
      <div class="actions"><button class="btn primary" value="save">Guardar</button><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn ghost danger small" value="reset" formnovalidate>Borrar mis datos</button></div>`,
    async (d, action) => {
      if (action === 'test') { await api.testNotify(); await loadState(); toast('Notificación de prueba enviada'); renderBadge(); return true; }
      if (action === 'reset') { if (!confirm('¿Borrar todas tus posiciones, preferencias e historial?')) return true; await api.reset(); S.manual = {}; S.radar = null; await loadState(); render(); toast('Datos borrados'); return; }
      const [hh, mm] = (d.alertTime || '08:00').split(':').map(Number);
      const wantsBrowser = !!d.browserNotifications;
      if (wantsBrowser && 'Notification' in window && Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') toast('El navegador no concedió permiso para notificaciones');
      }
      const n = (k) => (d[k] === '' ? null : C.num(d[k]));
      await api.saveSettings({ settings: {
        targetPct: n('targetPct') || 10, targetBasis: d.targetBasis, stopPct: n('stopPct'), maxCapitalPerTrade: n('maxCapitalPerTrade') || 0,
        defaultBuyFee: n('defaultBuyFee') || 0, defaultSellFeeFixed: n('defaultSellFeeFixed') || 0, defaultSellFeePct: n('defaultSellFeePct') || 0,
        realCash: n('realCash') || 0, virtualCapital: n('virtualCapital') || 10000, fxManual: n('fxManual'),
        simAutoClose: !!d.simAutoClose, alertsEnabled: !!d.alertsEnabled, alertHour: hh, alertMinute: mm, browserNotifications: wantsBrowser,
      } });
      await loadState(); render(); toast('Ajustes guardados');
    });
  }

  // ------------------------------------------------------------- eventos
  async function runRadar() { toast('Analizando…'); S.radar = await api.radar(); await loadState(); render(); }
  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('.tabbar button');
    if (tab) { S.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); if (S.tab === 'radar' && !S.radar && !S.state.lastRadar) runRadar().catch((x) => toast(x.message)); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const pos = () => S.state.positions.find((p) => p.id === b.dataset.id);
    try {
      switch (b.dataset.act) {
        case 'go': S.tab = b.dataset.tab; if (b.dataset.m) S.opsMode = b.dataset.m; render(); window.scrollTo(0, 0); break;
        case 'ops': S.opsMode = b.dataset.m; S.prefill = null; render(); break;
        case 'sizing': {
          S.form.sizing = b.dataset.v;
          const f = b.closest('form');
          $$('[data-act="sizing"]', f).forEach((x) => x.classList.toggle('on', x === b));
          $$('[data-sizing]', f).forEach((w) => { const on = w.dataset.sizing === b.dataset.v; w.hidden = !on; $$('input', w).forEach((i) => { i.disabled = !on; if (!on) i.value = ''; }); });
          updatePreviews(); break;
        }
        case 'close': closeDialog(pos()); break;
        case 'price': priceDialog(pos()); break;
        case 'edit': editDialog(pos()); break;
        case 'undo': if (confirm('¿Deshacer la última venta registrada? Las acciones vuelven a quedar abiertas.')) { await api.undoFill(b.dataset.id); await loadState(); render(); toast('Venta deshecha'); } break;
        case 'del': if (confirm('¿Eliminar esta operación? Se borrará también del historial.')) { await api.deletePosition(b.dataset.id); await loadState(); render(); } break;
        case 'runRadar': await runRadar(); break;
        case 'sendRadar': { const r = await api.sendRadar(); S.radar = null; await loadState(); render(); if (r.notification) toast(r.notification.title); break; }
        case 'rmTicker': await api.saveSettings({ watchlist: S.state.watchlist.filter((t) => t !== b.dataset.t) }); await loadState(); render(); break;
        case 'prefill': S.prefill = { mode: b.dataset.mode, ticker: b.dataset.t, price: b.dataset.p }; S.opsMode = b.dataset.mode; S.tab = b.dataset.mode === 'simulacion' ? 'simulador' : 'operaciones'; render(); window.scrollTo(0, 0); break;
        case 'checks': S.checks = C.acceptanceChecks(); render(); break;
        case 'inbox': inboxDialog(); break;
      }
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]'); if (!f) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try {
      if (f.dataset.form === 'addTicker') {
        const t = (d.t || '').trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) throw new Error('Ticker inválido');
        await api.saveSettings({ watchlist: [...new Set([...S.state.watchlist, t])] }); await loadState(); await refreshMarket(); render();
      } else if (f.dataset.form === 'filters') {
        S.filtersOpen = true;
        await api.saveSettings({ filters: { minPrice: C.num(d.minPrice), minAvgVolumeM: C.num(d.minAvgVolumeM), minDollarVolumeM: C.num(d.minDollarVolumeM), excludeEarningsDays: C.num(d.excludeEarningsDays), trend: d.trend, maxResults: Math.max(1, Math.min(10, C.num(d.maxResults, 3))) } });
        await loadState(); await runRadar();
      } else if (f.dataset.form === 'position') {
        const mode = f.dataset.mode;
        const body = { ...d, mode, openedAt: d.openedAt ? new Date(d.openedAt).toISOString() : undefined };
        if (mode === 'simulacion') {
          const p = C.createPosition(body, S.state.settings);
          const cash = C.portfolioSummary(S.state, mergedQuotes(), 'simulacion').cash;
          if (p.capital > cash + 0.005) throw new Error(`Efectivo virtual insuficiente (${usd(cash)})`);
        }
        const p = await api.addPosition(body);
        S.prefill = null;
        await loadState(); await refreshMarket(); render();
        toast(`${p.ticker} registrada · objetivo ${usd(C.targets(p).trigger)}`);
      } else if (f.dataset.form === 'backtest') {
        const t = (d.ticker || '').trim().toUpperCase();
        S.btParams = { ...d, ticker: t };
        toast('Simulando…');
        const h = await api.history(t, Number(d.sessions));
        const params = { capital: C.num(d.capital, 10000), entryRule: d.entryRule, targetPct: C.num(d.targetPct, 10), stopPct: d.stopPct ? C.num(d.stopPct) : null, dipPct: C.num(d.dipPct, 5), commission: C.num(d.commission), commissionPct: C.num(d.commissionPct), slippagePct: C.num(d.slippagePct), maxDays: C.num(d.maxDays) };
        const r = C.backtest(h.bars, params);
        S.bt = { ...r, ticker: t, source: h.source, dataType: h.type, error: h.error, from: h.bars[0].date, to: h.bars[h.bars.length - 1].date };
        render();
      }
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('input', (e) => { if (e.target.closest('#view form')) S.dirty = true; if (e.target.closest('form[data-form="position"]')) updatePreviews(); });
  $('#settingsBtn').addEventListener('click', settingsDialog);
  $('#bellBtn').addEventListener('click', inboxDialog);

  // ------------------------------------------------------------- arranque
  async function boot() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const h = await r.json(); if (!h.ok) throw new Error();
    } catch { api = local; SERVER = false; }
    await loadState();
    await refreshMarket().catch(() => {});
    const demo = /Demostración/.test(S.state.server.provider);
    const ban = $('#modeBanner');
    if (demo || !SERVER) {
      ban.hidden = false;
      ban.innerHTML = `<b>Modo demostración:</b> cotizaciones e historial simulados${SERVER ? '' : ' y datos guardados solo en este navegador (sin servidor)'}. Configura un proveedor siguiendo la guía para usar datos reales.`;
    }
    S.booted = true;
    render();
    setInterval(cycle, 60000);
    setInterval(updateCountdown, 1000);
    cycle();
  }
  boot();
})();
