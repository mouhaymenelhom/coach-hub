require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = '12h';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.JWT_SECRET) console.warn('⚠  JWT_SECRET is not set. Using an insecure development secret.');
if (!GOOGLE_CLIENT_ID) console.warn('⚠  GOOGLE_CLIENT_ID is not set. Google sign-in will not work.');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json({ limit: '100kb' }));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sign = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });

// Standard auth: "Authorization: Bearer <jwt>", optionally restricted to a role
function auth(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (role && payload.role !== role) return res.status(403).json({ error: 'Forbidden' });
      req.auth = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

// <video src> cannot send headers, so uploaded media accepts the JWT as ?token=
function mediaAuth(req, res, next) {
  try {
    req.auth = jwt.verify(String(req.query.token || ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).end();
  }
}

// Accepts YouTube / Vimeo links (converted to embed URLs) or direct .mp4/.webm links
function normalizeVideoUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;

  const host = u.hostname.replace(/^www\./, '');
  let id = null;

  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(embed|live|shorts)\/([\w-]{6,20})/);
      if (m) id = m[2];
    }
  }
  if (id && /^[\w-]{6,20}$/.test(id)) {
    return { kind: 'embed', src: `https://www.youtube.com/embed/${id}` };
  }

  if (host === 'vimeo.com') {
    const m = u.pathname.match(/^\/(\d+)/);
    if (m) return { kind: 'embed', src: `https://player.vimeo.com/video/${m[1]}` };
  }

  if (/\.(mp4|webm|ogg)$/i.test(u.pathname)) return { kind: 'file', src: u.toString() };
  return null;
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

// Members: Google OAuth2 (ID token verified server-side) -> our own JWT
app.post('/api/auth/google', loginLimiter, async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google sign-in is not configured on the server.' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: String(req.body.credential || ''),
      audience: GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p || !p.sub) throw new Error('bad payload');

    db.prepare(`
      INSERT INTO users (google_sub, email, name, picture) VALUES (?, ?, ?, ?)
      ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture
    `).run(p.sub, p.email || null, p.name || p.email || 'Member', p.picture || null);

    const user = db.prepare('SELECT id, name, email, picture FROM users WHERE google_sub = ?').get(p.sub);
    res.json({ token: sign({ sub: user.id, role: 'user', name: user.name }), user });
  } catch (err) {
    console.error('Google auth failed:', err.message);
    res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// Coach: username + password -> JWT
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
app.post('/api/auth/coach', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const coach = db.prepare('SELECT * FROM coaches WHERE username = ?').get(String(username || ''));
  const ok = bcrypt.compareSync(String(password || ''), coach ? coach.password_hash : DUMMY_HASH);
  if (!coach || !ok) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: sign({ sub: coach.id, role: 'coach', name: coach.username }), user: { name: coach.username } });
});

/* ------------------------------------------------------------------ */
/* Videos                                                              */
/* ------------------------------------------------------------------ */

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '');
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('video/')),
});

const removeUpload = (src) => {
  if (src && src.startsWith('/media/')) fs.unlink(path.join(UPLOAD_DIR, path.basename(src)), () => {});
};

app.get('/media/:file', mediaAuth, (req, res) => {
  const file = path.join(UPLOAD_DIR, path.basename(req.params.file));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file); // supports HTTP range requests (seeking)
});

app.get('/api/videos', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM videos ORDER BY id DESC').all());
});

app.post('/api/videos', auth('coach'), upload.single('file'), (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const fail = (msg) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: msg });
  };
  if (!title) return fail('Add a title.');

  let kind, src;
  if (req.file) {
    kind = 'file';
    src = `/media/${req.file.filename}`;
  } else {
    const n = normalizeVideoUrl(req.body.url || '');
    if (!n) return fail('Paste a YouTube or Vimeo link, a direct .mp4 link, or upload a video file.');
    ({ kind, src } = n);
  }

  const info = db.prepare('INSERT INTO videos (title, description, kind, src) VALUES (?, ?, ?, ?)')
    .run(title, description, kind, src);
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(info.lastInsertRowid);
  io.emit('video:new', video);
  res.status(201).json(video);
});

app.delete('/api/videos/:id', auth('coach'), (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  removeUpload(v.src);
  io.emit('video:removed', { id: v.id });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Lives                                                               */
/* ------------------------------------------------------------------ */

app.get('/api/lives', auth(), (req, res) => {
  res.json(db.prepare(`
    SELECT * FROM lives
    ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, id DESC
  `).all());
});

app.post('/api/lives', auth('coach'), (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const n = normalizeVideoUrl(req.body.url || '');
  if (!title) return res.status(400).json({ error: 'Add a title.' });
  if (!n || n.kind !== 'embed') return res.status(400).json({ error: 'Paste a YouTube or Vimeo link (e.g. your YouTube Live URL).' });

  const info = db.prepare('INSERT INTO lives (title, embed_url) VALUES (?, ?)').run(title, n.src);
  const live = db.prepare('SELECT * FROM lives WHERE id = ?').get(info.lastInsertRowid);
  io.emit('live:update', live);
  res.status(201).json(live);
});

app.patch('/api/lives/:id', auth('coach'), (req, res) => {
  const status = String(req.body.status || '');
  if (!['scheduled', 'live', 'ended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const info = db.prepare('UPDATE lives SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  const live = db.prepare('SELECT * FROM lives WHERE id = ?').get(req.params.id);
  io.emit('live:update', live);
  res.json(live);
});

app.delete('/api/lives/:id', auth('coach'), (req, res) => {
  const info = db.prepare('DELETE FROM lives WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  io.emit('live:update', { id: Number(req.params.id), removed: true });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Messaging (REST for history, Socket.IO for realtime)                */
/* ------------------------------------------------------------------ */

app.get('/api/messages', auth('user'), (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 300').all(req.auth.sub));
});

app.get('/api/coach/conversations', auth('coach'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, u.picture,
      (SELECT body FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender = 'user' AND m.read = 0) AS unread
    FROM users u
    ORDER BY COALESCE(last_at, u.created_at) DESC
  `).all());
});

app.get('/api/coach/conversations/:userId/messages', auth('coach'), (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 300').all(req.params.userId));
});

app.post('/api/coach/conversations/:userId/read', auth('coach'), (req, res) => {
  db.prepare("UPDATE messages SET read = 1 WHERE user_id = ? AND sender = 'user'").run(req.params.userId);
  res.json({ ok: true });
});

io.use((socket, next) => {
  try {
    socket.auth = jwt.verify(String(socket.handshake.auth.token || ''), JWT_SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const { sub, role } = socket.auth;
  socket.join(role === 'coach' ? 'coach' : `user:${sub}`);

  socket.on('message:send', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const body = String((payload && payload.body) || '').trim().slice(0, 2000);
    if (!body) return reply({ error: 'Empty message' });

    let userId = sub;
    if (role === 'coach') {
      userId = Number(payload.userId);
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return reply({ error: 'Unknown member' });
    }

    const info = db.prepare('INSERT INTO messages (user_id, sender, body, read) VALUES (?, ?, ?, ?)')
      .run(userId, role === 'coach' ? 'coach' : 'user', body, role === 'coach' ? 1 : 0);
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
    io.to(`user:${userId}`).to('coach').emit('message:new', msg);
    reply({ ok: true });
  });
});

/* ------------------------------------------------------------------ */
/* AI chatbot (any OpenAI-compatible provider, default: Groq free tier) */
/* ------------------------------------------------------------------ */

const AI_SYSTEM_PROMPT =
  "You are the assistant of an online sports coaching community. Give clear, friendly, concise answers about training, " +
  "technique, recovery and general nutrition. You are not a doctor: for pain, injuries or medical conditions, advise " +
  "seeing a professional. For anything about the coach's own programs or schedule, suggest messaging the coach directly.";

app.post('/api/chatbot', auth('user'), chatLimiter, async (req, res) => {
  const key = process.env.AI_API_KEY;
  if (!key) {
    return res.json({ reply: "The assistant isn't set up yet. Ask the coach to add an AI_API_KEY on the server." });
  }

  const history = (Array.isArray(req.body.messages) ? req.body.messages : [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!history.length || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Send a message first.' });
  }

  const base = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...history],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });
    if (!r.ok) {
      console.error('AI provider error', r.status, (await r.text()).slice(0, 300));
      return res.status(502).json({ error: 'The assistant is unavailable right now. Try again in a moment.' });
    }
    const data = await r.json();
    const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    res.json({ reply: (reply || '').trim() || "I couldn't come up with an answer. Try rephrasing?" });
  } catch (err) {
    console.error('AI request failed:', err.message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Try again in a moment.' });
  }
});

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', page('index.html'));               // public member login
app.get('/app', page('app.html'));              // member app
app.get('/coach/login', page('coach-login.html')); // private coach login (not linked anywhere)
app.get('/coach', page('coach.html'));          // coach dashboard
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => console.log(`Coach Hub running on http://localhost:${PORT}`));
