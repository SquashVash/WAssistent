import { readFileSync, writeFileSync, existsSync } from 'fs';

const USERS_FILE = './users.json';

export const PERMISSION_TAGS = [
  'brief', 'email', 'flights', 'scan', 'reminders', 'osint', 'dms', 'support',
  'status', 'settings', 'misc', 'server', 'users', 'chat', 'help',
];

export const ROLE_BUNDLES = {
  owner: [...PERMISSION_TAGS],
  admin: PERMISSION_TAGS.filter(t => t !== 'users'),
  user: ['brief', 'email', 'flights', 'reminders', 'misc', 'help', 'chat', 'status'],
};

let users = load();

function load() {
  let data = { users: [] };
  if (existsSync(USERS_FILE)) {
    try { data = JSON.parse(readFileSync(USERS_FILE, 'utf-8')); } catch {}
  }
  if (!Array.isArray(data.users)) data.users = [];

  const ownerChatId = process.env.MY_CHAT_ID;
  if (ownerChatId && !data.users.some(u => u.role === 'owner')) {
    data.users.push({
      name: 'Owner',
      phone: ownerChatId.replace(/@.*$/, ''),
      whatsappId: ownerChatId,
      role: 'owner',
      permissions: [],
    });
    writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
  }

  return data;
}

function save() {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export function getUsers() {
  return users.users;
}

export function getUserByChatId(chatId) {
  return users.users.find(u => u.whatsappId === chatId) || null;
}

function findByPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  return users.users.find(u => u.phone === digits);
}

export function addUser({ name, phone, role = 'user' }) {
  const digits = phone.replace(/\D/g, '');
  if (findByPhone(digits)) return null;
  const user = { name, phone: digits, whatsappId: `${digits}@c.us`, role, permissions: [] };
  users.users.push(user);
  save();
  return user;
}

export function removeUser(phone) {
  const digits = phone.replace(/\D/g, '');
  const before = users.users.length;
  users.users = users.users.filter(u => u.phone !== digits);
  if (users.users.length !== before) { save(); return true; }
  return false;
}

export function setUserRole(phone, role) {
  const user = findByPhone(phone);
  if (!user || !ROLE_BUNDLES[role]) return false;
  user.role = role;
  save();
  return true;
}

export function grantPermission(phone, tag) {
  const user = findByPhone(phone);
  if (!user || !PERMISSION_TAGS.includes(tag)) return false;
  if (!user.permissions.includes(tag)) {
    user.permissions.push(tag);
    save();
  }
  return true;
}

export function revokePermission(phone, tag) {
  const user = findByPhone(phone);
  if (!user) return false;
  user.permissions = user.permissions.filter(p => p !== tag);
  save();
  return true;
}

export function hasPermission(user, tag) {
  if (!user) return false;
  const bundle = ROLE_BUNDLES[user.role] || [];
  return bundle.includes(tag) || (user.permissions || []).includes(tag);
}
