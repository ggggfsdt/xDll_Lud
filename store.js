const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');
const STARTING_BALANCE = parseInt(process.env.STARTING_BALANCE) || 50;
const MAX_HISTORY = 20;

let data = { users: {}, promoCodes: [] };
let saveQueued = false;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!data.promoCodes) data.promoCodes = [];
  } catch (e) {
    console.warn('No existing data file, starting fresh.');
    data = { users: {}, promoCodes: [] };
  }
}
load();

function flush() {
  saveQueued = false;
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to write data file:', e);
  }
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
      winHistory: [],
    };
    queueSave();
  } else {
    if (defaults.username) data.users[id].username = defaults.username;
    if (defaults.pfp) data.users[id].pfp = defaults.pfp;
    if (data.users[id].banned === undefined) data.users[id].banned = false;
    if (!data.users[id].winHistory) data.users[id].winHistory = [];
  }
  return data.users[id];
}

async function saveUser(user) {
  data.users[user.id] = user;
  queueSave();
}

async function addWinToHistory(userId, winnerName, winnerPfp, winnings) {
  const user = await getUser(userId);
  if (!user) return;
  user.winHistory.unshift({
    winnerName,
    winnerPfp,
    winnings,
    timestamp: Date.now(),
  });
  if (user.winHistory.length > MAX_HISTORY) user.winHistory.pop();
  await saveUser(user);
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

function generateRandomCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function createPromoCode(amount, code = null, maxUses = 1) {
  const finalCode = code || generateRandomCode();
  const promo = {
    code: finalCode,
    amount: parseInt(amount),
    maxUses: parseInt(maxUses),
    usedCount: 0,
    createdAt: Date.now(),
  };
  data.promoCodes.push(promo);
  queueSave();
  return promo;
}

async function redeemPromoCode(code, userId) {
  const promo = data.promoCodes.find(p => p.code === code);
  if (!promo) return { ok: false, error: 'Invalid code' };
  if (promo.usedCount >= promo.maxUses) return { ok: false, error: 'Code already used' };
  const user = await getUser(userId);
  if (!user) return { ok: false, error: 'User not found' };
  user.balance += promo.amount;
  await saveUser(user);
  promo.usedCount += 1;
  queueSave();
  return { ok: true, amount: promo.amount, newBalance: user.balance };
}

async function getPromoCodes() {
  return data.promoCodes;
}

async function deletePromoCode(code) {
  data.promoCodes = data.promoCodes.filter(p => p.code !== code);
  queueSave();
}

module.exports = {
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
};
