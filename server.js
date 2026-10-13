const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 1200, H = 800, WATER = 50;          // map size, water border width
const R = 18;                                  // tank radius
const SPEED = 190, BULLET_SPEED = 560, BULLET_LIFE = 1.3;
const COOLDOWN = 0.45, MAX_HP = 3, RESPAWN = 3;
const TICK = 1 / 60, SEND_EVERY = 2;           // 60 Hz sim, 30 Hz network

// Cover on the beach: crates, sandbags, rocks (axis-aligned rectangles)
const OBSTACLES = [
  { x: 560, y: 340, w: 80, h: 120, t: 'rock' },
  { x: 220, y: 160, w: 120, h: 40, t: 'sandbag' },
  { x: 860, y: 600, w: 120, h: 40, t: 'sandbag' },
  { x: 220, y: 600, w: 40, h: 120, t: 'sandbag' },
  { x: 940, y: 80, w: 40, h: 120, t: 'sandbag' },
  { x: 140, y: 360, w: 60, h: 60, t: 'crate' },
  { x: 1000, y: 380, w: 60, h: 60, t: 'crate' },
  { x: 400, y: 250, w: 50, h: 50, t: 'crate' },
  { x: 750, y: 500, w: 50, h: 50, t: 'crate' },
  { x: 400, y: 520, w: 70, h: 70, t: 'rock' },
  { x: 730, y: 210, w: 70, h: 70, t: 'rock' },
  { x: 520, y: 110, w: 160, h: 36, t: 'sandbag' },
  { x: 520, y: 654, w: 160, h: 36, t: 'sandbag' },
];

const COLORS = ['#ff5a5a', '#4da3ff', '#ffd23f', '#a76bff', '#39d98a', '#ff8f3f', '#ff6bd6', '#3fe0e0'];

const players = new Map();   // id -> player
let bullets = [];
let nextId = 1, tickCount = 0;

// ---------- geometry ----------
function circleHitsRect(cx, cy, r, o) {
  const nx = Math.max(o.x, Math.min(cx, o.x + o.w));
  const ny = Math.max(o.y, Math.min(cy, o.y + o.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
function blocked(x, y, r) {
  if (x - r < WATER || y - r < WATER || x + r > W - WATER || y + r > H - WATER) return true;
  return OBSTACLES.some(o => circleHitsRect(x, y, r, o));
}
function spawnPoint() {
  for (let i = 0; i < 100; i++) {
    const x = WATER + 40 + Math.random() * (W - 2 * WATER - 80);
    const y = WATER + 40 + Math.random() * (H - 2 * WATER - 80);
    if (blocked(x, y, R + 6)) continue;
    let far = true;
    for (const p of players.values()) {
      if (!p.dead && Math.hypot(p.x - x, p.y - y) < 250) far = false;
    }
    if (far) return { x, y };
  }
  return { x: W / 2, y: 120 };
}

// ---------- game state ----------
function addPlayer(ws, name) {
  const id = nextId++;
  const used = new Set([...players.values()].map(p => p.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[id % COLORS.length];
  const sp = spawnPoint();
  const p = {
    id, ws, color, name: name || 'Игрок ' + id,
    x: sp.x, y: sp.y, a: 0, hp: MAX_HP, dead: false, respawnAt: 0,
    kills: 0, deaths: 0, cd: 0, input: { w: 0, a: 0, s: 0, d: 0, fire: 0 },
  };
  players.set(id, p);
  return p;
}

function update(dt) {
  for (const p of players.values()) {
    if (p.dead) {
      if (Date.now() >= p.respawnAt) {
        const sp = spawnPoint();
        p.x = sp.x; p.y = sp.y; p.hp = MAX_HP; p.dead = false;
      }
      continue;
    }
    const i = p.input;
    let dx = (i.d ? 1 : 0) - (i.a ? 1 : 0);
    let dy = (i.s ? 1 : 0) - (i.w ? 1 : 0);
    if (dx || dy) {
      p.a = Math.atan2(dy, dx);
      const len = Math.hypot(dx, dy);
      const mx = (dx / len) * SPEED * dt, my = (dy / len) * SPEED * dt;
      // move per-axis so tanks slide along walls
      if (!blocked(p.x + mx, p.y, R)) p.x += mx;
      if (!blocked(p.x, p.y + my, R)) p.y += my;
      // tanks can't drive through each other
      for (const q of players.values()) {
        if (q === p || q.dead) continue;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < R * 2 && d > 0) {
          const push = (R * 2 - d) / d;
          const nx = p.x + (p.x - q.x) * push, ny = p.y + (p.y - q.y) * push;
          if (!blocked(nx, ny, R)) { p.x = nx; p.y = ny; }
        }
      }
    }
    p.cd = Math.max(0, p.cd - dt);
    if (i.fire && p.cd === 0) {
      p.cd = COOLDOWN;
      bullets.push({
        owner: p.id,
        x: p.x + Math.cos(p.a) * (R + 6), y: p.y + Math.sin(p.a) * (R + 6),
        vx: Math.cos(p.a) * BULLET_SPEED, vy: Math.sin(p.a) * BULLET_SPEED, life: BULLET_LIFE,
      });
    }
  }

  const alive = [];
  for (const b of bullets) {
    // sub-step so fast bullets don't skip through thin walls
    let dead = false;
    for (let s = 0; s < 3 && !dead; s++) {
      b.x += (b.vx * dt) / 3; b.y += (b.vy * dt) / 3;
      if (blocked(b.x, b.y, 3)) { dead = true; break; }
      for (const p of players.values()) {
        if (p.dead || p.id === b.owner) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < R + 3) {
          dead = true;
          p.hp--;
          if (p.hp <= 0) {
            p.dead = true; p.deaths++; p.respawnAt = Date.now() + RESPAWN * 1000;
            const killer = players.get(b.owner);
            if (killer) killer.kills++;
            broadcast({ type: 'kill', killer: killer ? killer.name : '?', victim: p.name });
          }
          break;
        }
      }
    }
    b.life -= dt;
    if (!dead && b.life > 0) alive.push(b);
  }
  bullets = alive;
}

// ---------- network ----------
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { for (const p of players.values()) send(p.ws, msg); }

function snapshot() {
  return {
    type: 'state',
    t: Date.now(),
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y),
      a: +p.a.toFixed(2), hp: p.hp, dead: p.dead, kills: p.kills, deaths: p.deaths,
    })),
    bullets: bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), o: b.owner })),
  };
}

setInterval(() => {
  update(TICK);
  if (++tickCount % SEND_EVERY === 0 && players.size) broadcast(snapshot());
}, TICK * 1000);

// ---------- http + websocket ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const full = path.join(__dirname, 'public', path.normalize(file));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 1024 });
wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join' && !me) {
      if (players.size >= 12) return send(ws, { type: 'full' });
      const name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 14);
      me = addPlayer(ws, name);
      send(ws, { type: 'init', id: me.id, W, H, WATER, R, obstacles: OBSTACLES });
      broadcast({ type: 'info', text: me.name + ' вошёл в бой' });
    } else if (m.type === 'input' && me) {
      me.input = { w: +!!m.w, a: +!!m.a, s: +!!m.s, d: +!!m.d, fire: +!!m.fire };
    }
  });
  ws.on('close', () => {
    if (!me) return;
    players.delete(me.id);
    bullets = bullets.filter(b => b.owner !== me.id);
    broadcast({ type: 'info', text: me.name + ' вышел' });
  });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => console.log('Beach Tanks on http://localhost:' + PORT));
