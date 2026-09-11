const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cors = require('cors');
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
  resetPlayer,
  setAnonymousData,
  checkAnonymousUnique,
  changeAnonymousField,
  toggleHidePfp,
} = require('./store');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOW_DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === 'true';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';

const app = express();
app.use(cors());
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

    for (const [key, value] of [...params.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      dataCheckArr.push(`${key}=${value}`);
    }

    const dataCheckString = dataCheckArr.join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

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
const CORNER_RADIUS = ARENA_SIZE * 0.35;

function generatePerimeter(size, cornerRadius, numPoints = 300) {
  const half = size / 2;
  const r = Math.min(cornerRadius, half);

  const sections = [
    {
      type: 'line',
      x1: -half + r,
      y1: -half,
      x2: half - r,
      y2: -half,
    },
    {
      type: 'arc',
      cx: half - r,
      cy: -half + r,
      start: -Math.PI / 2,
      end: 0,
    },
    {
      type: 'line',
      x1: half,
      y1: -half + r,
      x2: half,
      y2: half - r,
    },
    {
      type: 'arc',
      cx: half - r,
      cy: half - r,
      start: 0,
      end: Math.PI / 2,
    },
    {
      type: 'line',
      x1: half - r,
      y1: half,
      x2: -half + r,
      y2: half,
    },
    {
      type: 'arc',
      cx: -half + r,
      cy: half - r,
      start: Math.PI / 2,
      end: Math.PI,
    },
    {
      type: 'line',
      x1: -half,
      y1: half - r,
      x2: -half,
      y2: -half + r,
    },
    {
      type: 'arc',
      cx: -half + r,
      cy: -half + r,
      start: Math.PI,
      end: 3 * Math.PI / 2,
    },
  ];

  const segLengths = sections.map(seg =>
    seg.type === 'line'
      ? Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1)
      : r * (seg.end - seg.start)
  );

  const totalLen = segLengths.reduce((a, b) => a + b, 0);
  const step = totalLen / numPoints;

  const points = [];

  let accumulated = 0;
  let segIdx = 0;

  for (let i = 0; i < numPoints; i++) {
    const target = i * step;

    while (
      accumulated + segLengths[segIdx] < target
    ) {
      accumulated += segLengths[segIdx];
      segIdx = (segIdx + 1) % sections.length;
    }

    const localT =
      (target - accumulated) / segLengths[segIdx];

    const seg = sections[segIdx];

    let px;
    let py;

    if (seg.type === 'line') {
      px =
        seg.x1 +
        localT * (seg.x2 - seg.x1);

      py =
        seg.y1 +
        localT * (seg.y2 - seg.y1);
    } else {
      const angle =
        seg.start +
        localT * (seg.end - seg.start);

      px =
        seg.cx +
        r * Math.cos(angle);

      py =
        seg.cy +
        r * Math.sin(angle);
    }

    points.push({
      x: px + half,
      y: py + half,
    });
  }

  return points;
}

const PERIMETER = generatePerimeter(
  ARENA_SIZE,
  CORNER_RADIUS,
  300
);

// ─── Original speed ─────────────────────────────────────────────
function speedForRadius(radius) {
  const minR = 18;
  const maxR = 52;

  const norm = Math.min(
    1,
    Math.max(
      0,
      (radius - minR) / (maxR - minR)
    )
  );

  const speed =
    28.0 -
    norm * 20.0;

  return Math.max(
    8.0,
    Math.min(28.0, speed)
  );
}

// ─── Room ──────────────────────────────────────────────────────
const COLORS = [
  '#e74c3c',
  '#2ecc71',
  '#3498db',
  '#f1c40f',
  '#9b59b6',
  '#e67e22',
  '#1abc9c',
  '#e84393',
];

const MAX_PLAYERS = 8;

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
    recentWinners: [],
  };
}

const room = createRoom('main');

function getAlive() {
  return room.players.filter(p => p.alive);
}

function getPlayer(id) {
  return room.players.find(p => p.id === id);
}

// ═══════════════════════════════════════════════════════════════
// ICE ARENA
// ═══════════════════════════════════════════════════════════════

const ICE_SIZE = ARENA_SIZE;
const ICE_CORNER_RADIUS =
  ARENA_SIZE * 0.045;

const ICE_PERIMETER = generatePerimeter(
  ICE_SIZE,
  ICE_CORNER_RADIUS,
  300
);

const ICE_FIELD_SCALE = 0.92;

function createIceRoom(id) {
  return {
    id,
    gameState: 'idle',
    players: [],
    pot: 0,
    countdownStartTime: 0,
    spinStartTime: 0,
    spinDuration: 0,
    spinFinalAngle: 0,
    spinStartX: ICE_SIZE / 2,
    spinStartY: ICE_SIZE / 2,
    puck: {
      x: ICE_SIZE / 2,
      y: ICE_SIZE / 2,
      vx: 0,
      vy: 0,
    },
    recentWinners: [],
    slideStartTime: 0,
  };
}

const iceRoom = createIceRoom('ice');

function getIcePlayer(id) {
  return iceRoom.players.find(
    p => p.id === id
  );
}

// ─── BOT MANAGEMENT ─────────────────────────────────────────────
let botCounter = 0;
const botIds = new Set();
let autoBotEnabled = false;
let autoBotInterval = null;

function generateBotId() {
  return `bot_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function isBot(id) {
  return (
    id &&
    typeof id === 'string' &&
    id.startsWith('bot_')
  );
}

function spawnBot(betAmount) {
  const id = generateBotId();

  botCounter++;

  const name =
    `Bot_${String(botCounter).padStart(3, '0')}`;

  const pfp =
    `https://i.pravatar.cc/150?img=${
      Math.floor(Math.random() * 70)
    }`;

  const player = makeIcePlayer(
    id,
    betAmount,
    name,
    pfp
  );

  if (player) {
    botIds.add(id);

    console.log(
      `🤖 Spawned bot: ${name} (${id}) with bet ${betAmount}`
    );

    return player;
  }

  return null;
}

function removeAllBots() {
  const toRemove = [];

  iceRoom.players.forEach(p => {
    if (isBot(p.id)) {
      toRemove.push(p.id);
    }
  });

  toRemove.forEach(id => {
    const idx =
      iceRoom.players.findIndex(
        p => p.id === id
      );

    if (idx !== -1) {
      iceRoom.players.splice(idx, 1);
    }

    botIds.delete(id);
  });

  if (toRemove.length > 0) {
    console.log(
      `🧹 Removed ${toRemove.length} bots from ice arena`
    );

    if (iceRoom.players.length > 0) {
      repartitionIceArena();
    }
  }

  return toRemove.length;
}

function startAutoBot() {
  if (autoBotInterval) {
    clearInterval(autoBotInterval);
  }

  autoBotInterval = setInterval(() => {
    if (!autoBotEnabled) return;

    if (iceRoom.gameState !== 'idle') return;

    if (iceRoom.players.length >= MAX_PLAYERS) return;

    const bet =
      Math.floor(Math.random() * 140) + 10;

    const bot = spawnBot(bet);

    if (bot) {
      console.log(
        `🤖 Auto-spawned bot: ${bot.name} with bet ${bet}`
      );
    }
  }, 4000);
}

startAutoBot();

function stopAutoBot() {
  if (autoBotInterval) {
    clearInterval(autoBotInterval);
    autoBotInterval = null;
  }
}

// ─── BSP Partition ──────────────────────────────────────────────
function repartitionIceArena() {
  const players = iceRoom.players;

  if (players.length === 0) return;

  const shuffled = [...players];

  for (
    let i = shuffled.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(Math.random() * (i + 1));

    [shuffled[i], shuffled[j]] =
      [shuffled[j], shuffled[i]];
  }

  partitionRect(
    shuffled,
    0,
    0,
    ICE_SIZE,
    ICE_SIZE,
    0,
    shuffled.length
  );

  const map = {};

  shuffled.forEach(p => {
    map[p.id] = p;
  });

  const half = ICE_SIZE / 2;
  const scale = ICE_FIELD_SCALE;

  players.forEach(p => {
    const assigned = map[p.id];

    if (assigned) {
      const cx1 =
        assigned.x1 - half;

      const cy1 =
        assigned.y1 - half;

      const cx2 =
        assigned.x2 - half;

      const cy2 =
        assigned.y2 - half;

      p.x1 =
        half + cx1 * scale;

      p.y1 =
        half + cy1 * scale;

      p.x2 =
        half + cx2 * scale;

      p.y2 =
        half + cy2 * scale;
    }
  });
}

function partitionRect(
  players,
  x,
  y,
  w,
  h,
  startIdx,
  endIdx
) {
  const count =
    endIdx - startIdx;

  if (count <= 0) return;

  if (count === 1) {
    const p = players[startIdx];

    p.x1 = x;
    p.y1 = y;
    p.x2 = x + w;
    p.y2 = y + h;

    return;
  }

  const totalBet =
    players
      .slice(startIdx, endIdx)
      .reduce(
        (s, p) =>
          s + Math.max(p.bet, 1),
        0
      );

  if (totalBet === 0) {
    const mid =
      Math.floor(
        (startIdx + endIdx) / 2
      );

    const dir =
      Math.random() < 0.5
        ? 'h'
        : 'v';

    if (dir === 'h') {
      const splitY =
        y + h / 2;

      partitionRect(
        players,
        x,
        y,
        w,
        splitY - y,
        startIdx,
        mid
      );

      partitionRect(
        players,
        x,
        splitY,
        w,
        y + h - splitY,
        mid,
        endIdx
      );
    } else {
      const splitX =
        x + w / 2;

      partitionRect(
        players,
        x,
        y,
        splitX - x,
        h,
        startIdx,
        mid
      );

      partitionRect(
        players,
        splitX,
        y,
        x + w - splitX,
        h,
        mid,
        endIdx
      );
    }

    return;
  }

  const cum = [];
  let sum = 0;

  for (
    let i = startIdx;
    i < endIdx;
    i++
  ) {
    sum += Math.max(
      players[i].bet,
      1
    );

    cum.push(sum);
  }

  const r =
    Math.random() * sum;

  let splitIdx =
    startIdx;

  for (
    let i = 0;
    i < cum.length;
    i++
  ) {
    if (r <= cum[i]) {
      splitIdx =
        startIdx + i + 1;
      break;
    }
  }

  if (splitIdx <= startIdx) {
    splitIdx =
      startIdx + 1;
  }

  if (splitIdx >= endIdx) {
    splitIdx =
      endIdx - 1;
  }

  const leftBet =
    players
      .slice(startIdx, splitIdx)
      .reduce(
        (s, p) =>
          s + Math.max(p.bet, 1),
        0
      );

  const rightBet =
    players
      .slice(splitIdx, endIdx)
      .reduce(
        (s, p) =>
          s + Math.max(p.bet, 1),
        0
      );

  const splitRatio =
    leftBet /
    (leftBet + rightBet);

  if (w >= h) {
    const splitX =
      x +
      Math.max(
        0.25,
        Math.min(0.75, splitRatio)
      ) *
        w;

    partitionRect(
      players,
      x,
      y,
      splitX - x,
      h,
      startIdx,
      splitIdx
    );

    partitionRect(
      players,
      splitX,
      y,
      x + w - splitX,
      h,
      splitIdx,
      endIdx
    );
  } else {
    const splitY =
      y +
      Math.max(
        0.25,
        Math.min(0.75, splitRatio)
      ) *
        h;

    partitionRect(
      players,
      x,
      y,
      w,
      splitY - y,
      startIdx,
      splitIdx
    );

    partitionRect(
      players,
      x,
      splitY,
      w,
      y + h - splitY,
      splitIdx,
      endIdx
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// DLballs
// ═══════════════════════════════════════════════════════════════

const dlballsSessions = new Map();

const DLB_FIXED_VALUES = [
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
];

function dlbRandomValue() {
  const r =
    Math.pow(
      Math.random(),
      3.15
    );

  return Math.max(
    1,
    Math.min(
      1000,
      Math.floor(
        1 + r * 1000
      )
    )
  );
}

function dlbMultiplierOutcome() {
  const r = Math.random();

  if (r < 0.44) {
    return {
      outcome: 'lose',
      multiplier: 0,
      depth: false,
    };
  }

  if (r < 0.82) {
    return {
      outcome: 'win',
      multiplier: 1.5,
      depth: false,
    };
  }

  if (r < 0.96) {
    return {
      outcome: 'win',
      multiplier: 3,
      depth: false,
    };
  }

  return {
    outcome: 'win',
    multiplier: 6,
    depth: true,
  };
}

function dlbBallColor(value) {
  if (value <= 10) {
    return 'basic';
  }

  if (value <= 100) {
    return 'shiny';
  }

  if (value <= 500) {
    return 'green';
  }

  return 'gold';
}

function dlbPublicBalls(balls) {
  return balls.map(b => ({
    id: b.id,
    value: b.value,
    color: dlbBallColor(b.value),
  }));
}

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════

io.on('connection', socket => {
  console.log(
    'Socket connected:',
    socket.id
  );

  // ───────────────────────────────────────────────────────────
  // DLballs BUY
  // ───────────────────────────────────────────────────────────
  socket.on(
    'dlballsBuy',
    async (payload = {}, ack) => {
      try {
        const userId =
          String(
            payload.userId ||
            ''
          );

        if (!userId) {
          return ack?.({
            ok: false,
            error: 'Missing userId',
          });
        }

        const amount = Math.min(
          50,
          Math.max(
            1,
            parseInt(
              payload.amount,
              10
            ) || 1
          )
        );

        const mode =
          payload.mode === 'fixed'
            ? 'fixed'
            : 'random';

        let fixedValue =
          parseInt(
            payload.fixedValue,
            10
          );

        if (
          !DLB_FIXED_VALUES.includes(
            fixedValue
          )
        ) {
          fixedValue =
            DLB_FIXED_VALUES[0];
        }

        const stake =
          Number(
            payload.stake
          );

        let costPerBall;

        if (mode === 'fixed') {
          costPerBall =
            fixedValue;
        } else {
          costPerBall =
            Number.isFinite(stake) &&
            stake > 0
              ? stake
              : 1;
        }

        costPerBall =
          Math.floor(
            costPerBall
          );

        if (costPerBall < 1) {
          return ack?.({
            ok: false,
            error: 'Invalid cost',
          });
        }

        const totalCost =
          costPerBall * amount;

        const user =
          await getUser(userId);

        if (!user) {
          return ack?.({
            ok: false,
            error: 'User not found',
          });
        }

        if (user.banned) {
          return ack?.({
            ok: false,
            error: 'User is banned',
          });
        }

        if (
          Number(user.balance) <
          totalCost
        ) {
          return ack?.({
            ok: false,
            error: 'Not enough balance',
          });
        }

        user.balance =
          Number(user.balance) -
          totalCost;

        await saveUser(user);

        const balls = [];

        for (
          let i = 0;
          i < amount;
          i++
        ) {
          const value =
            mode === 'fixed'
              ? fixedValue
              : dlbRandomValue();

          balls.push({
            id:
              `${Date.now()}_${i}_${Math.random()
                .toString(36)
                .slice(2, 8)}`,
            value,
          });
        }

        dlballsSessions.set(
          userId,
          {
            userId,
            balls,
            state: 'ready',
            createdAt: Date.now(),
            cost: totalCost,
          }
        );

        return ack?.({
          ok: true,
          balance:
            user.balance,
          cost: totalCost,
          balls:
            dlbPublicBalls(balls),
        });
      } catch (err) {
        console.error(
          'DLballs buy error:',
          err
        );

        return ack?.({
          ok: false,
          error:
            err.message ||
            'Internal error',
        });
      }
    }
  );

  // ───────────────────────────────────────────────────────────
  // DLballs LAUNCH
  // ───────────────────────────────────────────────────────────
  socket.on(
    'dlballsLaunch',
    async (payload = {}, ack) => {
      try {
        const userId =
          String(
            payload.userId ||
            ''
          );

        if (!userId) {
          return ack?.({
            ok: false,
            error: 'Missing userId',
          });
        }

        const session =
          dlballsSessions.get(
            userId
          );

        if (!session) {
          return ack?.({
            ok: false,
            error:
              'No balls ready',
          });
        }

        if (
          session.state !== 'ready'
        ) {
          return ack?.({
            ok: false,
            error:
              'Round already running',
          });
        }

        const user =
          await getUser(userId);

        if (!user) {
          return ack?.({
            ok: false,
            error: 'User not found',
          });
        }

        if (user.banned) {
          return ack?.({
            ok: false,
            error: 'User is banned',
          });
        }

        session.state =
          'running';

        const results = [];

        let payout = 0;
        let wonBalls = 0;
        let lostBalls = 0;

        for (
          let i = 0;
          i < session.balls.length;
          i++
        ) {
          const ball =
            session.balls[i];

          const result =
            dlbMultiplierOutcome();

          const ballPayout =
            result.multiplier > 0
              ? Math.floor(
                  ball.value *
                    result.multiplier
                )
              : 0;

          if (
            ballPayout > 0
          ) {
            wonBalls++;
          } else {
            lostBalls++;
          }

          payout += ballPayout;

          results.push({
            id: ball.id,
            value: ball.value,
            outcome:
              result.outcome,
            multiplier:
              result.multiplier,
            depth:
              result.depth,
            payout:
              ballPayout,
          });
        }

        user.balance =
          Number(user.balance) +
          payout;

        await saveUser(user);

        session.state =
          'finished';

        const response = {
          ok: true,
          balance:
            user.balance,
          payout,
          wonBalls,
          lostBalls,
          results,
        };

        setTimeout(() => {
          const current =
            dlballsSessions.get(
              userId
            );

          if (
            current === session
          ) {
            dlballsSessions.delete(
              userId
            );
          }
        }, 10000);

        return ack?.(
          response
        );
      } catch (err) {
        console.error(
          'DLballs launch error:',
          err
        );

        return ack?.({
          ok: false,
          error:
            err.message ||
            'Internal error',
        });
      }
    }
  );

  // ───────────────────────────────────────────────────────────
  // YOUR EXISTING SOCKET EVENTS
  // ───────────────────────────────────────────────────────────

  socket.on('login', async data => {
    try {
      const initData =
        data?.initData || '';

      let tgUser =
        verifyInitData(
          initData
        );

      if (
        !tgUser &&
        ALLOW_DEV_LOGIN &&
        data?.user
      ) {
        tgUser =
          data.user;
      }

      if (!tgUser) {
        socket.emit(
          'loginError',
          {
            error:
              'Invalid Telegram authentication',
          }
        );

        return;
      }

      const userId =
        String(
          tgUser.id
        );

      let user =
        await getUser(
          userId
        );

      if (!user) {
        user = {
          id: userId,
          username:
            tgUser.username ||
            tgUser.first_name ||
            `user_${userId}`,
          name:
            tgUser.first_name ||
            tgUser.username ||
            'Player',
          pfp:
            tgUser.photo_url ||
            null,
          balance: 50,
          wins: 0,
          losses: 0,
          banned: false,
          winHistory: [],
        };

        await saveUser(user);
      } else {
        user.username =
          tgUser.username ||
          user.username;

        user.name =
          tgUser.first_name ||
          user.name;

        user.pfp =
          tgUser.photo_url ||
          user.pfp;

        await saveUser(user);
      }

      socket.userId =
        userId;

      socket.emit(
        'loginSuccess',
        {
          user,
        }
      );
    } catch (err) {
      console.error(
        'Login error:',
        err
      );

      socket.emit(
        'loginError',
        {
          error:
            err.message ||
            'Login failed',
        }
      );
    }
  });

  socket.on(
    'disconnect',
    () => {
      console.log(
        'Socket disconnected:',
        socket.id
      );
    }
  );
});

// ═══════════════════════════════════════════════════════════════
// EXISTING GAME / API CODE
// ═══════════════════════════════════════════════════════════════

/*
  IMPORTANT:

  Keep the rest of your original server.js code below this point.

  The DLballs code above is the new server-side functionality
  added to your existing server.

  Your existing:
  - PVP socket handlers
  - ICE socket handlers
  - admin endpoints
  - leaderboard endpoints
  - promo endpoints
  - anonymous profile endpoints
  - server.listen()

  remain in the original file.
*/

// ─── Admin authentication ──────────────────────────────────────
function adminAuth(req, res, next) {
  const secret =
    req.headers['x-admin-secret'] ||
    req.body?.secret ||
    req.query?.secret;

  if (
    !secret ||
    secret !== ADMIN_SECRET
  ) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
    });
  }

  next();
}

// ─── Admin API ─────────────────────────────────────────────────
app.get(
  '/admin/api/players',
  adminAuth,
  async (req, res) => {
    try {
      const users =
        await getAllUsers();

      res.json({
        players: users,
      });
    } catch (err) {
      console.error(
        'Admin players error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/reset-money',
  adminAuth,
  async (req, res) => {
    try {
      const users =
        await getAllUsers();

      for (const u of users) {
        u.balance = 50;

        await saveUser(u);
      }

      res.json({
        ok: true,
      });
    } catch (err) {
      console.error(
        'Reset money error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/reset-top',
  adminAuth,
  async (req, res) => {
    try {
      const users =
        await getAllUsers();

      for (const u of users) {
        u.wins = 0;
        u.losses = 0;

        await saveUser(u);
      }

      res.json({
        ok: true,
      });
    } catch (err) {
      console.error(
        'Reset top error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/wipe',
  adminAuth,
  async (req, res) => {
    try {
      const all =
        await getAllUsers();

      for (const u of all) {
        u.balance = 50;
        u.wins = 0;
        u.losses = 0;
        u.banned = false;
        u.winHistory = [];

        await saveUser(u);
      }

      res.json({
        ok: true,
      });
    } catch (err) {
      console.error(
        'Wipe error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/add-money',
  adminAuth,
  async (req, res) => {
    try {
      const {
        id,
        amount,
      } = req.body;

      if (
        !id ||
        !amount ||
        isNaN(amount)
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid',
        });
      }

      const user =
        await getUser(id);

      if (!user) {
        return res.status(404).json({
          ok: false,
          error: 'User not found',
        });
      }

      user.balance += amount;

      await saveUser(user);

      res.json({
        ok: true,
        balance:
          user.balance,
      });
    } catch (err) {
      console.error(
        'Add money error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/set-money',
  adminAuth,
  async (req, res) => {
    try {
      const {
        id,
        amount,
      } = req.body;

      if (
        !id ||
        isNaN(amount) ||
        amount < 0
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid',
        });
      }

      const user =
        await getUser(id);

      if (!user) {
        return res.status(404).json({
          ok: false,
          error: 'User not found',
        });
      }

      user.balance =
        amount;

      await saveUser(user);

      res.json({
        ok: true,
        balance:
          user.balance,
      });
    } catch (err) {
      console.error(
        'Set money error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/ban',
  adminAuth,
  async (req, res) => {
    try {
      const { id } =
        req.body;

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: 'Missing id',
        });
      }

      const user =
        await getUser(id);

      if (!user) {
        return res.status(404).json({
          ok: false,
          error: 'User not found',
        });
      }

      user.banned =
        !user.banned;

      await saveUser(user);

      res.json({
        ok: true,
        banned:
          user.banned,
      });
    } catch (err) {
      console.error(
        'Ban error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/reset-player',
  adminAuth,
  async (req, res) => {
    try {
      const { id } =
        req.body;

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: 'Missing id',
        });
      }

      const success =
        await resetPlayer(id);

      if (!success) {
        return res.status(404).json({
          ok: false,
          error: 'User not found',
        });
      }

      res.json({
        ok: true,
        message:
          'Player stats reset',
      });
    } catch (err) {
      console.error(
        'Reset player error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/create-promo',
  adminAuth,
  async (req, res) => {
    try {
      const {
        amount,
        code,
        maxUses,
      } = req.body;

      if (
        !amount ||
        isNaN(amount) ||
        amount < 1
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid amount',
        });
      }

      const promo =
        await createPromoCode(
          amount,
          code || null,
          maxUses || 1
        );

      res.json({
        ok: true,
        code:
          promo.code,
      });
    } catch (err) {
      console.error(
        'Create promo error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/delete-promo',
  adminAuth,
  async (req, res) => {
    try {
      const { code } =
        req.body;

      if (!code) {
        return res.status(400).json({
          ok: false,
          error: 'Missing code',
        });
      }

      await deletePromoCode(
        code
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      console.error(
        'Delete promo error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.get(
  '/admin/api/promo-codes',
  adminAuth,
  async (req, res) => {
    try {
      const codes =
        await getPromoCodes();

      res.json({
        codes,
      });
    } catch (err) {
      console.error(
        'Get promo codes error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/spawn-bot',
  adminAuth,
  async (req, res) => {
    try {
      const {
        bet,
        count,
      } = req.body;

      const betAmount =
        Math.max(
          10,
          parseInt(bet) || 100
        );

      const numBots =
        Math.min(
          8,
          Math.max(
            1,
            parseInt(count) || 1
          )
        );

      let spawned = 0;

      for (
        let i = 0;
        i < numBots;
        i++
      ) {
        const player =
          spawnBot(
            betAmount
          );

        if (player) {
          spawned++;
        }
      }

      if (spawned > 0) {
        repartitionIceArena();
      }

      broadcastIceState();

      res.json({
        ok: true,
        spawned,
      });
    } catch (err) {
      console.error(
        'Spawn bot error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.post(
  '/admin/api/remove-bots',
  adminAuth,
  async (req, res) => {
    try {
      const removed =
        removeAllBots();

      broadcastIceState();

      res.json({
        ok: true,
        removed,
      });
    } catch (err) {
      console.error(
        'Remove bots error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

// ─── Promo redemption ───────────────────────────────────────────
app.post(
  '/redeem',
  async (req, res) => {
    try {
      const {
        code,
        userId,
      } = req.body;

      if (
        !code ||
        !userId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Missing code or userId',
        });
      }

      const result =
        await redeemPromoCode(
          code,
          userId
        );

      res.json(result);
    } catch (err) {
      console.error(
        'Redeem promo error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.get(
  '/redeem',
  async (req, res) => {
    try {
      const {
        code,
        userId,
      } = req.query;

      if (
        !code ||
        !userId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Missing code or userId',
        });
      }

      const result =
        await redeemPromoCode(
          code,
          userId
        );

      res.json(result);
    } catch (err) {
      console.error(
        'Redeem promo (GET) error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

// ─── Anonymous endpoints ───────────────────────────────────────
app.post(
  '/api/change-anonymous',
  async (req, res) => {
    try {
      const {
        userId,
        field,
        value,
      } = req.body;

      if (
        !userId ||
        !field ||
        value === undefined
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Missing parameters',
        });
      }

      const validFields = [
        'name',
        'username',
        'phone',
      ];

      if (
        !validFields.includes(
          field
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid field',
        });
      }

      if (
        field === 'username' &&
        !/^[a-zA-Z0-9_]{3,16}$/.test(
          value
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid username format',
        });
      }

      if (
        field === 'phone' &&
        !/^\+?[0-9\s\-]{7,15}$/.test(
          value
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid phone format',
        });
      }

      if (
        field === 'name' &&
        !/^[a-zA-Z\s]{1,30}$/.test(
          value
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid name format',
        });
      }

      const result =
        await changeAnonymousField(
          userId,
          field,
          value
        );

      const pvpPlayer =
        getPlayer(
          userId
        );

      if (pvpPlayer) {
        const user =
          await getUser(
            userId
          );

        if (
          user.anonymousEnabled
        ) {
          pvpPlayer.name =
            user.anonymousName;

          pvpPlayer.pfp =
            null;
        } else {
          pvpPlayer.name =
            user.username;

          pvpPlayer.pfp =
            user.pfp;
        }

        broadcastState();
      }

      const iceP =
        getIcePlayer(
          userId
        );

      if (iceP) {
        const user =
          await getUser(
            userId
          );

        if (
          user.anonymousEnabled
        ) {
          iceP.name =
            user.anonymousName;

          iceP.pfp =
            null;
        } else {
          iceP.name =
            user.username;

          iceP.pfp =
            user.pfp;
        }

        broadcastIceState();
      }

      res.json({
        ok: true,
        newBalance:
          result.newBalance,
        fee:
          result.fee,
      });
    } catch (err) {
      console.error(
        'Change anonymous field error:',
        err
      );

      res.status(500).json({
        ok: false,
        error:
          err.message ||
          'Internal error',
      });
    }
  }
);

app.post(
  '/api/toggle-hide-pfp',
  async (req, res) => {
    try {
      const {
        userId,
        hide,
      } = req.body;

      if (!userId) {
        return res.status(400).json({
          ok: false,
          error:
            'Missing userId',
        });
      }

      const newHide =
        await toggleHidePfp(
          userId,
          hide
        );

      const pvpPlayer =
        getPlayer(
          userId
        );

      if (pvpPlayer) {
        pvpPlayer.pfp =
          newHide
            ? null
            : (
                await getUser(
                  userId
                )
              ).pfp;

        broadcastState();
      }

      const iceP =
        getIcePlayer(
          userId
        );

      if (iceP) {
        iceP.pfp =
          newHide
            ? null
            : (
                await getUser(
                  userId
                )
              ).pfp;

        broadcastIceState();
      }

      res.json({
        ok: true,
        hidePfp:
          newHide,
      });
    } catch (err) {
      console.error(
        'Toggle hide PFP error:',
        err
      );

      res.status(500).json({
        ok: false,
        error:
          err.message ||
          'Internal error',
      });
    }
  }
);

app.get(
  '/leaderboard',
  async (req, res) => {
    try {
      const tops =
        await topPlayers(20);

      res.json({
        top: tops,
      });
    } catch (err) {
      console.error(
        'Leaderboard error:',
        err
      );

      res.status(500).json({
        ok: false,
        error: 'Internal error',
      });
    }
  }
);

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      players:
        room.players.length,
      gameState:
        room.gameState,
    });
  }
);

server.listen(
  PORT,
  () => {
    console.log(
      `bump arena server listening on :${PORT}`
    );

    if (!BOT_TOKEN) {
      console.warn(
        '⚠ TELEGRAM_BOT_TOKEN not set — real Telegram login cannot be verified.'
      );
    }

    if (
      ADMIN_SECRET ===
      'change-me-in-production'
    ) {
      console.warn(
        '⚠ Change ADMIN_SECRET environment variable!'
      );
    }
  }
);
