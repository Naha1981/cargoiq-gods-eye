import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// ---------- /tts (fish.audio clone voice, cache-first, rate limited) ----------
const FISH_KEY = process.env.FISH_API_KEY || '';
const FISH_REF = process.env.FISH_REFERENCE_ID || '18ae993ac5114994a4807d96b8140905';
const TTS_ORIGINS = new Set(['https://nahalabs.co.za', 'https://www.nahalabs.co.za', 'https://cargo-iq.lovable.app']);
const TTS_MAX_TEXT = 500;
const TTS_PER_IP_PER_MIN = 20;
const TTS_DAILY_CAP = 300;
const ttsCache = new Map();   // hash -> {buf, ts}
const ttsIpHits = new Map();  // ip -> [timestamps]
let ttsDay = new Date().toISOString().slice(0, 10);
let ttsDayCount = 0;
function ttsAllowed(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== ttsDay) { ttsDay = today; ttsDayCount = 0; }
  if (ttsDayCount >= TTS_DAILY_CAP) return false;
  const now = Date.now();
  const hits = (ttsIpHits.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= TTS_PER_IP_PER_MIN) { ttsIpHits.set(ip, hits); return false; }
  hits.push(now); ttsIpHits.set(ip, hits);
  ttsDayCount++;
  return true;
}
async function handleTts(req, res) {
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  let allowed = '';
  for (const o of TTS_ORIGINS) { if (origin === o || referer.startsWith(o)) { allowed = o; break; } }
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (allowed) res.setHeader('access-control-allow-origin', allowed);
  if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); res.end(); return; }
  if (!allowed) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'origin' })); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  if (!FISH_KEY) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'tts-disabled' })); return; }
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!ttsAllowed(ip)) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rate-limited' })); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
  req.on('end', async () => {
    let text = '';
    try { text = String(JSON.parse(body).text || '').trim(); } catch {}
    if (!text || text.length > TTS_MAX_TEXT) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'text' })); return; }
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const hit = ttsCache.get(hash);
    if (hit) { res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-tts-cache': 'hit' }); res.end(hit.buf); return; }
    try {
      const up = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + FISH_KEY, model: 's2.1-pro-free', 'content-type': 'application/json' },
        body: JSON.stringify({ text, reference_id: FISH_REF, format: 'mp3' }),
        signal: AbortSignal.timeout(25000)
      });
      if (!up.ok) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream-' + up.status })); return; }
      const buf = Buffer.from(await up.arrayBuffer());
      if (ttsCache.size > 500) { const k0 = ttsCache.keys().next().value; ttsCache.delete(k0); }
      ttsCache.set(hash, { buf, ts: Date.now() });
      console.log('[tts] rendered', text.length, 'chars');
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-tts-cache': 'miss' }); res.end(buf);
    } catch (e) {
      res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'tts-failed' }));
    }
  });
}

const KEY = process.env.AISSTREAM_API_KEY;
if (!KEY) { console.error('AISSTREAM_API_KEY missing'); process.exit(1); }

const BOXES = [[[-30.3, 30.7], [-29.4, 31.5]], [[-29.2, 31.8], [-28.4, 32.5]]];
const vessels = new Map(); // mmsi -> latest record
const clients = new Set();

const server = http.createServer((req, res) => {
  if (req.url === '/tts') { handleTts(req, res); return; }
  if (req.url === '/voice-miss') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => { console.log('[voice-miss]', body.slice(0, 500)); res.writeHead(204); res.end(); });
      return;
    }
    res.writeHead(405); res.end(); return;
  }
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, vessels: vessels.size, clients: clients.size, upstream: upstreamLive }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/stream' });
wss.on('connection', (ws) => {
  clients.add(ws);
  try {
    ws.send(JSON.stringify({ MessageType: 'NahaLabsInit', Vessels: [...vessels.values()].slice(-500) }));
  } catch {}
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

setInterval(() => {
  for (const c of clients) { try { c.ping(); } catch {} }
}, 25000);

let upstreamLive = false;
let upstreamAttempts = 0;
function connectUpstream() {
  const up = new WebSocket('wss://stream.aisstream.io/v0/stream');
  up.on('open', () => {
    upstreamLive = true;
    upstreamAttempts = 0;
    up.send(JSON.stringify({
      APIKey: KEY,
      BoundingBoxes: BOXES,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData']
    }));
    console.log('upstream connected');
  });
  up.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const meta = m.MetaData || {};
    const mmsi = String(meta.MMSI || '');
    if (mmsi) {
      const rec = vessels.get(mmsi) || { mmsi };
      if (meta.ShipName) rec.name = String(meta.ShipName).trim();
      if (m.MessageType === 'PositionReport') {
        const p = m.Message.PositionReport;
        rec.lat = p.Latitude; rec.lon = p.Longitude;
        rec.sog = p.Sog; rec.cog = p.Cog; rec.hdg = p.TrueHeading;
        rec.t = Date.now();
      } else if (m.MessageType === 'ShipStaticData') {
        const s = m.Message.ShipStaticData || {};
        rec.type = s.Type; rec.dest = (s.Destination || '').trim();
      }
      vessels.set(mmsi, rec);
    }
    const raw = data.toString();
    for (const c of clients) {
      if (c.readyState === 1) { try { c.send(raw); } catch {} }
    }
  });
  up.on('close', () => {
    upstreamLive = false;
    upstreamAttempts = Math.min(upstreamAttempts + 1, 7);
    const delay = Math.min(5000 * Math.pow(2, upstreamAttempts), 180000) + Math.floor(Math.random() * 3000);
    console.log('upstream closed, retrying in ' + Math.round(delay / 1000) + 's');
    setTimeout(connectUpstream, delay);
  });
  up.on('error', (e) => {
    console.error('upstream error:', e.message);
    try { up.close(); } catch {}
  });
}
connectUpstream();

// prune vessels not heard from in 45 minutes
setInterval(() => {
  const cut = Date.now() - 45 * 60 * 1000;
  for (const [k, v] of vessels) if ((v.t || 0) < cut) vessels.delete(k);
}, 10 * 60 * 1000);

const port = process.env.PORT || 10000;
server.listen(port, () => console.log('relay listening on', port));
