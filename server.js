// GramWasi backend server — zero-dependency Node.js
// Run: node server.js   (PORT env, default 8080)
// Data: SUPABASE_URL + SUPABASE_ANON_KEY set ho to Supabase (permanent, shared),
// warna data.json file next to this file (ya VERCEL/NETLIFY par /tmp).
// Admin API key: header x-admin-key: gramwasi-admin-123 (change before real use)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'gramwasi-admin-123';
const DATA_FILE = process.env.GRAMWASI_DATA_FILE || (process.env.VERCEL || process.env.NETLIFY ? '/tmp/gramwasi-data.json' : path.join(__dirname, 'data.json'));

// ---------- Storage ----------
// Do mode hai:
//  1) SUPABASE (permanent + sab serverless instances ke beech shared):
//     env SUPABASE_URL + SUPABASE_ANON_KEY set ho to pura DB ek hi jagah rehta
//     hai — Supabase table public.app_state, sirf ek row (id=1), column data
//     (jsonb) me pura DB object (wahi shape jo data.json me hota tha).
//     Netlify par /tmp wali dikkat (ek instance ka banaya account dusre
//     instance ko nahi dikhta) isiliye khatam ho jati hai.
//  2) FILE (fallback, pehle jaisa behaviour): GRAMWASI_DATA_FILE set ho to wo
//     path, VERCEL/NETLIFY par /tmp/gramwasi-data.json, warna server ke paas
//     wali data.json.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_ON = !!(SUPABASE_URL && SUPABASE_KEY);

let db = { users: [], posts: [], messages: [], stories: [], notifications: [], seq: 1 };
let dbReady = false;   // pehli load koshish ho chuki hai
let dbHasData = false; // db me asli loaded/seed data aa chuka hai (khali initial object nahi)
let dbLoading = null;  // chal rahi load ka promise (duplicate load rokne ke liye)
let lastLoadAt = 0;    // aakhri successful load/save ka time (ms)
let pendingSaves = 0;  // chal rahe Supabase saves ki ginti
let sbHasRow = false;  // Supabase me app_state ki row (id=1) maujud hai

function seedData() {
  const d = { users: [], posts: [], messages: [], stories: [], notifications: [], seq: 1 };
  const mk = (u, name, verified) => ({
    id: d.seq++, username: u, name, bio: '', avatar: 'https://picsum.photos/seed/' + u + '/150/150',
    passwordHash: hash('demo123'), verified: !!verified, blocked: false,
    followers: [], following: [], acceptedChats: [], blockedUsers: [], createdAt: Date.now()
  });
  d.users.push(mk('demo', 'Demo User', true), mk('aarav_sharma', 'Aarav Sharma', true),
    mk('priya_singh', 'Priya Singh', false), mk('rohit_kumar', 'Rohit Kumar', false));
  return d;
}
function normalizeDb(d) {
  const out = { users: [], posts: [], messages: [], stories: [], notifications: [], seq: 1 };
  if (d && typeof d === 'object') {
    if (Array.isArray(d.users)) out.users = d.users;
    if (Array.isArray(d.posts)) out.posts = d.posts;
    if (Array.isArray(d.messages)) out.messages = d.messages;
    if (Array.isArray(d.stories)) out.stories = d.stories;
    if (Array.isArray(d.notifications)) out.notifications = d.notifications;
    if (typeof d.seq === 'number' && d.seq > 0) out.seq = d.seq;
    if (d.pending && typeof d.pending === 'object') out.pending = d.pending;
  }
  return out;
}
function fileLoad() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return (d && Array.isArray(d.users)) ? d : null;
  } catch (e) { return null; }
}
function fileSave() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1)); } catch (e) { /* data write fail ho to request crash nahi hona chahiye */ } }
function sbSignal() { try { return AbortSignal.timeout(10000); } catch (e) { return undefined; } }
async function sbLoad() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=data', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, signal: sbSignal() });
  if (!r.ok) throw new Error('Supabase load HTTP ' + r.status);
  const rows = await r.json();
  if (Array.isArray(rows) && rows[0] && rows[0].data && Array.isArray(rows[0].data.users)) return rows[0].data;
  return null;
}
async function sbSave() {
  const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
  const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1', {
    method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal,count=exact' },
    body: JSON.stringify({ data: db }), signal: sbSignal() });
  if (!r.ok) throw new Error('Supabase save HTTP ' + r.status);
  let affected = null;
  const cr = r.headers.get('content-range');
  if (cr && cr.indexOf('/') >= 0) { const n = parseInt(cr.split('/')[1], 10); if (!isNaN(n)) affected = n; }
  if (affected > 0) { sbHasRow = true; return; }
  if (affected === null && sbHasRow) return; // header na mile, par row pehle se pakki hai — PATCH par bharosa
  // Row hi nahi hai (PATCH ne kuch affect nahi kiya) — upsert se bana do
  const ins = await fetch(SUPABASE_URL + '/rest/v1/app_state', {
    method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 1, data: db }), signal: sbSignal() });
  if (!ins.ok) throw new Error('Supabase insert HTTP ' + ins.status);
  sbHasRow = true;
}
async function loadDb(force) {
  if (dbLoading) return dbLoading;
  if (dbReady && !force) return;
  dbLoading = (async () => {
    try {
      if (SUPABASE_ON) {
        const data = await sbLoad();
        if (data) { db = normalizeDb(data); sbHasRow = true; }
        else { db = seedData(); await sbSave(); }
      } else {
        const data = fileLoad();
        if (data) db = normalizeDb(data);
        else { db = seedData(); fileSave(); }
      }
      dbHasData = true;
      lastLoadAt = Date.now();
    } catch (e) {
      // Storage fail ho jaye to request crash nahi hona chahiye — in-memory/seed DB se kaam chalao
      console.warn('[storage] load fail, in-memory DB se continue:', (e && e.message) || e);
      if (!dbHasData) { db = seedData(); dbHasData = true; }
    } finally { dbReady = true; dbLoading = null; }
  })();
  return dbLoading;
}
function ensureDb() { return loadDb(false); }
// Read endpoints par taza data: dusre instance ne kuch likha ho to wo bhi dikhe
// (chat polling, user search jaise cases ke liye). 4 second se purani load ho
// tabhi refresh; apna save chal raha ho to refresh skip (purana data na aaye).
async function refreshIfStale(p, method) {
  if (!SUPABASE_ON || method !== 'GET') return;
  if (p !== '/api/users' && p !== '/api/chat' && p !== '/api/chat/unread' && p !== '/api/chat/inbox' && p !== '/api/notifications' && p !== '/api/posts' && p !== '/api/stories' && p !== '/api/telegram/discover') return;
  if (pendingSaves > 0) return;
  if (Date.now() - lastLoadAt > 4000) await loadDb(true);
}
async function saveDb() {
  if (!SUPABASE_ON) { fileSave(); return; }
  pendingSaves++;
  try { await sbSave(); lastLoadAt = Date.now(); }
  catch (e) { console.warn('[storage] save fail:', (e && e.message) || e); }
  finally { pendingSaves--; }
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
    followers: (u.followers || []).length, following: (u.following || []).length,
    followerList: u.followers || [], followingList: u.following || [] };
}
function byName(name) { return db.users.find(u => u.username === String(name || '').toLowerCase()); }
// Admin ke liye rich user record. passwordHash KABHI nahi jata, aur E2EE
// publicKey ki value bhi nahi — sirf hasKey boolean (key set hai ya nahi).
function adminUser(u) {
  return { username: u.username, name: u.name, bio: u.bio || '', avatar: u.avatar,
    email: u.email || '', emailVerified: !!u.emailVerified,
    verified: !!u.verified, blocked: !!u.blocked,
    followers: (u.followers || []).length, following: (u.following || []).length,
    followerList: u.followers || [], followingList: u.following || [],
    postCount: db.posts.filter(x => x.username === u.username).length,
    messageCount: db.messages.filter(x => x.from === u.username).length,
    createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
    hasKey: !!u.publicKey };
}

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
        if (fid) { post.telegramFileId = fid; post.image = ''; await saveDb(); }
      }
    } else if (post.image.startsWith('http')) {
      const j = await tgCall('sendPhoto', { chat_id: TG_CHAT, photo: post.image, caption: '@' + post.username + ': ' + (post.caption || '') });
      const ph = j && j.result && j.result.photo;
      if (ph) { post.telegramFileId = ph[ph.length - 1].file_id; await saveDb(); }
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

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { send(res, 200, {}); return; }

  await ensureDb();
  await refreshIfStale(p, req.method);

  // Serve admin panel at /admin if the file sits next to the server folder
  if (p === '/admin' || p === '/admin/') {
    const f = path.join(__dirname, '..', 'admin', 'index.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(f)); return;
    }
  }
  if (p === '/' || p === '/health') { send(res, 200, { app: 'GramWasi', ok: true, telegramStorage: TG_ON, storage: SUPABASE_ON ? 'supabase' : 'file' }); return; }
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
      // Pending signup bhi username ko hold karta hai: kisi AUR email wale ka
      // pending hai to ye username nahi mil sakta. Wahi email ho to allow —
      // pending overwrite hokar naya code jayega (resend jaisa).
      db.pending = db.pending || {};
      const heldPend = db.pending[username];
      if (heldPend && heldPend.email !== email) return send(res, 409, { error: 'username pehle se liya gaya hai, dusra chuno' });
      if (db.users.some(x => x.email === email)) return send(res, 409, { error: 'is email se pehle hi account hai' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.pending = db.pending || {};
      db.pending[username] = { username, name: body.name || username, email,
        passwordHash: hash(body.password), code, codeAt: Date.now() };
      await saveDb();
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
      pend.codeAt = Date.now(); await saveDb();
      const sent = await sendMail(pend.email, 'GramWasi verification code',
        'Tumhara naya GramWasi verification code hai: ' + pend.code + '\nYe code 15 minute tak valid hai.');
      const out = { needVerify: true, mailSent: sent };
      if (!MAIL_CONFIGURED) out.devCode = pend.code;
      return send(res, 200, out);
    }
    if (p === '/api/verify-email' && req.method === 'POST') {
      // Sahi code = tab account BANTA hai. Galat code par kuch nahi banta.
      // Username pehle se kisi verified user ka hai to bina saboot ke success
      // NAHI milta — sirf wahi banda dobara verify ho sakta hai jiska pending
      // email usi account ke email se match kare AUR code sahi ho.
      const username = String(body.username || '').toLowerCase().trim();
      db.pending = db.pending || {};
      const pend = db.pending[username];
      const existing = byName(username);
      if (existing && existing.emailVerified) {
        if (pend && String(body.code || '') === pend.code && pend.email === existing.email) {
          delete db.pending[username]; await saveDb();
          return send(res, 200, { user: pub(existing), already: true });
        }
        // Dusre email wala pending is username par kabza nahi rakh sakta — hata do.
        if (pend && pend.email !== existing.email) { delete db.pending[username]; await saveDb(); }
        return send(res, 409, { error: 'ye username pehle se liya gaya hai — login karo ya dusra username chuno' });
      }
      if (!pend) return send(res, 404, { error: 'pehle signup karke code lo' });
      if (String(body.code || '') !== pend.code) return send(res, 400, { error: 'galat code — account nahi bana' });
      if (Date.now() - (pend.codeAt || 0) > 15 * 60 * 1000) { delete db.pending[username]; await saveDb(); return send(res, 400, { error: 'code expire ho gaya, dobara signup karo' }); }
      // Aakhri safety check, account bante hi pehle: is username ka user pehle
      // se maujood hai to DOOSRA account kabhi nahi banna chahiye.
      if (byName(username)) return send(res, 409, { error: 'ye username pehle se liya gaya hai — login karo ya dusra username chuno' });
      const u = { id: db.seq++, username, name: pend.name, bio: '', email: pend.email,
        emailVerified: true,
        avatar: 'https://picsum.photos/seed/' + username + '/150/150',
        passwordHash: pend.passwordHash, verified: false, blocked: false,
        followers: [], following: [], acceptedChats: [], blockedUsers: [], createdAt: Date.now() };
      db.users.push(u);
      delete db.pending[username];
      await saveDb();
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
      u.lastLoginAt = Date.now(); await saveDb();
      // Message-request system ke liye: kaunsi chats accept ho chuki hain aur
      // kaun blocked hai — app ko login par hi mil jata hai (purane records par
      // ye fields na ho to khali array).
      return send(res, 200, { user: pub(u),
        acceptedChats: Array.isArray(u.acceptedChats) ? u.acceptedChats : [],
        blockedUsers: Array.isArray(u.blockedUsers) ? u.blockedUsers : [] });
    }
    if (p === '/api/users' && req.method === 'GET') {
      return send(res, 200, { users: db.users.filter(u => !u.blocked).map(pub) });
    }
    if (p === '/api/profile' && req.method === 'POST') {
      // Profile update: sirf wahi fields badlo jo body me bheje gaye hain
      // (name / bio / avatar). Avatar data URL ho sakta hai — ~700KB tak ki
      // string allow hai, usse badi reject (400). pub() me name/bio/avatar
      // pehle se shamil hain, to response me updated profile turant dikhta hai.
      const u = byName(body.username);
      if (!u) return send(res, 404, { error: 'user nahi mila' });
      if (body.avatar !== undefined) {
        if (typeof body.avatar !== 'string' || body.avatar.length > 700 * 1024) {
          return send(res, 400, { error: 'avatar bahut bada hai (max ~700KB)' });
        }
      }
      if (body.name !== undefined) u.name = String(body.name);
      if (body.bio !== undefined) u.bio = String(body.bio);
      if (body.avatar !== undefined) u.avatar = body.avatar;
      await saveDb();
      return send(res, 200, { ok: true, user: pub(u) });
    }
    if (p === '/api/stories' && req.method === 'POST') {
      // Story lagana: 24 ghante tak rehti hai. Image string chahiye
      // (data URL, ~1.5MB tak). views me dekhene walon ke username jama hote hain.
      const me = byName(body.username);
      if (!me) return send(res, 404, { error: 'user nahi mila' });
      if (typeof body.image !== 'string' || !body.image || body.image.length > 1.5 * 1024 * 1024) {
        return send(res, 400, { error: 'story image chahiye (max ~1.5MB)' });
      }
      db.stories = db.stories || [];
      const story = { id: db.seq++, username: me.username, image: body.image,
        caption: body.caption ? String(body.caption) : '', at: Date.now(), views: [] };
      db.stories.push(story);
      await saveDb();
      return send(res, 201, { ok: true, story });
    }
    if (p === '/api/stories' && req.method === 'GET') {
      // Sirf pichhle 24 ghante ki stories, user ke hisaab se group karke —
      // sabse nayi story wala group sabse upar. Expire ho chuki stories
      // is read par db se hata bhi dete hain (aur kuch hata to save).
      db.stories = db.stories || [];
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const before = db.stories.length;
      db.stories = db.stories.filter(s => s && typeof s.at === 'number' && s.at > cutoff);
      if (db.stories.length !== before) await saveDb();
      const byUser = {};
      db.stories.forEach(s => {
        if (!byUser[s.username]) byUser[s.username] = [];
        byUser[s.username].push({ id: s.id, image: s.image, caption: s.caption || '', at: s.at, views: s.views || [] });
      });
      const groups = Object.keys(byUser).map(username => {
        const items = byUser[username].slice().sort((a, b) => a.at - b.at);
        return { username, items, latest: items.length ? items[items.length - 1].at : 0 };
      }).sort((a, b) => b.latest - a.latest)
        .map(g => ({ username: g.username, items: g.items }));
      return send(res, 200, { ok: true, stories: groups });
    }
    if (p === '/api/stories/view' && req.method === 'POST') {
      // Story dekhi gayi: viewer ka username views me jodo (ek baar hi).
      // Khud ki story dekhne se view nahi badhta.
      db.stories = db.stories || [];
      const story = db.stories.find(s => s.id === Number(body.storyId));
      if (!story) return send(res, 404, { error: 'story nahi mili' });
      const v = byName(body.viewer);
      const viewerName = v ? v.username : String(body.viewer || '').toLowerCase().trim();
      if (!viewerName) return send(res, 400, { error: 'viewer chahiye' });
      if (!Array.isArray(story.views)) story.views = [];
      if (viewerName !== story.username && story.views.indexOf(viewerName) < 0) {
        story.views.push(viewerName);
        await saveDb();
      }
      return send(res, 200, { ok: true, views: story.views.length });
    }
    if (p === '/api/keys' && req.method === 'POST') {
      // End-to-end encryption: user ki PUBLIC key server par rakhi jati hai.
      // Private key sirf user ke phone par rehti hai — server (aur Telegram
      // backup) ko sirf encrypted (cipher) message milta hai, asli text kabhi nahi.
      const u = byName(body.username);
      if (!u || typeof body.publicKey !== 'string' || body.publicKey.length > 4000) {
        return send(res, 400, { error: 'bad key' });
      }
      u.publicKey = body.publicKey; await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/follow' && req.method === 'POST') {
      // Do mode: (1) body.action = "follow" | "unfollow" ho to state EXPLICIT
      // set hoti hai — idempotent (pehle se follow hai to follow hi rehta hai,
      // toggle nahi hota; v8 app yahi bhejta hai taaki follow apne aap revert
      // na ho). (2) action na ho to purana TOGGLE behaviour (purane app
      // versions ke liye). Dono taraf ki list saath update hoti hai aur counts
      // pub() me lists ki length se bante hain — hamesha lists se sync.
      // Follow TRANSITION (nahi tha -> ho gaya) par target ko notification.
      if (!body.from || !body.to) return send(res, 400, { error: 'from aur to dono chahiye' });
      if (String(body.from).toLowerCase().trim() === String(body.to).toLowerCase().trim()) {
        return send(res, 400, { error: 'khud ko follow nahi kar sakte' });
      }
      const me = byName(body.from), other = byName(body.to);
      if (!me || !other) return send(res, 404, { error: 'user nahi mila' });
      if (!Array.isArray(me.following)) me.following = [];
      if (!Array.isArray(other.followers)) other.followers = [];
      const wasFollowing = me.following.indexOf(other.username) >= 0;
      let following;
      if (body.action === 'follow') following = true;
      else if (body.action === 'unfollow') following = false;
      else following = !wasFollowing;
      if (following && !wasFollowing) {
        me.following.push(other.username);
        if (other.followers.indexOf(me.username) < 0) other.followers.push(me.username);
        db.notifications = db.notifications || [];
        db.notifications.push({ id: db.seq++, user: other.username, type: 'follow',
          from: me.username, createdAt: Date.now(), read: false });
      } else if (!following && wasFollowing) {
        me.following.splice(me.following.indexOf(other.username), 1);
        const j = other.followers.indexOf(me.username);
        if (j >= 0) other.followers.splice(j, 1);
      }
      await saveDb();
      return send(res, 200, { ok: true, following, user: pub(other), me: pub(me) });
    }
    if (p === '/api/notifications' && req.method === 'GET') {
      // User ki notifications (abhi follow wali) — sabse nayi pehle, max 100.
      const me = String(url.searchParams.get('user') || '').toLowerCase().trim();
      if (!me) return send(res, 400, { error: 'user chahiye' });
      db.notifications = db.notifications || [];
      const list = db.notifications.filter(n => n.user === me)
        .slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
      return send(res, 200, { ok: true, notifications: list });
    }
    if (p === '/api/notifications/read' && req.method === 'POST') {
      // User ki saari notifications read mark kar do.
      const me = byName(body.user);
      if (!me) return send(res, 404, { error: 'user nahi mila' });
      db.notifications = db.notifications || [];
      db.notifications.forEach(n => { if (n.user === me.username) n.read = true; });
      await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/block-user' && req.method === 'POST') {
      // User-level block (admin wale account-block se alag). blocked explicit
      // boolean ho to wahi set hota hai, na ho to toggle. Block karne par
      // follow DONO taraf se hat jata hai (main use follow nahi karta, wo
      // mujhe nahi karta) aur chat band ho jati hai (send par 403, chat read
      // par khali list, inbox se gayab).
      const me = byName(body.user), other = byName(body.target);
      if (!me || !other) return send(res, 404, { error: 'user nahi mila' });
      if (me.username === other.username) return send(res, 400, { error: 'khud ko block nahi kar sakte' });
      if (!Array.isArray(me.blockedUsers)) me.blockedUsers = [];
      const has = me.blockedUsers.indexOf(other.username) >= 0;
      const blocked = body.blocked === undefined ? !has : !!body.blocked;
      if (blocked && !has) me.blockedUsers.push(other.username);
      if (!blocked && has) me.blockedUsers.splice(me.blockedUsers.indexOf(other.username), 1);
      if (blocked) {
        if (Array.isArray(me.following)) me.following = me.following.filter(n => n !== other.username);
        if (Array.isArray(me.followers)) me.followers = me.followers.filter(n => n !== other.username);
        if (Array.isArray(other.following)) other.following = other.following.filter(n => n !== me.username);
        if (Array.isArray(other.followers)) other.followers = other.followers.filter(n => n !== me.username);
      }
      await saveDb();
      return send(res, 200, { ok: true, blocked });
    }
    if (p === '/api/posts' && req.method === 'GET') {
      const posts = db.posts.slice().reverse().map(post => {
        const out = { ...post, user: post.username, author: pub(byName(post.username)) };
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
      db.posts.push(post); await saveDb();
      tgStorePostImage(post); // background me Telegram storage par bhej do (free space)
      return send(res, 201, { post: { ...post, user: post.username, author: pub(me) } });
    }
    if (p === '/api/posts/like' && req.method === 'POST') {
      const post = db.posts.find(x => x.id === body.postId);
      const me = byName(body.username);
      if (!post || !me) return send(res, 400, { error: 'bad like' });
      const i = post.likes.indexOf(me.username);
      if (i >= 0) post.likes.splice(i, 1); else post.likes.push(me.username);
      await saveDb(); return send(res, 200, { likes: post.likes.length, likedBy: post.likes });
    }
    if (p === '/api/posts/comment' && req.method === 'POST') {
      const post = db.posts.find(x => x.id === body.postId);
      const me = byName(body.username);
      if (!post || !me || !body.text) return send(res, 400, { error: 'bad comment' });
      post.comments.push({ username: me.username, text: String(body.text), at: Date.now() });
      await saveDb(); return send(res, 200, { comments: post.comments });
    }
    if (p === '/api/chat' && req.method === 'GET') {
      const me = url.searchParams.get('user'), other = url.searchParams.get('with');
      // Maine use block kiya hai to mujhe uski chat khali dikhegi.
      const meU = byName(me), otherU = byName(other);
      if (meU && otherU && (meU.blockedUsers || []).indexOf(otherU.username) >= 0) {
        return send(res, 200, { messages: [] });
      }
      const msgs = db.messages.filter(m =>
        (m.from === me && m.to === other) || (m.from === other && m.to === me));
      return send(res, 200, { messages: msgs });
    }
    if (p === '/api/chat/accept' && req.method === 'POST') {
      // Message request accept: partner ko meri acceptedChats me jodo —
      // uski chat ab Requests se main inbox me chali jayegi.
      const me = byName(body.user), other = byName(body.with);
      if (!me || !other) return send(res, 400, { error: 'user aur with dono chahiye' });
      if (!Array.isArray(me.acceptedChats)) me.acceptedChats = [];
      if (me.acceptedChats.indexOf(other.username) < 0) me.acceptedChats.push(other.username);
      await saveDb();
      return send(res, 200, { ok: true, acceptedChats: me.acceptedChats });
    }
    if (p === '/api/chat/inbox' && req.method === 'GET') {
      // Har partner ke saath ek conversation summary — sabse recent chat
      // sabse upar (lastAt DESC). Blocked partner bilkul nahi dikhte.
      // lastText sirf plaintext ka snippet hai; encrypted (enc) message ka
      // text server par hota hi nahi, isliye null.
      const me = byName(url.searchParams.get('user'));
      if (!me) return send(res, 404, { error: 'user nahi mila' });
      const blockedList = me.blockedUsers || [];
      const myFollowing = me.following || [];
      const convos = {};
      db.messages.forEach(m => {
        let partner = null;
        if (m.from === me.username) partner = m.to;
        else if (m.to === me.username) partner = m.from;
        if (!partner || partner === me.username) return;
        if (blockedList.indexOf(partner) >= 0) return;
        const c = convos[partner] || (convos[partner] = { with: partner, lastAt: 0,
          lastFrom: null, lastKind: 'text', lastText: null, unread: 0,
          hasSent: false, iFollow: myFollowing.indexOf(partner) >= 0 });
        if (m.from === me.username) c.hasSent = true;
        if (m.to === me.username && m.read !== true) c.unread++;
        const at = typeof m.at === 'number' ? m.at : 0;
        if (at >= c.lastAt) {
          c.lastAt = at; c.lastFrom = m.from;
          if (m.enc) { c.lastKind = 'enc'; c.lastText = null; }
          else if (String(m.text || '').startsWith('voice:')) { c.lastKind = 'voice'; c.lastText = String(m.text).slice(0, 80); }
          else { c.lastKind = 'text'; c.lastText = String(m.text || '').slice(0, 80); }
        }
      });
      const conversations = Object.keys(convos).map(k => convos[k]).sort((a, b) => b.lastAt - a.lastAt);
      return send(res, 200, { ok: true, conversations });
    }
    if (p === '/api/chat/unread' && req.method === 'GET') {
      // Har partner ke kitne message unread hain (badge count ke liye).
      // Apne bheje hue message khud ke liye kabhi unread nahi hote — sirf
      // to===user wale gine jate hain.
      const me = String(url.searchParams.get('user') || '').toLowerCase().trim();
      if (!me) return send(res, 400, { error: 'user chahiye' });
      const counts = {};
      let total = 0;
      db.messages.forEach(m => {
        if (m.to === me && m.read !== true) { counts[m.from] = (counts[m.from] || 0) + 1; total++; }
      });
      return send(res, 200, { ok: true, counts, total });
    }
    if (p === '/api/chat/read' && req.method === 'POST') {
      // Ek partner ke saare aaye hue message read mark kar do (chat khulte hi).
      const me = byName(body.user), other = byName(body.with);
      if (!body.user || !body.with || !me || !other) return send(res, 400, { error: 'user aur with dono chahiye' });
      db.messages.forEach(m => {
        if (m.from === other.username && m.to === me.username) m.read = true;
      });
      await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/app-version' && req.method === 'GET') {
      // Force update: app is endpoint se latest/min version check karta hai.
      return send(res, 200, { ok: true, latest: 8, min: 8,
        apkUrl: process.env.APP_APK_URL || 'https://thunderous-lolly-b19730.netlify.app/GramWasi.apk',
        notes: 'Naya version — follow notification, message request, voice fix aur chat fix. Update karke hi app chalega.' });
    }
    if (p === '/api/chat/send' && req.method === 'POST') {
      const from = byName(body.from), to = byName(body.to);
      if (!from || !to || !body.text) return send(res, 400, { error: 'bad message' });
      // Kisi ek taraf se bhi block hai to message nahi jayega.
      if ((from.blockedUsers || []).indexOf(to.username) >= 0 ||
          (to.blockedUsers || []).indexOf(from.username) >= 0) {
        return send(res, 403, { error: 'blocked' });
      }
      const m = { id: db.seq++, from: from.username, to: to.username, text: String(body.text), at: Date.now(), read: false };
      if (body.enc) m.enc = true; // E2EE payload hai — inbox me kind 'enc' dikhega, text snippet nahi
      db.messages.push(m); await saveDb();
      tgMirrorMessage(m); // Telegram par backup copy (free storage)
      return send(res, 201, { message: m });
    }
    // Admin endpoints
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin) return send(res, 401, { error: 'admin key chahiye' });
      if (p === '/api/admin/stats' && req.method === 'GET') {
        const storyCutoff = Date.now() - 24 * 60 * 60 * 1000;
        return send(res, 200, { users: db.users.length, posts: db.posts.length,
          messages: db.messages.length,
          likes: db.posts.reduce((a, x) => a + x.likes.length, 0),
          stories: (db.stories || []).filter(s => s && typeof s.at === 'number' && s.at > storyCutoff).length,
          pendingSignups: Object.keys(db.pending || {}).length });
      }
      if (p === '/api/admin/users' && req.method === 'GET') {
        // Rich user list admin panel ke liye — passwordHash kabhi nahi jata
        // (sirf hash store hota hai, dekhna mumkin hi nahi by design).
        return send(res, 200, { ok: true, users: db.users.map(adminUser) });
      }
      if (p === '/api/admin/reset-password' && req.method === 'POST') {
        // Password DIKHAYA nahi ja sakta (sirf hash hai) — admin ka sahi
        // tareeka yahi hai: user ke liye naya password SET kar do.
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 4) {
          return send(res, 400, { error: 'newPassword kam se kam 4 character ka chahiye' });
        }
        u.passwordHash = hash(body.newPassword);
        await saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/delete-user' && req.method === 'POST') {
        // User ko pura hata do: uske posts, stories, bheje/paaye message,
        // aur dusro ki followers/following lists se uska naam bhi.
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        const un = u.username;
        db.users = db.users.filter(x => x.username !== un);
        db.posts = db.posts.filter(x => x.username !== un);
        db.stories = (db.stories || []).filter(x => x.username !== un);
        db.messages = db.messages.filter(x => x.from !== un && x.to !== un);
        db.users.forEach(x => {
          if (Array.isArray(x.followers)) x.followers = x.followers.filter(n => n !== un);
          if (Array.isArray(x.following)) x.following = x.following.filter(n => n !== un);
        });
        await saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/delete-post' && req.method === 'POST') {
        const idx = db.posts.findIndex(x => x.id === Number(body.postId));
        if (idx < 0) return send(res, 404, { error: 'post nahi mila' });
        db.posts.splice(idx, 1);
        await saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/verify' && req.method === 'POST') {
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        u.verified = !!body.verified; await saveDb();
        return send(res, 200, { user: pub(u) });
      }
      if (p === '/api/admin/block' && req.method === 'POST') {
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        u.blocked = !!body.blocked; await saveDb();
        return send(res, 200, { user: pub(u) });
      }
    }
    send(res, 404, { error: 'route nahi mila' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
}

const server = http.createServer(handleRequest);

ensureDb(); // warm-up load (handleRequest bhi har request par ensureDb karta hai)
if (require.main === module) {
  server.listen(PORT, () => console.log('GramWasi server running on port ' + PORT));
}
module.exports = handleRequest;
