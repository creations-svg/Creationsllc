#!/usr/bin/env node
/*
 * Radar Bursátil USA — servidor sin dependencias (Node ≥ 18).
 *
 *  - Sirve la aplicación (public/).
 *  - Guarda posiciones, preferencias e historial por usuario (data/users/*.json).
 *  - Consulta proveedores de datos con claves que NUNCA salen del servidor.
 *  - Programa la alerta diaria de las 8:00 a. m. (Colombia) en días hábiles de NYSE
 *    y vigila las posiciones abiertas para avisar al tocar objetivo o pérdida.
 *
 * Variables de entorno (ver GUIA.md): PORT, FINNHUB_API_KEY, ALPHAVANTAGE_API_KEY,
 * TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NTFY_TOPIC, NTFY_SERVER, NOTIFY_WEBHOOK_URL,
 * WHATSAPP_CALLMEBOT_PHONE, WHATSAPP_CALLMEBOT_APIKEY, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_TO, WHATSAPP_TEMPLATE, WHATSAPP_TEMPLATE_LANG, WHATSAPP_API_VERSION,
 * QUOTE_POLL_MINUTES, DATA_DIR.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./public/core.js');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
fs.mkdirSync(USERS_DIR, { recursive: true });

const ENV = {
  finnhub: process.env.FINNHUB_API_KEY || '',
  alpha: process.env.ALPHAVANTAGE_API_KEY || '',
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  ntfyServer: process.env.NTFY_SERVER || 'https://ntfy.sh',
  webhook: process.env.NOTIFY_WEBHOOK_URL || '',
  pollMinutes: Number(process.env.QUOTE_POLL_MINUTES || 5),
  // WhatsApp, opción 1: CallMeBot (gratis, uso personal, solo a tu propio número)
  cmbPhone: process.env.WHATSAPP_CALLMEBOT_PHONE || '',
  cmbKey: process.env.WHATSAPP_CALLMEBOT_APIKEY || '',
  // WhatsApp, opción 2: API oficial WhatsApp Cloud (Meta)
  waToken: process.env.WHATSAPP_TOKEN || '',
  waPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  waTo: process.env.WHATSAPP_TO || '',
  waTemplate: process.env.WHATSAPP_TEMPLATE || '',
  waLang: process.env.WHATSAPP_TEMPLATE_LANG || 'es',
  waVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
  waBase: process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com', // cambiable solo para pruebas
  cmbBase: process.env.CALLMEBOT_API_BASE || 'https://api.callmebot.com',
};
const waCallMeBot = () => !!(ENV.cmbPhone && ENV.cmbKey);
const waCloud = () => !!(ENV.waToken && ENV.waPhoneId && ENV.waTo);

// ------------------------------------------------------------ acceso
/*
 * Con APP_USERS="usuario:contraseña,otro:clave" o APP_PASSWORD (usuario APP_USER, por defecto «radar»)
 * toda la app exige inicio de sesión (HTTP Basic, siempre sobre HTTPS) y los datos se guardan por
 * usuario de login, compartidos entre todos sus dispositivos. /api/health queda libre para el
 * chequeo de salud del hosting. Sin estas variables (uso local), cada dispositivo es un usuario.
 */
const ACCOUNTS = (() => {
  const out = new Map();
  for (const pair of (process.env.APP_USERS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i > 0) out.set(pair.slice(0, i), pair.slice(i + 1));
  }
  if (process.env.APP_PASSWORD) out.set(process.env.APP_USER || 'radar', process.env.APP_PASSWORD);
  return out;
})();
const AUTH = ACCOUNTS.size > 0;
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
function authenticate(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = dec.indexOf(':');
  if (i < 0) return null;
  const user = dec.slice(0, i), pass = dec.slice(i + 1);
  const expected = ACCOUNTS.get(user);
  // Comparación en tiempo constante (sobre hashes de igual longitud).
  const ok = crypto.timingSafeEqual(sha(pass), sha(expected == null ? crypto.randomBytes(16) : expected)) && expected != null;
  return ok ? user : null;
}
const loginUserId = (name) => 'login_' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 24);

// ------------------------------------------------------------ almacenamiento
const validUser = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(id);
const userFile = (id) => path.join(USERS_DIR, id + '.json');
function loadState(id) {
  try { return C.normalizeState(JSON.parse(fs.readFileSync(userFile(id), 'utf8'))); } catch { return C.emptyState(); }
}
function saveState(id, s) {
  const f = userFile(id);
  fs.writeFileSync(f + '.tmp', JSON.stringify(s, null, 1));
  fs.renameSync(f + '.tmp', f); // escritura atómica
}
function listUsers() {
  return fs.readdirSync(USERS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}
// Carga-modifica-guarda síncrono: atómico dentro del bucle de eventos de Node.
function mutate(id, fn) { const s = loadState(id); const r = fn(s); saveState(id, s); return r; }

// --------------------------------------------------------------- proveedores
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttlMs) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
async function getJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const providerName = () => (ENV.finnhub ? 'Finnhub' : 'Demostración');

async function getQuote(ticker, now = new Date()) {
  if (!ENV.finnhub) return C.demoQuote(ticker, now);
  return cached('q:' + ticker, 30000, async () => {
    try {
      const j = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${ENV.finnhub}`);
      if (!(j.c > 0)) throw new Error('sin precio');
      const asOf = new Date(j.t * 1000);
      const ms = C.marketStatus(now);
      const ageMin = (now - asOf) / 60000;
      // Clasificación honesta del dato según su antigüedad y el estado del mercado.
      const type = ms.state === 'abierto' ? (ageMin <= 2 ? 'tiempo_real' : 'retrasada') : 'cierre';
      return { ticker, price: j.c, prevClose: j.pc, high: j.h, low: j.l, type, source: 'Finnhub', asOf: asOf.toISOString() };
    } catch (e) {
      const q = C.demoQuote(ticker, now);
      return { ...q, error: 'Proveedor no disponible: ' + e.message };
    }
  });
}
async function getQuotes(tickers) {
  const out = {};
  await Promise.all([...new Set(tickers)].map(async (t) => { out[t] = await getQuote(t); }));
  return out;
}
async function getBars(ticker, sessions = 260) {
  const today = C.zoned(new Date(), C.NY).date;
  if (!ENV.alpha) return { bars: C.demoBars(ticker, today, sessions), source: 'Demostración', adjusted: true, type: 'simulada' };
  return cached(`b:${ticker}:${sessions}:${today}`, 6 * 3600e3, async () => {
    try {
      const full = sessions > 100 ? 'full' : 'compact';
      const j = await getJson(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&outputsize=${full}&apikey=${ENV.alpha}`);
      const series = j['Time Series (Daily)'];
      if (!series) throw new Error(j.Note || j.Information || 'sin datos');
      const bars = Object.entries(series).map(([date, v]) => {
        const k = Number(v['5. adjusted close']) / Number(v['4. close']); // ajuste por splits y dividendos
        return { date, open: C.r2(v['1. open'] * k), high: C.r2(v['2. high'] * k), low: C.r2(v['3. low'] * k), close: C.r2(v['5. adjusted close'] * 1), volume: Number(v['6. volume']) };
      }).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-sessions);
      return { bars, source: 'Alpha Vantage', adjusted: true, type: 'cierre' };
    } catch (e) {
      return { bars: C.demoBars(ticker, today, sessions), source: 'Demostración', adjusted: true, type: 'simulada', error: 'Proveedor no disponible: ' + e.message };
    }
  });
}
async function getEarnings(ticker) {
  const today = C.zoned(new Date(), C.NY).date;
  if (!ENV.finnhub) return C.demoEarnings(ticker, today);
  return cached('e:' + ticker + today, 12 * 3600e3, async () => {
    try {
      const j = await getJson(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${C.addDays(today, 90)}&symbol=${encodeURIComponent(ticker)}&token=${ENV.finnhub}`);
      const e = (j.earningsCalendar || []).map((x) => x.date).sort()[0];
      return e || null;
    } catch { return null; }
  });
}
async function getFx() {
  return cached('fx', 3600e3, async () => {
    try {
      const j = await getJson('https://open.er-api.com/v6/latest/USD');
      if (!(j.rates && j.rates.COP > 0)) throw new Error('sin tasa');
      return { rate: j.rates.COP, source: 'open.er-api.com (referencia, no es la tasa de eToro)', asOf: new Date(j.time_last_update_unix * 1000).toISOString(), type: 'referencia' };
    } catch {
      return { rate: 3900, source: 'Valor de demostración', asOf: new Date().toISOString(), type: 'simulada' };
    }
  });
}
async function runRadar(state) {
  const today = C.zoned(new Date(), C.NY).date;
  const universe = await Promise.all(state.watchlist.map(async (t) => {
    const [quote, b, earningsDate] = await Promise.all([getQuote(t), getBars(t, 120), getEarnings(t)]);
    return { ticker: t, quote, bars: b.bars, earningsDate };
  }));
  const r = C.screen(universe, state.filters, state.settings, today);
  return { ...r, generatedAt: new Date().toISOString(), nyDate: today, provider: providerName() };
}

// ---------------------------------------------------------------- canales
function channelStatus() {
  return [
    { id: 'app', name: 'Bandeja de la aplicación', active: true },
    { id: 'navegador', name: 'Notificación del navegador (con la app abierta)', active: true, note: 'Se activa desde Ajustes en cada dispositivo' },
    { id: 'telegram', name: 'Telegram', active: !!(ENV.tgToken && ENV.tgChat) },
    { id: 'ntfy', name: 'ntfy (push al celular)', active: !!ENV.ntfyTopic },
    { id: 'whatsapp', name: 'WhatsApp', active: waCallMeBot() || waCloud(), note: waCloud() ? 'API oficial WhatsApp Cloud (Meta)' + (ENV.waTemplate ? ' · plantilla ' + ENV.waTemplate : ' · sin plantilla: solo llega si escribiste al número en las últimas 24 h') : waCallMeBot() ? 'CallMeBot (uso personal)' : 'Configúralo en el servidor (ver GUIA.md)' },
    { id: 'webhook', name: 'Webhook (correo vía Zapier, Make, n8n…)', active: !!ENV.webhook },
  ];
}
async function dispatch(n) {
  const text = `${n.title}\n${n.body}`;
  const jobs = [];
  if (ENV.tgToken && ENV.tgChat) jobs.push(['telegram', () => getJson(`https://api.telegram.org/bot${ENV.tgToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: ENV.tgChat, text }) })]);
  if (ENV.ntfyTopic) jobs.push(['ntfy', async () => { const r = await fetch(`${ENV.ntfyServer}/${encodeURIComponent(ENV.ntfyTopic)}`, { method: 'POST', body: n.body, headers: { Title: encodeURIComponent(n.title), Tags: n.type } }); if (!r.ok) throw new Error('HTTP ' + r.status); }]);
  if (waCloud()) jobs.push(['whatsapp', async () => {
    // Las plantillas de Meta no admiten saltos de línea en los parámetros.
    const flat = text.replace(/\s*\n\s*/g, ' · ').replace(/ {4,}/g, ' ').slice(0, 1000);
    const msg = ENV.waTemplate
      ? { type: 'template', template: { name: ENV.waTemplate, language: { code: ENV.waLang }, components: [{ type: 'body', parameters: [{ type: 'text', text: flat }] }] } }
      : { type: 'text', text: { body: text.slice(0, 4000) } };
    await getJson(`${ENV.waBase}/${ENV.waVersion}/${encodeURIComponent(ENV.waPhoneId)}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ENV.waToken}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: ENV.waTo.replace(/[^\d]/g, ''), ...msg }),
    });
  }]);
  else if (waCallMeBot()) jobs.push(['whatsapp', async () => {
    const u = `${ENV.cmbBase}/whatsapp.php?phone=${encodeURIComponent(ENV.cmbPhone)}&text=${encodeURIComponent(text.slice(0, 1500))}&apikey=${encodeURIComponent(ENV.cmbKey)}`;
    const r = await fetch(u);
    const body = await r.text();
    if (!r.ok || /error|invalid/i.test(body.slice(0, 500))) throw new Error('CallMeBot HTTP ' + r.status);
  }]);
  if (ENV.webhook) jobs.push(['webhook', async () => { const r = await fetch(ENV.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: n.title, body: n.body, type: n.type, ticker: n.ticker, createdAt: n.createdAt, key: n.key }) }); if (!r.ok) throw new Error('HTTP ' + r.status); }]);
  const results = [{ channel: 'app', status: 'enviada', sentAt: new Date().toISOString() }];
  for (const [ch, fn] of jobs) {
    try { await fn(); results.push({ channel: ch, status: 'enviada', sentAt: new Date().toISOString() }); }
    catch (e) { results.push({ channel: ch, status: 'error: ' + e.message, sentAt: new Date().toISOString() }); }
  }
  return results;
}
// Registra (con deduplicación) y envía por los canales externos activos.
async function notifyUser(userId, ev) {
  const n = mutate(userId, (s) => C.recordNotification(s, ev));
  if (!n) return null;
  const results = await dispatch(n);
  mutate(userId, (s) => { const x = s.notifications.find((y) => y.id === n.id); if (x) x.channels = results; });
  return { ...n, channels: results };
}
async function finalizeNotifications(userId, ns) {
  for (const n of ns) {
    const results = await dispatch(n);
    mutate(userId, (s) => { const x = s.notifications.find((y) => y.id === n.id); if (x) x.channels = results; });
    n.channels = results;
  }
  return ns;
}

// ------------------------------------------------------------- planificador
async function checkPositions(userId) {
  const s = loadState(userId);
  const tickers = s.positions.filter((p) => p.status !== 'cerrada').map((p) => p.ticker);
  if (!tickers.length) return [];
  const quotes = await getQuotes(tickers);
  const ns = mutate(userId, (st) => C.applyQuotes(st, quotes));
  return finalizeNotifications(userId, ns);
}
async function sendDailyRadar(userId, { force = false } = {}) {
  const s = loadState(userId);
  const r = await runRadar(s);
  const date = C.zoned(new Date(), C.BOGOTA).date;
  mutate(userId, (st) => { st.lastRadar = r; });
  const ev = { type: 'radar', date, items: r.items, at: new Date().toISOString() };
  if (force) ev.key = `radar-manual:${Date.now()}`;
  return notifyUser(userId, ev);
}
let lastPoll = 0;
async function tick() {
  const now = new Date();
  const b = C.zoned(now, C.BOGOTA);
  for (const u of listUsers()) {
    const s = loadState(u);
    if (!s.settings.alertsEnabled) continue;
    const at = (s.settings.alertHour ?? 8) * 60 + (s.settings.alertMinute ?? 0);
    // Ventana de 60 min por si el servidor estuvo apagado a la hora exacta; sentKeys evita duplicados.
    if (C.isTradingDay(b.date) && b.minutes >= at && b.minutes < at + 60 && !s.sentKeys[`radar:${b.date}`]) {
      try { await sendDailyRadar(u); } catch (e) { console.error('radar', u, e.message); }
    }
  }
  const ms = C.marketStatus(now);
  if (['abierto', 'preapertura', 'posmercado'].includes(ms.state) && Date.now() - lastPoll >= ENV.pollMinutes * 60000) {
    lastPoll = Date.now();
    for (const u of listUsers()) { try { await checkPositions(u); } catch (e) { console.error('check', u, e.message); } }
  }
}

// ---------------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('JSON inválido')); } });
  });
}
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const f = path.normalize(path.join(PUBLIC, rel));
  if (!f.startsWith(PUBLIC)) return send(res, 403, { error: 'Prohibido' });
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}
function publicState(s) {
  return { ...s, sentKeys: undefined, server: { auth: AUTH, provider: providerName(), historyProvider: ENV.alpha ? 'Alpha Vantage' : 'Demostración', channels: channelStatus(), realExecutionAvailable: false, pollMinutes: ENV.pollMinutes } };
}

const routes = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true, provider: providerName(), time: new Date().toISOString() })],
  ['GET', /^\/api\/market$/, async () => ({ ...C.marketStatus(), nextAlert: C.nextDailyAlert() })],
  ['GET', /^\/api\/fx$/, async () => getFx()],
  ['GET', /^\/api\/quotes$/, async (ctx) => getQuotes((ctx.query.get('symbols') || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x)).slice(0, 30))],
  ['GET', /^\/api\/history$/, async (ctx) => {
    const t = (ctx.query.get('symbol') || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) throw new Error('Ticker inválido');
    return getBars(t, Math.min(1300, Math.max(60, Number(ctx.query.get('sessions') || 260))));
  }],
  ['GET', /^\/api\/state$/, async (ctx) => publicState(loadState(ctx.user))],
  ['PUT', /^\/api\/settings$/, async (ctx) => {
    const b = ctx.body;
    return publicState(mutate(ctx.user, (s) => {
      if (b.settings) s.settings = { ...s.settings, ...b.settings, realExecution: false };
      if (b.filters) s.filters = { ...s.filters, ...b.filters };
      if (Array.isArray(b.watchlist)) s.watchlist = [...new Set(b.watchlist.map((x) => String(x).toUpperCase().trim()).filter((x) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x)))].slice(0, 30);
      return s;
    }));
  }],
  ['POST', /^\/api\/positions$/, async (ctx) => mutate(ctx.user, (s) => { const p = C.createPosition(ctx.body, s.settings); s.positions.unshift(p); return p; })],
  ['POST', /^\/api\/positions\/([\w-]+)\/close$/, async (ctx, m) => mutate(ctx.user, (s) => {
    const p = s.positions.find((x) => x.id === m[1]);
    if (!p) throw new Error('Posición no encontrada');
    // Desde la interfaz solo se acepta el cierre manual con precio ejecutado.
    return C.closePosition(p, { ...ctx.body, source: 'manual' });
  })],
  ['POST', /^\/api\/positions\/([\w-]+)\/price$/, async (ctx, m) => {
    const price = C.num(ctx.body.price);
    if (!(price > 0)) throw new Error('Precio inválido');
    const s0 = loadState(ctx.user);
    const p0 = s0.positions.find((x) => x.id === m[1]);
    if (!p0) throw new Error('Posición no encontrada');
    const ns = mutate(ctx.user, (s) => C.applyQuotes(s, { [p0.ticker]: { price, type: 'manual', source: 'Ingreso manual', asOf: new Date().toISOString() } }));
    return { notifications: await finalizeNotifications(ctx.user, ns.filter((n) => n.ticker === p0.ticker)) };
  }],
  ['PATCH', /^\/api\/positions\/([\w-]+)$/, async (ctx, m) => mutate(ctx.user, (s) => C.editPosition(s, m[1], ctx.body))],
  ['POST', /^\/api\/positions\/([\w-]+)\/undo-fill$/, async (ctx, m) => mutate(ctx.user, (s) => C.undoLastFill(s, m[1]))],
  ['DELETE', /^\/api\/positions\/([\w-]+)$/, async (ctx, m) => mutate(ctx.user, (s) => { s.positions = s.positions.filter((x) => x.id !== m[1]); return { ok: true }; })],
  ['POST', /^\/api\/check$/, async (ctx) => ({ notifications: await checkPositions(ctx.user) })],
  ['GET', /^\/api\/radar$/, async (ctx) => { const r = await runRadar(loadState(ctx.user)); mutate(ctx.user, (s) => { s.lastRadar = r; }); return r; }],
  ['POST', /^\/api\/radar\/send$/, async (ctx) => ({ notification: await sendDailyRadar(ctx.user, { force: true }) })],
  ['POST', /^\/api\/notifications\/read$/, async (ctx) => mutate(ctx.user, (s) => { s.notifications.forEach((n) => { n.read = true; }); return { ok: true }; })],
  ['POST', /^\/api\/notifications\/test$/, async (ctx) => ({ notification: await notifyUser(ctx.user, { type: 'prueba', key: 'prueba:' + Date.now(), title: '🔔 Prueba de notificación', body: 'Si ves este mensaje, el canal está funcionando.', at: new Date().toISOString() }) })],
  ['POST', /^\/api\/reset$/, async (ctx) => { saveState(ctx.user, C.emptyState()); return { ok: true }; }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let login = null;
  if (AUTH && url.pathname !== '/api/health') {
    login = authenticate(req);
    if (!login) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Radar Bursatil USA", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Inicia sesión para usar Radar Bursátil USA.');
    }
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!route) return send(res, 404, { error: 'Ruta no encontrada' });
  try {
    const needsUser = !/^\/api\/(health|market|fx|quotes|history)$/.test(url.pathname);
    const user = login ? loginUserId(login) : req.headers['x-user-id'];
    if (needsUser && !validUser(user)) return send(res, 401, { error: 'Falta un identificador de usuario válido (X-User-Id)' });
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const out = await route[2]({ query: url.searchParams, body, user }, url.pathname.match(route[1]));
    send(res, 200, out);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

if (require.main === module) {
  // En Render (variable RENDER) la app queda en Internet: no arrancar sin contraseña.
  if (process.env.RENDER && !AUTH) {
    console.error('ERROR: configura APP_PASSWORD (o APP_USERS) en Render antes de publicar la app.');
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`Radar Bursátil USA en http://localhost:${PORT}`);
    console.log(AUTH ? `Acceso con contraseña: ${ACCOUNTS.size} usuario(s)` : 'AVISO: sin APP_PASSWORD/APP_USERS la app no pide contraseña (solo para uso local).');
    console.log(`Datos: ${providerName()} · Historial: ${ENV.alpha ? 'Alpha Vantage' : 'Demostración'} · Canales: ${channelStatus().filter((c) => c.active).map((c) => c.id).join(', ')}`);
  });
  setInterval(() => tick().catch((e) => console.error('tick', e)), 60000);
  tick().catch(() => {});
}
module.exports = { server, tick, loadState, saveState, sendDailyRadar, checkPositions };
