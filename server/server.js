const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));

const rooms = {};
const lastRoom = {}; // name -> roomId

function createRoom(roomId) {
  rooms[roomId] = {
    players: [], started: false, host: null, chat: [],
    bagSeed: Math.floor(Math.random() * 1000000),
    mutationMode: false, mutationSeed: 0,
    // Host-configurable game settings
    roomSettings: {
      mutationRate: 60,      // % chance of mutation (0-100)
      gravityBase: 1000,     // ms per drop at level 1
      gravityDec: 80,        // ms decrease per level
      gravityMin: 50,        // minimum ms per drop
      lockDelay: 1000,       // lock delay in ms
    }
  };
}
function getRoom(roomId) { return rooms[roomId]; }

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('create_room', ({ name, roomId: requestedId }) => {
    // roomIdが指定されていて既存ルームがある場合はjoinとして扱う
    if (requestedId) {
      const existingRoom = getRoom(requestedId.toUpperCase());
      if (existingRoom) {
        const rid = requestedId.toUpperCase();
        if (existingRoom.players.length >= 3) { socket.emit('error', { msg: 'Room is full (max 3)' }); return; }
        if (existingRoom.started) { socket.emit('error', { msg: 'Game already started' }); return; }
        if (existingRoom.players.find(p => p.name === name)) { socket.emit('error', { msg: 'Name already in room' }); return; }
        existingRoom.players.push({ id: socket.id, name, board: null, score: 0, lines: 0, level: 1, alive: true, combo: 0, b2b: false });
        socket.join(rid); socket.roomId = rid; socket.playerName = name;
        lastRoom[name] = rid;
        socket.emit('room_joined', { roomId: rid, players: existingRoom.players });
        io.to(rid).emit('room_update', { players: existingRoom.players, host: existingRoom.host, started: existingRoom.started });
        return;
      }
    }
    // 新規作成
    const roomId = requestedId && requestedId.length >= 4
      ? requestedId.toUpperCase()
      : Math.random().toString(36).substr(2, 6).toUpperCase();
    createRoom(roomId);
    const room = getRoom(roomId);
    room.host = socket.id;
    room.players.push({ id: socket.id, name, board: null, score: 0, lines: 0, level: 1, alive: true, combo: 0, b2b: false });
    socket.join(roomId); socket.roomId = roomId; socket.playerName = name;
    lastRoom[name] = roomId;
    socket.emit('room_created', { roomId, players: room.players });
    io.to(roomId).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
  });

  socket.on('join_room', ({ roomId, name }) => {
    const room = getRoom(roomId);
    if (!room) { socket.emit('error', { msg: 'Room not found' }); return; }
    if (room.players.length >= 3) { socket.emit('error', { msg: 'Room is full (max 3)' }); return; }
    if (room.started) { socket.emit('error', { msg: 'Game already started' }); return; }
    room.players.push({ id: socket.id, name, board: null, score: 0, lines: 0, level: 1, alive: true, combo: 0, b2b: false });
    socket.join(roomId); socket.roomId = roomId; socket.playerName = name;
    lastRoom[name] = roomId;
    socket.emit('room_joined', { roomId, players: room.players });
    io.to(roomId).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
  });

  socket.on('rejoin_last_room', ({ name }) => {
    const roomId = lastRoom[name];
    if (!roomId) { socket.emit('rejoin_result', { success: false }); return; }
    const room = getRoom(roomId);
    if (!room || room.started || room.players.length >= 3 || room.players.find(p => p.name === name)) {
      socket.emit('rejoin_result', { success: false }); return;
    }
    room.players.push({ id: socket.id, name, board: null, score: 0, lines: 0, level: 1, alive: true, combo: 0, b2b: false });
    socket.join(roomId); socket.roomId = roomId; socket.playerName = name;
    // rejoin_resultにhostも含める
    socket.emit('rejoin_result', { success: true, roomId, players: room.players, host: room.host, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
    io.to(roomId).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
  });

  socket.on('set_mutation', ({ enabled, seed }) => {
    const room = getRoom(socket.roomId); if (!room) return;
    if (socket.id !== room.host) return;
    room.mutationMode = !!enabled;
    room.mutationSeed = seed || 0;
    io.to(socket.roomId).emit('mutation_update', { enabled: room.mutationMode, seed: room.mutationSeed });
    io.to(socket.roomId).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
  });

  socket.on('set_room_settings', (newSettings) => {
    const room = getRoom(socket.roomId); if (!room) return;
    if (socket.id !== room.host) return;
    // Validate and clamp values
    if (newSettings.mutationRate !== undefined) room.roomSettings.mutationRate = Math.max(0, Math.min(100, parseInt(newSettings.mutationRate) || 60));
    if (newSettings.gravityBase !== undefined) room.roomSettings.gravityBase = Math.max(100, Math.min(3000, parseInt(newSettings.gravityBase) || 1000));
    if (newSettings.gravityDec !== undefined) room.roomSettings.gravityDec = Math.max(0, Math.min(200, parseInt(newSettings.gravityDec) || 80));
    if (newSettings.gravityMin !== undefined) room.roomSettings.gravityMin = Math.max(20, Math.min(500, parseInt(newSettings.gravityMin) || 50));
    if (newSettings.lockDelay !== undefined) room.roomSettings.lockDelay = Math.max(200, Math.min(3000, parseInt(newSettings.lockDelay) || 1000));
    io.to(socket.roomId).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
  });

  socket.on('start_game', () => {
    const room = getRoom(socket.roomId);
    if (!room || socket.id !== room.host) return;
    if (room.players.length < 2) { socket.emit('error', { msg: 'Need at least 2 players' }); return; }
    room.started = true;
    room.bagSeed = Math.floor(Math.random() * 1000000);
    if (room.mutationMode && !room.mutationSeed) room.mutationSeed = Math.floor(Math.random() * 1000000);
    room.players.forEach(p => { p.board = null; p.score = 0; p.lines = 0; p.level = 1; p.alive = true; p.combo = 0; p.b2b = false; });
    io.to(socket.roomId).emit('game_start', { players: room.players, bagSeed: room.bagSeed, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
  });

  socket.on('piece_update', ({ currentPiece }) => {
    const room = getRoom(socket.roomId); if (!room) return;
    socket.to(socket.roomId).emit('opponent_piece_update', { id: socket.id, currentPiece });
  });

  socket.on('board_update', ({ board, score, lines, level, currentPiece, nextPieces, holdPiece }) => {
    const room = getRoom(socket.roomId); if (!room) return;
    const player = room.players.find(p => p.id === socket.id); if (!player) return;
    player.board = board; player.score = score; player.lines = lines; player.level = level;
    player.currentPiece = currentPiece; player.nextPieces = nextPieces; player.holdPiece = holdPiece;
    socket.to(socket.roomId).emit('opponent_update', {
      id: socket.id, board, score, lines, level, currentPiece, nextPieces, holdPiece
    });
  });

  socket.on('lines_cleared', ({ attack, allClear, spinType, clearRows }) => {
    const room = getRoom(socket.roomId); if (!room) return;
    const total = attack || 0;
    if (total > 0) {
      const others = room.players.filter(p => p.id !== socket.id && p.alive);
      others.forEach(p => {
        io.to(p.id).emit('receive_garbage', { lines: total, fromId: socket.id });
        socket.emit('attack_sent', { fromId: socket.id, toId: p.id, attack: total, clearRows: clearRows || [] });
      });
      io.to(socket.roomId).emit('attack_sent', { fromId: socket.id, toId: others[0]?.id, attack: total, clearRows: clearRows || [] });
    }
  });

  socket.on('spin_effect', ({ spinType }) => {
    socket.to(socket.roomId).emit('opponent_spin', { id: socket.id, spinType });
  });

  // ルーム一覧取得
  socket.on('get_rooms', () => {
    const list = Object.entries(rooms)
      .filter(([, r]) => !r.started && r.players.length < 3)
      .map(([id, r]) => ({ id, players: r.players.map(p => p.name), count: r.players.length }));
    socket.emit('rooms_list', list);
  });

  // ゲーム後に同じルームへ再参加
  socket.on('rejoin_room', ({ roomId: rid, name }) => {
    const room = getRoom(rid);
    if (!room) { socket.emit('error', { msg: 'Room no longer exists' }); return; }
    if (room.started) { socket.emit('error', { msg: 'Game already started' }); return; }
    if (room.players.length >= 3) { socket.emit('error', { msg: 'Room is full' }); return; }
    if (room.players.find(p => p.name === name)) { socket.emit('error', { msg: 'Name already in room' }); return; }
    room.players.push({ id: socket.id, name, board: null, score: 0, lines: 0, level: 1, alive: true, combo: 0, b2b: false });
    socket.join(rid); socket.roomId = rid; socket.playerName = name;
    lastRoom[name] = rid;
    socket.emit('room_joined', { roomId: rid, players: room.players });
    io.to(rid).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
  });

  socket.on('game_over', () => {
    const room = getRoom(socket.roomId); if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.alive = false;
    io.to(socket.roomId).emit('player_dead', { id: socket.id, name: player ? player.name : '' });
    const alive = room.players.filter(p => p.alive);
    if (alive.length <= 1 && room.started) {
      room.started = false;
      const winner = alive.length === 1 ? alive[0] : null;
      io.to(socket.roomId).emit('game_end', {
        winner: winner ? winner.id : null,
        winnerName: winner ? winner.name : 'Draw',
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, lines: p.lines }))
      });
      room.players.forEach(p => { p.alive = true; p.board = null; });
    }
  });

  socket.on('chat_message', ({ message, name: clientName }) => {
    const name = socket.playerName || clientName || 'Anonymous';
    const msg = { id: socket.id, name, message, time: Date.now() };
    // ルームがあればルーム内履歴にも保存
    if (socket.roomId && getRoom(socket.roomId)) {
      const room = getRoom(socket.roomId);
      room.chat.push(msg); if (room.chat.length > 50) room.chat.shift();
    }
    // 全接続者に送信（どの画面にいても受け取れる）
    io.emit('chat_message', msg);
  });

  socket.on('clear_last_room', () => {
    if (socket.playerName) delete lastRoom[socket.playerName];
    socket.roomId = null;
  });

  socket.on('leave_room', () => {
    const room = getRoom(socket.roomId); if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(socket.roomId);
    if (room.players.length === 0) { delete rooms[socket.roomId]; socket.roomId = null; return; }
    if (room.host === socket.id) room.host = room.players[0].id;
    io.to(socket.roomId).emit('player_left', { id: socket.id });
    io.to(socket.roomId).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
    socket.roomId = null;
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.roomId); if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[socket.roomId]; return; }
    if (room.host === socket.id) room.host = room.players[0].id;
    io.to(socket.roomId).emit('player_left', { id: socket.id });
    io.to(socket.roomId).emit('room_update', { players: room.players, host: room.host, started: room.started, mutationMode: room.mutationMode, mutationSeed: room.mutationSeed, roomSettings: room.roomSettings });
    if (room.started) {
      const alive = room.players.filter(p => p.alive);
      if (alive.length <= 1) {
        room.started = false;
        const winner = alive.length === 1 ? alive[0] : null;
        io.to(socket.roomId).emit('game_end', {
          winner: winner ? winner.id : null, winnerName: winner ? winner.name : 'Draw',
          scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, lines: p.lines }))
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tetris server running on http://localhost:${PORT}`));
