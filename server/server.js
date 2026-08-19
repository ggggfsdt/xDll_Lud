// ═══════════════════════════════════════════════════════════════
// dllump · bump arena — multiplayer backend
//
// This server is the single source of truth for every match:
//   - it verifies each player's Telegram login
//   - it holds everyone's balance and stats (persisted to disk)
//   - it runs ONE authoritative physics simulation per room
//   - it broadcasts snapshots to every connected client
//   - it decides the winner and pays out
//
// Clients never decide who wins. That's what makes this fair when
// strangers on the internet are betting against each other — no
// client can lie about physics results, because the client doesn't
// compute them anymore. It only *renders* what the server sends.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { getUser, saveUser, topPlayers, allUsersCount } = require('./store');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''; // required to verify real Telegram users
const ALLOW_DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === 'true'; // set true only for local testing

const app = express();
app.use(express.json());
app.use(express.static('public')); // put the client build here if you want to serve it from this same server

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten this to your actual mini-app domain before going live
});

// ─────────────────────────────────────────────────────────────
// TELEGRAM AUTH — verifies the initData string Telegram gives the
// mini app so we know the userId/username/photo really came from
// Telegram and weren't just typed into the client by an attacker.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ─────────────────────────────────────────────────────────────
function verifyInitData(initData) {
  if (!BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckArr = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Date.now() / 1000 - authDate > 86400) return null; // reject stale logins (>24h old)

    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// ARENA GEOMETRY — identical logic to the client, kept in one
// fixed logical size. The client scales this to whatever pixel
// size its canvas is; the server never needs to know pixel sizes.
// ─────────────────────────────────────────────────────────────
const ARENA_SIZE = 400;
const CORNER_RADIUS = ARENA_SIZE * 0.15;

function generatePerimeter(size, cornerRadius, numPoints = 300) {
  const half = size / 2;
  const r = Math.min(cornerRadius, half);
  const sections = [
    { type: 'line', x1: -half + r, y1: -half, x2: half - r, y2: -half },
    { type: 'arc', cx: half - r, cy: -half + r, start: -Math.PI / 2, end: 0 },
    { type: 'line', x1: half, y1: -half + r, x2: half, y2: half - r },
    { type: 'arc', cx: half - r, cy: half - r, start: 0, end: Math.PI / 2 },
    { type: 'line', x1: half - r, y1: half, x2: -half + r, y2: half },
    { type: 'arc', cx: -half + r, cy: half - r, start: Math.PI / 2, end: Math.PI },
    { type: 'line', x1: -half, y1: half - r, x2: -half, y2: -half + r },
    { type: 'arc', cx: -half + r, cy: -half + r, start: Math.PI, end: 3 * Math.PI / 2 }
  ];
  const segLengths = sections.map(seg => seg.type === 'line'
    ? Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1)
    : r * (seg.end - seg.start));
  const totalLen = segLengths.reduce((a, b) => a + b, 0);
  const step = totalLen / numPoints;
  const points = [];
  let accumulated = 0, segIdx = 0;
  for (let i = 0; i < numPoints; i++) {
    const target = i * step;
    while (accumulated + segLengths[segIdx] < target) {
      accumulated += segLengths[segIdx];
      segIdx = (segIdx + 1) % sections.length;
    }
    const localT = (target - accumulated) / segLengths[segIdx];
    const seg = sections[segIdx];
    let px, py;
    if (seg.type === 'line') {
      px = seg.x1 + localT * (seg.x2 - seg.x1);
      py = seg.y1 + localT * (seg.y2 - seg.y1);
    } else {
      const angle = seg.start + localT * (seg.end - seg.start);
      px = seg.cx + r * Math.cos(angle);
      py = seg.cy + r * Math.sin(angle);
    }
    points.push({ x: px + half, y: py + half });
  }
  return points;
}

const PERIMETER = generatePerimeter(ARENA_SIZE, CORNER_RADIUS, 300);

function speedForRadius(radius) {
  const minR = 14, maxR = 52;
  const norm = Math.min(1, Math.max(0, (radius - minR) / (maxR - minR)));
  const speed = 6.0 - norm * 3.0;
  return Math.max(3.0, Math.min(6.0, speed));
}

// ─────────────────────────────────────────────────────────────
// ROOM — one shared arena. Simple MVP: everyone online plays in
// the same room. (Easy to extend to multiple rooms/lobbies later.)
// ─────────────────────────────────────────────────────────────
const COLORS = ['#5b8def', '#50c890', '#e06060', '#d4af37', '#c084e0', '#f0a070', '#60c0d0', '#e8a0a0'];
const MAX_PLAYERS = 8;

function createRoom(id) {
  return {
    id,
    gameState: 'idle', // idle -> countdown -> prestart -> playing -> finished -> idle
    players: [],       // players currently in this round
    pot: 0,
    opening: null,
    openingTimer: 0,
    gameTime: 0,
    countdownStartTime: 0,
    prestartTimer: 0,
  };
}

const room = createRoom('main');

function getAlive() { return room.players.filter(p => p.alive); }
function getPlayer(id) { return room.players.find(p => p.id === id); }

function computeRadii() {
  const totalBet = room.players.reduce((s, p) => s + p.bet, 0);
  if (totalBet === 0) return;
  room.players.forEach(p => {
    const ratio = p.bet / totalBet;
    const r = 18 + ratio * 34;
    p.targetRadius = Math.min(Math.max(r, 14), 52);
    if (p.displayRadius === undefined) p.displayRadius = p.targetRadius;
  });
}

function makePlayer(id, bet, name, pfp) {
  const half = ARENA_SIZE / 2;
  const radius = 18;
  let x, y, attempts = 0, overlap = true;
  while (overlap && attempts < 100) {
    x = half + (Math.random() - 0.5) * (ARENA_SIZE * 0.6);
    y = half + (Math.random() - 0.5) * (ARENA_SIZE * 0.6);
    overlap = room.players.some(p => Math.hypot(p.x - x, p.y - y) < p.radius + radius + 5);
    attempts++;
  }
  const colorIdx = room.players.length % COLORS.length;
  const p = {
    id, bet, name: name || 'player', pfp: pfp || '',
    color: COLORS[colorIdx],
    radius, displayRadius: radius, targetRadius: radius,
    mass: radius * radius * 1.2,
    x: x ?? half, y: y ?? half, vx: 0, vy: 0,
    alive: true,
  };
  room.players.push(p);
  computeRadii();
  return p;
}

function startCountdown() {
  if (room.gameState !== 'idle') return;
  if (getAlive().length < 2) return;
  room.gameState = 'countdown';
  room.countdownStartTime = Date.now();
}

function startPrestart() {
  room.gameState = 'prestart';
  room.prestartTimer = 2.0;
}

function startGame() {
  room.gameState = 'playing';
  room.gameTime = 0;
  room.openingTimer = 0;
  room.opening = null;
  const alive = getAlive();
  const half = ARENA_SIZE / 2;
  alive.forEach((p, i) => {
    const angle = (i / alive.length) * Math.PI * 2 + Math.random() * 0.3;
    const baseSpeed = speedForRadius(p.displayRadius || p.radius);
    const speed = baseSpeed * (0.9 + Math.random() * 0.2);
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.x = half + Math.cos(angle) * (ARENA_SIZE * 0.15 + Math.random() * 15);
    p.y = half + Math.sin(angle) * (ARENA_SIZE * 0.15 + Math.random() * 15);
    p.alive = true;
  });
  room.openingTimer = 3.5 + Math.random() * 2.5;
}

async function endGame(winnerId) {
  if (room.gameState === 'finished') return;
  room.gameState = 'finished';
  const winner = getPlayer(winnerId);
  let payload = null;

  if (winner) {
    const totalPot = room.pot;
    const winnerBet = winner.bet;
    const losersBets = totalPot - winnerBet;
    const commission = Math.floor(losersBets * 0.02);
    const winnings = totalPot - commission;

    const winnerUser = await getUser(winner.id);
    if (winnerUser) {
      winnerUser.balance += winnings;
      winnerUser.wins += 1;
      await saveUser(winnerUser);
    }
    for (const p of room.players) {
      if (p.id === winner.id) continue;
      const u = await getUser(p.id);
      if (u) { u.losses += 1; await saveUser(u); }
    }

    payload = {
      winnerId: winner.id,
      winnerName: winner.name,
      winnerPfp: winner.pfp,
      winnings,
      multiplier: +(winnings / winnerBet).toFixed(2),
    };
  }

  io.to(room.id).emit('roundEnd', payload);

  setTimeout(() => {
    room.players = [];
    room.pot = 0;
    room.opening = null;
    room.gameState = 'idle';
  }, 3000);
}

function isInGap(idx) {
  const opening = room.opening;
  if (!opening || opening.state !== 'open') return false;
  const { startIdx, endIdx } = opening;
  return startIdx < endIdx ? (idx >= startIdx && idx <= endIdx) : (idx >= startIdx || idx <= endIdx);
}

function updatePhysics(dt) {
  if (room.gameState !== 'playing') return;
  room.gameTime += dt;

  const alive = getAlive();
  if (alive.length <= 1) {
    if (alive.length === 1) endGame(alive[0].id);
    else { room.gameState = 'idle'; room.players = []; room.opening = null; }
    return;
  }

  const half = ARENA_SIZE / 2;
  const totalPts = PERIMETER.length;

  room.openingTimer -= dt;
  if (room.openingTimer <= 0) {
    if (!room.opening) {
      const gameTime = room.gameTime;
      const [minGap, maxGap] = gameTime < 4 ? [0.08, 0.18] : [0.15, 0.35];
      const gapSize = Math.floor((minGap + Math.random() * (maxGap - minGap)) * totalPts);
      const startIdx = Math.floor(Math.random() * totalPts);
      const endIdx = (startIdx + gapSize) % totalPts;
      room.opening = { startIdx, endIdx, flashCount: 0, flashTimer: 0, state: 'flashing' };
      room.openingTimer = 3.5 + Math.random() * 2.5;
    } else {
      room.opening = null;
      room.openingTimer = 1.5 + Math.random() * 2.0;
    }
  }

  const opening = room.opening;
  if (opening && opening.state === 'flashing') {
    opening.flashTimer += dt;
    if (opening.flashTimer > 0.25) {
      opening.flashTimer = 0;
      opening.flashCount++;
      if (opening.flashCount >= 4) opening.state = 'open';
    }
  }

  const subSteps = 6;
  const subDt = dt / subSteps;

  for (let step = 0; step < subSteps; step++) {
    alive.forEach(p => {
      if (!p.alive) return;
      p.x += p.vx * subDt * 60;
      p.y += p.vy * subDt * 60;

      const radius = p.displayRadius || p.radius;
      for (let i = 0; i < totalPts; i++) {
        const j = (i + 1) % totalPts;
        if (opening && opening.state === 'open' && isInGap(i) && isInGap(j)) continue;
        const ax = PERIMETER[i].x, ay = PERIMETER[i].y;
        const bx = PERIMETER[j].x, by = PERIMETER[j].y;
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;
        let t = ((p.x - ax) * dx + (p.y - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const nearX = ax + t * dx, nearY = ay + t * dy;
        const distX = p.x - nearX, distY = p.y - nearY;
        const dist = Math.sqrt(distX * distX + distY * distY);
        if (dist < radius) {
          const nx = distX / dist, ny = distY / dist;
          const overlap = radius - dist;
          p.x += nx * overlap;
          p.y += ny * overlap;
          const vn = p.vx * nx + p.vy * ny;
          if (vn < 0) { p.vx -= 2 * vn * nx; p.vy -= 2 * vn * ny; }
          break;
        }
      }

      if (opening && opening.state === 'open') {
        const cx = half, cy = half;
        const dx = p.x - cx, dy = p.y - cy;
        const distFromCenter = Math.sqrt(dx * dx + dy * dy);
        const escapeThreshold = half * 1.12 + radius;
        if (distFromCenter > escapeThreshold) {
          let nearestGapIdx = -1, minDist = Infinity;
          for (let i = 0; i < totalPts; i++) {
            if (isInGap(i)) {
              const d = (p.x - PERIMETER[i].x) ** 2 + (p.y - PERIMETER[i].y) ** 2;
              if (d < minDist) { minDist = d; nearestGapIdx = i; }
            }
          }
          if (nearestGapIdx >= 0) {
            const angle = Math.atan2(dy, dx);
            const gapAngle = Math.atan2(PERIMETER[nearestGapIdx].y - cy, PERIMETER[nearestGapIdx].x - cx);
            let diff = Math.abs(angle - gapAngle);
            diff = Math.min(diff, 2 * Math.PI - diff);
            const vOut = p.vx * dx + p.vy * dy;
            if (diff < 0.8 && vOut > 0) { p.alive = false; return; }
          }
        }
      }
    });

    const stillAlive = alive.filter(p => p.alive);
    for (let i = 0; i < stillAlive.length; i++) {
      for (let j = i + 1; j < stillAlive.length; j++) {
        const a = stillAlive[i], b = stillAlive[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const rA = a.displayRadius || a.radius, rB = b.displayRadius || b.radius;
        const minDist = rA + rB;
        if (dist < minDist && dist > 0.001) {
          const nx = dx / dist, ny = dy / dist;
          const overlap = (minDist - dist) * 0.5;
          a.x -= nx * overlap; a.y -= ny * overlap;
          b.x += nx * overlap; b.y += ny * overlap;
          const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
          const dvn = dvx * nx + dvy * ny;
          if (dvn > 0) {
            const totalMass = a.mass + b.mass;
            const impulse = 2 * dvn / (1 / a.mass + 1 / b.mass);
            const aFactor = 1 - (a.mass / totalMass) * 0.6;
            const bFactor = 1 - (b.mass / totalMass) * 0.6;
            a.vx -= (impulse / a.mass) * aFactor * nx; a.vy -= (impulse / a.mass) * aFactor * ny;
            b.vx += (impulse / b.mass) * bFactor * nx; b.vy += (impulse / b.mass) * bFactor * ny;
          }
        }
      }
    }

    stillAlive.forEach(p => {
      const maxSp = speedForRadius(p.displayRadius || p.radius);
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp > maxSp) { p.vx = (p.vx / sp) * maxSp; p.vy = (p.vy / sp) * maxSp; }
      const minSp = 3.0;
      if (sp < minSp && sp > 0.01) { const ratio = minSp / sp; p.vx *= ratio; p.vy *= ratio; }
    });
  }

  // radii ease toward target, same as the client used to do locally
  room.players.forEach(p => {
    const diff = p.targetRadius - p.displayRadius;
    if (Math.abs(diff) > 0.01) p.displayRadius += diff * Math.min(1, 8.0 * dt);
  });
}

// ─────────────────────────────────────────────────────────────
// GAME LOOP — server tick. This is the authoritative clock; the
// client just plays back whatever this loop broadcasts.
// ─────────────────────────────────────────────────────────────
const TICK_HZ = 30;
let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;

  if (room.gameState === 'playing') {
    updatePhysics(dt);
  } else if (room.gameState === 'countdown') {
    const elapsed = (now - room.countdownStartTime) / 1000;
    if (elapsed >= 3.0) startPrestart();
  } else if (room.gameState === 'prestart') {
    room.prestartTimer -= dt;
    if (room.prestartTimer <= 0) startGame();
  } else if (room.gameState === 'idle') {
    if (getAlive().length >= 2) startCountdown();
  }

  broadcastState();
}, 1000 / TICK_HZ);

function broadcastState() {
  io.to(room.id).emit('state', {
    gameState: room.gameState,
    pot: room.pot,
    countdownStartTime: room.countdownStartTime,
    players: room.players.map(p => ({
      id: p.id, name: p.name, pfp: p.pfp, bet: p.bet, color: p.color,
      x: p.x, y: p.y, displayRadius: p.displayRadius, alive: p.alive,
    })),
    opening: room.opening,
  });
}

// ─────────────────────────────────────────────────────────────
// SOCKET.IO — this is where real players connect from Telegram.
// No bots anywhere in this file — every player array entry only
// ever gets created from a verified 'placeBet' from a real socket.
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let userId = null;

  socket.on('join', async ({ initData }, ack) => {
    let tgUser = verifyInitData(initData);
    if (!tgUser && ALLOW_DEV_LOGIN) {
      tgUser = { id: 'dev_' + socket.id.slice(0, 6), username: 'dev_player', photo_url: '' };
    }
    if (!tgUser) {
      ack?.({ ok: false, error: 'Could not verify Telegram login.' });
      return;
    }
    userId = String(tgUser.id);
    socket.data.userId = userId;
    socket.join(room.id);

    const user = await getUser(userId, {
      username: tgUser.username || tgUser.first_name || 'player',
      pfp: tgUser.photo_url || '',
    });

    ack?.({
      ok: true,
      user,
      arena: { size: ARENA_SIZE, cornerRadius: CORNER_RADIUS, perimeter: PERIMETER },
    });
    broadcastState();
  });

  socket.on('placeBet', async ({ amount }, ack) => {
    if (!userId) return ack?.({ ok: false, error: 'Not joined.' });
    if (!['idle', 'countdown', 'prestart'].includes(room.gameState)) {
      return ack?.({ ok: false, error: 'Round already in progress.' });
    }
    const amt = Math.max(10, Math.floor(Number(amount) || 0));
    const user = await getUser(userId);
    if (!user || amt > user.balance) return ack?.({ ok: false, error: 'Insufficient balance.' });
    if (room.players.length >= MAX_PLAYERS && !getPlayer(userId)) {
      return ack?.({ ok: false, error: 'Arena is full.' });
    }

    user.balance -= amt;
    await saveUser(user);

    const existing = getPlayer(userId);
    if (existing) {
      existing.bet += amt;
      computeRadii();
    } else {
      makePlayer(userId, amt, user.username, user.pfp);
    }
    room.pot += amt;

    ack?.({ ok: true, balance: user.balance });
    broadcastState();
  });

  socket.on('leaderboard', async (_, ack) => {
    ack?.({ ok: true, top: await topPlayers(20) });
  });

  socket.on('disconnect', () => {
    // players stay in the round even if they close the app mid-match;
    // their bet is already committed to the pot either way.
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, players: room.players.length, gameState: room.gameState });
});

app.get('/leaderboard', async (req, res) => {
  res.json({ top: await topPlayers(20), totalUsers: await allUsersCount() });
});

server.listen(PORT, () => {
  console.log(`bump arena server listening on :${PORT}`);
  if (!BOT_TOKEN) {
    console.warn('⚠ TELEGRAM_BOT_TOKEN is not set — real Telegram logins cannot be verified. Set ALLOW_DEV_LOGIN=true only for local testing.');
  }
});
