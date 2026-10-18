import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const KEY = process.env.AISSTREAM_API_KEY;
if (!KEY) { console.error('AISSTREAM_API_KEY missing'); process.exit(1); }

const BOXES = [[[-30.3, 30.7], [-29.4, 31.5]], [[-29.2, 31.8], [-28.4, 32.5]]];
const vessels = new Map(); // mmsi -> latest record
const clients = new Set();

const server = http.createServer((req, res) => {
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
function connectUpstream() {
  const up = new WebSocket('wss://stream.aisstream.io/v0/stream');
  up.on('open', () => {
    upstreamLive = true;
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
    console.log('upstream closed, retrying in 5s');
    setTimeout(connectUpstream, 5000);
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
