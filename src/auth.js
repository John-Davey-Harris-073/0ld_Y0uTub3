const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

// Защита от простых паролей и мусорных ников
function validateUsername(username) {
  return /^[A-Za-z0-9_]{3,20}$/.test(username);
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 6;
}

module.exports = { hashPassword, verifyPassword, validateUsername, validatePassword };