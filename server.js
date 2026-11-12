// Front of Drones: сервер (Node.js + Socket.io)
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';          // адрес твоего сайта на GitHub Pages
const OWNER_NICK = 'Profi_7783', OWNER = OWNER_NICK.toLowerCase();
const OWNER_PASS = process.env.OWNER_PASSWORD;             // пароль владельца задаётся в настройках хостинга
const FILE = process.env.DATA_FILE || './data.json';

let db = { accounts: {}, sessions: {}, perks: {}, news: [], votes: {}, chat: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
let pending = 0;
const save = () => { if (pending) return; pending = 1; setTimeout(() => { pending = 0; fs.writeFile(FILE, JSON.stringify(db), () => {}); }, 1500); };

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (p, salt) => crypto.scryptSync(p, salt, 32);
const setPass = (a, p) => { a.salt = crypto.randomBytes(16).toString('hex'); a.hash = scrypt(p, a.salt).toString('hex'); };
const okPass = (a, p) => { const x = scrypt(p, a.salt), y = Buffer.from(a.hash, 'hex'); return x.length === y.length && crypto.timingSafeEqual(x, y); };

if (OWNER_PASS) {
  const a = db.accounts[OWNER] || (db.accounts[OWNER] = { n: OWNER_NICK, tg: 'owner', ts: Date.now() });
  setPass(a, OWNER_PASS); save();
} else console.warn('ВНИМАНИЕ: не задан OWNER_PASSWORD, владелец не сможет войти');

const pub = a => ({ n: a.n, k: a.n.toLowerCase(), tg: a.tg || '' });
const users = () => Object.values(db.accounts).filter(a => a.n.toLowerCase() !== OWNER).map(pub);
const tries = {};
const limited = ip => { const t = (tries[ip] = (tries[ip] || []).filter(x => Date.now() - x < 60000)); t.push(Date.now()); return t.length > 12; };
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); s.end('Front of Drones server OK'); });
const io = new Server(srv, { cors: { origin: ORIGIN === '*' ? '*' : ORIGIN.split(',') } });
const online = () => { const s = new Set(); for (const [, x] of io.sockets.sockets) if (x.data.k) s.add(x.data.k); return s.size; };
const pushOnline = () => io.to('in').emit('online', online());

io.on('connection', sock => {
  const ip = (sock.handshake.headers['x-forwarded-for'] || sock.handshake.address || '').split(',')[0];
  const me = () => sock.data.k && db.accounts[sock.data.k];
  const isOwner = () => sock.data.k === OWNER;
  const snapshot = () => ({ me: pub(me()), owner: isOwner(), perks: db.perks, news: db.news, votes: Object.values(db.votes), chat: db.chat.slice(-80), users: isOwner() ? users() : [] });
  const enter = k => { sock.data.k = k; sock.join('in'); if (k === OWNER) sock.join('owner'); pushOnline(); };

  const auth = (reg) => (d, cb) => {
    if (typeof cb !== 'function') return;
    const n = clean(d && d.n, 20), p = String((d && d.p) || ''), k = n.toLowerCase();
    if (limited(ip)) return cb({ ok: 0, err: 'Слишком много попыток, подожди минуту' });
    if (!/^[A-Za-z0-9_]{3,20}$/.test(n)) return cb({ ok: 0, err: 'Ник: 3–20 символов, латиница, цифры и _' });
    if (p.length < 6 || p.length > 64) return cb({ ok: 0, err: 'Пароль: от 6 до 64 символов' });
    let a = db.accounts[k];
    if (reg) {
      if (a || k === OWNER) return cb({ ok: 0, err: 'Этот ник уже занят' });
      a = db.accounts[k] = { n, ts: Date.now() }; setPass(a, p);
      io.to('owner').emit('users', users());
    } else if (!a || !a.hash || !okPass(a, p)) return cb({ ok: 0, err: 'Неверный ник или пароль' });
    const t = crypto.randomBytes(24).toString('hex'); db.sessions[sha(t)] = k; save();
    enter(k); cb({ ok: 1, token: t, ...snapshot() });
  };
  sock.on('register', auth(1));
  sock.on('login', auth(0));

  sock.on('resume', (d, cb) => {
    if (typeof cb !== 'function') return;
    const k = db.sessions[sha(String((d && d.t) || ''))];
    if (!k || !db.accounts[k]) return cb({ ok: 0 });
    enter(k); cb({ ok: 1, ...snapshot() });
  });
  sock.on('logout', d => { delete db.sessions[sha(String((d && d.t) || ''))]; save(); });

  sock.on('setTg', (v, cb) => {
    const a = me(); if (!a || typeof cb !== 'function') return;
    const t = clean(v, 40).replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(t)) return cb({ ok: 0, err: 'Ник в Telegram: 5–32 символа, латиница, цифры и _' });
    a.tg = '@' + t; save(); io.to('owner').emit('users', users()); cb({ ok: 1, me: pub(a) });
  });

  sock.on('chat:send', t => {
    const a = me(); t = clean(t, 300);
    if (!a || !a.tg || !t || Date.now() - (sock.data.last || 0) < 700) return;
    sock.data.last = Date.now();
    const m = { id: Date.now() + '-' + crypto.randomBytes(2).toString('hex'), u: a.n, t, ts: Date.now() };
    db.chat.push(m); if (db.chat.length > 200) db.chat.shift(); save(); io.to('in').emit('chat:new', m);
  });
  sock.on('chat:del', id => { if (!isOwner()) return; db.chat = db.chat.filter(m => m.id !== id); save(); io.to('in').emit('chat:del', id); });

  sock.on('news:post', (t, cb) => {
    if (typeof cb !== 'function') return;
    if (!isOwner()) return cb({ ok: 0, err: 'Только владелец' });
    t = clean(t, 800); if (!t) return cb({ ok: 0, err: 'Пустая новость' });
    const n = { id: 'n' + Date.now(), t, ts: Date.now() }; db.news.push(n); save(); io.to('in').emit('news:new', n); cb({ ok: 1 });
  });
  sock.on('news:del', id => {
    if (!isOwner()) return;
    db.news = db.news.filter(n => n.id !== id);
    for (const k of Object.keys(db.votes)) if (db.votes[k].nid === id) delete db.votes[k];
    save(); io.to('in').emit('news:del', id);
  });

  sock.on('vote', d => {
    const a = me(); if (!a || !d || !db.news.some(n => n.id === d.nid) || (d.v !== 1 && d.v !== -1)) return;
    const k = a.n.toLowerCase(), id = d.nid + '_' + k, cur = db.votes[id];
    const v = cur && cur.v === d.v ? 0 : d.v;
    if (v) db.votes[id] = { id, nid: d.nid, k, v }; else delete db.votes[id];
    save(); io.to('in').emit('vote:set', { id, nid: d.nid, k, v });
  });

  sock.on('perk:set', (d, cb) => {
    if (typeof cb !== 'function') return;
    if (!isOwner()) return cb({ ok: 0, err: 'Только владелец может выдавать привилегии' });
    const k = clean(d && d.k, 20).toLowerCase();
    if (!db.accounts[k]) return cb({ ok: 0, err: 'Игрок не найден' });
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 8)
      .map(x => ({ t: clean(x && x.t, 30), c: /^#[0-9a-f]{6}$/i.test(x && x.c) ? x.c : '#98a093' })).filter(x => x.t);
    if (items.length) db.perks[k] = items; else delete db.perks[k];
    save(); io.to('in').emit('perks:set', { k, items }); cb({ ok: 1 });
  });

  sock.on('disconnect', () => setTimeout(pushOnline, 200));
});

srv.listen(PORT, () => console.log('Front of Drones server on port ' + PORT));
