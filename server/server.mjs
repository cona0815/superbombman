// ============================================================
// 成語炸彈超人 多人連線伺服器
// 版本：v6.0.0　日期：2026-10-21　協定：1
// ・老師控制台：金鑰登入、一頁開多間房（成語大亂鬥／炸彈超人）、開始、結束、鎖房、踢人
// ・學生大廳：只列出老師開好的房間，點一下加入；加入後分享自己的 Tinkercad 人物給同房同學
// ・遊戲世界由「主機學生」（房間裡第一位準備好的人）的瀏覽器計算，伺服器負責：
//   房間／人員管理、轉送位置與事件、主機離線時換人接手、保存成績給老師
// 架構與「大橋大車拚」相同：Node.js + ws，部署在 Render（render.yaml）
// ============================================================
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

export const PROTOCOL = 1;
export const SERVER_VERSION = 'v6.0.0 (2026-10-21)';
export const MODES = { brawl: '成語大亂鬥', bomb: '炸彈超人' };
const MAX_VERTICES = 240000, MAX_MESSAGE = 6 * 1024 * 1024;
const nick = v => typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().slice(0, 12) : '';
const label = v => typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().slice(0, 16) : '';
const token = () => randomBytes(24).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length <= 256 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const OLD_CLIENT = '網站已更新，請按 Ctrl+F5 重新整理後再加入。';
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/* 人物模型：量化後的頂點（位置 uint16 ×3、顏色 uint8 ×3），只接受有界的靜態三角形 */
export function validateModel(m) {
  if (!m || m.v !== 2 || !Number.isInteger(m.n) || m.n < 3 || m.n > MAX_VERTICES || m.n % 3) throw Error('人物最多 8 萬個三角面，請在 Tinkercad 簡化後再匯出。');
  if (!Array.isArray(m.bb) || m.bb.length !== 6 || m.bb.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6)) throw Error('人物資料格式不正確。');
  for (const [k, per] of [['p', 6], ['c', 3]]) {
    if (typeof m[k] !== 'string' || m[k].length > 4000000 || !B64.test(m[k])) throw Error('人物資料格式不正確。');
    if (Buffer.from(m[k], 'base64').length !== m.n * per) throw Error('人物資料長度不正確。');
  }
  return { v: 2, n: m.n, bb: m.bb.map(v => +v), p: m.p, c: m.c };
}

export function createServer({ teacherKey = 'local-classroom-test', origins = [], maxPlayers = 8, maxRooms = 12, graceMs = 60000, teacherGraceMs = 30 * 60000, countdownMs = 4000, maxGameMs = 15 * 60000, production = false, now: clock = () => Date.now() } = {}) {
  if (production && (teacherKey === 'local-classroom-test' || teacherKey.trim().length < 16 || !origins.length || origins.includes('*'))) throw Error('正式環境必須設定至少 16 字元的 TEACHER_KEY 及明確的 ALLOWED_ORIGINS。');
  const rooms = new Map(), clients = new Set(), attempts = new Map(), teachers = new Map();
  const stats = { started: clock(), games: 0 };
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const o = req.headers.origin; if (o && (origins.includes(o) || !origins.length)) res.setHeader('Access-Control-Allow-Origin', o);
    const url = (req.url || '').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'bomber-idiom', protocol: PROTOCOL, version: SERVER_VERSION, rooms: rooms.size, maxRooms, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0), uptime: Math.round((clock() - stats.started) / 1000) }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  const send = (ws, msg) => { if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 10 * 1024 * 1024) { ws.close(1013, 'Slow connection'); return; } ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } };
  const people = r => [...r.players.values()];
  const publicPerson = (p, forTeacher) => {
    const o = { id: p.id, name: p.name, slot: p.slot, connected: !!p.ws, model: !!p.model, ready: !!p.model && !!p.ws, score: p.score, kills: p.kills, alive: p.alive, rank: p.rank };
    if (forTeacher) { o.rtt = p.rtt || 0; o.cls = p.cls || ''; }
    return o;
  };
  const teacherOnline = r => { const t = teachers.get(r.owner); return !!(t && t.sockets.size); };
  const state = (r, forTeacher) => ({ t: 'state', v: PROTOCOL, code: r.code, label: r.label, mode: r.mode, phase: r.phase, epoch: r.epoch, locked: r.locked, limit: maxPlayers, minutes: r.minutes, host: r.host, seed: r.seed, startAt: r.startAt || 0, now: clock(), teacherOnline: teacherOnline(r), people: people(r).sort((a, b) => a.slot - b.slot).map(p => publicPerson(p, forTeacher)) });
  const publishStudents = r => { const s = JSON.stringify(state(r, false)); for (const p of r.players.values()) send(p.ws, s); };
  const consoleMsg = t => ({ t: 'console', v: PROTOCOL, now: clock(), maxRooms, limit: maxPlayers, modes: MODES, rooms: [...t.rooms].map(c => rooms.get(c)).filter(Boolean).map(r => ({ ...state(r, true), history: r.history })) });
  const flushTeacher = t => { if (!t || !t.sockets.size) return; t.pending = false; const m = JSON.stringify(consoleMsg(t)); for (const ws of t.sockets) send(ws, m); };
  const publishTeacher = r => { const t = teachers.get(r.owner); if (t) t.pending = true; };
  const publish = r => { publishStudents(r); publishTeacher(r); r.dirty = false; };
  const end = (r, why) => {
    rooms.delete(r.code); const t = teachers.get(r.owner); if (t) t.rooms.delete(r.code);
    for (const p of r.players.values()) { if (p.ws) { p.ws.room = null; p.ws.person = null; send(p.ws, { t: 'ended', reason: why || '老師已結束這間房。' }); p.ws.close(1000, 'Room ended'); } }
    r.players.clear(); if (t) flushTeacher(t);
  };
  const removePlayer = (r, p) => { r.players.delete(p.id); if (r.host === p.id) pickHost(r); publish(r); };
  // 主機：第一位準備好（有人物、在線）的學生；離線就換下一位，並通知大家
  const pickHost = r => {
    const cand = people(r).filter(p => p.ws && p.model).sort((a, b) => a.slot - b.slot);
    const next = cand.length ? cand[0].id : null;
    if (next !== r.host) { r.host = next; r.dirty = true; if (r.phase === 'play' && next) for (const p of r.players.values()) send(p.ws, { t: 'host', id: next, epoch: r.epoch }); }
  };
  // 學生大廳：列出已開好的房間
  const watchers = new Set();
  const roomList = () => [...rooms.values()].sort((a, b) => a.createdAt - b.createdAt).map(r => { const n = r.players.size; return { code: r.code, label: r.label, mode: r.mode, modeName: MODES[r.mode], phase: r.phase, minutes: r.minutes, n, limit: maxPlayers, locked: r.locked, open: !r.locked && n < maxPlayers && r.phase !== 'play' && r.phase !== 'countdown' }; });
  let lastListSig = '';
  const pushList = force => { if (!watchers.size) return; const list = roomList(), sig = JSON.stringify(list); if (!force && sig === lastListSig) return; lastListSig = sig; const m = JSON.stringify({ t: 'rooms', v: PROTOCOL, rooms: list }); for (const w of watchers) send(w, m); };
  const resetPlayer = q => { q.score = 0; q.kills = 0; q.alive = true; q.rank = 0; };
  function startGame(r, now) {
    const ready = people(r).filter(q => q.ws && q.model);
    if (!ready.length) throw Error('請至少等一位學生加入並分享好人物後再開始。');
    if (people(r).some(q => q.ws && !q.model)) throw Error('還有學生正在分享人物，請稍候幾秒再開始。');
    // 沒連線的人先移出，免得占位
    for (const q of people(r)) if (!q.ws) r.players.delete(q.id);
    r.phase = 'countdown'; r.epoch++; r.seed = randomBytes(4).readUInt32LE(0); r.startAt = now + countdownMs; r.gameNo = (r.gameNo || 0) + 1; r.result = null; stats.games++;
    for (const q of people(r)) resetPlayer(q);
    pickHost(r);
    const msg = JSON.stringify({ t: 'start', v: PROTOCOL, epoch: r.epoch, mode: r.mode, seed: r.seed, startAt: r.startAt, now, minutes: r.minutes, host: r.host, people: people(r).sort((a, b) => a.slot - b.slot).map(p => publicPerson(p, false)) });
    for (const q of people(r)) send(q.ws, msg);
  }
  function finishGame(r, now, ranking, why) {
    if (r.phase !== 'play' && r.phase !== 'countdown') return;
    r.phase = 'results'; r.epoch++;
    const list = Array.isArray(ranking) ? ranking.slice(0, maxPlayers) : [];
    list.forEach((e, i) => { const q = r.players.get(e && e.id); if (!q) return; q.rank = i + 1; q.score = Math.max(0, e.score | 0); q.kills = Math.max(0, e.kills | 0); q.alive = !!e.alive; });
    r.result = { at: now, mode: r.mode, no: r.gameNo, why: why || '', ranking: people(r).filter(q => q.rank).sort((a, b) => a.rank - b.rank).map(q => ({ name: q.name, cls: q.cls, rank: q.rank, score: q.score, kills: q.kills })) };
    r.history.push(r.result); if (r.history.length > 20) r.history.shift();
    const msg = JSON.stringify({ t: 'result', epoch: r.epoch, ranking: r.result.ranking, why: r.result.why });
    for (const q of people(r)) send(q.ws, msg);
    r.dirty = true;
  }

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowed = origins.length ? origins.includes(origin) : !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || /^file:/.test(origin) || origin === 'null';
    if ((req.url || '').split('?')[0] !== '/room' || !allowed || clients.size >= maxRooms * maxPlayers + 40) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const ip = req.socket.remoteAddress, now = clock(), a = attempts.get(ip) || { at: now, count: 0 };
    if (now - a.at > 60000) { a.at = now; a.count = 0; } a.count++; attempts.set(ip, a);
    if (a.count > 400) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }   // 全班共用學校出口 IP
    wss.handleUpgrade(req, socket, head, ws => { ws.alive = true; ws.ip = ip; wss.emit('connection', ws, req); });
  });

  wss.on('connection', ws => {
    clients.add(ws); ws.born = clock(); ws.rate = { at: clock(), n: 0, bytes: 0 }; ws.assets = 0;
    ws.on('pong', () => ws.alive = true);
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      const now = clock();
      try {
        if (now - ws.rate.at > 1000) ws.rate = { at: now, n: 0, bytes: 0 };
        // 遊戲中主機每秒最多：位置 25 + 快照 15 + 事件；一般學生：位置 25 + 事件
        if (++ws.rate.n > 90 || (ws.rate.bytes += data.length) > MAX_MESSAGE + 400000) { ws.close(1008, 'Rate limit'); return; }
        if (binary) throw Error('只接受遊戲訊息。');
        const m = JSON.parse(data.toString()); if (!m || typeof m !== 'object') throw Error('訊息格式不正確。');
        if (m.t === 'list') { if (m.v !== PROTOCOL) throw Error(OLD_CLIENT); if (ws.teacher || ws.room) return; watchers.add(ws); ws.watch = true; send(ws, { t: 'rooms', v: PROTOCOL, rooms: roomList() }); return; }
        if (m.t === 'ping') { send(ws, { t: 'pong', c: m.c, s: now }); if (ws.person && Number.isFinite(m.rtt)) ws.person.rtt = Math.max(0, Math.min(9999, Math.round(m.rtt))); return; }

        // ---------- 老師控制台 ----------
        if (m.t === 'hello' && m.role === 'teacher') {
          if (m.v !== PROTOCOL) throw Error(OLD_CLIENT);
          if (ws.teacher || ws.room) throw Error('已經登入。');
          ws.joinTries = (ws.joinTries || 0) + 1; if (ws.joinTries > 5) { ws.close(1008, 'Too many attempts'); return; }
          let t = null;
          if (m.token) t = [...teachers.values()].find(x => equal(m.token, x.token));
          if (!t) {
            if (!equal(m.key, teacherKey)) throw Error(m.token ? '老師登入已過期，請重新輸入開房金鑰。' : '老師開房金鑰不正確。');
            t = { id: randomBytes(8).toString('hex'), token: token(), rooms: new Set(), sockets: new Set(), gone: 0 };
            teachers.set(t.id, t);
          }
          t.sockets.add(ws); t.gone = 0; ws.teacher = t;
          send(ws, { ...consoleMsg(t), t: 'console', token: t.token, welcome: true, version: SERVER_VERSION });
          for (const c of t.rooms) { const r = rooms.get(c); if (r) publishStudents(r); }
          return;
        }
        if (ws.teacher) {
          const t = ws.teacher;
          if (m.t === 'create') {
            if (rooms.size >= maxRooms) throw Error(`伺服器最多同時 ${maxRooms} 間房，請先結束用完的房間。`);
            const mode = MODES[m.mode] ? m.mode : 'brawl';
            const minutes = Math.max(1, Math.min(10, m.minutes | 0 || 4));
            let code; do { code = randomBytes(4).toString('hex').toUpperCase(); } while (rooms.has(code));
            const r = { code, label: label(m.label) || `第 ${t.rooms.size + 1} 房`, owner: t.id, mode, minutes, phase: 'lobby', epoch: 1, locked: false, players: new Map(), host: null, seed: 0, startAt: 0, createdAt: now, history: [], result: null };
            rooms.set(code, r); t.rooms.add(code); publish(r); send(ws, { t: 'created', code });
            return;
          }
          if (m.t === 'startAll') {
            const done = [], skipped = [];
            for (const c of t.rooms) { const r = rooms.get(c); if (!r || !['lobby', 'results'].includes(r.phase)) continue; try { startGame(r, now); done.push(c); publish(r); } catch (e) { skipped.push(`${r.label}：${e.message}`); } }
            send(ws, { t: 'notice', message: done.length ? `已同時開始 ${done.length} 間房。` + (skipped.length ? ' 未開始：' + skipped.join('；') : '') : '沒有可開始的房間。' + (skipped.length ? ' ' + skipped.join('；') : '') });
            return;
          }
          const r = rooms.get(String(m.code || '').toUpperCase());
          if (!r || r.owner !== t.id) throw Error('找不到這間房，可能已經結束。');
          if (m.t === 'lock') { r.locked = !!m.locked; publish(r); return; }
          if (m.t === 'end') { end(r); return; }
          if (m.t === 'rename') { r.label = label(m.label) || r.label; publish(r); return; }
          if (m.t === 'setup') {
            if (r.phase === 'play' || r.phase === 'countdown') throw Error('比賽中不能改設定。');
            if (m.mode != null && MODES[m.mode]) r.mode = m.mode;
            if (m.minutes != null) r.minutes = Math.max(1, Math.min(10, m.minutes | 0));
            r.epoch++; publish(r); return;
          }
          if (m.t === 'kick') { const q = r.players.get(m.id); if (q) { if (q.ws) { send(q.ws, { t: 'ended', reason: '老師已請你離開這間房。' }); q.ws.room = null; q.ws.person = null; q.ws.close(1000, 'Kicked'); } removePlayer(r, q); } return; }
          if (m.t === 'start') { if (r.phase !== 'lobby' && r.phase !== 'results') throw Error('目前不能開始新的一場。'); startGame(r, now); publish(r); return; }
          if (m.t === 'stop') { if (r.phase === 'play' || r.phase === 'countdown') { finishGame(r, now, [], '老師提前結束。'); publish(r); } return; }
          if (m.t === 'lobby') { r.phase = 'lobby'; r.epoch++; r.startAt = 0; for (const q of people(r)) resetPlayer(q); const msg = JSON.stringify({ t: 'lobby', epoch: r.epoch }); for (const q of people(r)) send(q.ws, msg); publish(r); return; }
          throw Error('不支援的操作。');
        }

        // ---------- 學生 ----------
        if (m.t === 'join') {
          if (m.v !== PROTOCOL) throw Error(OLD_CLIENT);
          if (ws.room) throw Error('已經在房間中。');
          ws.joinTries = (ws.joinTries || 0) + 1; if (ws.joinTries > 8) { ws.close(1008, 'Too many attempts'); return; }
          const r = rooms.get(String(m.code || '').toUpperCase()); if (!r) throw Error('找不到房間，請確認房號或請老師重新開房。');
          let p = null;
          if (m.token) p = people(r).find(q => equal(m.token, q.token));
          if (p?.ws && p.ws !== ws) { const old = p.ws; old.room = null; old.person = null; send(old, { t: 'ended', reason: '你在另一個分頁或裝置重新連線了。' }); old.close(1000, 'Replaced'); }
          if (!p && ['countdown', 'play'].includes(r.phase)) throw Error('這一場已經開始，請等下一場。');
          if (!p && (r.locked || r.players.size >= maxPlayers)) throw Error(r.locked ? '老師已鎖定房間。' : '房間人數已滿。');
          if (!p) {
            const name = nick(m.name); if (!name) throw Error('請輸入座號或暱稱。');
            const occupied = new Set(people(r).map(q => q.slot)); let slot = 0; while (occupied.has(slot)) slot++;
            p = { id: randomBytes(6).toString('hex'), token: token(), name, cls: nick(m.cls), slot, model: null, score: 0, kills: 0, alive: true, rank: 0 };
            r.players.set(p.id, p);
          }
          p.ws = ws; p.gone = 0; ws.room = r; ws.person = p; watchers.delete(ws); ws.watch = false;
          send(ws, { ...state(r, false), t: 'welcome', id: p.id, token: p.token, version: SERVER_VERSION });
          if (p.model && !r.host) pickHost(r);
          publish(r); return;
        }
        const r = ws.room, p = ws.person; if (!r || !p || !rooms.has(r.code)) throw Error('請先加入房間。');
        if (m.t === 'model') {
          if (!p.model) p.model = validateModel(m.model);
          send(ws, { t: 'modelOK' }); if (!r.host) pickHost(r); publish(r); return;
        }
        if (m.t === 'getModel') {
          if (now - (ws.assetAt || 0) > 1000) { ws.assetAt = now; ws.assets = 0; } if (++ws.assets > 12) throw Error('人物請求過於頻繁。');
          const target = r.players.get(m.id); if (target?.model) send(ws, { t: 'model', id: target.id, model: target.model }); return;
        }
        // ---- 遊戲中的轉送 ----
        if (m.t === 'pose') {   // 位置：轉給同房其他人
          if (r.phase !== 'play' && r.phase !== 'countdown') return;
          if (now - (p.poseAt || 0) < 35) return; p.poseAt = now;
          if (typeof m.d !== 'string' || m.d.length > 400) throw Error('位置資料不正確。');
          const out = JSON.stringify({ t: 'pose', id: p.id, d: m.d });
          for (const q of r.players.values()) if (q !== p) send(q.ws, out);
          return;
        }
        if (m.t === 'ev') {   // 學生動作 → 主機
          if (r.phase !== 'play') return;
          if (typeof m.d !== 'string' || m.d.length > 2000) throw Error('事件資料不正確。');
          const h = r.host && r.players.get(r.host); if (h && h.ws) send(h.ws, JSON.stringify({ t: 'ev', id: p.id, d: m.d }));
          return;
        }
        if (m.t === 'snap' || m.t === 'hev') {   // 主機 → 同房其他人
          if (p.id !== r.host) return;
          if (r.phase !== 'play' && r.phase !== 'countdown') return;
          if (typeof m.d !== 'string' || m.d.length > 60000) throw Error('快照資料不正確。');
          const out = JSON.stringify({ t: m.t, d: m.d });
          for (const q of r.players.values()) if (q !== p) send(q.ws, out);
          return;
        }
        if (m.t === 'playing') { if (r.phase === 'countdown' && now >= r.startAt - 500) { r.phase = 'play'; r.dirty = true; } return; }
        if (m.t === 'result') { if (p.id !== r.host) return; finishGame(r, now, m.ranking, label(m.why)); publish(r); return; }
        if (m.t === 'leave') { ws.room = null; ws.person = null; removePlayer(r, p); ws.close(1000, 'Left'); return; }
        if (['start', 'lobby', 'lock', 'end', 'kick', 'stop'].includes(m.t)) throw Error('這個功能由老師操作。');
        throw Error('不支援的操作。');
      } catch (e) { send(ws, { t: 'error', message: e instanceof SyntaxError ? '訊息格式不正確。' : e.message }); }
      finally { if (ws.teacher && ws.teacher.pending) flushTeacher(ws.teacher); }
    });
    ws.on('close', () => {
      clients.delete(ws); watchers.delete(ws);
      if (ws.teacher) { const t = ws.teacher; t.sockets.delete(ws); if (!t.sockets.size) { t.gone = clock(); for (const c of t.rooms) { const r = rooms.get(c); if (r) publishStudents(r); } } }
      const r = ws.room, p = ws.person; if (r && p && p.ws === ws) { p.ws = null; p.gone = clock(); if (r.host === p.id) pickHost(r); publish(r); }
    });
  });

  let tickN = 0;
  const tick = setInterval(() => {
    const now = clock(); tickN++;
    if (tickN % 10 === 0) pushList(false);
    for (const r of [...rooms.values()]) {
      if (r.phase === 'countdown' && now >= r.startAt) { r.phase = 'play'; r.dirty = true; }
      if (r.phase === 'play') {
        if (!people(r).some(q => q.ws)) { r.phase = 'lobby'; r.epoch++; r.dirty = true; }
        else if (now - r.startAt > maxGameMs) finishGame(r, now, [], '超過時間上限，伺服器自動結束。');
      }
      for (const p of [...r.players.values()]) if (!p.ws && now - p.gone > graceMs) { r.players.delete(p.id); if (r.host === p.id) pickHost(r); r.dirty = true; }
      if (r.dirty && tickN % 5 === 0) publish(r);
    }
    for (const t of [...teachers.values()]) {
      if (t.pending && tickN % 3 === 0) flushTeacher(t);
      if (!t.sockets.size && t.gone && now - t.gone > teacherGraceMs) { for (const c of [...t.rooms]) { const r = rooms.get(c); if (r) end(r, '老師離線太久，房間已關閉。'); } teachers.delete(t.id); }
      else if (!t.rooms.size && !t.sockets.size && now - (t.gone || now) > 60000) teachers.delete(t.id);
    }
  }, 100); tick.unref?.();
  const heartbeat = setInterval(() => { for (const ws of clients) { if (!ws.alive || !ws.room && !ws.teacher && !ws.watch && clock() - ws.born > 20000) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } for (const [ip, a] of attempts) if (clock() - a.at > 60000) attempts.delete(ip); }, 10000); heartbeat.unref?.();
  return { server, rooms, teachers, stats, async close() { clearInterval(tick); clearInterval(heartbeat); for (const ws of clients) ws.terminate(); wss.close(); await new Promise(r => server.close(r)); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const production = process.env.NODE_ENV === 'production';
  const origins = [...new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean))];
  const int = (k, d) => { const v = parseInt(process.env[k] || '', 10); return Number.isFinite(v) && v > 0 ? v : d; };
  const app = createServer({ production, teacherKey: process.env.TEACHER_KEY || 'local-classroom-test', origins, maxRooms: int('MAX_ROOMS', 12), maxPlayers: Math.min(8, int('MAX_PLAYERS', 8)) });
  app.server.listen(Number(process.env.PORT || 8787), process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1'), () => console.log(`Bomber Idiom room server ${SERVER_VERSION} ready; health endpoint: /health`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
}
