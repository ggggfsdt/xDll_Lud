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
  setTimeout(flush, 250);
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
      banned: false,
    };
    queueSave();
  } else {
    if (defaults.username) data.users[id].username = defaults.username;
    if (defaults.pfp) data.users[id].pfp = defaults.pfp;
    if (data.users[id].banned === undefined) data.users[id].banned = false;
  }
  return data.users[id];
}

async function saveUser(user) {
  data.users[user.id] = user;
  queueSave();
}

async function getAllUsers() {
  return Object.values(data.users);
}

async function topPlayers(limit = 20) {
  return Object.values(data.users)
    .filter(u => !u.banned)
    .sort((a, b) => (b.wins - a.wins) || (b.balance - a.balance))
    .slice(0, limit)
    .map(u => ({ id: u.id, username: u.username, pfp: u.pfp, wins: u.wins, losses: u.losses, balance: u.balance }));
}

async function allUsersCount() {
  return Object.keys(data.users).length;
}

module.exports = { getUser, saveUser, getAllUsers, topPlayers, allUsersCount };
