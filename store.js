// ═══════════════════════════════════════════════════════════════
// Persistence — a plain JSON file on disk. This is intentionally
// simple so the whole project runs with zero external database to
// set up. It's fine for an MVP / small player base.
//
// IMPORTANT: Railway/Render/Fly's free/managed tiers usually give
// the container an EPHEMERAL filesystem — data can be wiped on
// redeploy or restart unless you attach a persistent volume. For
// anything beyond testing, swap this file for a real database
// (Railway's managed Postgres is one click away and works nicely
// with something like Prisma or plain `pg`). Everything else in
// server.js only talks to the functions exported here, so swapping
// the storage layer later won't touch your game logic.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');
const STARTING_BALANCE = 1000;

let data = { users: {} };
let saveQueued = false;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    data = { users: {} };
  }
}
load();

function flush() {
  saveQueued = false;
  fs.writeFile(DB_PATH, JSON.stringify(data), () => {});
}

function queueSave() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(flush, 250); // debounce so a betting flurry doesn't hammer disk I/O
}

async function getUser(id, defaults = {}) {
  if (!data.users[id]) {
    data.users[id] = {
      id,
      username: defaults.username || 'player',
      pfp: defaults.pfp || '',
      balance: STARTING_BALANCE,
      wins: 0,
      losses: 0,
    };
    queueSave();
  } else if (defaults.username || defaults.pfp) {
    // keep username/avatar fresh in case they changed it on Telegram
    if (defaults.username) data.users[id].username = defaults.username;
    if (defaults.pfp) data.users[id].pfp = defaults.pfp;
  }
  return data.users[id];
}

async function saveUser(user) {
  data.users[user.id] = user;
  queueSave();
}

async function topPlayers(limit = 20) {
  return Object.values(data.users)
    .sort((a, b) => (b.wins - a.wins) || (b.balance - a.balance))
    .slice(0, limit)
    .map(u => ({ id: u.id, username: u.username, pfp: u.pfp, wins: u.wins, losses: u.losses, balance: u.balance }));
}

async function allUsersCount() {
  return Object.keys(data.users).length;
}

module.exports = { getUser, saveUser, topPlayers, allUsersCount };
