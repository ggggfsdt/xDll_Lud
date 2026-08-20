// ═══════════════════════════════════════════════════════════════
// dllump · bump arena — multiplayer backend
// ═══════════════════════════════════════════════════════════════

// ─── Catch unhandled errors ──────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection:', reason);
});

// ─── Imports ──────────────────────────────────────────────────
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cors = require('cors'); // <-- ADDED
const { Server } = require('socket.io');
const {
  getUser,
  saveUser,
  addWinToHistory,
  getAllUsers,
  topPlayers,
  allUsersCount,
  createPromoCode,
  redeemPromoCode,
  getPromoCodes,
  deletePromoCode,
} = require('./store');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOW_DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === 'true';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';

// ─── express + socket.io ──────────────────────────────────────
const app = express();
app.use(cors()); // <-- ADDED: allow all origins (or restrict later)
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

// ─── Telegram auth ─────────────────────────────────────────────
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
    if (Date.now() / 1000 - authDate > 86400) return null;
    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) {
    console.error('Auth error:', e);
    return null;
  }
}

// ─── Arena geometry ─────────────────────────────────────────────
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

const MIN_RADIUS = 11;
const MAX_RADIUS = 52;

function speedForRadius(radius) {
  const norm = Math.min(1, Math.max(0, (radius - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS)));
  const speed = 6.5 - norm * 3.5;
  return Math.max(3.0, Math.min(6.5, speed));
}

// ─── Room ──────────────────────────────────────────────────────
const COLORS = ['#5b8def', '#50c890', '#e06060', '#d4af37', '#c084e0', '#f0a070', '#60c0d0', '#e8a0a0'];
const MAX_PLAYERS = 8;

// ─── Reactions ──────────────────────────────────────────────────
const REACTION_EMOJIS = ['😂', '😮', '🔥', '💀', '👍', '❤️'];
const REACTION_GIF_URL = 'https://i.postimg.cc/Z5G1xdN9/ezgif-20d222277768f496.gif';
const REACTION_COOLDOWN_MS = 1500;
const reactionCooldowns = new Map(); // userId -> last reaction timestamp (ms)

function createRoom(id) {
  return {
    id,
    gameState: 'idle',
    players: [],
    pot: 0,
    opening: null,
    openingTimer: 0,
    gameTime: 0,
    countdownStartTime: 0,
    prestartTimer: 0,
    recentWinners: [], // last few winners, kept server-side so the win-history strip survives a client reload/reconnect
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
    // exponent > 1 compresses small shares toward the floor (way smaller for a tiny
    // bet against a big pot) while ratio=1 (sole bettor) still reaches MAX_RADIUS
    const scaled = Math.pow(ratio, 1.3);
    const r = MIN_RADIUS + scaled * (MAX_RADIUS - MIN_RADIUS);
    p.targetRadius = Math.min(Math.max(r, MIN_RADIUS), MAX_RADIUS);
    p.mass = p.targetRadius * p.targetRadius * 1.2;
    // Immediately update displayRadius so sizes change during countdown
    p.displayRadius = p.targetRadius;
  });
}

function makePlayer(id, bet, name, pfp, crownRank) {
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
    crownRank: crownRank || null, // 1 = gold crown/outline, 2 = silver crown/outline, null = none
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
  room.countdownEndTime = Date.now() + 10000; // 10 seconds
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
  room.openingTimer = 3.0 + Math.random() * 3.5; // time before the first opening appears
}

async function endGame(winnerId) {
  if (room.gameState === 'finished') return;
  room.gameState = 'finished';
  const winner = getPlayer(winnerId);
  let payload = null;

  if (winner) {
    // Compute the payload from data we already have in memory FIRST.
    // This is deliberately independent of any database/promo-code call
    // below — if a store.js write fails for any reason, the win screen
    // should still show. (Previously the whole payload lived inside the
    // same try/catch as the DB writes, so any persistence error — e.g.
    // from the newer promo-code/ban logic in store.js — silently
    // resulted in `payload = null`, which is why the win screen and
    // win-history strip could stop appearing with no visible error on
    // the client.)
    const totalPot = room.pot;
    const winnerBet = winner.bet;
    const losersBets = totalPot - winnerBet;
    const commission = Math.floor(losersBets * 0.02);
    const winnings = totalPot - commission;
    payload = {
      winnerId: winner.id,
      winnerName: winner.name,
      winnerPfp: winner.pfp,
      winnings,
      multiplier: +(winnings / winnerBet).toFixed(2),
    };

    room.recentWinners.unshift({ name: winner.name, pfp: winner.pfp });
    if (room.recentWinners.length > 8) room.recentWinners.length = 8;

    // Persistence is best-effort from here on — log failures loudly but
    // never let them affect the payload we already built above.
    try {
      const winnerUser = await getUser(winner.id);
      if (winnerUser) {
        winnerUser.balance += winnings;
        winnerUser.wins += 1;
        await saveUser(winnerUser);
      }
    } catch (err) {
      console.error('endGame: failed to credit winner balance:', err);
    }

    for (const p of room.players) {
      if (p.id === winner.id) continue;
      try {
        const u = await getUser(p.id);
        if (u) { u.losses += 1; await saveUser(u); }
      } catch (err) {
        console.error('endGame: failed to update loser stats for', p.id, err);
      }
    }

    try {
      await addWinToHistory(winner.id, winner.name, winner.pfp, winnings);
    } catch (err) {
      console.error('endGame: failed to write win history:', err);
    }
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
      // Openings start small-to-medium and grow larger as the round goes on,
      // so early game has tighter escape windows and it opens up later.
      let minGap, maxGap;
      if (gameTime < 5) { [minGap, maxGap] = [0.05, 0.16]; }
      else if (gameTime < 12) { [minGap, maxGap] = [0.12, 0.26]; }
      else { [minGap, maxGap] = [0.20, 0.42]; }
      const gapSize = Math.floor((minGap + Math.random() * (maxGap - minGap)) * totalPts);
      const startIdx = Math.floor(Math.random() * totalPts);
      const endIdx = (startIdx + gapSize) % totalPts;
      // slightly randomized blink speed each opening (a bit faster or slower than before)
      const flashInterval = 0.18 + Math.random() * 0.14; // was fixed at 0.25
      room.opening = { startIdx, endIdx, flashCount: 0, flashTimer: 0, flashInterval, state: 'flashing' };
      room.openingTimer = 3.0 + Math.random() * 3.5; // was 3.5–6.0, now 3.0–6.5
    } else {
      room.opening = null;
      room.openingTimer = 1.2 + Math.random() * 2.6; // was 1.5–3.5, now 1.2–3.8
    }
  }
  const opening = room.opening;
  if (opening && opening.state === 'flashing') {
    opening.flashTimer += dt;
    if (opening.flashTimer > (opening.flashInterval || 0.25)) {
      opening.flashTimer = 0;
      opening.flashCount++;
      if (opening.flashCount >= 4) opening.state = 'open';
    }
  }

  // Finds the closest solid-wall segment to p (skipping segments inside an open gap)
  // and, if p is overlapping it, pushes p back out and reflects its velocity.
  // Returns true if a solid wall was actually hit this call.
  //
  // Correction magnitude is capped at 1.5x the circle's own radius — even in a rare
  // deep-overlap edge case, this guarantees no single correction can violently
  // Finds the closest solid-wall segment to p (skipping segments inside an open gap)
  // and, if p is overlapping it, pushes p back out. If reflectVelocity is true it also
  // bounces the velocity off the wall (normal physics, used for the main per-substep
  // movement pass). If false, it ONLY corrects position with no velocity change — used
  // for the safety pass after player-vs-player collisions, so we don't add a second
  // "bounce" on top of the real one and cause jittering.
  function resolveWallCollision(p, radius, reflectVelocity) {
    let bestDist = Infinity, bestNx = 0, bestNy = 0;
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
      if (dist < radius && dist < bestDist) {
        bestDist = dist;
        bestNx = distX / dist;
        bestNy = distY / dist;
      }
    }
    if (bestDist === Infinity) return false;
    let overlap = radius - bestDist;
    overlap = Math.min(overlap, radius * 1.5);
    p.x += bestNx * overlap;
    p.y += bestNy * overlap;
    if (reflectVelocity) {
      const vn = p.vx * bestNx + p.vy * bestNy;
      if (vn < 0) { p.vx -= 2 * vn * bestNx; p.vy -= 2 * vn * bestNy; }
    }
    return true;
  }

  // Is p actually lined up with (near the angular position of) the currently open gap,
  // and clearly past the boundary? This is what decides "you actually escaped" vs.
  // "you're just near a wall somewhere else" — without this check, elimination could
  // fire from an ordinary near-boundary moment that had nothing to do with the gap.
  function checkGapEscape(p, radius) {
    if (!(opening && opening.state === 'open')) return false;
    const cx = half, cy = half;
    const dx = p.x - cx, dy = p.y - cy;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distFromCenter < half * 0.9) return false; // nowhere near the boundary yet

    let nearestGapIdx = -1, minDist = Infinity;
    for (let i = 0; i < totalPts; i++) {
      if (isInGap(i)) {
        const ddx = p.x - PERIMETER[i].x, ddy = p.y - PERIMETER[i].y;
        const d = ddx * ddx + ddy * ddy;
        if (d < minDist) { minDist = d; nearestGapIdx = i; }
      }
    }
    if (nearestGapIdx < 0) return false;
    const angle = Math.atan2(dy, dx);
    const gapAngle = Math.atan2(PERIMETER[nearestGapIdx].y - cy, PERIMETER[nearestGapIdx].x - cx);
    let diff = Math.abs(angle - gapAngle);
    diff = Math.min(diff, 2 * Math.PI - diff);
    // must actually be angled toward the gap (not just anywhere near the boundary),
    // and clearly past the wall line — close enough that the gap can't close on them
    // mid-flight without them already being marked eliminated
    return diff < 0.55 && distFromCenter > half * 1.0 + radius * 0.3;
  }

  const subSteps = 10; // was 6 — smaller circles move faster (see speedForRadius) and the
  // extra substeps keep their per-step travel distance small enough that they can't tunnel
  // deep into a wall/another circle before a collision is caught, which is what was causing
  // the "glitchy" snap-corrections on small circles.
  const subDt = dt / subSteps;
  for (let step = 0; step < subSteps; step++) {
    alive.forEach(p => {
      if (!p.alive) return;
      p.x += p.vx * subDt * 60;
      p.y += p.vy * subDt * 60;
      const radius = p.displayRadius || p.radius;

      resolveWallCollision(p, radius, true);

      if (checkGapEscape(p, radius)) {
        p.alive = false;
        return;
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
          const totalMass = a.mass + b.mass;
          const totalOverlap = minDist - dist;
          // mass-weighted separation: the lighter circle gets shoved back more, the
          // heavier one barely moves — like a real puck hit, not two equal blobs
          // nudging apart by the same amount regardless of size
          const aPush = totalOverlap * (b.mass / totalMass);
          const bPush = totalOverlap * (a.mass / totalMass);
          a.x -= nx * aPush; a.y -= ny * aPush;
          b.x += nx * bPush; b.y += ny * bPush;

          const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
          const dvn = dvx * nx + dvy * ny;
          if (dvn > 0) {
            // Fully elastic collision — no artificial damping. A real puck-on-puck hit
            // transfers momentum cleanly and the two separate sharply; the old 0.6
            // damping factor here softened every hit, which meant circles often didn't
            // fully separate on the first impulse and needed several more small
            // corrections over the next substeps — that repeated micro-correction is
            // what was actually reading as "shaking" instead of a clean launch.
            const impulse = 2 * dvn / (1 / a.mass + 1 / b.mass);
            a.vx -= (impulse / a.mass) * nx;
            a.vy -= (impulse / a.mass) * ny;
            b.vx += (impulse / b.mass) * nx;
            b.vy += (impulse / b.mass) * ny;
          }
        }
      }
    }

    // Position-only safety pass: the player-vs-player separation above can shove someone
    // straight into (or through) a wall if they were pinned against it — this catches
    // that and nudges them back, WITHOUT touching velocity (that's the fix for the
    // "shaking balloon" feel — reflecting velocity here too was double-bouncing every
    // substep and destroying the clean hockey-puck slide).
    stillAlive.forEach(p => {
      const radius = p.displayRadius || p.radius;
      resolveWallCollision(p, radius, false);
    });

    stillAlive.forEach(p => {
      const maxSp = speedForRadius(p.displayRadius || p.radius);
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp > maxSp) { p.vx = (p.vx / sp) * maxSp; p.vy = (p.vy / sp) * maxSp; }
      // NOTE: no minimum-speed floor here anymore — see below. Enforcing one every
      // substep (300x/sec) was constantly snapping velocity back up after ordinary
      // collisions, which is what was producing the jittery "shaking" feel instead of
      // a clean puck slide. Real elastic collisions don't need it.
    });
  }
  // Once per full tick (not per substep): only nudge someone who has genuinely stalled
  // near-zero, so the arena never has a permanently frozen circle — this doesn't fight
  // normal collision outcomes the way the old per-substep floor did.
  getAlive().forEach(p => {
    if (!p.alive) return;
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (sp < 0.6 && sp > 0.001) {
      const minSp = 1.2;
      const ratio = minSp / sp;
      p.vx *= ratio; p.vy *= ratio;
    } else if (sp <= 0.001) {
      const angle = Math.random() * Math.PI * 2;
      p.vx = Math.cos(angle) * 1.2;
      p.vy = Math.sin(angle) * 1.2;
    }
  });
  room.players.forEach(p => {
    const diff = p.targetRadius - p.displayRadius;
    if (Math.abs(diff) > 0.01) p.displayRadius += diff * Math.min(1, 8.0 * dt);
  });
}

// ─── Game Loop ────────────────────────────────────────────────
const TICK_HZ = 30;
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  try {
    if (room.gameState === 'playing') updatePhysics(dt);
    else if (room.gameState === 'countdown') {
      const elapsed = (now - room.countdownStartTime) / 1000;
      if (elapsed >= 10.0) startPrestart();
    } else if (room.gameState === 'prestart') {
      room.prestartTimer -= dt;
      if (room.prestartTimer <= 0) startGame();
    } else if (room.gameState === 'idle') {
      if (getAlive().length >= 2) startCountdown();
    }
    broadcastState();
  } catch (err) {
    console.error('Game loop error:', err);
  }
}, 1000 / TICK_HZ);

function broadcastState() {
  io.to(room.id).emit('state', {
    gameState: room.gameState,
    pot: room.pot,
    countdownStartTime: room.countdownStartTime,
    players: room.players.map(p => ({
      id: p.id, name: p.name, pfp: p.pfp, bet: p.bet, color: p.color,
      x: p.x, y: p.y, displayRadius: p.displayRadius, alive: p.alive,
      crownRank: p.crownRank || null,
    })),
    opening: room.opening,
  });
}

// ─── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  let userId = null;
  socket.on('join', async ({ initData }, ack) => {
    try {
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
      if (user.banned) {
        ack?.({ ok: false, error: 'You have been banned.' });
        return;
      }
      ack?.({
        ok: true,
        user: {
          ...user,
          winHistory: user.winHistory || [],
          anonymous: !!user.anonymous,
        },
        arena: { size: ARENA_SIZE, cornerRadius: CORNER_RADIUS, perimeter: PERIMETER },
        recentWinners: room.recentWinners,
      });
      broadcastState();
    } catch (err) {
      console.error('Join error:', err);
      ack?.({ ok: false, error: 'Internal error' });
    }
  });

  socket.on('placeBet', async ({ amount }, ack) => {
    try {
      if (!userId) return ack?.({ ok: false, error: 'Not joined.' });
      if (!['idle', 'countdown', 'prestart'].includes(room.gameState)) {
        return ack?.({ ok: false, error: 'Round already in progress.' });
      }
      const amt = Math.max(10, Math.floor(Number(amount) || 0));
      const user = await getUser(userId);
      if (!user || amt > user.balance) return ack?.({ ok: false, error: 'Insufficient balance.' });
      if (user.banned) return ack?.({ ok: false, error: 'You are banned.' });
      if (room.players.length >= MAX_PLAYERS && !getPlayer(userId)) {
        return ack?.({ ok: false, error: 'Arena is full.' });
      }
      user.balance -= amt;
      await saveUser(user);
      const existing = getPlayer(userId);
      if (existing) { existing.bet += amt; computeRadii(); }
      else {
        let crownRank = null;
        try {
          const top2 = await topPlayers(2);
          if (top2[0] && String(top2[0].id) === String(userId)) crownRank = 1;
          else if (top2[1] && String(top2[1].id) === String(userId)) crownRank = 2;
        } catch (err) {
          console.error('crownRank lookup failed:', err);
        }
        makePlayer(userId, amt, user.username, user.anonymous ? '' : user.pfp, crownRank);
      }
      room.pot += amt;
      ack?.({ ok: true, balance: user.balance });
      broadcastState();
    } catch (err) {
      console.error('Bet error:', err);
      ack?.({ ok: false, error: 'Internal error' });
    }
  });

  socket.on('setAnonymous', async ({ enabled }, ack) => {
    try {
      if (!userId) return ack?.({ ok: false, error: 'Not joined.' });
      const user = await getUser(userId);
      if (!user) return ack?.({ ok: false, error: 'User not found.' });
      user.anonymous = !!enabled;
      await saveUser(user);

      // if they're already sitting in an active round, update their live avatar
      // immediately instead of waiting for the next round to pick it up
      const livePlayer = getPlayer(userId);
      if (livePlayer) {
        livePlayer.pfp = user.anonymous ? '' : user.pfp;
        broadcastState();
      }
      ack?.({ ok: true, anonymous: user.anonymous });
    } catch (err) {
      console.error('setAnonymous error:', err);
      ack?.({ ok: false, error: 'Internal error' });
    }
  });

  socket.on('leaderboard', async (_, ack) => {
    try {
      const top = await topPlayers(20);
      const masked = top.map(u => (u.anonymous ? { ...u, pfp: '' } : u));
      ack?.({ ok: true, top: masked });
    } catch (err) {
      console.error('Leaderboard error:', err);
      ack?.({ ok: false, error: 'Internal error' });
    }
  });

  // ─── Reactions ────────────────────────────────────────────────
  // Server enforces the cooldown and whitelist itself — a modified client could try to
  // spam or send arbitrary content otherwise, since this just gets relayed to everyone.
  socket.on('reaction', ({ type, value }, ack) => {
    try {
      if (!userId) return ack?.({ ok: false, error: 'Not joined.' });
      const now = Date.now();
      const last = reactionCooldowns.get(userId) || 0;
      if (now - last < REACTION_COOLDOWN_MS) {
        return ack?.({ ok: false, error: 'Too soon.' });
      }

      let payload;
      if (type === 'gif') {
        payload = { type: 'gif', value: REACTION_GIF_URL };
      } else if (type === 'emoji' && REACTION_EMOJIS.includes(value)) {
        payload = { type: 'emoji', value };
      } else {
        return ack?.({ ok: false, error: 'Invalid reaction.' });
      }

      reactionCooldowns.set(userId, now);
      io.to(room.id).emit('reaction', { userId, ...payload });
      ack?.({ ok: true });
    } catch (err) {
      console.error('reaction error:', err);
      ack?.({ ok: false, error: 'Internal error' });
    }
  });

  socket.on('disconnect', () => {});
});

// ─────────────────────────────────────────────────────────────
// ADMIN API (requires ADMIN_SECRET)
// ─────────────────────────────────────────────────────────────
const ADMIN_HTML = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Admin Panel</title>
<style>body{background:#0a0a12;color:#eee;font-family:sans-serif;padding:20px;max-width:1000px;margin:auto}
table{width:100%;border-collapse:collapse;margin:10px 0}
th,td{padding:8px;border:1px solid #333;text-align:left}
button{padding:6px 12px;margin:2px;border:none;border-radius:6px;cursor:pointer;background:#4CAF50;color:#fff}
button.danger{background:#e06060}
button.warning{background:#f0a030}
input{padding:6px;border-radius:4px;border:1px solid #444;background:#222;color:#fff}
.auth{display:flex;gap:10px;margin-bottom:20px}
.section{border:1px solid #333;padding:15px;margin-top:15px;border-radius:8px}
</style></head>
<body>
<h2>dllump Admin</h2>
<div class="auth"><input id="secret" placeholder="Admin Secret" type="password"/><button onclick="auth()">Authenticate</button></div>
<div id="content" style="display:none">
  <div class="section">
    <h3>Players</h3>
    <button onclick="refreshPlayers()">Refresh Players</button>
    <div id="players"></div>
  </div>
  <div class="section">
    <h3>Actions</h3>
    <button class="warning" onclick="resetTop()">Reset Top (wins/losses)</button>
    <button class="warning" onclick="resetEconomy()">Reset Economy (balance to 50)</button>
    <button class="danger" onclick="wipeAll()">Wipe All Data</button>
  </div>
  <div class="section">
    <h3>Promo Codes</h3>
    <p>Generate a new code:</p>
    <input id="promoAmount" placeholder="Amount" value="100"/>
    <input id="promoCode" placeholder="Custom code (optional)"/>
    <input id="promoMaxUses" placeholder="Max uses" value="1"/>
    <button onclick="generatePromo()">Generate Promo</button>
    <div id="promoCodes"></div>
  </div>
  <div class="section">
    <h3>Individual Player</h3>
    <input id="addUserId" placeholder="User ID"/><input id="addAmount" placeholder="Amount"/><button onclick="addMoney()">Add Money</button>
    <br/>
    <input id="setUserId" placeholder="User ID"/><input id="setAmount" placeholder="New Balance"/><button onclick="setMoney()">Set Balance</button>
    <br/>
    <input id="banUserId" placeholder="User ID"/><button class="danger" onclick="banPlayer()">Ban/Unban</button>
  </div>
</div>
<script>
const ADMIN_SECRET = '${ADMIN_SECRET}';
async function fetchAdmin(path, method='GET', body=null) {
  const headers = {'admin-secret': document.getElementById('secret').value};
  if(body) headers['Content-Type'] = 'application/json';
  const res = await fetch('/admin/api'+path, {method, headers, body: body ? JSON.stringify(body) : null});
  return res.json();
}
function auth(){
  const secret = document.getElementById('secret').value;
  if(secret === ADMIN_SECRET) {
    document.getElementById('content').style.display = 'block';
    refreshPlayers();
    refreshPromoCodes();
  } else alert('Wrong secret');
}
async function refreshPlayers(){
  const data = await fetchAdmin('/players');
  const players = data.players || [];
  let html = '<table><tr><th>ID</th><th>Username</th><th>Balance</th><th>Wins</th><th>Losses</th><th>Banned</th><th>Actions</th></tr>';
  players.forEach(p => {
    html += \`<tr><td>\${p.id}</td><td>\${p.username}</td><td>\${p.balance}</td><td>\${p.wins}</td><td>\${p.losses}</td><td>\${p.banned ? '🚫' : ''}</td>
    <td><button onclick="banPlayer('\${p.id}')">Toggle Ban</button></td></tr>\`;
  });
  html += '</table>';
  document.getElementById('players').innerHTML = html;
}
async function refreshPromoCodes(){
  const data = await fetchAdmin('/promo-codes');
  const codes = data.codes || [];
  let html = '<table><tr><th>Code</th><th>Amount</th><th>Uses</th><th>Max</th><th>Actions</th></tr>';
  codes.forEach(c => {
    html += \`<tr><td>\${c.code}</td><td>\${c.amount}</td><td>\${c.usedCount}</td><td>\${c.maxUses}</td>
    <td><button onclick="deletePromo('\${c.code}')">Delete</button></td></tr>\`;
  });
  html += '</table>';
  document.getElementById('promoCodes').innerHTML = html;
}
async function resetTop(){ if(confirm('Reset all wins/losses to 0?')){ await fetchAdmin('/reset-top', 'POST'); refreshPlayers(); } }
async function resetEconomy(){ if(confirm('Reset all balances to 50?')){ await fetchAdmin('/reset-money', 'POST'); refreshPlayers(); } }
async function wipeAll(){ if(confirm('Wipe ALL player data? This cannot be undone!')){ await fetchAdmin('/wipe', 'POST'); refreshPlayers(); } }
async function addMoney(){
  const id = document.getElementById('addUserId').value;
  const amount = parseInt(document.getElementById('addAmount').value);
  if(!id || !amount) return;
  await fetchAdmin('/add-money', 'POST', {id, amount});
  refreshPlayers();
}
async function setMoney(){
  const id = document.getElementById('setUserId').value;
  const amount = parseInt(document.getElementById('setAmount').value);
  if(!id || isNaN(amount)) return;
  await fetchAdmin('/set-money', 'POST', {id, amount});
  refreshPlayers();
}
async function banPlayer(id){
  const userId = id || document.getElementById('banUserId').value;
  if(!userId) return;
  await fetchAdmin('/ban', 'POST', {id: userId});
  refreshPlayers();
}
async function generatePromo(){
  const amount = parseInt(document.getElementById('promoAmount').value) || 100;
  const code = document.getElementById('promoCode').value || null;
  const maxUses = parseInt(document.getElementById('promoMaxUses').value) || 1;
  const data = await fetchAdmin('/create-promo', 'POST', {amount, code, maxUses});
  if(data.ok){ alert('Promo created: '+data.code); refreshPromoCodes(); }
  else alert('Error: '+data.error);
}
async function deletePromo(code){
  if(!confirm('Delete promo '+code+'?')) return;
  await fetchAdmin('/delete-promo', 'POST', {code});
  refreshPromoCodes();
}
</script>
</body></html>
`;

function adminAuth(req, res, next) {
  const secret = req.headers['admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// Serve admin HTML
app.get('/admin', (req, res) => {
  res.send(ADMIN_HTML);
});

// Admin API endpoints
app.get('/admin/api/players', adminAuth, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ players: users });
  } catch (err) {
    console.error('Admin players error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/admin/api/reset-money', adminAuth, async (req, res) => {
  try {
    const users = await getAllUsers();
    for (const u of users) {
      u.balance = 50;
      await saveUser(u);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset money error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/admin/api/reset-top', adminAuth, async (req, res) => {
  try {
    const users = await getAllUsers();
    for (const u of users) {
      u.wins = 0;
      u.losses = 0;
      await saveUser(u);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset top error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/admin/api/wipe', adminAuth, async (req, res) => {
  try {
    const all = await getAllUsers();
    for (const u of all) {
      u.balance = 50;
      u.wins = 0;
      u.losses = 0;
      u.banned = false;
      u.winHistory = [];
      await saveUser(u);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Wipe error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/admin/api/add-money', adminAuth, async (req, res) => {
  try {
    const { id, amount } = req.body;
    if (!id || !amount || isNaN(amount)) return res.status(400).json({ ok: false, error: 'Invalid' });
    const user = await getUser(id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    user.balance += amount;
    await saveUser(user);
    res.json({ ok: true, balance: user.balance });
  } catch (err) {
    console.error('Add money error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/admin/api/set-money', adminAuth, async (req, res) => {
  try {
    const { id, amount } = req.body;
    if (!id || isNaN(amount) || amount < 0) return res.status(400).json({ ok: false, error: 'Invalid' });
    const user = await getUser(id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    user.balance = amount;
    await saveUser(user);
    res.json({ ok: true, balance: user.balance });
  } catch (err) {
    console.error('Set money error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/admin/api/ban', adminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
    const user = await getUser(id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    user.banned = !user.banned;
    await saveUser(user);
    res.json({ ok: true, banned: user.banned });
  } catch (err) {
    console.error('Ban error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// Promo admin endpoints
app.post('/admin/api/create-promo', adminAuth, async (req, res) => {
  try {
    const { amount, code, maxUses } = req.body;
    if (!amount || isNaN(amount) || amount < 1) return res.status(400).json({ ok: false, error: 'Invalid amount' });
    const promo = await createPromoCode(amount, code || null, maxUses || 1);
    res.json({ ok: true, code: promo.code });
  } catch (err) {
    console.error('Create promo error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/admin/api/delete-promo', adminAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });
    await deletePromoCode(code);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete promo error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.get('/admin/api/promo-codes', adminAuth, async (req, res) => {
  try {
    const codes = await getPromoCodes();
    res.json({ codes });
  } catch (err) {
    console.error('Get promo codes error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── PUBLIC PROMO REDEEM ENDPOINT ─────────────────────────────
// store.js's redeemPromoCode already enforces the code's overall maxUses, but that's
// a global counter — it doesn't stop the SAME person from redeeming a multi-use code
// more than once. We track that separately here, on the user's own record, so it
// works regardless of how store.js's promo-code bookkeeping is structured.
async function handleRedeem(code, userId) {
  const normalizedCode = String(code).trim().toUpperCase();
  const user = await getUser(userId);
  if (!user) return { ok: false, error: 'User not found' };

  user.redeemedCodes = user.redeemedCodes || [];
  if (user.redeemedCodes.includes(normalizedCode)) {
    return { ok: false, error: 'You already redeemed this code.' };
  }

  const result = await redeemPromoCode(code, userId);
  if (result && result.ok) {
    user.redeemedCodes.push(normalizedCode);
    await saveUser(user);
  }
  return result;
}

app.post('/redeem', async (req, res) => {
  try {
    const { code, userId } = req.body;
    if (!code || !userId) {
      return res.status(400).json({ ok: false, error: 'Missing code or userId' });
    }
    res.json(await handleRedeem(code, userId));
  } catch (err) {
    console.error('Redeem promo error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.get('/redeem', async (req, res) => {
  try {
    const { code, userId } = req.query;
    if (!code || !userId) {
      return res.status(400).json({ ok: false, error: 'Missing code or userId' });
    }
    res.json(await handleRedeem(code, userId));
  } catch (err) {
    console.error('Redeem promo (GET) error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Health & leaderboard ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, players: room.players.length, gameState: room.gameState });
});
app.get('/leaderboard', async (req, res) => {
  try {
    const top = await topPlayers(20);
    res.json({ top: top.map(u => (u.anonymous ? { ...u, pfp: '' } : u)) });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Start server ──────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`bump arena server listening on :${PORT}`);
  if (!BOT_TOKEN) console.warn('⚠ TELEGRAM_BOT_TOKEN not set — real Telegram login cannot be verified.');
  if (ADMIN_SECRET === 'change-me-in-production') console.warn('⚠ Change ADMIN_SECRET environment variable!');
});
