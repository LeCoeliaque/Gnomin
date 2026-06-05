/* =========================================================================
   Gnoming A-Round — Realtime Server (Node + ws)
   Room-code based. Authoritative game state. Render-free-tier friendly.
   ========================================================================= */
const http = require('http');
const { WebSocketServer } = require('ws');
const E = require('./engine.js');

const PORT = process.env.PORT || 8080;

/* ---- Rooms ----
rooms[code] = {
  code, hostId, players:[{id,name,ws,connected}],
  state (engine state or null in lobby), config, started,
  createdAt, lastActive
}
*/
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

// Health endpoint so Render (and keep-alive pingers) get a 200.
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Gnoming A-Round server is awake. Rooms: ' + rooms.size);
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server });

function send(ws, type, payload) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

// Build a per-player view: hide other players' face-down card values & own face-down values.
function viewFor(room, playerId) {
  const s = room.state;
  if (!s) {
    return {
      phase: 'lobby', code: room.code, hostId: room.hostId,
      players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected })),
      config: room.config,
    };
  }
  const maskGrid = (p, isSelf) => p.grid.map(cell => {
    if (!cell.card) return { faceUp: cell.faceUp, card: null };
    if (cell.faceUp) return { faceUp: true, card: cell.card };
    // face-down: never reveal value to anyone (not even self)
    return { faceUp: false, card: { hidden: true } };
  });

  return {
    phase: s.phase,
    code: room.code,
    hostId: room.hostId,
    round: s.round,
    currentIdx: s.currentIdx,
    dealerIdx: s.dealerIdx,
    firstOutIdx: s.firstOutIdx,
    finalTurnsRemaining: s.finalTurnsRemaining,
    config: s.config,
    deckCount: s.deck.length,
    discards: s.discards.map(pile => pile.length ? pile[pile.length - 1] : null),
    hazardsRemoved: s.hazardsRemoved.length,
    setupFlipsRemaining: s.setupFlipsRemaining ? s.setupFlipsRemaining[playerId] : 0,
    hazardFlipOwed: s.hazardFlips ? !!s.hazardFlips[playerId] : false,
    pending: s.pending ? { stage: s.pending.stage, held: s.pending.held || null } : null,
    pendingFor: s.players[s.currentIdx] ? s.players[s.currentIdx].id : null,
    log: s.log.slice(-12),
    lastBreakdown: s.phase === 'roundEnd' || s.phase === 'gameOver' ? s.lastBreakdown : null,
    winner: s.winner || null,
    players: s.players.map(p => ({
      id: p.id, name: p.name, connected: p.connected,
      total: p.total, roundScores: p.roundScores,
      faceDown: E.faceDownCount(p),
      grid: maskGrid(p, p.id === playerId),
    })),
    you: playerId,
  };
}

function broadcast(room) {
  for (const p of room.players) {
    send(p.ws, 'state', { state: viewFor(room, p.id) });
  }
  room.lastActive = Date.now();
}

function findRoomByWs(ws) {
  for (const room of rooms.values()) {
    const p = room.players.find(pp => pp.ws === ws);
    if (p) return { room, player: p };
  }
  return null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    const found = findRoomByWs(ws);
    if (!found) return;
    const { room, player } = found;
    player.connected = false;
    if (room.state) {
      const sp = E.playerById(room.state, player.id);
      if (sp) sp.connected = false;
    }
    // If lobby and host left, promote or close
    if (!room.state && player.id === room.hostId) {
      room.players = room.players.filter(p => p.id !== player.id);
      if (room.players.length === 0) { rooms.delete(room.code); return; }
      room.hostId = room.players[0].id;
    }
    broadcast(room);
  });
});

function handle(ws, msg) {
  switch (msg.type) {
    case 'create': return onCreate(ws, msg);
    case 'join': return onJoin(ws, msg);
    case 'rejoin': return onRejoin(ws, msg);
    case 'setConfig': return onSetConfig(ws, msg);
    case 'start': return onStart(ws, msg);
    case 'setupFlip': return onAction(ws, s => E.setupFlip(s, msg.playerId, msg.cell), msg);
    case 'draw': return onAction(ws, s => E.draw(s, msg.playerId, msg.source), msg);
    case 'place': return onAction(ws, s => E.place(s, msg.playerId, msg.cell), msg);
    case 'discard': return onAction(ws, s => E.discard(s, msg.playerId, msg.pile), msg);
    case 'hazardFlip': return onAction(ws, s => E.hazardFlip(s, msg.playerId, msg.cell), msg);
    case 'nextRound': return onNextRound(ws, msg);
    case 'chat': return onChat(ws, msg);
    default: send(ws, 'error', { error: 'Unknown action.' });
  }
}

function onCreate(ws, msg) {
  const code = makeCode();
  const playerId = uid();
  const room = {
    code, hostId: playerId,
    players: [{ id: playerId, name: (msg.name || 'Gnome').slice(0, 16), ws, connected: true }],
    state: null,
    config: { advBounce: false, runs: false, advHazard: false, advMulligan: false, kidMode: false },
    createdAt: Date.now(), lastActive: Date.now(),
  };
  rooms.set(code, room);
  send(ws, 'joined', { code, playerId, hostId: room.hostId });
  broadcast(room);
}

function onJoin(ws, msg) {
  const room = rooms.get((msg.code || '').toUpperCase());
  if (!room) return send(ws, 'error', { error: 'Room not found.' });
  if (room.state) return send(ws, 'error', { error: 'Game already started.' });
  if (room.players.length >= 6) return send(ws, 'error', { error: 'Room is full (max 6).' });
  const playerId = uid();
  room.players.push({ id: playerId, name: (msg.name || 'Gnome').slice(0, 16), ws, connected: true });
  send(ws, 'joined', { code: room.code, playerId, hostId: room.hostId });
  broadcast(room);
}

// Reconnect to an in-progress (or lobby) game using a known playerId.
function onRejoin(ws, msg) {
  const room = rooms.get((msg.code || '').toUpperCase());
  if (!room) return send(ws, 'error', { error: 'Room not found.' });
  const p = room.players.find(pp => pp.id === msg.playerId);
  if (!p) return send(ws, 'error', { error: 'Player not in this room.' });
  p.ws = ws; p.connected = true;
  if (room.state) { const sp = E.playerById(room.state, p.id); if (sp) sp.connected = true; }
  send(ws, 'joined', { code: room.code, playerId: p.id, hostId: room.hostId });
  // Always broadcast full state so reconnected player is fully in sync
  broadcast(room);
}

function onSetConfig(ws, msg) {
  const found = findRoomByWs(ws);
  if (!found) return;
  const { room, player } = found;
  if (player.id !== room.hostId) return send(ws, 'error', { error: 'Only the host can change settings.' });
  if (room.state) return;
  room.config = Object.assign(room.config, msg.config || {});
  broadcast(room);
}

function onStart(ws, msg) {
  const found = findRoomByWs(ws);
  if (!found) return;
  const { room, player } = found;
  if (player.id !== room.hostId) return send(ws, 'error', { error: 'Only the host can start.' });
  if (room.players.length < 2) return send(ws, 'error', { error: 'Need at least 2 gnomes.' });
  if (room.state) return send(ws, 'error', { error: 'Already started.' });
  room.state = E.newGame(room.players.map(p => ({ id: p.id, name: p.name })), room.config);
  E.startRound(room.state);
  room.started = true;
  broadcast(room);
}

function onNextRound(ws, msg) {
  const found = findRoomByWs(ws);
  if (!found) return;
  const { room, player } = found;
  if (player.id !== room.hostId) return send(ws, 'error', { error: 'Only the host can continue.' });
  if (!room.state || room.state.phase !== 'roundEnd') return;
  E.startRound(room.state);
  broadcast(room);
}

function onChat(ws, msg) {
  const found = findRoomByWs(ws);
  if (!found) return;
  const { room, player } = found;
  const text = (msg.text || '').slice(0, 140);
  for (const p of room.players) send(p.ws, 'chat', { from: player.name, text });
}

function onAction(ws, fn, msg) {
  const found = findRoomByWs(ws);
  if (!found) return send(ws, 'error', { error: 'Not in a room.' });
  const { room } = found;
  if (!room.state) return send(ws, 'error', { error: 'Game not started.' });
  const res = fn(room.state);
  if (res && res.ok === false) return send(ws, 'error', { error: res.error });
  broadcast(room);
}

// Heartbeat: drop dead sockets
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(interval));

// Sweep idle rooms (2h)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > 2 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log('Gnoming A-Round server listening on ' + PORT));
