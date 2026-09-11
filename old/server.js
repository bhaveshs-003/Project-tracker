/**
 * Functional Tool — static hosting + authentication API.
 *
 *   npm install
 *   node server.js        →  http://localhost:3000
 *
 * The frontend is served from this same server on purpose: same origin means no
 * CORS setup and the session cookie is sent automatically. Opening index.html
 * straight off the filesystem puts the page on a null origin, where the cookie
 * will not work.
 *
 * Seeded accounts (see seedUsers below):
 *   alex@example.com        / admin123     → admin
 *   daniel@northwind.example / partner123  → partner
 *   mei@northwind.example    / partner123  → partner
 *   lucas@contoso.example    / partner123  → partner
 *   sofia@contoso.example    / partner123  → partner
 *
 * Account ids match the ids the frontend already uses for people (c1, p1…p4).
 * Projects store POC assignments by those ids, so they must not be reissued.
 */

var express = require('express');
var crypto  = require('crypto');
var fs      = require('fs');
var path    = require('path');

var PORT      = process.env.PORT || 3000;
var DATA_DIR  = path.join(__dirname, 'data');
var USERS_FILE = path.join(DATA_DIR, 'users.json');
var SESSION_COOKIE = 'ft_session';
var SESSION_MS = 8 * 60 * 60 * 1000;   // 8 hours

// ---------------------------------------------------------------
// Passwords — scrypt with a per-user salt. Never store the password.
// ---------------------------------------------------------------
function hashPassword(password, salt) {
  var useSalt = salt || crypto.randomBytes(16).toString('hex');
  var hash = crypto.scryptSync(password, useSalt, 64).toString('hex');
  return { salt: useSalt, hash: hash };
}

function passwordMatches(password, user) {
  var candidate = crypto.scryptSync(password, user.salt, 64);
  var stored = Buffer.from(user.hash, 'hex');
  // Length check first: timingSafeEqual throws on a length mismatch
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// ---------------------------------------------------------------
// Storage — a JSON file, read into memory and written on change
// ---------------------------------------------------------------
function seedUsers() {
  var seeds = [
    { id: 'c1', name: 'Alex Morgan',   email: 'alex@example.com',              role: 'admin',   password: 'admin123' },
    { id: 'p1', name: 'Daniel Okafor', email: 'daniel@northwind.example',      role: 'partner', password: 'partner123' },
    { id: 'p2', name: 'Mei Chen',      email: 'mei@northwind.example',         role: 'partner', password: 'partner123' },
    { id: 'p3', name: 'Lucas Brandt',  email: 'lucas@contoso.example',         role: 'partner', password: 'partner123' },
    { id: 'p4', name: 'Sofia Rossi',   email: 'sofia@contoso.example',         role: 'partner', password: 'partner123' }
  ];

  return seeds.map(function (seed) {
    var creds = hashPassword(seed.password);
    return {
      id: seed.id, name: seed.name, email: seed.email, role: seed.role,
      salt: creds.salt, hash: creds.hash
    };
  });
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Could not read users.json, reseeding:', e.message);
  }

  var seeded = seedUsers();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(seeded, null, 2));
  console.log('Seeded ' + seeded.length + ' accounts into data/users.json');
  return seeded;
}

var users = loadUsers();

function saveUsers() {
  writeJsonAtomic(USERS_FILE, users);
}

function findByEmail(email) {
  var wanted = String(email || '').trim().toLowerCase();
  return users.filter(function (u) { return u.email.toLowerCase() === wanted; })[0] || null;
}

// What the client is allowed to see about an account — never salt or hash
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

// ---------------------------------------------------------------
// Sessions — random id in an httpOnly cookie, state kept server-side and
// written to disk so a server restart does not sign everybody out.
// ---------------------------------------------------------------
var SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
var sessions = loadSessions();

function loadSessions() {
  var map = new Map();
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      var saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      Object.keys(saved).forEach(function (id) {
        // Drop anything that expired while the server was down
        if (saved[id].expires > Date.now()) map.set(id, saved[id]);
      });
    }
  } catch (e) {
    console.error('Could not read sessions.json, starting empty:', e.message);
  }
  return map;
}

// Write via a temp file and rename, so a crash mid-write cannot leave a
// half-written file behind — a corrupt sessions.json signs everybody out.
function writeJsonAtomic(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  var tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function saveSessions() {
  try {
    var plain = {};
    sessions.forEach(function (session, id) { plain[id] = session; });
    writeJsonAtomic(SESSIONS_FILE, plain);
  } catch (e) {
    console.error('Could not persist sessions:', e.message);
  }
}

function createSession(userId) {
  var id = crypto.randomUUID();
  sessions.set(id, { userId: userId, expires: Date.now() + SESSION_MS });
  saveSessions();
  return id;
}

function readSession(req) {
  var raw = req.headers.cookie || '';
  var match = raw.split(';').map(function (c) { return c.trim(); })
    .filter(function (c) { return c.indexOf(SESSION_COOKIE + '=') === 0; })[0];
  if (!match) return null;

  var id = match.slice(SESSION_COOKIE.length + 1);
  var session = sessions.get(id);
  if (!session) return null;

  if (session.expires < Date.now()) {
    sessions.delete(id);
    saveSessions();
    return null;
  }
  return { id: id, session: session };
}

function currentUser(req) {
  var found = readSession(req);
  if (!found) return null;
  return users.filter(function (u) { return u.id === found.session.userId; })[0] || null;
}

function cookieHeader(sessionId) {
  // Secure is omitted so this works over plain http on localhost.
  // Add '; Secure' when this is served over HTTPS.
  return SESSION_COOKIE + '=' + sessionId +
    '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (SESSION_MS / 1000);
}

// ---------------------------------------------------------------
// App
// ---------------------------------------------------------------
var app = express();
app.use(express.json());

// Auth request log — every attempt, what it carried and how it ended. Kept
// deliberately noisy while login problems are being chased; drop it later.
app.use('/api', function (req, res, next) {
  var started = Date.now();
  var who = (req.body && req.body.email) ? ' email=' + req.body.email : '';
  var cookie = (req.headers.cookie || '').indexOf(SESSION_COOKIE) > -1 ? ' cookie=yes' : ' cookie=no';
  res.on('finish', function () {
    console.log('[api] ' + new Date().toISOString().slice(11, 19) + ' ' +
      req.method + ' ' + req.originalUrl + ' -> ' + res.statusCode +
      who + cookie +
      ' origin=' + (req.headers.origin || req.headers.referer || 'none') +
      ' (' + (Date.now() - started) + 'ms)');
  });
  next();
});

// Gate for routes that need a signed-in user.
// Also slides the expiry forward so somebody actively using the app is never
// kicked out mid-session when the original 8 hours happens to run out.
function requireAuth(req, res, next) {
  var found = readSession(req);
  if (!found) return res.status(401).json({ error: 'Not signed in' });

  var user = users.filter(function (u) { return u.id === found.session.userId; })[0];
  if (!user) {                       // account deleted while signed in
    sessions.delete(found.id);
    saveSessions();
    return res.status(401).json({ error: 'Not signed in' });
  }

  if (found.session.expires - Date.now() < SESSION_MS / 2) {
    found.session.expires = Date.now() + SESSION_MS;
    saveSessions();
    res.setHeader('Set-Cookie', cookieHeader(found.id));
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only' });
  }
  next();
}

// ---- Auth ----
app.post('/api/auth/login', function (req, res) {
  var body = req.body || {};
  var user = findByEmail(body.email);

  // One message for "no such account" and "wrong password" alike, so the
  // response cannot be used to discover which emails are registered.
  var invalid = { error: 'Invalid email or password' };
  if (!user || !body.password) return res.status(401).json(invalid);
  if (!passwordMatches(String(body.password), user)) return res.status(401).json(invalid);

  res.setHeader('Set-Cookie', cookieHeader(createSession(user.id)));
  res.json(publicUser(user));
});

app.post('/api/auth/logout', function (req, res) {
  var found = readSession(req);
  if (found) { sessions.delete(found.id); saveSessions(); }
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, function (req, res) {
  res.json(publicUser(req.user));
});

// ---- Accounts (admin only) ----
// Keeps logins in step with the directory managed in the Profile tab.
app.post('/api/accounts', requireAuth, requireAdmin, function (req, res) {
  var body = req.body || {};

  if (!body.id || !body.name || !body.email || !body.password) {
    return res.status(400).json({ error: 'id, name, email and password are required' });
  }
  if (String(body.password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (users.some(function (u) { return u.id === body.id; })) {
    return res.status(409).json({ error: 'That account id already exists' });
  }
  if (findByEmail(body.email)) {
    return res.status(409).json({ error: 'That email is already registered' });
  }

  var creds = hashPassword(String(body.password));
  var user = {
    id: body.id,
    name: body.name,
    email: String(body.email).trim(),
    role: body.role === 'admin' ? 'admin' : 'partner',
    salt: creds.salt,
    hash: creds.hash
  };
  users.push(user);
  saveUsers();
  res.status(201).json(publicUser(user));
});

app.patch('/api/accounts/:id', requireAuth, requireAdmin, function (req, res) {
  var body = req.body || {};
  var user = users.filter(function (u) { return u.id === req.params.id; })[0];
  if (!user) return res.status(404).json({ error: 'No such account' });

  if (body.email) {
    var clash = findByEmail(body.email);
    if (clash && clash.id !== user.id) {
      return res.status(409).json({ error: 'That email is already registered' });
    }
    user.email = String(body.email).trim();
  }
  if (body.name) user.name = body.name;

  // A blank password means "leave it alone"
  if (body.password) {
    if (String(body.password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    var creds = hashPassword(String(body.password));
    user.salt = creds.salt;
    user.hash = creds.hash;
  }

  saveUsers();
  res.json(publicUser(user));
});

app.delete('/api/accounts/:id', requireAuth, requireAdmin, function (req, res) {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete the account you are signed in with' });
  }

  var before = users.length;
  users = users.filter(function (u) { return u.id !== req.params.id; });
  if (users.length === before) return res.status(404).json({ error: 'No such account' });

  // Sign out any live session belonging to that account
  sessions.forEach(function (session, id) {
    if (session.userId === req.params.id) sessions.delete(id);
  });
  saveSessions();

  saveUsers();
  res.json({ ok: true });
});

// ---- Static frontend, same origin as the API ----
app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, function () {
  console.log('Functional Tool running at http://localhost:' + PORT);
});
