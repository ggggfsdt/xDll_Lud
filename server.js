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
} = require('./store');

const PORT =
  process.env.PORT || 3000;

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || '';

const ALLOW_DEV_LOGIN =
  process.env.ALLOW_DEV_LOGIN === 'true';

const ADMIN_SECRET =
  process.env.ADMIN_SECRET ||
  'change-me-in-production';

// ─── express + socket.io ──────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server =
  http.createServer(app);

const io =
  new Server(server, {
    cors: {
      origin: '*'
    },
    transports: [
      'websocket',
      'polling'
    ],
  });

// ─── Telegram auth ─────────────────────────────────────────────
function verifyInitData(initData) {
  if (!BOT_TOKEN) return null;

  try {
    const params =
      new URLSearchParams(
        initData
      );

    const hash =
      params.get('hash');

    params.delete('hash');

    const dataCheckArr = [];

    for (
      const [key, value]
      of [...params.entries()]
        .sort(
          (a, b) =>
            a[0].localeCompare(
              b[0]
            )
        )
    ) {
      dataCheckArr.push(
        `${key}=${value}`
      );
    }

    const dataCheckString =
      dataCheckArr.join('\n');

    const secretKey =
      crypto
        .createHmac(
          'sha256',
          'WebAppData'
        )
        .update(BOT_TOKEN)
        .digest();

    const computedHash =
      crypto
        .createHmac(
          'sha256',
          secretKey
        )
        .update(
          dataCheckString
        )
        .digest('hex');

    if (
      computedHash !== hash
    ) {
      return null;
    }

    const authDate =
      parseInt(
        params.get(
          'auth_date'
        ) || '0',
        10
      );

    if (
      Date.now() / 1000 -
        authDate >
      86400
    ) {
      return null;
    }

    const userJson =
      params.get('user');

    if (!userJson) {
      return null;
    }

    return JSON.parse(
      userJson
    );

  } catch (e) {
    console.error(
      'Auth error:',
      e
    );

    return null;
  }
}

// ─── Arena geometry ─────────────────────────────────────────────
const ARENA_SIZE = 400;
const CORNER_RADIUS =
  ARENA_SIZE * 0.15;

function generatePerimeter(
  size,
  cornerRadius,
  numPoints = 300
) {
  const half =
    size / 2;

  const r =
    Math.min(
      cornerRadius,
      half
    );

  const sections = [
    {
      type: 'line',
      x1: -half + r,
      y1: -half,
      x2: half - r,
      y2: -half
    },
    {
      type: 'arc',
      cx: half - r,
      cy: -half + r,
      start: -Math.PI / 2,
      end: 0
    },
    {
      type: 'line',
      x1: half,
      y1: -half + r,
      x2: half,
      y2: half - r
    },
    {
      type: 'arc',
      cx: half - r,
      cy: half - r,
      start: 0,
      end: Math.PI / 2
    },
    {
      type: 'line',
      x1: half - r,
      y1: half,
      x2: -half + r,
      y2: half
    },
    {
      type: 'arc',
      cx: -half + r,
      cy: half - r,
      start: Math.PI / 2,
      end: Math.PI
    },
    {
      type: 'line',
      x1: -half,
      y1: half - r,
      x2: -half,
      y2: -half + r
    },
    {
      type: 'arc',
      cx: -half + r,
      cy: -half + r,
      start: Math.PI,
      end: 3 * Math.PI / 2
    }
  ];

  const segLengths =
    sections.map(seg =>
      seg.type === 'line'
        ? Math.hypot(
            seg.x2 - seg.x1,
            seg.y2 - seg.y1
          )
        : r *
          (
            seg.end -
            seg.start
          )
    );

  const totalLen =
    segLengths.reduce(
      (a, b) => a + b,
      0
    );

  const step =
    totalLen / numPoints;

  const points = [];

  let accumulated = 0;
  let segIdx = 0;

  for (
    let i = 0;
    i < numPoints;
    i++
  ) {
    const target =
      i * step;

    while (
      accumulated +
        segLengths[
          segIdx
        ] <
      target
    ) {
      accumulated +=
        segLengths[
          segIdx
        ];

      segIdx =
        (
          segIdx + 1
        ) %
        sections.length;
    }

    const localT =
      (
        target -
        accumulated
      ) /
      segLengths[
        segIdx
      ];

    const seg =
      sections[segIdx];

    let px;
    let py;

    if (
      seg.type === 'line'
    ) {
      px =
        seg.x1 +
        localT *
          (
            seg.x2 -
            seg.x1
          );

      py =
        seg.y1 +
        localT *
          (
            seg.y2 -
            seg.y1
          );

    } else {
      const angle =
        seg.start +
        localT *
          (
            seg.end -
            seg.start
          );

      px =
        seg.cx +
        r *
          Math.cos(
            angle
          );

      py =
        seg.cy +
        r *
          Math.sin(
            angle
          );
    }

    points.push({
      x: px + half,
      y: py + half
    });
  }

  return points;
}

const PERIMETER =
  generatePerimeter(
    ARENA_SIZE,
    CORNER_RADIUS,
    300
  );

function speedForRadius(
  radius
) {
  const minR = 14;
  const maxR = 52;

  const norm =
    Math.min(
      1,
      Math.max(
        0,
        (
          radius - minR
        ) /
        (
          maxR - minR
        )
      )
    );

  const speed =
    8.0 -
    norm * 5.5;

  return Math.max(
    2.5,
    Math.min(
      8.0,
      speed
    )
  );
}

// ─── Room ──────────────────────────────────────────────────────
const COLORS = [
  '#5b8def',
  '#50c890',
  '#e06060',
  '#d4af37',
  '#c084e0',
  '#f0a070',
  '#60c0d0',
  '#e8a0a0'
];

const MAX_PLAYERS = 8;

function createRoom(id) {
  return {
    id,

    gameState:
      'idle',

    players: [],

    pot: 0,

    opening: null,

    openingTimer: 0,

    gameTime: 0,

    countdownStartTime:
      0,

    prestartTimer:
      0,

    recentWinners: [],
  };
}

const room =
  createRoom('main');

function getAlive() {
  return room.players.filter(
    p => p.alive
  );
}

function getPlayer(id) {
  return room.players.find(
    p => p.id === id
  );
}

function computeRadii() {
  const totalBet =
    room.players.reduce(
      (s, p) =>
        s + p.bet,
      0
    );

  if (
    totalBet === 0
  ) {
    return;
  }

  room.players.forEach(
    p => {
      const ratio =
        p.bet /
        totalBet;

      const r =
        18 +
        ratio * 34;

      p.targetRadius =
        Math.min(
          Math.max(
            r,
            14
          ),
          52
        );

      p.mass =
        p.targetRadius *
        p.targetRadius *
        1.2;

      p.displayRadius =
        p.targetRadius;
    }
  );
}

function makePlayer(
  id,
  bet,
  name,
  pfp
) {
  const half =
    ARENA_SIZE / 2;

  const radius =
    18;

  let x;
  let y;

  let attempts = 0;
  let overlap = true;

  while (
    overlap &&
    attempts < 100
  ) {
    x =
      half +
      (
        Math.random() -
        0.5
      ) *
      (
        ARENA_SIZE *
        0.6
      );

    y =
      half +
      (
        Math.random() -
        0.5
      ) *
      (
        ARENA_SIZE *
        0.6
      );

    overlap =
      room.players.some(
        p =>
          Math.hypot(
            p.x - x,
            p.y - y
          ) <
          p.radius +
          radius +
          5
      );

    attempts++;
  }

  const colorIdx =
    room.players.length %
    COLORS.length;

  const p = {
    id,
    bet,

    name:
      name ||
      'player',

    pfp:
      pfp ||
      '',

    color:
      COLORS[
        colorIdx
      ],

    radius,

    displayRadius:
      radius,

    targetRadius:
      radius,

    mass:
      radius *
      radius *
      1.2,

    x:
      x ?? half,

    y:
      y ?? half,

    vx: 0,
    vy: 0,

    alive: true,
  };

  room.players.push(
    p
  );

  computeRadii();

  return p;
}

function startCountdown() {
  if (
    room.gameState !==
    'idle'
  ) {
    return;
  }

  if (
    getAlive().length <
    2
  ) {
    return;
  }

  room.gameState =
    'countdown';

  room.countdownStartTime =
    Date.now();

  room.countdownEndTime =
    Date.now() +
    10000;
}

function startPrestart() {
  room.gameState =
    'prestart';

  room.prestartTimer =
    2.0;
}

function startGame() {
  room.gameState =
    'playing';

  room.gameTime =
    0;

  room.openingTimer =
    0;

  room.opening =
    null;

  const alive =
    getAlive();

  const half =
    ARENA_SIZE / 2;

  alive.forEach(
    (p, i) => {
      const angle =
        (
          i /
          alive.length
        ) *
        Math.PI *
        2 +
        Math.random() *
        0.3;

      const baseSpeed =
        speedForRadius(
          p.displayRadius ||
          p.radius
        );

      const speed =
        baseSpeed *
        (
          0.9 +
          Math.random() *
          0.2
        );

      p.vx =
        Math.cos(
          angle
        ) *
        speed;

      p.vy =
        Math.sin(
          angle
        ) *
        speed;

      p.x =
        half +
        Math.cos(
          angle
        ) *
        (
          ARENA_SIZE *
          0.15 +
          Math.random() *
          15
        );

      p.y =
        half +
        Math.sin(
          angle
        ) *
        (
          ARENA_SIZE *
          0.15 +
          Math.random() *
          15
        );

      p.alive = true;
    }
  );

  room.openingTimer =
    3.0 +
    Math.random() *
    3.5;
}

async function endGame(
  winnerId
) {
  if (
    room.gameState ===
    'finished'
  ) {
    return;
  }

  room.gameState =
    'finished';

  const winner =
    getPlayer(
      winnerId
    );

  let payload =
    null;

  if (winner) {
    const totalPot =
      room.pot;

    const winnerBet =
      winner.bet;

    const losersBets =
      totalPot -
      winnerBet;

    const commission =
      Math.floor(
        losersBets *
        0.02
      );

    const winnings =
      totalPot -
      commission;

    payload = {
      winnerId:
        winner.id,

      winnerName:
        winner.name,

      winnerPfp:
        winner.pfp,

      winnings,

      multiplier:
        +(
          winnings /
          winnerBet
        ).toFixed(2),
    };

    room.recentWinners.unshift({
      name:
        winner.name,

      pfp:
        winner.pfp
    });

    if (
      room.recentWinners
        .length > 8
    ) {
      room.recentWinners
        .length = 8;
    }

    try {
      const winnerUser =
        await getUser(
          winner.id
        );

      if (winnerUser) {
        winnerUser.balance +=
          winnings;

        winnerUser.wins +=
          1;

        await saveUser(
          winnerUser
        );
      }

    } catch (err) {
      console.error(
        'endGame: failed to credit winner balance:',
        err
      );
    }

    for (
      const p of room.players
    ) {
      if (
        p.id ===
        winner.id
      ) {
        continue;
      }

      try {
        const u =
          await getUser(
            p.id
          );

        if (u) {
          u.losses +=
            1;

          await saveUser(
            u
          );
        }

      } catch (err) {
        console.error(
          'endGame: failed to update loser stats for',
          p.id,
          err
        );
      }
    }

    try {
      await addWinToHistory(
        winner.id,
        winner.name,
        winner.pfp,
        winnings
      );
    } catch (err) {
      console.error(
        'endGame: failed to write win history:',
        err
      );
    }
  }

  io.to(room.id)
    .emit(
      'roundEnd',
      payload
    );

  setTimeout(
    () => {
      room.players =
        [];

      room.pot =
        0;

      room.opening =
        null;

      room.gameState =
        'idle';
    },
    3000
  );
}

function isInGap(idx) {
  const opening =
    room.opening;

  if (
    !opening ||
    opening.state !==
      'open'
  ) {
    return false;
  }

  const {
    startIdx,
    endIdx
  } = opening;

  return startIdx < endIdx
    ? (
        idx >= startIdx &&
        idx <= endIdx
      )
    : (
        idx >= startIdx ||
        idx <= endIdx
      );
}
