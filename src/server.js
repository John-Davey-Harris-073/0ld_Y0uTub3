require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('cookie-session');
const multer = require('multer');

const db = require('./db');
const { hashPassword, verifyPassword, validateUsername, validatePassword } = require('./auth');
const { generateThumbnail } = require('./thumb');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

const PORT = process.env.PORT || 3000;
const MAX_MB = parseInt(process.env.MAX_FILE_MB || '100', 10);
const CATEGORIES = ['Music', 'Comedy', 'Film', 'Education', 'Gaming', 'Sports', 'News', 'Entertainment', 'Howto & Style', 'Science & Technology'];

app.use(session({
  name: 'yt',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
}));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Хелперы форматирования (как было в старом YouTube) ----------
function fmtViews(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtRel(ts) {
  const diff = Math.max(0, Date.now() - Number(ts));
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} week${w === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

function fmtDate(ts) {
  return new Date(Number(ts)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.fmtViews = fmtViews;
  res.locals.fmtRel = fmtRel;
  res.locals.fmtDate = fmtDate;
  res.locals.categories = CATEGORIES;
  if (req.session.userId) {
    const u = db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (u) res.locals.user = u;
    else req.session = null;
  }
  next();
});

// ---------- Middleware ----------
function requireLogin(req, res, next) {
  if (!res.locals.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

function safeNext(nextUrl) {
  return nextUrl && nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/';
}

// ---------- Главная ----------
app.get('/', (req, res) => {
  const recent = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     ORDER BY v.created_at DESC LIMIT 24`
  );
  const popular = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     ORDER BY v.views DESC, v.created_at DESC LIMIT 10`
  );
  res.render('home', { pageTitle: 'YouTube', recent, popular, showGuide: true });
});

// ---------- Все видео ----------
app.get('/videos', (req, res) => {
  const sort = ['date', 'views', 'channel'].includes(req.query.sort) ? req.query.sort : 'date';
  const orderBy =
    sort === 'views' ? 'v.views DESC, v.created_at DESC'
    : sort === 'channel' ? 'u.username ASC, v.created_at DESC'
    : 'v.created_at DESC';
  const perPage = 15;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = db.get('SELECT COUNT(*) AS c FROM videos').c;
  const videos = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [perPage, (page - 1) * perPage]
  );
  const pages = Math.max(1, Math.ceil(total / perPage));
  res.render('allvideos', { pageTitle: 'Videos', videos, sort, page, pages, total, showGuide: true });
});

// ---------- Каналы ----------
app.get('/channels', (req, res) => {
  const channels = db.all(
    `SELECT u.id, u.username, u.joined_at, u.description,
       (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id) AS video_count,
       (SELECT COUNT(*) FROM subscriptions s WHERE s.channel_id = u.id) AS sub_count
     FROM users u ORDER BY sub_count DESC, u.username`
  );
  res.render('channels', { pageTitle: 'Channels', channels, showGuide: true });
});

// ---------- Подписки ----------
app.get('/subscriptions', requireLogin, (req, res) => {
  const videos = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     WHERE v.user_id IN (SELECT channel_id FROM subscriptions WHERE subscriber_id = ?)
     ORDER BY v.created_at DESC LIMIT 30`,
    [res.locals.user.id]
  );
  res.render('subscriptions', { pageTitle: 'Subscriptions', videos, showGuide: true });
});

// ---------- Поиск ----------
app.get('/results', (req, res) => {
  const q = String(req.query.search_query || '').trim();
  if (!q) return res.redirect('/');
  const like = `%${q}%`;
  const results = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     WHERE v.title LIKE ? OR v.description LIKE ? OR v.tags LIKE ?
     ORDER BY v.views DESC, v.created_at DESC LIMIT 30`,
    [like, like, like]
  );
  res.render('search', { pageTitle: `Search: ${q}`, query: q, results, showGuide: true });
});

// ---------- Просмотр видео ----------
app.get('/watch/:id', (req, res) => {
  const video = db.get(
    'SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?',
    [req.params.id]
  );
  if (!video) return res.status(404).render('error', { pageTitle: 'Error', message: 'Video not found.' });

  db.run('UPDATE videos SET views = views + 1 WHERE id = ?', [video.id]);

  const related = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     WHERE v.category = ? AND v.id != ? ORDER BY v.views DESC LIMIT 8`,
    [video.category, video.id]
  );
  const moreFrom = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     WHERE v.user_id = ? AND v.id != ? ORDER BY v.created_at DESC LIMIT 3`,
    [video.user_id, video.id]
  );
  const comments = db.all(
    `SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.video_id = ? ORDER BY c.created_at DESC LIMIT 100`,
    [video.id]
  );
  const commentCount = db.get('SELECT COUNT(*) AS c FROM comments WHERE video_id = ?', [video.id]).c;
  const likeCounts = { 1: 0, '-1': 0 };
  for (const row of db.all('SELECT rating, COUNT(*) AS c FROM likes WHERE video_id = ? GROUP BY rating', [video.id])) {
    likeCounts[row.rating] = row.c;
  }
  const myRating = res.locals.user
    ? db.get('SELECT rating FROM likes WHERE video_id = ? AND user_id = ?', [video.id, res.locals.user.id])
    : null;

  res.render('watch', { pageTitle: video.title, video, related, moreFrom, comments, commentCount, likeCounts, myRating: myRating ? myRating.rating : 0 });
});

// ---------- Канал пользователя ----------
app.get('/channel/:username', (req, res) => {
  const channel = db.get('SELECT * FROM users WHERE username = ?', [req.params.username]);
  if (!channel) return res.status(404).render('error', { pageTitle: 'Error', message: 'Channel not found.' });

  const videos = db.all(
    `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id
     WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 50`,
    [channel.id]
  );
  const subCount = db.get('SELECT COUNT(*) AS c FROM subscriptions WHERE channel_id = ?', [channel.id]).c;
  const isSubscribed = res.locals.user
    ? !!db.get('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?', [res.locals.user.id, channel.id])
    : false;

  res.render('channel', { pageTitle: channel.username, channel, videos, subCount, isSubscribed, showGuide: true });
});

// ---------- Подписка / отписка ----------
app.post('/channel/:username/subscribe', requireLogin, (req, res) => {
  const channel = db.get('SELECT * FROM users WHERE username = ?', [req.params.username]);
  if (!channel) return res.status(404).render('error', { pageTitle: 'Error', message: 'Channel not found.' });
  if (channel.id !== res.locals.user.id) {
    const action = req.body.action === 'unsubscribe' ? 'unsubscribe' : 'subscribe';
    if (action === 'subscribe') {
      db.run(
        `INSERT INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (subscriber_id, channel_id) DO NOTHING`,
        [res.locals.user.id, channel.id, Date.now()]
      );
    } else {
      db.run('DELETE FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?', [res.locals.user.id, channel.id]);
    }
  }
  res.redirect(`/channel/${encodeURIComponent(channel.username)}`);
});

// ---------- Загрузка видео ----------
const uploadDir = db.uploadDir();
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(uploadDir, 'uploads')),
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'video').replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp4|webm|mkv|avi|mov|m4v|flv|3gp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only video files are allowed (mp4, webm, mkv, avi, mov, m4v, flv, 3gp).'), ok);
  },
});

app.get('/upload', requireLogin, (req, res) => {
  res.render('upload', { pageTitle: 'Upload Video', maxMB: MAX_MB, error: req.query.error || '' });
});

app.post('/upload', requireLogin, upload.single('video'), async (req, res) => {
  if (!req.file) return res.redirect('/upload?error=Choose a video file first.');
  const title = String(req.body.title || '').trim();
  if (!title) {
    fs.unlinkSync(req.file.path);
    return res.redirect('/upload?error=Title is required.');
  }
  const description = String(req.body.description || '').trim();
  const tags = String(req.body.tags || '').trim();
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'Entertainment';

  const r = await db.run(
    'INSERT INTO videos (user_id, title, description, tags, category, filename, views, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
    [res.locals.user.id, title, description, tags, category, req.file.filename, Date.now()]
  );

  const thumbOut = path.join(uploadDir, 'thumbs', `${r.id}.jpg`);
  generateThumbnail(req.file.path, thumbOut); // асинхронно, при ошибке — заглушка

  res.redirect(`/watch/${r.id}`);
});

// ---------- Лайки / дизлайки ----------
app.post('/videos/:id/like', requireLogin, (req, res) => {
  const video = db.get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
  if (!video) return res.status(404).render('error', { pageTitle: 'Error', message: 'Video not found.' });
  const rating = req.body.rating === '-1' ? -1 : 1;
  const existing = db.get('SELECT id, rating FROM likes WHERE video_id = ? AND user_id = ?', [video.id, res.locals.user.id]);
  if (existing && existing.rating === rating) {
    db.run('DELETE FROM likes WHERE id = ?', [existing.id]);
  } else if (existing) {
    db.run('UPDATE likes SET rating = ? WHERE id = ?', [rating, existing.id]);
  } else {
    db.run('INSERT INTO likes (video_id, user_id, rating, created_at) VALUES (?, ?, ?, ?)', [video.id, res.locals.user.id, rating, Date.now()]);
  }
  res.redirect(`/watch/${video.id}`);
});

// ---------- Комментарии ----------
app.post('/videos/:id/comment', requireLogin, (req, res) => {
  const video = db.get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
  if (!video) return res.status(404).render('error', { pageTitle: 'Error', message: 'Video not found.' });
  const text = String(req.body.text || '').trim();
  if (text) {
    db.run('INSERT INTO comments (video_id, user_id, text, created_at) VALUES (?, ?, ?, ?)', [video.id, res.locals.user.id, text.slice(0, 2000), Date.now()]);
  }
  res.redirect(`/watch/${video.id}#comments`);
});

// ---------- Файлы видео и миниатюр ----------
const VIDEO_EXT_RE = /^[A-Za-z0-9._-]+\.(mp4|webm|mkv|avi|mov|m4v|flv|3gp)$/;
app.get('/uploads/:file', (req, res) => {
  if (!VIDEO_EXT_RE.test(req.params.file)) return res.status(404).send('Not found');
  const p = path.join(uploadDir, 'uploads', req.params.file);
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.sendFile(p);
});

app.get('/thumbs/:id', (req, res) => {
  const p = path.join(uploadDir, 'thumbs', `${req.params.id}.jpg`);
  if (!/^\d+$/.test(req.params.id) || !fs.existsSync(p)) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'placeholder.svg'));
  }
  res.sendFile(p);
});

// ---------- Вход / регистрация ----------
app.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { pageTitle: 'Sign In', error: '', next: safeNext(req.query.next) });
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.render('login', { pageTitle: 'Sign In', error: 'Invalid username or password.', next: safeNext(req.body.next) });
  }
  req.session.userId = user.id;
  res.redirect(safeNext(req.body.next));
});

app.get('/register', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('register', { pageTitle: 'Create Account', error: '' });
});

app.post('/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const description = String(req.body.description || '').trim();

  let error = '';
  if (!validateUsername(username)) error = 'Username must be 3-20 characters (letters, numbers, underscore).';
  else if (!validatePassword(password)) error = 'Password must be at least 6 characters.';
  else if (password !== confirm) error = 'Passwords do not match.';

  if (!error) {
    try {
      const r = await db.run(
        'INSERT INTO users (username, password_hash, description, joined_at) VALUES (?, ?, ?, ?)',
        [username, hashPassword(password), description, Date.now()]
      );
      req.session.userId = r.id;
      return res.redirect('/');
    } catch (e) {
      error = 'This username is already taken.';
    }
  }
  res.status(400).render('register', { pageTitle: 'Create Account', error });
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ---------- Ошибки ----------
app.use((req, res) => {
  res.status(404).render('error', { pageTitle: 'Error', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.redirect(`/upload?error=File is too big (max ${MAX_MB} MB).`);
  }
  if (err && err.message && err.message.includes('Only video files')) {
    return res.redirect(`/upload?error=${encodeURIComponent(err.message)}`);
  }
  console.error(err);
  res.status(500).render('error', { pageTitle: 'Error', message: 'Internal server error.' });
});

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`0ld_YouTube running on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });