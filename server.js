const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 1800, H = 1200, WATER = 50;         // map size, water border width
const R = 18;                                  // tank radius
const SPEED = 190, REVERSE = 0.6, TURN = 3.3;  // px/s, reverse multiplier, rad/s
const BULLET_SPEED = 560, BULLET_LIFE = 1.3;
const COOLDOWN = 0.45, MAX_HP = 5, RESPAWN = 3;
const TICK = 1 / 60, SEND_EVERY = 2;           // 60 Hz sim, 30 Hz network
const MIN_TANKS = 0;                           // bots fill the arena up to this many tanks (0 = no bots)
const BOT_NAMES = ['Краб', 'Чайка', 'Пират', 'Волна', 'Акула', 'Пальма', 'Медуза', 'Дельфин'];

// Cover on the beach: crates, sandbags, rocks (axis-aligned rectangles)
const OBSTACLES = [
  { x: 840, y: 500, w: 120, h: 200, t: 'rock' },
  { x: 300, y: 300, w: 90, h: 90, t: 'rock' },
  { x: 1410, y: 810, w: 90, h: 90, t: 'rock' },
  { x: 300, y: 810, w: 90, h: 90, t: 'rock' },
  { x: 1410, y: 300, w: 90, h: 90, t: 'rock' },
  { x: 500, y: 150, w: 200, h: 40, t: 'sandbag' },
  { x: 1100, y: 1010, w: 200, h: 40, t: 'sandbag' },
  { x: 1100, y: 150, w: 200, h: 40, t: 'sandbag' },
  { x: 500, y: 1010, w: 200, h: 40, t: 'sandbag' },
  { x: 780, y: 330, w: 240, h: 40, t: 'sandbag' },
  { x: 780, y: 830, w: 240, h: 40, t: 'sandbag' },
  { x: 200, y: 540, w: 40, h: 160, t: 'sandbag' },
  { x: 1560, y: 500, w: 40, h: 160, t: 'sandbag' },
  { x: 640, y: 480, w: 40, h: 240, t: 'sandbag' },
  { x: 1120, y: 480, w: 40, h: 240, t: 'sandbag' },
  { x: 160, y: 200, w: 60, h: 60, t: 'crate' },
  { x: 1580, y: 940, w: 60, h: 60, t: 'crate' },
  { x: 160, y: 940, w: 60, h: 60, t: 'crate' },
  { x: 1580, y: 200, w: 60, h: 60, t: 'crate' },
  { x: 560, y: 330, w: 56, h: 56, t: 'crate' },
  { x: 1184, y: 814, w: 56, h: 56, t: 'crate' },
  { x: 1184, y: 330, w: 56, h: 56, t: 'crate' },
  { x: 560, y: 814, w: 56, h: 56, t: 'crate' },
  { x: 860, y: 150, w: 60, h: 60, t: 'crate' },
  { x: 860, y: 990, w: 60, h: 60, t: 'crate' },
];

const COLORS = ['#ff5a5a', '#4da3ff', '#ffd23f', '#a76bff', '#39d98a', '#ff8f3f', '#ff6bd6', '#3fe0e0'];

const players = new Map();   // id -> player (humans and bots)
let bullets = [];
let crates = [], nextCrate = 1, nextDrop = 0;
const DROP_EVERY = 30000, FALL_MS = 1800, POWER_TIME = 15000;
const POWER_TYPES = ['double', 'triple', 'shield'];
const POWER_NAMES = { double: 'двойной урон', triple: 'тройной выстрел', shield: 'щит' };
let fxQueue = [];
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
function lineClear(x1, y1, x2, y2) {
  const d = Math.hypot(x2 - x1, y2 - y1), n = Math.ceil(d / 12);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    if (OBSTACLES.some(o => x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h)) return false;
  }
  return true;
}
function normAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
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

// ---------- players & bots ----------
function makeTank(name, ws, bot) {
  const id = nextId++;
  const used = new Set([...players.values()].map(p => p.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[id % COLORS.length];
  const sp = spawnPoint();
  const p = {
    id, ws, bot, color, name,
    x: sp.x, y: sp.y, a: Math.random() * Math.PI * 2, hp: MAX_HP, dead: false, respawnAt: 0,
    kills: 0, deaths: 0, cd: 0, shield: false, doubleUntil: 0, tripleUntil: 0, input: { w: 0, a: 0, s: 0, d: 0, fire: 0 },
    ai: { evadeT: 0, evadeDir: 1, back: 0, checkT: 0, lx: sp.x, ly: sp.y },
  };
  players.set(id, p);
  return p;
}

function balanceBots() {
  const humans = [...players.values()].filter(p => !p.bot).length;
  const bots = [...players.values()].filter(p => p.bot);
  const want = humans === 0 ? 0 : Math.max(0, MIN_TANKS - humans);
  while (bots.length > want) {
    const b = bots.pop();
    players.delete(b.id);
    bullets = bullets.filter(x => x.owner !== b.id);
  }
  while (bots.length < want) {
    const taken = new Set([...players.values()].map(p => p.name));
    const name = BOT_NAMES.find(n => !taken.has('🤖 ' + n)) || 'Бот';
    bots.push(makeTank('🤖 ' + name, null, true));
  }
}

function botThink(b) {
  const ai = b.ai, i = b.input;
  if (b.dead) { i.w = i.a = i.s = i.d = i.fire = 0; return; }
  // nearest living enemy
  let t = null, best = Infinity;
  for (const q of players.values()) {
    if (q === b || q.dead) continue;
    const d = Math.hypot(q.x - b.x, q.y - b.y);
    if (d < best) { best = d; t = q; }
  }
  i.w = i.a = i.s = i.d = i.fire = 0;

  // stuck detection: wanted to move but barely did
  ai.checkT += 1 / 30;
  if (ai.checkT >= 0.6) {
    if (Math.hypot(b.x - ai.lx, b.y - ai.ly) < 8 && ai.evadeT <= 0) {
      ai.evadeT = 0.8; ai.back = 0.35; ai.evadeDir = Math.random() < 0.5 ? -1 : 1;
    }
    ai.lx = b.x; ai.ly = b.y; ai.checkT = 0;
  }

  const probe = !blocked(b.x + Math.cos(b.a) * 40, b.y + Math.sin(b.a) * 40, R);
  if (ai.evadeT > 0) {
    ai.evadeT -= 1 / 30; ai.back -= 1 / 30;
    if (ai.back > 0) i.s = 1; else if (probe) i.w = 1;
    if (ai.evadeDir > 0) i.d = 1; else i.a = 1;
    return;
  }
  if (!probe) { ai.evadeT = 0.5; ai.evadeDir = Math.random() < 0.5 ? -1 : 1; return; }
  if (!t) { i.w = 1; return; }

  const diff = normAngle(Math.atan2(t.y - b.y, t.x - b.x) - b.a);
  if (diff > 0.12) i.d = 1; else if (diff < -0.12) i.a = 1;
  const los = lineClear(b.x, b.y, t.x, t.y);
  if (los && best < 150) i.s = 1;                       // too close: back off
  else if (!los || best > 280) { if (Math.abs(diff) < 1.2) i.w = 1; }   // approach / go around
  if (los && Math.abs(diff) < 0.22 && best < 650 && Math.random() < 0.85) i.fire = 1;
}

// ---------- simulation ----------
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
    // tank controls: A/D rotate the hull, W/S drive forward/back
    // humans move on their own screen and report position/angle (see 'input'); only bots are simulated here
    if (p.bot) p.a = normAngle(p.a + ((i.d ? 1 : 0) - (i.a ? 1 : 0)) * TURN * dt);
    const drive = p.bot ? (i.w ? 1 : 0) - (i.s ? 1 : 0) : 0;
    if (drive) {
      const sp = SPEED * (drive > 0 ? 1 : REVERSE) * dt * drive;
      const mx = Math.cos(p.a) * sp, my = Math.sin(p.a) * sp;
      // per-axis so tanks slide along walls
      if (!blocked(p.x + mx, p.y, R)) p.x += mx;
      if (!blocked(p.x, p.y + my, R)) p.y += my;
    }
    // tanks can't drive through each other
    for (const q of players.values()) {
      if (q === p || q.dead) continue;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < R * 2 && d > 0) {
        const push = (R * 2 - d) / d / 2;
        const nx = p.x + (p.x - q.x) * push, ny = p.y + (p.y - q.y) * push;
        if (!blocked(nx, ny, R)) { p.x = nx; p.y = ny; }
      }
    }
    p.cd = Math.max(0, p.cd - dt);
    if (i.fire && p.cd === 0) {
      p.cd = COOLDOWN;
      const mx = p.x + Math.cos(p.a) * (R + 6), my = p.y + Math.sin(p.a) * (R + 6);
      const now = Date.now(), dmg = p.doubleUntil > now ? 2 : 1;
      const angles = p.tripleUntil > now ? [p.a - 0.2, p.a, p.a + 0.2] : [p.a];
      for (const ang of angles) {
        bullets.push({ owner: p.id, dmg, x: mx, y: my, vx: Math.cos(ang) * BULLET_SPEED, vy: Math.sin(ang) * BULLET_SPEED, life: BULLET_LIFE });
      }
      fxQueue.push({ k: 'shot', x: Math.round(mx), y: Math.round(my), a: +p.a.toFixed(2) });
    }
    // pick up landed power-up crates
    for (let ci = crates.length - 1; ci >= 0; ci--) {
      const c = crates[ci];
      if (c.landAt > Date.now() || Math.hypot(p.x - c.x, p.y - c.y) > R + 18) continue;
      const now = Date.now();
      if (c.type === 'double') p.doubleUntil = now + POWER_TIME;
      else if (c.type === 'triple') p.tripleUntil = now + POWER_TIME;
      else p.shield = true;
      crates.splice(ci, 1);
      fxQueue.push({ k: 'pickup', x: Math.round(c.x), y: Math.round(c.y), t: c.type });
      broadcast({ type: 'info', text: '⚡ ' + p.name + ' взял ' + POWER_NAMES[c.type] });
    }
  }

  // every 30 s a crate drops from the sky (only while someone is playing)
  const now2 = Date.now();
  if ([...players.values()].some(p => !p.bot)) {
    if (!nextDrop) nextDrop = now2 + 8000;               // first drop soon after the first player joins
    if (now2 >= nextDrop && crates.length < 5) {
      nextDrop = now2 + DROP_EVERY;
      for (let n = 0; n < 50; n++) {
        const x = WATER + 60 + Math.random() * (W - 2 * WATER - 120), y = WATER + 60 + Math.random() * (H - 2 * WATER - 120);
        if (blocked(x, y, 40)) continue;
        crates.push({ id: nextCrate++, x: Math.round(x), y: Math.round(y), type: POWER_TYPES[Math.floor(Math.random() * 3)], landAt: now2 + FALL_MS });
        broadcast({ type: 'info', text: '📦 С неба падает ящик с улучшением!' });
        break;
      }
    }
  } else { nextDrop = 0; crates = []; }

  const alive = [];
  for (const b of bullets) {
    let dead = false;
    for (let s = 0; s < 3 && !dead; s++) {          // sub-step so fast bullets don't tunnel
      b.x += (b.vx * dt) / 3; b.y += (b.vy * dt) / 3;
      if (blocked(b.x, b.y, 3)) { dead = true; fxQueue.push({ k: 'wall', x: Math.round(b.x), y: Math.round(b.y) }); break; }
      for (const p of players.values()) {
        if (p.dead || p.id === b.owner) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < R + 3) {
          dead = true;
          if (p.shield) {                              // shield soaks up one bullet
            p.shield = false;
            fxQueue.push({ k: 'shield', x: Math.round(b.x), y: Math.round(b.y), id: p.id });
            break;
          }
          p.hp -= b.dmg;
          fxQueue.push({ k: 'hit', x: Math.round(b.x), y: Math.round(b.y), id: p.id });
          if (p.hp <= 0) {
            p.dead = true; p.deaths++; p.respawnAt = Date.now() + RESPAWN * 1000;
            p.shield = false; p.doubleUntil = p.tripleUntil = 0;
            const killer = players.get(b.owner);
            if (killer) killer.kills++;
            fxQueue.push({ k: 'boom', x: Math.round(p.x), y: Math.round(p.y), c: p.color });
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
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { for (const p of players.values()) if (!p.bot) send(p.ws, msg); }

function snapshot() {
  const now = Date.now();
  const s = {
    type: 'state',
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y),
      a: +p.a.toFixed(2), hp: p.hp, dead: p.dead, kills: p.kills, deaths: p.deaths, bot: p.bot,
      sh: p.shield ? 1 : 0, dbl: Math.max(0, Math.ceil((p.doubleUntil - now) / 1000)), tri: Math.max(0, Math.ceil((p.tripleUntil - now) / 1000)),
    })),
    bullets: bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy), d: b.dmg })),
    crates: crates.map(c => ({ id: c.id, x: c.x, y: c.y, type: c.type, fall: Math.max(0, c.landAt - now) })),
    fx: fxQueue,
  };
  fxQueue = [];
  return s;
}

let lastTick = Date.now();
setInterval(() => {
  // real elapsed time, so a slow/busy server doesn't run the game in slow motion
  const now = Date.now(), dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;
  if (tickCount % 2 === 0) for (const p of players.values()) if (p.bot) botThink(p);
  update(dt);
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
      if ([...players.values()].filter(p => !p.bot).length >= 12) return send(ws, { type: 'full' });
      const name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 14);
      // make room for the newcomer by removing a bot first
      me = makeTank(name || 'Игрок', ws, false);
      balanceBots();
      send(ws, { type: 'init', id: me.id, W, H, WATER, R, SPEED, REVERSE, TURN, MAX_HP, obstacles: OBSTACLES });
      broadcast({ type: 'info', text: me.name + ' вошёл в бой' });
    } else if (m.type === 'input' && me) {
      me.input = { w: +!!m.w, a: +!!m.a, s: +!!m.s, d: +!!m.d, fire: +!!m.fire };
      // accept the client's own position/angle if it is plausible (not in a wall, not teleporting)
      const now = Date.now(), since = Math.min((now - (me.lastPos || now)) / 1000, 0.3);
      if (!me.dead && Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.pa)) {
        const maxD = SPEED * since * 1.6 + 25;
        if (Math.hypot(m.x - me.x, m.y - me.y) <= maxD && !blocked(m.x, m.y, R)) { me.x = m.x; me.y = m.y; }
        me.a = normAngle(m.pa);
      }
      me.lastPos = now;
    }
  });
  ws.on('close', () => {
    if (!me) return;
    players.delete(me.id);
    bullets = bullets.filter(b => b.owner !== me.id);
    balanceBots();
    broadcast({ type: 'info', text: me.name + ' вышел' });
  });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => console.log('Beach Tanks on http://localhost:' + PORT));
