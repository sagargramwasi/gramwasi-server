// GramWasi backend server — zero-dependency Node.js
// Run: node server.js   (PORT env, default 8080)
// Data persists to data.json next to this file.
// Admin API key: header x-admin-key: gramwasi-admin-123 (change before real use)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'gramwasi-admin-123';
const DB_FILE = path.join(__dirname, 'data.json');

let db = { users: [], posts: [], messages: [], seq: 1 };
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { seed(); }
}
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1)); }
function seed() {
  db = { users: [], posts: [], messages: [], seq: 1 };
  const mk = (u, name, verified) => ({
    id: db.seq++, username: u, name, bio: '', avatar: 'https://picsum.photos/seed/' + u + '/150/150',
    passwordHash: hash('demo123'), verified: !!verified, blocked: false,
    followers: [], following: [], createdAt: Date.now()
  });
  db.users.push(mk('demo', 'Demo User', true), mk('aarav_sharma', 'Aarav Sharma', true),
    mk('priya_singh', 'Priya Singh', false), mk('rohit_kumar', 'Rohit Kumar', false));
  save();
}
function hash(p) { return crypto.createHash('sha256').update('gw:' + p).digest('hex'); }
// Real email sending needs a FREE mail service (koi paisa nahi lagta). Teen me se
// koi ek env me set karo:
//   1) RESEND_API_KEY  — resend.com free account ki API key (sabse asaan)
//   2) BREVO_API_KEY   — brevo.com free account ki API key (roz 300 mail free)
//   3) SMTP_URL        — apne Gmail ka App Password: smtp://tum@gmail.com:APP_PASSWORD@smtp.gmail.com:465
// Kuch bhi set na ho to DEMO mode: code API response me wapas milta hai (test ke liye),
// lekin asli mail nahi jata.
const httpsMail = require('https');
const MAIL_CONFIGURED = !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY || process.env.SMTP_URL);
function mailApi(host, path2, headers, payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const r = httpsMail.request({ host, path: path2, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(resp.statusCode >= 200 && resp.statusCode < 300)); });
    r.on('error', () => resolve(false));
    r.write(data); r.end();
  });
}
function smtpSend(urlStr, from, to, subject, text) {
  // Zero-dependency SMTP over implicit TLS (port 465) — Gmail App Password ke liye
  return new Promise(resolve => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve(false); }
    const tls = require('tls');
    const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
    const sock = tls.connect(Number(u.port || 465), u.hostname, { servername: u.hostname }, () => {});
    const cmds = ['EHLO gramwasi.local', 'AUTH LOGIN', Buffer.from(user).toString('base64'),
      Buffer.from(pass).toString('base64'), 'MAIL FROM:<' + from + '>', 'RCPT TO:<' + to + '>', 'DATA',
      'From: ' + from + '\r\nTo: ' + to + '\r\nSubject: ' + subject + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + text + '\r\n.', 'QUIT'];
    let step = 0, buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => {
      buf += d;
      if (!buf.includes('\n')) return;
      buf = '';
      if (step < cmds.length) sock.write(cmds[step++] + '\r\n');
      else { sock.end(); resolve(true); }
    });
    sock.on('error', () => resolve(false));
    setTimeout(() => { try { sock.destroy(); } catch (e) {} resolve(false); }, 15000);
  });
}
async function sendMail(to, subject, text) {
  try {
    if (process.env.RESEND_API_KEY) {
      return await mailApi('api.resend.com', '/emails',
        { Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
        { from: process.env.MAIL_FROM || 'GramWasi <onboarding@resend.dev>', to: [to], subject, text });
    }
    if (process.env.BREVO_API_KEY) {
      return await mailApi('api.brevo.com', '/v3/smtp/email',
        { 'api-key': process.env.BREVO_API_KEY },
        { sender: { name: 'GramWasi', email: process.env.MAIL_FROM_EMAIL || 'no-reply@gramwasi.app' },
          to: [{ email: to }], subject, textContent: text });
    }
    if (process.env.SMTP_URL) {
      const from = decodeURIComponent(new URL(process.env.SMTP_URL).username);
      return await smtpSend(process.env.SMTP_URL, from, to, subject, text);
    }
  } catch (e) { /* mail fail ho to demo fallback neeche hai */ }
  return false;
}
function pub(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, bio: u.bio, avatar: u.avatar,
    email: u.email || '', emailVerified: !!u.emailVerified,
    publicKey: u.publicKey || null,
    verified: u.verified, blocked: u.blocked,
    followers: u.followers.length, following: u.following.length,
    followerList: u.followers, followingList: u.following };
}
function byName(name) { return db.users.find(u => u.username === String(name || '').toLowerCase()); }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

// ---------- Telegram storage + message mirror (FREE, optional) ----------
// Set env TELEGRAM_BOT_TOKEN (BotFather se milega) and TELEGRAM_CHAT_ID
// (ek private channel jisme bot admin ho). Token kabhi code me mat likho —
// sirf hosting ke environment/settings me dalo.
// Kaam: (1) post ki photo Telegram channel par store hoti hai, server par
// sirf uski file_id rehti hai (server storage bachta hai).
// (2) har chat message ki ek copy Telegram par backup hoti hai.
const https = require('https');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const TG_ON = !!(TG_TOKEN && TG_CHAT);
function tgCall(method, params) {
  return new Promise(resolve => {
    if (!TG_ON) return resolve(null);
    const data = JSON.stringify(params || {});
    const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/' + method,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); });
    r.on('error', () => resolve(null));
    r.write(data); r.end();
  });
}
function tgUploadPhoto(buffer, caption) {
  // multipart upload of an image buffer via sendPhoto; resolves to Telegram file_id or null
  return new Promise(resolve => {
    if (!TG_ON) return resolve(null);
    const boundary = '----gw' + Date.now();
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + TG_CHAT +
      '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + (caption || 'GramWasi post') +
      '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="post.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const payload = Buffer.concat([head, buffer, tail]);
    const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/sendPhoto',
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length } },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        try { const j = JSON.parse(d); const ph = j.result && j.result.photo; resolve(ph ? ph[ph.length - 1].file_id : null); }
        catch (e) { resolve(null); } }); });
    r.on('error', () => resolve(null));
    r.write(payload); r.end();
  });
}
async function tgStorePostImage(post) {
  if (!TG_ON || !post.image) return;
  try {
    if (post.image.startsWith('data:')) {
      const b64 = post.image.split(',')[1] || '';
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 0 && buf.length < 10 * 1024 * 1024) {
        const fid = await tgUploadPhoto(buf, '@' + post.username + ': ' + (post.caption || ''));
        if (fid) { post.telegramFileId = fid; post.image = ''; save(); }
      }
    } else if (post.image.startsWith('http')) {
      const j = await tgCall('sendPhoto', { chat_id: TG_CHAT, photo: post.image, caption: '@' + post.username + ': ' + (post.caption || '') });
      const ph = j && j.result && j.result.photo;
      if (ph) { post.telegramFileId = ph[ph.length - 1].file_id; save(); }
    }
  } catch (e) { /* Telegram fail ho to post server par hi rehta hai */ }
}
function tgMirrorMessage(m) {
  if (!TG_ON) return;
  // Encrypted message (enc: se shuru) Telegram par bhi sirf cipher jata hai —
  // asli text na server ko milta hai, na Telegram ko. 🔒
  const bodyText = String(m.text || '').startsWith('enc:')
    ? '🔒 encrypted message (sirf bhejne wala aur paane wala hi padh sakta hai)'
    : m.text;
  tgCall('sendMessage', { chat_id: TG_CHAT, text: '💬 @' + m.from + ' → @' + m.to + ': ' + bodyText }).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { send(res, 200, {}); return; }

  // Serve admin panel at /admin if the file sits next to the server folder
  if (p === '/admin' || p === '/admin/') {
    const f = path.join(__dirname, '..', 'admin', 'index.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(f)); return;
    }
  }
  if (p === '/' || p === '/health') { send(res, 200, { app: 'GramWasi', ok: true, telegramStorage: TG_ON }); return; }
  if (p === '/api/media' && req.method === 'GET') {
    // Telegram par stored photo ko wapas dikhana: /api/media?postId=<id>
    const post = db.posts.find(x => x.id === Number(url.searchParams.get('postId')));
    if (!post) { send(res, 404, { error: 'post nahi mila' }); return; }
    if (post.image) { res.writeHead(302, { Location: post.image }); res.end(); return; }
    if (post.telegramFileId && TG_ON) {
      const j = await tgCall('getFile', { file_id: post.telegramFileId });
      const fp = j && j.result && j.result.file_path;
      if (fp) { res.writeHead(302, { Location: 'https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fp }); res.end(); return; }
    }
    send(res, 404, { error: 'media nahi mila' }); return;
  }
  if (p === '/api/telegram/discover' && req.method === 'GET') {
    // Bot ko channel me add karke channel me ek message bhejo, fir ye kholo —
    // chat id dikh jayegi jo TELEGRAM_CHAT_ID me dalni hai. (Admin only)
    if (req.headers['x-admin-key'] !== ADMIN_KEY) { send(res, 401, { error: 'admin key chahiye' }); return; }
    if (!TG_TOKEN) { send(res, 200, { telegramStorage: false, note: 'TELEGRAM_BOT_TOKEN set nahi hai' }); return; }
    const j = await new Promise(resolve => {
      const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/getUpdates', method: 'GET' },
        resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); });
      r.on('error', () => resolve(null)); r.end();
    });
    const chats = [];
    ((j && j.result) || []).forEach(u => {
      const c = (u.channel_post && u.channel_post.chat) || (u.message && u.message.chat);
      if (c && !chats.some(x => x.id === c.id)) chats.push({ id: c.id, title: c.title || c.username || c.first_name || '', type: c.type });
    });
    send(res, 200, { chats }); return;
  }

  const body = req.method === 'POST' ? await readBody(req) : {};
  const isAdmin = req.headers['x-admin-key'] === ADMIN_KEY;

  try {
    if (p === '/api/signup' && req.method === 'POST') {
      // PENDING signup: account abhi NAHI banta. Sirf ek pending entry banti hai
      // aur code Gmail par jata hai. Sahi code dalne par hi account create hoga.
      const username = String(body.username || '').toLowerCase().trim();
      const email = String(body.email || '').toLowerCase().trim();
      if (!username || !body.password) return send(res, 400, { error: 'username aur password chahiye' });
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'sahi Gmail/email dalo' });
      if (byName(username)) return send(res, 409, { error: 'username pehle se liya gaya hai, dusra chuno' });
      if (db.users.some(x => x.email === email)) return send(res, 409, { error: 'is email se pehle hi account hai' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.pending = db.pending || {};
      db.pending[username] = { username, name: body.name || username, email,
        passwordHash: hash(body.password), code, codeAt: Date.now() };
      save();
      const sent = await sendMail(email, 'GramWasi verification code',
        'Namaste!\n\nTumhara GramWasi verification code hai: ' + code + '\n\nYe code 15 minute tak valid hai. Sahi code dalne par hi tumhara account banega.\n\n— GramWasi team');
      if (!MAIL_CONFIGURED) console.log('[DEMO MAIL] ' + email + ' ka verification code: ' + code);
      const out = { needVerify: true, pending: true, mailSent: sent };
      if (!MAIL_CONFIGURED) out.devCode = code; // demo mode only; mail service judne par code sirf Gmail par jayega
      return send(res, 201, out);
    }
    if (p === '/api/resend-code' && req.method === 'POST') {
      const username = String(body.username || '').toLowerCase().trim();
      db.pending = db.pending || {};
      const pend = db.pending[username];
      if (!pend) return send(res, 404, { error: 'pending signup nahi mila, pehle signup karo' });
      pend.code = String(Math.floor(100000 + Math.random() * 900000));
      pend.codeAt = Date.now(); save();
      const sent = await sendMail(pend.email, 'GramWasi verification code',
        'Tumhara naya GramWasi verification code hai: ' + pend.code + '\nYe code 15 minute tak valid hai.');
      const out = { needVerify: true, mailSent: sent };
      if (!MAIL_CONFIGURED) out.devCode = pend.code;
      return send(res, 200, out);
    }
    if (p === '/api/verify-email' && req.method === 'POST') {
      // Sahi code = tab account BANTA hai. Galat code par kuch nahi banta.
      const username = String(body.username || '').toLowerCase().trim();
      db.pending = db.pending || {};
      const pend = db.pending[username];
      const existing = byName(username);
      if (existing && existing.emailVerified) return send(res, 200, { user: pub(existing), already: true });
      if (!pend) return send(res, 404, { error: 'pehle signup karke code lo' });
      if (String(body.code || '') !== pend.code) return send(res, 400, { error: 'galat code — account nahi bana' });
      if (Date.now() - (pend.codeAt || 0) > 15 * 60 * 1000) { delete db.pending[username]; save(); return send(res, 400, { error: 'code expire ho gaya, dobara signup karo' }); }
      const u = { id: db.seq++, username, name: pend.name, bio: '', email: pend.email,
        emailVerified: true,
        avatar: 'https://picsum.photos/seed/' + username + '/150/150',
        passwordHash: pend.passwordHash, verified: false, blocked: false,
        followers: [], following: [], createdAt: Date.now() };
      db.users.push(u);
      delete db.pending[username];
      save();
      return send(res, 201, { user: pub(u), created: true });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const u = byName(body.username);
      if (!u) {
        db.pending = db.pending || {};
        if (db.pending[String(body.username || '').toLowerCase().trim()]) {
          return send(res, 403, { error: 'pehle Gmail wala code dalke account banao', needVerify: true, username: String(body.username || '').toLowerCase().trim() });
        }
        return send(res, 401, { error: 'galat username/password' });
      }
      if (u.passwordHash !== hash(body.password || '')) return send(res, 401, { error: 'galat username/password' });
      if (u.blocked) return send(res, 403, { error: 'account blocked hai' });
      if (u.email && !u.emailVerified) return send(res, 403, { error: 'pehle email verify karo', needVerify: true, username: u.username });
      return send(res, 200, { user: pub(u) });
    }
    if (p === '/api/users' && req.method === 'GET') {
      return send(res, 200, { users: db.users.filter(u => !u.blocked).map(pub) });
    }
    if (p === '/api/keys' && req.method === 'POST') {
      // End-to-end encryption: user ki PUBLIC key server par rakhi jati hai.
      // Private key sirf user ke phone par rehti hai — server (aur Telegram
      // backup) ko sirf encrypted (cipher) message milta hai, asli text kabhi nahi.
      const u = byName(body.username);
      if (!u || typeof body.publicKey !== 'string' || body.publicKey.length > 4000) {
        return send(res, 400, { error: 'bad key' });
      }
      u.publicKey = body.publicKey; save();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/follow' && req.method === 'POST') {
      const me = byName(body.from), other = byName(body.to);
      if (!me || !other || me === other) return send(res, 400, { error: 'bad follow' });
      const i = me.following.indexOf(other.username);
      if (i >= 0) { me.following.splice(i, 1); other.followers.splice(other.followers.indexOf(me.username), 1); }
      else { me.following.push(other.username); other.followers.push(me.username); }
      save(); return send(res, 200, { user: pub(other), me: pub(me) });
    }
    if (p === '/api/posts' && req.method === 'GET') {
      const posts = db.posts.slice().reverse().map(post => {
        const out = { ...post, author: pub(byName(post.username)) };
        if (!out.image && post.telegramFileId) out.image = '/api/media?postId=' + post.id;
        return out;
      });
      return send(res, 200, { posts });
    }
    if (p === '/api/posts' && req.method === 'POST') {
      const me = byName(body.username);
      if (!me) return send(res, 400, { error: 'user nahi mila' });
      const post = { id: db.seq++, username: me.username, image: body.image || '',
        caption: body.caption || '', likes: [], comments: [], createdAt: Date.now() };
      db.posts.push(post); save();
      tgStorePostImage(post); // background me Telegram storage par bhej do (free space)
      return send(res, 201, { post: { ...post, author: pub(me) } });
    }
    if (p === '/api/posts/like' && req.method === 'POST') {
      const post = db.posts.find(x => x.id === body.postId);
      const me = byName(body.username);
      if (!post || !me) return send(res, 400, { error: 'bad like' });
      const i = post.likes.indexOf(me.username);
      if (i >= 0) post.likes.splice(i, 1); else post.likes.push(me.username);
      save(); return send(res, 200, { likes: post.likes.length, likedBy: post.likes });
    }
    if (p === '/api/posts/comment' && req.method === 'POST') {
      const post = db.posts.find(x => x.id === body.postId);
      const me = byName(body.username);
      if (!post || !me || !body.text) return send(res, 400, { error: 'bad comment' });
      post.comments.push({ username: me.username, text: String(body.text), at: Date.now() });
      save(); return send(res, 200, { comments: post.comments });
    }
    if (p === '/api/chat' && req.method === 'GET') {
      const me = url.searchParams.get('user'), other = url.searchParams.get('with');
      const msgs = db.messages.filter(m =>
        (m.from === me && m.to === other) || (m.from === other && m.to === me));
      return send(res, 200, { messages: msgs });
    }
    if (p === '/api/chat/send' && req.method === 'POST') {
      const from = byName(body.from), to = byName(body.to);
      if (!from || !to || !body.text) return send(res, 400, { error: 'bad message' });
      const m = { id: db.seq++, from: from.username, to: to.username, text: String(body.text), at: Date.now() };
      db.messages.push(m); save();
      tgMirrorMessage(m); // Telegram par backup copy (free storage)
      return send(res, 201, { message: m });
    }
    // Admin endpoints
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin) return send(res, 401, { error: 'admin key chahiye' });
      if (p === '/api/admin/stats' && req.method === 'GET') {
        return send(res, 200, { users: db.users.length, posts: db.posts.length,
          messages: db.messages.length,
          likes: db.posts.reduce((a, x) => a + x.likes.length, 0) });
      }
      if (p === '/api/admin/verify' && req.method === 'POST') {
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        u.verified = !!body.verified; save();
        return send(res, 200, { user: pub(u) });
      }
      if (p === '/api/admin/block' && req.method === 'POST') {
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        u.blocked = !!body.blocked; save();
        return send(res, 200, { user: pub(u) });
      }
    }
    send(res, 404, { error: 'route nahi mila' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

load();
server.listen(PORT, () => console.log('GramWasi server running on port ' + PORT));
