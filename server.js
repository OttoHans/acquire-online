'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const webpush = require('web-push');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MAX_ACTIVE_GAMES = 10;

// VAPID
let VAPID_PUBLIC = process.env.VAPID_PUBLIC;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE;
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey;
  VAPID_PRIVATE = keys.privateKey;
  console.warn('VAPID keys not set. Set VAPID_PUBLIC and VAPID_PRIVATE env vars.');
}
webpush.setVapidDetails('mailto:acquire@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

// POSTGRES
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      pin VARCHAR(6) PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS lobbies (
      pin VARCHAR(6) PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      id SERIAL PRIMARY KEY,
      pin VARCHAR(6) NOT NULL,
      player_name VARCHAR(50) NOT NULL,
      subscription JSONB NOT NULL,
      UNIQUE(pin, player_name)
    );
    CREATE TABLE IF NOT EXISTS dismissed_games (
      player_name VARCHAR(50) NOT NULL,
      pin VARCHAR(6) NOT NULL,
      dismissed_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(player_name, pin)
    );
  `);
}

// ── GAME DB ──
async function saveGame(pin, state) {
  await pool.query(
    `INSERT INTO games(pin,state,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(pin) DO UPDATE SET state=$2, updated_at=NOW()`,
    [pin, JSON.stringify(state)]
  );
}
async function loadGame(pin) {
  const r = await pool.query('SELECT state FROM games WHERE pin=$1', [pin]);
  return r.rows[0] ? r.rows[0].state : null;
}
async function countActiveGames() {
  const r = await pool.query(`SELECT COUNT(*) FROM games WHERE state->>'ended'='false' AND state->>'started'='true'`);
  return parseInt(r.rows[0].count, 10);
}
async function getPlayerGames(playerName) {
  const dismissed = await getDismissedPins(playerName);
  // Started games
  const r = await pool.query(
    `SELECT pin, state, updated_at FROM games WHERE state->'players' @> $1::jsonb ORDER BY
      CASE WHEN state->>'ended'='true' THEN 1 ELSE 0 END, updated_at DESC`,
    [JSON.stringify([{ name: playerName }])]
  );
  const startedGames = r.rows.filter(row => {
    if (!row.state.ended) return true;
    return !dismissed.includes(row.pin);
  });
  // Pending lobbies
  const lr = await pool.query(
    `SELECT pin, data, created_at FROM lobbies WHERE data->'players' @> $1::jsonb ORDER BY created_at DESC`,
    [JSON.stringify([{ name: playerName }])]
  );
  return { startedGames, pendingLobbies: lr.rows };
}
async function dismissGame(playerName, pin) {
  await pool.query(`INSERT INTO dismissed_games(player_name,pin) VALUES($1,$2) ON CONFLICT DO NOTHING`, [playerName, pin]);
}
async function getDismissedPins(playerName) {
  const r = await pool.query('SELECT pin FROM dismissed_games WHERE player_name=$1', [playerName]);
  return r.rows.map(row => row.pin);
}
async function deleteGame(pin) {
  await pool.query('DELETE FROM games WHERE pin=$1', [pin]);
  await pool.query('DELETE FROM dismissed_games WHERE pin=$1', [pin]);
  await pool.query('DELETE FROM push_subs WHERE pin=$1', [pin]);
}
async function getAllGames() {
  const r = await pool.query('SELECT pin, state, updated_at FROM games ORDER BY updated_at DESC');
  return r.rows;
}

// ── LOBBY DB ──
async function saveLobby(pin, data) {
  await pool.query(
    `INSERT INTO lobbies(pin,data,created_at) VALUES($1,$2,NOW()) ON CONFLICT(pin) DO UPDATE SET data=$2`,
    [pin, JSON.stringify(data)]
  );
}
async function loadLobby(pin) {
  const r = await pool.query('SELECT data FROM lobbies WHERE pin=$1', [pin]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function deleteLobby(pin) {
  await pool.query('DELETE FROM lobbies WHERE pin=$1', [pin]);
}

// ── PUSH ──
async function savePushSub(pin, playerName, sub) {
  await pool.query(
    `INSERT INTO push_subs(pin,player_name,subscription) VALUES($1,$2,$3) ON CONFLICT(pin,player_name) DO UPDATE SET subscription=$3`,
    [pin, playerName, JSON.stringify(sub)]
  );
}
async function getPushSubs(playerName) {
  const r = await pool.query('SELECT subscription FROM push_subs WHERE player_name=$1', [playerName]);
  return r.rows.map(row => row.subscription);
}
async function sendPush(playerName, title, body, pin) {
  const subs = await getPushSubs(playerName);
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify({ title, body, pin })); }
    catch (e) { if (e.statusCode === 410) await pool.query('DELETE FROM push_subs WHERE player_name=$1', [playerName]); }
  }
}

// ── CHAIN DEFINITIONS ──
const CHAINS = [
  { id: 'tower',       name: 'Tower',       tier: 1, color: '#c8a800' },
  { id: 'luxor',       name: 'Luxor',       tier: 1, color: '#a01818' },
  { id: 'worldwide',   name: 'Worldwide',   tier: 2, color: '#c8622a' },
  { id: 'festival',    name: 'Festival',    tier: 2, color: '#2e7d32' },
  { id: 'imperial',    name: 'Imperial',    tier: 2, color: '#c2185b' },
  { id: 'american',    name: 'American',    tier: 3, color: '#1565c0' },
  { id: 'continental', name: 'Continental', tier: 3, color: '#00838f' },
];

const COLS = ['1','2','3','4','5','6','7','8','9','10','11','12'];
const ROWS = ['A','B','C','D','E','F','G','H','I'];

function allTiles() { const t=[]; for(const c of COLS) for(const r of ROWS) t.push(c+r); return t; }
function shuffle(arr) { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function neighbors(tid) {
  const col=tid.slice(0,-1),row=tid.slice(-1),ci=COLS.indexOf(col),ri=ROWS.indexOf(row),n=[];
  if(ci>0)n.push(COLS[ci-1]+row);if(ci<COLS.length-1)n.push(COLS[ci+1]+row);
  if(ri>0)n.push(col+ROWS[ri-1]);if(ri<ROWS.length-1)n.push(col+ROWS[ri+1]);
  return n;
}
function chainSize(board,id){return Object.values(board).filter(v=>v===id).length;}
function isSafe(board,id){return chainSize(board,id)>=11;}
function activeChains(board){return CHAINS.map(c=>c.id).filter(id=>chainSize(board,id)>0);}
function availableChains(board){return CHAINS.map(c=>c.id).filter(id=>chainSize(board,id)===0);}

function sharePrice(chainId, size) {
  if (size < 2) return 0;
  const tier = CHAINS.find(c => c.id === chainId).tier;
  let base;
  if (size === 2) base = 200;
  else if (size === 3) base = 300;
  else if (size === 4) base = 400;
  else if (size === 5) base = 500;
  else if (size <= 10) base = 600;
  else if (size <= 20) base = 700;
  else if (size <= 30) base = 800;
  else if (size <= 40) base = 900;
  else base = 1000;
  return base + (tier - 1) * 100;
}

function netWorth(player, board) {
  let n = player.cash;
  CHAINS.forEach(c => {
    if (player.stocks[c.id] > 0) {
      const sz = chainSize(board, c.id);
      if (sz > 0) n += player.stocks[c.id] * sharePrice(c.id, sz);
    }
  });
  return n;
}

function floodFill(board, tid, chainId) {
  board[tid] = chainId;
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of Object.keys(board)) {
      if (board[t] === 'neutral' && neighbors(t).some(n => board[n] === chainId)) {
        board[t] = chainId; changed = true;
      }
    }
  }
}

function classifyTilePlacement(board, tid) {
  const nb = neighbors(tid);
  const placedNb = nb.filter(t => board[t]);
  const chainNb = [...new Set(placedNb.map(t => board[t] !== 'neutral' ? board[t] : null).filter(Boolean))];
  const neutralNb = placedNb.filter(t => board[t] === 'neutral');
  if (!placedNb.length) return { type: 'lone' };
  if (!chainNb.length) {
    if (neutralNb.length && availableChains(board).length) return { type: 'found' };
    if (neutralNb.length && !availableChains(board).length) return { type: 'temp_unplayable' };
    return { type: 'lone' };
  }
  if (chainNb.length === 1) return { type: 'grow', chain: chainNb[0] };
  const safeChains = chainNb.filter(id => isSafe(board, id));
  if (safeChains.length >= 2) return { type: 'perm_unplayable' };
  return { type: 'merge', chains: chainNb };
}

function generatePin() { return Math.floor(100000 + Math.random() * 900000).toString(); }

function createGameState(playerNames, mode, gameName) {
  const bag = shuffle(allTiles());
  const players = playerNames.map((name, i) => ({
    id: i, name, cash: 6000, hand: [],
    stocks: Object.fromEntries(CHAINS.map(c => [c.id, 0]))
  }));
  const tempBoard = {};
  players.forEach(p => {
    let attempts = 0;
    while (p.hand.length < 6 && bag.length && attempts < 200) {
      const t = bag.pop();
      const cls = classifyTilePlacement(tempBoard, t);
      if (cls.type === 'perm_unplayable') { attempts++; bag.unshift(t); continue; }
      p.hand.push(t);
    }
  });
  return {
    board: {}, bag, players,
    stocks: Object.fromEntries(CHAINS.map(c => [c.id, 25])),
    currentPlayer: 0, phase: 'place',
    pendingTile: null, pendingFoundOptions: null, pendingMerge: null,
    log: [`Game started with ${playerNames.join(', ')}.`],
    started: true, ended: false,
    advancedMode: mode === 'advanced',
    gameName: gameName || null,
    endStats: null,
  };
}

function drawTileForPlayer(state, pi, addLog) {
  const p = state.players[pi];
  let drawn = false;
  let attempts = 0;
  while (state.bag.length && !drawn && attempts < 50) {
    const t = state.bag.pop();
    const cls = classifyTilePlacement(state.board, t);
    if (cls.type === 'perm_unplayable') {
      addLog(`Tile ${t} is permanently unplayable (would merge two safe chains) — discarded.`);
      attempts++;
      continue;
    }
    p.hand.push(t);
    drawn = true;
  }
}

function gameSummary(pin, state, playerName) {
  const me = state.players.find(p => p.name === playerName);
  const myIdx = state.players.findIndex(p => p.name === playerName);
  const isMyTurn = !state.ended && state.currentPlayer === myIdx && state.phase === 'place';
  const myStocks = me ? CHAINS.filter(c => me.stocks[c.id] > 0).map(c => ({
    id: c.id, name: c.name, color: c.color,
    count: me.stocks[c.id],
    price: sharePrice(c.id, chainSize(state.board, c.id))
  })) : [];
  return {
    pin, gameName: state.gameName || null,
    players: state.players.map(p => p.name),
    currentPlayer: state.players[state.currentPlayer]?.name,
    phase: state.phase, isMyTurn, ended: state.ended,
    advancedMode: state.advancedMode,
    myCash: me ? me.cash : 0,
    myNet: me ? netWorth(me, state.board) : 0,
    myStocks, bagCount: state.bag.length,
    pending: false,
  };
}

function lobbySummary(pin, lobbyData, playerName) {
  return {
    pin,
    gameName: lobbyData.gameName || null,
    players: lobbyData.players.map(p => p.name),
    mode: lobbyData.mode,
    creator: lobbyData.creator,
    isCreator: lobbyData.creator === playerName,
    pending: true,
    ended: false,
    isMyTurn: false,
    myCash: 0,
    myNet: 0,
    myStocks: [],
    advancedMode: lobbyData.mode === 'advanced',
  };
}

const rooms = new Map();
function getRoomClients(pin) { if (!rooms.has(pin)) rooms.set(pin, new Set()); return rooms.get(pin); }
function broadcastToRoom(pin, msg) {
  const d = JSON.stringify(msg);
  getRoomClients(pin).forEach(({ ws }) => { if (ws.readyState === 1) ws.send(d); });
}

function publicState(state) {
  return {
    board: state.board,
    players: state.players.map(p => ({ id: p.id, name: p.name, cash: p.cash, stocks: p.stocks, handCount: p.hand.length })),
    stocks: state.stocks, currentPlayer: state.currentPlayer, phase: state.phase,
    log: state.log.slice(-80),
    pendingFoundOptions: state.pendingFoundOptions,
    pendingMerge: state.pendingMerge ? {
      chains: state.pendingMerge.chains,
      survivor: state.pendingMerge.survivor,
      absorbed: state.pendingMerge.absorbed,
      currentDecision: state.pendingMerge.queue[0] || null,
      queueLength: state.pendingMerge.queue.length,
      preMergeSizes: state.pendingMerge.preMergeSizes,
    } : null,
    started: state.started, ended: state.ended, advancedMode: state.advancedMode,
    bagCount: state.bag.length, gameName: state.gameName || null,
    endStats: state.endStats || null,
  };
}

async function broadcastState(pin, state) {
  broadcastToRoom(pin, { type: 'state', state: publicState(state) });
  getRoomClients(pin).forEach(({ ws, name }) => {
    const p = state.players.find(pl => pl.name === name);
    const unplayable = p ? p.hand.filter(t => {
      const cls = classifyTilePlacement(state.board, t);
      return cls.type === 'perm_unplayable' || cls.type === 'temp_unplayable';
    }) : [];
    if (p && ws.readyState === 1) ws.send(JSON.stringify({
      type: 'private', hand: p.hand, unplayable
    }));
  });
}

// In-memory lobby cache (populated from DB on demand)
const lobbies = new Map();

// HTTP ROUTES
app.get('/vapid-public', (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post('/push-subscribe', async (req, res) => {
  const { pin, playerName, subscription } = req.body;
  if (!pin || !playerName || !subscription) return res.status(400).json({ error: 'Missing fields' });
  await savePushSub(pin, playerName, subscription);
  res.json({ ok: true });
});

app.post('/new-game', async (req, res) => {
  try {
    const activeCount = await countActiveGames();
    if (activeCount >= MAX_ACTIVE_GAMES) return res.status(429).json({ error: `Server at capacity (${MAX_ACTIVE_GAMES} active games).` });
    const pin = generatePin();
    const mode = req.body?.mode || 'beginner';
    const gameName = req.body?.gameName?.trim() || null;
    const creatorName = req.body?.creatorName?.trim() || null;
    const lobbyData = { players: [], open: true, mode, gameName, creator: creatorName };
    lobbies.set(pin, lobbyData);
    await saveLobby(pin, lobbyData);
    res.json({ pin });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/my-games/:playerName', async (req, res) => {
  try {
    const playerName = decodeURIComponent(req.params.playerName);
    const { startedGames, pendingLobbies } = await getPlayerGames(playerName);
    const summaries = [
      ...pendingLobbies.map(row => lobbySummary(row.pin, row.data, playerName)),
      ...startedGames.map(row => gameSummary(row.pin, row.state, playerName)),
    ];
    res.json({ games: summaries });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/dismiss-game', async (req, res) => {
  try {
    const { playerName, pin } = req.body;
    if (!playerName || !pin) return res.status(400).json({ error: 'Missing fields' });
    await dismissGame(playerName, pin);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/rematch', async (req, res) => {
  try {
    const { pin } = req.body;
    const state = await loadGame(pin);
    if (!state) return res.status(404).json({ error: 'Game not found' });
    const activeCount = await countActiveGames();
    if (activeCount >= MAX_ACTIVE_GAMES) return res.status(429).json({ error: `Server at capacity.` });
    const newPin = generatePin();
    const mode = state.advancedMode ? 'advanced' : 'beginner';
    const gameName = state.gameName ? `${state.gameName} (rematch)` : null;
    const creator = state.players[0]?.name || null;
    const lobbyData = { players: [], open: true, mode, gameName, creator };
    lobbies.set(newPin, lobbyData);
    await saveLobby(newPin, lobbyData);
    res.json({ pin: newPin, mode, gameName, players: state.players.map(p => p.name) });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/admin/games', async (req, res) => {
  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin || req.headers['x-admin-pin'] !== adminPin) return res.status(403).json({ error: 'Forbidden' });
  try {
    const rows = await getAllGames();
    res.json({ games: rows.map(row => ({
      pin: row.pin, gameName: row.state.gameName || null,
      players: row.state.players.map(p => p.name),
      ended: row.state.ended, started: row.state.started, phase: row.state.phase,
      currentPlayer: row.state.players[row.state.currentPlayer]?.name,
      updatedAt: row.updated_at,
    }))});
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/admin/games/:pin', async (req, res) => {
  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin || req.headers['x-admin-pin'] !== adminPin) return res.status(403).json({ error: 'Forbidden' });
  try { await deleteGame(req.params.pin); await deleteLobby(req.params.pin); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/game-snapshot/:pin', async (req, res) => {
  try {
    const state = await loadGame(req.params.pin);
    if (!state) return res.status(404).json({ error: 'Game not found' });
    res.json({ state: publicState(state) });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// WEBSOCKET
wss.on('connection', ws => {
  let myPin = null, myName = null;
  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === 'join') {
        const { pin, name } = msg;
        if (!pin || !name) return;
        myPin = pin; myName = name;

        // Check for a started game first
        const existingState = await loadGame(pin);
        if (existingState && existingState.started) {
          const isPlayer = existingState.players.some(p => p.name === name);
          if (!isPlayer) { ws.send(JSON.stringify({ type: 'error', msg: `Game ${pin} is in progress. Only original players can rejoin.` })); myPin = null; myName = null; return; }
          getRoomClients(pin).add({ ws, name });
          ws.send(JSON.stringify({ type: 'state', state: publicState(existingState) }));
          const p = existingState.players.find(pl => pl.name === name);
          if (p) {
            const unplayable = p.hand.filter(t => { const cls = classifyTilePlacement(existingState.board, t); return cls.type === 'perm_unplayable' || cls.type === 'temp_unplayable'; });
            ws.send(JSON.stringify({ type: 'private', hand: p.hand, unplayable }));
          }
          return;
        }

        // Load lobby from memory or DB
        let lobby = lobbies.get(pin);
        if (!lobby) {
          const dbLobby = await loadLobby(pin);
          if (dbLobby) { lobby = dbLobby; lobbies.set(pin, lobby); }
        }
        if (!lobby) { ws.send(JSON.stringify({ type: 'error', msg: `No game found with PIN ${pin}.` })); myPin = null; myName = null; return; }
        if (!lobby.open) { ws.send(JSON.stringify({ type: 'error', msg: `Game ${pin} has already started.` })); myPin = null; myName = null; return; }

        // Add player if not already in lobby
        if (!lobby.players.find(p => p.name === name)) {
          if (lobby.players.length >= 6) { ws.send(JSON.stringify({ type: 'error', msg: 'This game is full.' })); myPin = null; myName = null; return; }
          if (lobby.players.some(p => p.name.toLowerCase() === name.toLowerCase())) { ws.send(JSON.stringify({ type: 'error', msg: `Name "${name}" is taken. Use a different name.` })); myPin = null; myName = null; return; }
          // Set creator to first joiner if not already set
          if (!lobby.creator && lobby.players.length === 0) lobby.creator = name;
          lobby.players.push({ name });
          await saveLobby(pin, lobby);
        }

        getRoomClients(pin).add({ ws, name });
        broadcastToRoom(pin, { type: 'lobby', players: lobby.players.map(p => p.name), open: lobby.open, pin, gameName: lobby.gameName, mode: lobby.mode, creator: lobby.creator });
        return;
      }

      if (msg.action === 'start_game') {
        if (!myPin || !myName) return;
        let lobby = lobbies.get(myPin);
        if (!lobby) {
          const dbLobby = await loadLobby(myPin);
          if (dbLobby) { lobby = dbLobby; lobbies.set(myPin, lobby); }
        }
        if (!lobby) { ws.send(JSON.stringify({ type: 'error', msg: 'Lobby not found.' })); return; }
        // Only creator can start
        if (lobby.creator && lobby.creator !== myName) { ws.send(JSON.stringify({ type: 'error', msg: 'Only the game creator can start the game.' })); return; }
        if (lobby.players.length < 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Need at least 2 players.' })); return; }
        lobby.open = false;
        const state = createGameState(lobby.players.map(p => p.name), lobby.mode || 'beginner', lobby.gameName);
        await saveGame(myPin, state);
        await deleteLobby(myPin);
        lobbies.delete(myPin);
        await broadcastState(myPin, state);
        // Notify all non-creator players that game has started
        for (const p of lobby.players) {
          if (p.name !== myName) {
            const gn = lobby.gameName ? `"${lobby.gameName}"` : `game ${myPin}`;
            await sendPush(p.name, 'ACQUIRE — Game Started!', `${myName} has started ${gn}. It's your turn soon!`, myPin);
          }
        }
        return;
      }

      if (!myPin || !myName) return;
      const state = await loadGame(myPin);
      if (!state || !state.started || state.ended) return;
      const pi = state.players.findIndex(p => p.name === myName);
      if (pi < 0) return;
      const changed = await handleGameAction(state, pi, myName, msg, myPin);
      if (changed) { await saveGame(myPin, state); await broadcastState(myPin, state); }
    } catch (e) { console.error('WS error:', e); }
  });
  ws.on('close', () => {
    if (myPin) { const clients = getRoomClients(myPin); for (const c of clients) { if (c.ws === ws) { clients.delete(c); break; } } }
  });
});

// ── BUILD SEQUENTIAL MERGE QUEUE ──
function buildMergeQueue(state, absorbed, currentPlayer) {
  const n = state.players.length;
  const sortedAbsorbed = [...absorbed].sort((a, b) => {
    const sa = chainSize(state.board, a), sb = chainSize(state.board, b);
    if (sa !== sb) return sa - sb;
    return CHAINS.findIndex(c => c.id === a) - CHAINS.findIndex(c => c.id === b);
  });
  const queue = [];
  for (const chainId of sortedAbsorbed) {
    for (let offset = 0; offset < n; offset++) {
      const pi = (currentPlayer + offset) % n;
      if (state.players[pi].stocks[chainId] > 0) queue.push({ pi, chainId });
    }
  }
  return queue;
}

async function handleGameAction(state, pi, myName, msg, pin) {
  const addLog = t => { state.log.push(t); if (state.log.length > 100) state.log = state.log.slice(-100); };
  const notifyCurrentPlayer = async () => {
    const cp = state.players[state.currentPlayer];
    if (cp.name !== myName) {
      const gn = state.gameName ? `"${state.gameName}"` : `game ${pin}`;
      await sendPush(cp.name, 'ACQUIRE — Your Turn!', `It's your turn in ${gn}.`, pin);
    }
  };
  const notifyMergeDecider = async (entry) => {
    const cp = state.players[entry.pi];
    if (cp.name !== myName) {
      const gn = state.gameName ? `"${state.gameName}"` : `game ${pin}`;
      const chainName = CHAINS.find(c => c.id === entry.chainId).name;
      await sendPush(cp.name, 'ACQUIRE — Merger Decision', `Decide what to do with your ${chainName} shares in ${gn}.`, pin);
    }
  };

  if (msg.action === 'place_tile') {
    if (state.phase !== 'place' || pi !== state.currentPlayer) return false;
    const tid = msg.tile;
    const cp = state.players[pi];
    if (!cp.hand.includes(tid)) return false;
    const cls = classifyTilePlacement(state.board, tid);
    if (cls.type === 'perm_unplayable') return false;
    if (cls.type === 'temp_unplayable') return false;
    cp.hand = cp.hand.filter(t => t !== tid);
    state.board[tid] = 'neutral';
    addLog(`${cp.name} placed tile ${tid}.`);
    const nb = neighbors(tid);
    const placedNb = nb.filter(t => state.board[t]);
    const chainNb = [...new Set(placedNb.map(t => state.board[t] !== 'neutral' ? state.board[t] : null).filter(Boolean))];
    const neutralNb = placedNb.filter(t => state.board[t] === 'neutral');
    if (!chainNb.length && neutralNb.length && availableChains(state.board).length) {
      state.phase = 'found_pending';
      state.pendingTile = tid;
      state.pendingFoundOptions = availableChains(state.board);
    } else if (chainNb.length === 1) {
      floodFill(state.board, tid, chainNb[0]);
      neutralNb.forEach(t => { if (state.board[t] === 'neutral') floodFill(state.board, t, chainNb[0]); });
      state.phase = 'buy';
      await notifyCurrentPlayer();
    } else if (chainNb.length > 1) {
      const sizes = chainNb.map(c => ({ id: c, size: chainSize(state.board, c) }))
        .sort((a, b) => b.size - a.size || CHAINS.findIndex(x => x.id === a.id) - CHAINS.findIndex(x => x.id === b.id));
      const survivor = sizes[0].id;
      const absorbed = chainNb.filter(c => c !== survivor);
      const preMergeBoard = { ...state.board };
      const preMergeSizes = {};
      absorbed.forEach(c => { preMergeSizes[c] = chainSize(state.board, c); });
      absorbed.forEach(c => payBonuses(state, c, addLog, pin, preMergeBoard));
      const survivorChain = CHAINS.find(c => c.id === survivor);
      const absorbedNames = absorbed.map(c => CHAINS.find(x => x.id === c).name);
      addLog(`MERGER: ${absorbedNames.join(', ')} absorbed into ${survivorChain.name}.`);
      const queue = buildMergeQueue(state, absorbed, state.currentPlayer);
      if (!queue.length) {
        doMerge(state, tid, survivor, absorbed, neutralNb);
        state.phase = 'buy';
        await notifyCurrentPlayer();
      } else {
        state.phase = 'merge_pending';
        state.pendingMerge = { chains: chainNb, survivor, absorbed, queue, pendingTile: tid, pendingNeutralNb: neutralNb, preMergeBoard, preMergeSizes };
        await notifyMergeDecider(queue[0]);
      }
    } else {
      state.phase = 'buy';
      await notifyCurrentPlayer();
    }
    return true;
  }

  if (msg.action === 'found_chain') {
    if (state.phase !== 'found_pending' || pi !== state.currentPlayer) return false;
    const chainId = msg.chainId;
    if (!availableChains(state.board).includes(chainId)) return false;
    floodFill(state.board, state.pendingTile, chainId);
    let changed = true;
    while (changed) { changed = false; for (const t of Object.keys(state.board)) { if (state.board[t] === 'neutral' && neighbors(t).some(n => state.board[n] === chainId)) { state.board[t] = chainId; changed = true; } } }
    const cp = state.players[pi];
    if (state.stocks[chainId] > 0) { cp.stocks[chainId]++; state.stocks[chainId]--; }
    const chain = CHAINS.find(c => c.id === chainId);
    addLog(`${cp.name} founded ${chain.name}! Receives 1 free share.`);
    state.phase = 'buy'; state.pendingTile = null; state.pendingFoundOptions = null;
    await notifyCurrentPlayer();
    return true;
  }

  if (msg.action === 'merge_decision') {
    if (state.phase !== 'merge_pending' || !state.pendingMerge) return false;
    const queue = state.pendingMerge.queue;
    const head = queue[0];
    if (!head || head.pi !== pi || head.chainId !== msg.chainId) return false;
    const p = state.players[pi];
    const chainId = msg.chainId;
    const survivor = state.pendingMerge.survivor;
    const total = p.stocks[chainId];
    const maxTradeByBank = Math.floor(state.stocks[survivor] / 2);
    const sell = Math.max(0, Math.min(msg.sell || 0, total));
    const tradePossible = Math.floor((total - sell) / 2);
    const trade = Math.max(0, Math.min(msg.trade || 0, tradePossible, maxTradeByBank));
    const preMergeSize = state.pendingMerge.preMergeSizes[chainId];
    const price = sharePrice(chainId, preMergeSize);
    if (sell > 0) {
      p.cash += sell * price; p.stocks[chainId] -= sell; state.stocks[chainId] += sell;
      addLog(`${p.name} sold ${sell} ${CHAINS.find(c => c.id === chainId).name} @ $${price.toLocaleString()} each — receives $${(sell * price).toLocaleString()}.`);
    }
    if (trade > 0) {
      p.stocks[chainId] -= trade * 2; state.stocks[chainId] += trade * 2;
      p.stocks[survivor] += trade; state.stocks[survivor] -= trade;
      addLog(`${p.name} traded ${trade * 2} ${CHAINS.find(c => c.id === chainId).name} → ${trade} ${CHAINS.find(c => c.id === survivor).name}.`);
    }
    const kept = total - sell - trade * 2;
    if (kept > 0) addLog(`${p.name} keeps ${kept} ${CHAINS.find(c => c.id === chainId).name}.`);
    queue.shift();
    if (queue.length === 0) {
      doMerge(state, state.pendingMerge.pendingTile, survivor, state.pendingMerge.absorbed, state.pendingMerge.pendingNeutralNb);
      state.phase = 'buy'; state.pendingMerge = null;
      await notifyCurrentPlayer();
    } else {
      await notifyMergeDecider(queue[0]);
    }
    return true;
  }

  if (msg.action === 'buy_stock') {
    if (state.phase !== 'buy' || pi !== state.currentPlayer) return false;
    const cp = state.players[pi];
    const purchases = msg.purchases || {};
    let totalQty = 0, totalCost = 0;
    for (const [chainId, qty] of Object.entries(purchases)) {
      if (qty <= 0) continue;
      if (!chainSize(state.board, chainId)) continue;
      totalQty += qty; totalCost += qty * sharePrice(chainId, chainSize(state.board, chainId));
    }
    if (totalQty > 3 || totalCost > cp.cash) return false;
    for (const [chainId, qty] of Object.entries(purchases)) {
      if (qty <= 0) continue;
      const price = sharePrice(chainId, chainSize(state.board, chainId));
      cp.cash -= qty * price; cp.stocks[chainId] += qty; state.stocks[chainId] -= qty;
      addLog(`${cp.name} bought ${qty} ${CHAINS.find(c => c.id === chainId).name} for $${(qty * price).toLocaleString()}.`);
    }
    drawTileForPlayer(state, pi, addLog);
    const ac = activeChains(state.board);
    if (ac.length && (ac.every(c => isSafe(state.board, c)) || ac.some(c => chainSize(state.board, c) >= 41))) {
      endGame(state, addLog, pin); return true;
    }
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    state.phase = 'place';
    autoDiscardUnplayable(state, state.currentPlayer, addLog);
    await notifyCurrentPlayer();
    return true;
  }

  if (msg.action === 'end_game_voluntary') {
    if (pi !== state.currentPlayer) return false;
    endGame(state, addLog, pin); return true;
  }
  return false;
}

function doMerge(state, placedTid, survivor, absorbed, neutralNb) {
  state.board[placedTid] = survivor;
  absorbed.forEach(chainId => {
    for (const t of Object.keys(state.board)) {
      if (state.board[t] === chainId) state.board[t] = survivor;
    }
  });
  floodFill(state.board, placedTid, survivor);
  if (neutralNb) neutralNb.forEach(t => { if (state.board[t] === 'neutral') floodFill(state.board, t, survivor); });
}

function autoDiscardUnplayable(state, pi, addLog) {
  const p = state.players[pi];
  const toDiscard = p.hand.filter(t => classifyTilePlacement(state.board, t).type === 'perm_unplayable');
  if (!toDiscard.length) return;
  p.hand = p.hand.filter(t => !toDiscard.includes(t));
  toDiscard.forEach(t => addLog(`${p.name}'s tile ${t} is permanently unplayable — discarded and replaced.`));
  toDiscard.forEach(() => drawTileForPlayer(state, pi, addLog));
}

function payBonuses(state, chainId, log, pin, boardOverride) {
  const board = boardOverride || state.board;
  const size = chainSize(board, chainId);
  const p = sharePrice(chainId, size);
  const major = p * 10, minor = p * 5;
  const chain = CHAINS.find(c => c.id === chainId);
  const holdings = state.players.map((pl, i) => ({ i, n: pl.stocks[chainId] })).filter(x => x.n > 0);
  holdings.sort((a, b) => b.n - a.n);
  if (!holdings.length) return;
  const bonusEvents = [];
  if (holdings.length === 1) {
    state.players[holdings[0].i].cash += major + minor;
    log(`${state.players[holdings[0].i].name} receives both bonuses for ${chain.name} (${size} hotels): $${(major + minor).toLocaleString()}`);
    bonusEvents.push({ playerName: state.players[holdings[0].i].name, chainName: chain.name, chainColor: chain.color, amount: major + minor, type: 'majority + minority' });
  } else {
    const top = holdings[0].n;
    const majH = holdings.filter(h => h.n === top);
    if (majH.length > 1) {
      const share = Math.floor((major + minor) / majH.length / 100) * 100;
      majH.forEach(h => { state.players[h.i].cash += share; bonusEvents.push({ playerName: state.players[h.i].name, chainName: chain.name, chainColor: chain.color, amount: share, type: 'majority (tied)' }); });
      log(`Tied majority for ${chain.name} — $${share.toLocaleString()} each to ${majH.map(h => state.players[h.i].name).join(', ')}`);
    } else {
      state.players[holdings[0].i].cash += major;
      log(`${state.players[holdings[0].i].name} majority bonus for ${chain.name}: $${major.toLocaleString()}`);
      bonusEvents.push({ playerName: state.players[holdings[0].i].name, chainName: chain.name, chainColor: chain.color, amount: major, type: 'majority' });
      const minH = holdings.slice(1).filter(h => h.n === holdings[1].n);
      if (minH.length) {
        const share = Math.floor(minor / minH.length / 100) * 100;
        minH.forEach(h => { state.players[h.i].cash += share; bonusEvents.push({ playerName: state.players[h.i].name, chainName: chain.name, chainColor: chain.color, amount: share, type: 'minority' }); });
        log(`${minH.map(h => state.players[h.i].name).join(', ')} minority bonus for ${chain.name}: $${share.toLocaleString()} each`);
      }
    }
  }
  if (pin && bonusEvents.length) setTimeout(() => broadcastToRoom(pin, { type: 'bonus', bonuses: bonusEvents }), 100);
}

function endGame(state, addLog, pin) {
  activeChains(state.board).forEach(c => payBonuses(state, c, addLog, pin));
  state.players.forEach(p => {
    activeChains(state.board).forEach(chainId => {
      if (p.stocks[chainId] > 0) {
        const val = p.stocks[chainId] * sharePrice(chainId, chainSize(state.board, chainId));
        p.cash += val;
        addLog(`${p.name} cashes out ${p.stocks[chainId]} ${CHAINS.find(c => c.id === chainId).name} for $${val.toLocaleString()}.`);
      }
    });
  });
  state.endStats = {
    players: state.players.map(p => ({ name: p.name, finalCash: p.cash, stocks: Object.fromEntries(CHAINS.map(c => [c.id, p.stocks[c.id]])) })),
    chainSizes: Object.fromEntries(CHAINS.map(c => [c.id, chainSize(state.board, c.id)])),
  };
  state.phase = 'ended'; state.ended = true;
  const sorted = [...state.players].sort((a, b) => b.cash - a.cash);
  addLog(`GAME OVER! Winner: ${sorted[0].name} with $${sorted[0].cash.toLocaleString()}.`);
}

const PORT = process.env.PORT || 3000;
dbInit().then(() => server.listen(PORT, () => console.log(`Acquire server on port ${PORT}`))).catch(e => {
  console.error('DB init failed:', e);
  server.listen(PORT, () => console.log(`Acquire server on port ${PORT} (no DB)`));
});
