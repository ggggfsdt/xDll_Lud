const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');
const STARTING_BALANCE = parseInt(process.env.STARTING_BALANCE) || 50;

let data = { users: {}, promoCodes: [] };
let saveQueued = false;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!data.promoCodes) data.promoCodes = [];
    data.promoCodes.forEach(p => {
      if (!p.redeemedBy) p.redeemedBy = [];
    });
  } catch (e) {
    data = { users: {}, promoCodes: [] };
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

// ─── Generate random anonymous values ──────────────────────────
function generateRandomAnonymousName() {
  const first = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'];
  const second = ['Wolf', 'Fox', 'Hawk', 'Eagle', 'Lion', 'Tiger', 'Bear', 'Shark', 'Dragon', 'Phoenix', 'Raven', 'Falcon', 'Owl', 'Snake', 'Panther', 'Leopard', 'Cheetah', 'Hound', 'Viper', 'Cobra'];
  return first[Math.floor(Math.random() * first.length)] + ' ' + second[Math.floor(Math.random() * second.length)];
}

function generateRandomAnonymousUsername() {
  const adjectives = ['Swift', 'Silent', 'Shadow', 'Crimson', 'Phantom', 'Noble', 'Frost', 'Storm', 'Blaze', 'Ivy', 'Echo', 'Raven', 'Lunar', 'Solar', 'Apex'];
  const nouns = ['Wolf', 'Fox', 'Hawk', 'Lion', 'Tiger', 'Bear', 'Shark', 'Dragon', 'Phoenix', 'Raven', 'Falcon', 'Owl', 'Snake'];
  const num = Math.floor(Math.random() * 1000);
  return adjectives[Math.floor(Math.random() * adjectives.length)] + nouns[Math.floor(Math.random() * nouns.length)] + num;
}

function generateRandomAnonymousPhone() {
  const country = ['+1', '+44', '+49', '+33', '+91', '+61', '+81', '+86', '+7', '+39', '+34', '+31', '+46'];
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(String(Math.floor(Math.random() * 900) + 100));
  }
  return country[Math.floor(Math.random() * country.length)] + ' ' + parts.join(' ');
}

// ─── Ensure user has anonymous fields ──────────────────────────
function ensureAnonymousFields(user) {
  if (user.anonymousEnabled === undefined) user.anonymousEnabled = false;
  if (!user.anonymousName) user.anonymousName = user.username || generateRandomAnonymousName();
  if (!user.anonymousUsername) user.anonymousUsername = generateRandomAnonymousUsername();
  if (!user.anonymousPhone) user.anonymousPhone = generateRandomAnonymousPhone();
  return user;
}

// ─── Get user ──────────────────────────────────────────────────
async function getUser(id, defaults = {}) {
  if (!data.users[id]) {
    const username = defaults.username || 'player';
    const pfp = defaults.pfp || '';
    data.users[id] = {
      id,
      username,
      pfp,
      balance: STARTING_BALANCE,
      wins: 0,
      losses: 0,
      banned: false,
      winHistory: [],
      anonymousEnabled: false,
      anonymousName: generateRandomAnonymousName(),
      anonymousUsername: generateRandomAnonymousUsername(),
      anonymousPhone: generateRandomAnonymousPhone(),
    };
    queueSave();
  } else {
    if (defaults.username) data.users[id].username = defaults.username;
    if (defaults.pfp) data.users[id].pfp = defaults.pfp;
    if (data.users[id].banned === undefined) data.users[id].banned = false;
    if (!Array.isArray(data.users[id].winHistory)) data.users[id].winHistory = [];
    ensureAnonymousFields(data.users[id]);
  }
  return data.users[id];
}

// ─── Set anonymous data ────────────────────────────────────────
async function setAnonymousData(userId, data) {
  const user = await getUser(userId);
  if (data.enabled !== undefined) user.anonymousEnabled = data.enabled;
  if (data.name !== undefined) user.anonymousName = data.name;
  if (data.username !== undefined) user.anonymousUsername = data.username;
  if (data.phone !== undefined) user.anonymousPhone = data.phone;
  queueSave();
  return {
    anonymousEnabled: user.anonymousEnabled,
    anonymousName: user.anonymousName,
    anonymousUsername: user.anonymousUsername,
    anonymousPhone: user.anonymousPhone,
  };
}

// ─── Check uniqueness of anonymous field ──────────────────────
async function checkAnonymousUnique(field, value, excludeUserId) {
  // field can be 'username' or 'phone'
  const allUsers = Object.values(data.users);
  for (const u of allUsers) {
    if (u.id === excludeUserId) continue;
    if (field === 'username' && u.anonymousUsername === value) return false;
    if (field === 'phone' && u.anonymousPhone === value) return false;
  }
  return true;
}

// ─── Add win to history ────────────────────────────────────────
async function addWinToHistory(id, name, pfp, amount) {
  const user = await getUser(id);
  if (!Array.isArray(user.winHistory)) user.winHistory = [];
  user.winHistory.unshift({ name, pfp, amount, timestamp: Date.now() });
  if (user.winHistory.length > 20) user.winHistory.length = 20;
  queueSave();
  return user.winHistory;
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

// ─── Reset player (admin) ──────────────────────────────────────
async function resetPlayer(userId) {
  const user = data.users[userId];
  if (!user) return false;
  user.balance = STARTING_BALANCE;
  user.wins = 0;
  user.losses = 0;
  user.winHistory = [];
  user.anonymousEnabled = false;
  user.anonymousName = generateRandomAnonymousName();
  user.anonymousUsername = generateRandomAnonymousUsername();
  user.anonymousPhone = generateRandomAnonymousPhone();
  queueSave();
  return true;
}

// ─── Promo codes ──────────────────────────────────────────────
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
    redeemedBy: [],
    createdAt: Date.now(),
  };
  data.promoCodes.push(promo);
  queueSave();
  return promo;
}

async function redeemPromoCode(code, userId) {
  const promo = data.promoCodes.find(p => p.code === code);
  if (!promo) return { ok: false, error: 'Invalid code' };
  if (promo.usedCount >= promo.maxUses) return { ok: false, error: 'Code already fully used' };
  if (promo.redeemedBy && promo.redeemedBy.includes(userId)) {
    return { ok: false, error: 'You have already redeemed this code' };
  }
  const user = await getUser(userId);
  if (!user) return { ok: false, error: 'User not found' };
  user.balance += promo.amount;
  await saveUser(user);
  promo.usedCount += 1;
  if (!promo.redeemedBy) promo.redeemedBy = [];
  promo.redeemedBy.push(userId);
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
  resetPlayer,
  setAnonymousData,
  checkAnonymousUnique,
};
