const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// ── CLI flags ──────────────────────────────────────────────────────
// Usage: npm start -- --ai          (enable training data recording)
//        npm start -- --ai --port 4000
const argv = process.argv.slice(2);
const AI_MODE = argv.includes('--ai');
const PORT_ARG = (() => { const i = argv.indexOf('--port'); return i >= 0 ? parseInt(argv[i+1]) : null; })();

if (AI_MODE) {
  console.log('🤖 AI MODE ENABLED — match data will be recorded to ./training_data/');
  const dataDir = path.join(__dirname, '../training_data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, '../public')));

// ── Training data helpers ─────────────────────────────────────────
const trainingDataDir = path.join(__dirname, '../training_data');

// Active recording sessions: roomId -> { matchId, players: {id: {frames:[], name}} }
const recordingSessions = {};

function startRecording(roomId, players) {
  // Always ensure training_data dir exists when recording is requested
  if (!fs.existsSync(trainingDataDir)) {
    try { fs.mkdirSync(trainingDataDir, { recursive: true }); } catch(e) {}
  }
  const matchId = `match_${Date.now()}_${roomId}`;
  recordingSessions[roomId] = {
    matchId,
    players: {},
    startTime: Date.now()
  };
  for (const p of players) {
    recordingSessions[roomId].players[p.id] = { name: p.name, frames: [] };
  }
  console.log(`[AI] Recording started: ${matchId}`);
}

function recordPlacement(roomId, playerId, frameData) {
  const session = recordingSessions[roomId];
  if (!session || !session.players[playerId]) return;
  session.players[playerId].frames.push(frameData);
}

function stopRecording(roomId, result) {
  const session = recordingSessions[roomId];
  if (!session) return;
  delete recordingSessions[roomId];

  const outPath = path.join(trainingDataDir, `${session.matchId}.json`);
  const out = {
    matchId: session.matchId,
    startTime: session.startTime,
    endTime: Date.now(),
    result,
    players: {}
  };
  for (const [pid, pdata] of Object.entries(session.players)) {
    out.players[pid] = { name: pdata.name, frames: pdata.frames };
  }
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[AI] Saved: ${outPath} (${Object.values(out.players).reduce((s,p)=>s+p.frames.length,0)} frames)`);
}

const rooms = {};
const lastRoom = {};
const onlinePlayers = {}; // socket.id -> name

// ── Constants (mirror client) ──────────────────────────────────────
const COLS = 10, ROWS = 20, HIDDEN = 3;
// 4Wideモード時のボード幅
const COLS_4WIDE = 4;

const PIECE_SHAPES = {
  I:[[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],[[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],[[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],[[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]]],
  O:[[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]]],
  T:[[[0,1,0],[1,1,1],[0,0,0]],[[0,1,0],[0,1,1],[0,1,0]],[[0,0,0],[1,1,1],[0,1,0]],[[0,1,0],[1,1,0],[0,1,0]]],
  S:[[[0,1,1],[1,1,0],[0,0,0]],[[0,1,0],[0,1,1],[0,0,1]],[[0,0,0],[0,1,1],[1,1,0]],[[1,0,0],[1,1,0],[0,1,0]]],
  Z:[[[1,1,0],[0,1,1],[0,0,0]],[[0,0,1],[0,1,1],[0,1,0]],[[0,0,0],[1,1,0],[0,1,1]],[[0,1,0],[1,1,0],[1,0,0]]],
  J:[[[1,0,0],[1,1,1],[0,0,0]],[[0,1,1],[0,1,0],[0,1,0]],[[0,0,0],[1,1,1],[0,0,1]],[[0,1,0],[0,1,0],[1,1,0]]],
  L:[[[0,0,1],[1,1,1],[0,0,0]],[[0,1,0],[0,1,0],[0,1,1]],[[0,0,0],[1,1,1],[1,0,0]],[[1,1,0],[0,1,0],[0,1,0]]]
};
const PIECE_TYPES = ['I','O','T','S','Z','J','L'];

function seededRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}
class Bag {
  constructor(seed) { this.rng = seededRng(seed || Math.floor(Math.random()*1e6)); this.bag = []; }
  fill() {
    const a = [...PIECE_TYPES];
    for (let i = a.length-1; i > 0; i--) { const j = Math.floor(this.rng()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    this.bag = a;
  }
  next() { if (!this.bag.length) this.fill(); return this.bag.pop(); }
}

function cloneBoard(b) { return b.map(r=>[...r]); }
function getShape(type, rot) { return PIECE_SHAPES[type][((rot%4)+4)%4]; }

function isValid(board, type, rot, x, y) {
  const shape = getShape(type, rot);
  const cols = board[0].length;
  for (let r = 0; r < shape.length; r++) for (let c = 0; c < shape[r].length; c++) {
    if (!shape[r][c]) continue;
    const nx = x+c, ny = y+r;
    if (nx < 0 || nx >= cols || ny >= ROWS+HIDDEN) return false;
    if (ny >= 0 && board[ny] && board[ny][nx]) return false;
  }
  return true;
}

function hardDropY(board, type, rot, x, startY) {
  let y = startY;
  while (isValid(board, type, rot, x, y+1)) y++;
  return y;
}

function placePiece(board, type, rot, x, y) {
  const b = cloneBoard(board);
  const shape = getShape(type, rot);
  const cols = board[0].length;
  for (let r = 0; r < shape.length; r++) for (let c = 0; c < shape[r].length; c++) {
    if (!shape[r][c]) continue;
    const ny = y+r, nx = x+c;
    if (ny >= 0 && ny < ROWS+HIDDEN && nx >= 0 && nx < cols) b[ny][nx] = type;
  }
  return b;
}

function clearLines(board) {
  const b = cloneBoard(board);
  const cols = board[0].length;
  const cleared = [];
  for (let r = ROWS+HIDDEN-1; r >= 0; r--) {
    if (b[r].every(c => c !== 0)) cleared.push(r);
  }
  for (const r of [...cleared].sort((a,v)=>v-a)) { b.splice(r,1); b.unshift(Array(cols).fill(0)); }
  return { board: b, lines: cleared.length };
}

function detectTspin(board, type, rot, x, y) {
  if (type !== 'T') return null;
  const cols = board[0].length;
  const corners = [[0,0],[2,0],[0,2],[2,2]];
  const filled = corners.filter(([cx,cy]) => {
    const nx=x+cx, ny=y+cy;
    return (nx<0||nx>=cols||ny<0||ny>=ROWS+HIDDEN)||(ny>=0&&board[ny]&&board[ny][nx]);
  });
  if (filled.length < 3) return null;
  const front = {0:[[0,0],[2,0]],1:[[2,0],[2,2]],2:[[0,2],[2,2]],3:[[0,0],[0,2]]}[rot];
  const ff = front.filter(([cx,cy]) => {
    const nx=x+cx, ny=y+cy;
    return (nx<0||nx>=cols||ny<0||ny>=ROWS+HIDDEN)||(ny>=0&&board[ny]&&board[ny][nx]);
  });
  return ff.length >= 2 ? 'TSPIN' : 'MINI_TSPIN';
}

// S/Z/L/J/Iスピンを検出（着地状態で回転後にスピン判定）
// BOTのallplacement探索で使う: 到達経路にkickが含まれているか、
// または着地状態（下にブロック/床）でスピン確定
function detectSpin(board, type, rot, x, y, wasKicked) {
  if (type === 'T') return detectTspin(board, type, rot, x, y);

  const cols = board[0].length;
  // 着地チェック（下に何かあるか）
  const shape = getShape(type, rot);
  let atBottom = false;
  outer: for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const ny = y + r + 1;
      if (ny >= ROWS + HIDDEN || (ny >= 0 && board[ny] && board[ny][x+c])) {
        atBottom = true;
        break outer;
      }
    }
  }

  if (!atBottom) return null;

  if (type === 'I' && wasKicked) return 'ISPIN';
  // S/Z/L/J: only count as spin when wall-kick was required (not plain drop)
  if (type === 'S' && wasKicked && atBottom) return 'SSPIN';
  if (type === 'Z' && wasKicked && atBottom) return 'ZSPIN';
  if (type === 'L' && wasKicked && atBottom) return 'LSPIN';
  if (type === 'J' && wasKicked && atBottom) return 'JSPIN';

  return null;
}

function evaluateBoard(board, linesCleared, spinType, isB2B, combo, level, ren) {
  const cols = board[0].length;
  // Column heights
  const heights = Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < ROWS+HIDDEN; r++) {
      if (board[r][c]) { heights[c] = ROWS+HIDDEN - r; break; }
    }
  }
  const maxH = Math.max(...heights);
  const sumH  = heights.reduce((a,b)=>a+b,0);
  const avgH  = sumH / cols;

  // ── Garbage row analysis ────────────────────────────────────────
  // Count garbage rows ('G' cells) and compute how buried they are
  let garbageRows = 0;
  let garbageBuried = 0; // how many non-garbage rows are on top of garbage
  let foundGarbage = false;
  for (let r = ROWS+HIDDEN-1; r >= 0; r--) {
    const isGarbage = board[r].some(c => c === 'G');
    if (isGarbage) {
      garbageRows++;
      foundGarbage = true;
    } else if (foundGarbage && board[r].some(c => c !== 0)) {
      garbageBuried++;
    }
  }

  // ── Holes analysis (critical penalty) ──────────────────────────
  let holes = 0, coveredDepth = 0;
  // Also detect "floor gaps": cells directly on top of empty space at the bottom
  let floorGaps = 0;
  for (let c = 0; c < cols; c++) {
    let inBlock = false, d = 0;
    for (let r = 0; r < ROWS+HIDDEN; r++) {
      if (board[r][c])  { inBlock = true; d = 0; }
      else if (inBlock) { holes++; d++; coveredDepth += d * d; }
    }
    // Floor gap: bottom cell is empty but column has blocks above
    if (heights[c] > 0 && board[ROWS+HIDDEN-1][c] === 0) {
      // Find how deep the bottom gap is
      let gapDepth = 0;
      for (let r = ROWS+HIDDEN-1; r >= 0; r--) {
        if (!board[r][c]) gapDepth++;
        else break;
      }
      floorGaps += gapDepth * gapDepth; // quadratic — deep floor gaps are terrible
    }
  }

  // ── Overhang detection (blocks floating over empty space) ───────
  // Penalty for any filled cell that has empty space directly below it
  let overhangs = 0;
  for (let r = 1; r < ROWS+HIDDEN; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r-1][c] !== 0 && board[r][c] === 0) {
        // Check if there's a hole below
        let hasHoleBelow = false;
        for (let rr = r; rr < ROWS+HIDDEN; rr++) {
          if (board[rr][c] === 0) { hasHoleBelow = true; break; }
          else break;
        }
        if (hasHoleBelow) overhangs++;
      }
    }
  }

  // Bumpiness
  let bumpiness = 0;
  for (let c = 0; c < cols-1; c++) bumpiness += Math.abs(heights[c]-heights[c+1]);

  let score = 0;

  // ── 4WIDE MODE optimization ────────────────────────────────────
  if (cols <= 4) {
    // In 4wide mode, prioritize REN (combos) and line clearing
    score += (ren || 0) * 1200;
    score += (combo || 0) * 500;
    if (linesCleared > 0) {
      // Encourage clearing only 1 line at a time to maximize REN chain
      if (linesCleared === 1) score += 3000;
      else score += 500;
    }
    // Penalize single-column deep wells (vertical I-shaped holes)
    for (let c = 0; c < cols; c++) {
      const lh = c > 0 ? heights[c-1] : 99;
      const rh = c < cols-1 ? heights[c+1] : 99;
      const wellDepth = Math.min(lh, rh) - heights[c];
      if (wellDepth >= 3) score -= wellDepth * wellDepth * 12;
    }
    // Strong bumpiness penalty: flat is critical for 4-wide chains
    score -= bumpiness * 15;
  } else {
    // Normal mode line clear bonuses
    const linePts = [0, 50, 250, 600, 1800];
    score += linePts[Math.min(linesCleared, 4)] || 0;
  }

  // Extra bonus for clearing when stack is dangerous
  if (linesCleared > 0 && maxH > 10) score += linesCleared * (maxH - 10) * 40;
  // Spin bonuses (CC-inspired values)
  if (spinType === 'TSPIN') {
    if (linesCleared === 1) score += 1200;
    else if (linesCleared === 2) score += 2800; // TSD
    else if (linesCleared === 3) score += 4500; // TST
    else if (linesCleared > 0) score += linesCleared * 500;
  } else if (spinType === 'MINI_TSPIN' && linesCleared > 0) {
    score += 200;
  } else if (spinType && linesCleared > 0) {
    score += linesCleared * 600; // S/Z/L/J/I spin
  }
  if (isB2B)   score += 700;
  if (combo>0) score += 70 * combo;
  if ((ren||0) >= 2) score += (ren||0) * 120;
  if (linesCleared > 0 && board.every(r=>r.every(c=>c===0))) score += 15000;

  // ── Garbage clearing bonus ─────────────────────────────────────
  // Strongly reward clearing lines when there are garbage rows
  if (garbageRows > 0 && linesCleared > 0) {
    score += linesCleared * garbageRows * 120; // big bonus for clearing garbage
  }

  // ── Penalties ─────────────────────────────────────────────────
  score -= holes        * 180.0;  // very strong hole penalty (increased from 100)
  score -= coveredDepth * 20.0;   // increased from 15
  score -= floorGaps    * 35.0;   // floor gaps: empty space at bottom of column
  score -= overhangs    * 30.0;   // overhang penalty
  score -= bumpiness    * 4.0;
  score -= sumH         * 1.5;

  // ── Garbage stack penalty ──────────────────────────────────────
  // More garbage rows = bigger penalty (encourages clearing them)
  if (garbageRows > 0) {
    score -= garbageRows * 60;            // base penalty per garbage row
    score -= garbageBuried * garbageRows * 40; // buried garbage is worse
  }

  // ── Height danger — aggressive escalation ─────────────────────
  if (maxH > 6)  score -= (maxH - 6)  * 20;
  if (maxH > 10) score -= (maxH - 10) * 80;
  if (maxH > 13) score -= (maxH - 13) * 250;

  // ── I-piece gap penalty ────────────────────────────────────────
  // Penalize having 2+ consecutive columns that are both significantly
  // lower than their neighbors (forms a shaft that blocks I placement)
  for (let c = 0; c < cols - 1; c++) {
    const leftWall  = c > 0        ? heights[c-1] : heights[c] + 4;
    const rightWall = c < cols - 2 ? heights[c+2] : heights[c+1] + 4;
    const shaftDepth = Math.min(leftWall, rightWall) - Math.max(heights[c], heights[c+1]);
    if (shaftDepth >= 3) {
      // A 2-wide shaft of depth >= 3 could trap an I-piece
      score -= shaftDepth * 60;
    }
  }
  if (maxH > 16) score -= (maxH - 16) * 700;
  if (maxH > 18) score -= (maxH - 18) * 2000;
  if (maxH > 20) score -= (maxH - 20) * 5000;

  // ── Well: only reward when stack is LOW ────────────────────────
  if (maxH <= 8) {
    let wellCount = 0;
    let bestWellCol = -1, bestWellDepth = 0;
    for (let c = 0; c < cols; c++) {
      const lh = c > 0      ? heights[c-1] : 99;
      const rh = c < cols-1 ? heights[c+1] : 99;
      const w = Math.min(lh - heights[c], rh - heights[c]);
      if (w >= 2) {
        wellCount++;
        if (w > bestWellDepth) { bestWellDepth = w; bestWellCol = c; }
      }
    }
    if (bestWellDepth >= 2) {
      const edgeDist = Math.min(bestWellCol, cols-1-bestWellCol);
      const edgeMult = edgeDist === 0 ? 1.5 : edgeDist === 1 ? 0.8 : 0.2;
      score += Math.min(bestWellDepth, 6) * 14 * edgeMult;
    }
    if (wellCount >= 2) score -= (wellCount - 1) * 300;
  }

  // ── T-spin setup reward ──────────────────────────────────────
  if (maxH <= 14) score += evaluateTspinSetup(board, heights);

  // Variance penalty (flat is good)
  const variance = heights.reduce((a,h)=>a+Math.pow(h-avgH,2),0) / cols;
  score -= variance * 0.8;

  // ── 縦積み（narrow tall column）ペナルティ ──────────────────────
  // 幅1〜2の高い柱は隙間に入れられない原因になるので強くペナルティ
  for (let c = 0; c < cols; c++) {
    const h = heights[c];
    if (h < 4) continue;
    // 隣の列との差: 両方の隣より高い場合は突出柱
    const lh = c > 0 ? heights[c-1] : 0;
    const rh = c < cols-1 ? heights[c+1] : 0;
    const protrude = h - Math.max(lh, rh);
    if (protrude >= 3) {
      // 孤立した突出柱：穴を作る元凶
      score -= protrude * protrude * 18;
    }
    if (protrude >= 5) {
      // 特に高い突出柱は致命的
      score -= protrude * 60;
    }
  }
  // 単独セル（隣に何もない1セル幅の柱）の最上段ペナルティ
  for (let c = 0; c < cols; c++) {
    if (heights[c] < 2) continue;
    const topRow = ROWS + HIDDEN - heights[c];
    const lEmpty = c === 0 || !board[topRow][c-1];
    const rEmpty = c === cols-1 || !board[topRow][c+1];
    if (lEmpty && rEmpty && heights[c] >= 3) {
      // 両隣が空で単独柱 → 非常に詰めにくい
      score -= heights[c] * 25;
    }
  }
  for (let c = 0; c < cols - 1; c++) {
    const leftNeighH  = c > 0        ? heights[c-1] : heights[c+2] || 0;
    const rightNeighH = c < cols - 2 ? heights[c+2] : heights[c-1] || 0;
    const avgNeigh = (leftNeighH + rightNeighH) / 2;
    const gap0 = avgNeigh - heights[c];
    const gap1 = avgNeigh - heights[c+1];
    if (gap0 >= 3 && gap1 >= 3) {
      const pitDepth = Math.min(gap0, gap1);
      score -= pitDepth * pitDepth * 25;
    }
  }

  return score;
}

// T-spin setup evaluation (looks for actual TSD-ready slots)
function evaluateTspinSetup(board, heights) {
  const cols = board[0].length;
  let bonus = 0;
  for (let c = 1; c < cols-1; c++) {
    const lh = heights[c-1], ch = heights[c], rh = heights[c+1];
    const ld = lh - ch, rd = rh - ch;
    if (ld >= 2 && rd >= 2 && ch >= 2) {
      bonus += 80;
      const bRow = ROWS+HIDDEN - ch;
      if (bRow >= 0 && bRow < ROWS+HIDDEN) {
        const hasL = c > 0      && board[bRow] && board[bRow][c-1];
        const hasR = c < cols-1 && board[bRow] && board[bRow][c+1];
        if (hasL && hasR) bonus += 180;
        else if (hasL || hasR) bonus += 80;
      }
    } else if ((ld >= 2 && rd >= 1) || (ld >= 1 && rd >= 2)) {
      bonus += 25;
    }
  }
  return Math.min(bonus, 400);
}

// SRS wall kick tables
const SRS_KICKS = {
  'I': {
    '0->1': [[-2,0],[1,0],[-2,-1],[1,2]],
    '1->0': [[2,0],[-1,0],[2,1],[-1,-2]],
    '1->2': [[-1,0],[2,0],[-1,2],[2,-1]],
    '2->1': [[1,0],[-2,0],[1,-2],[-2,1]],
    '2->3': [[2,0],[-1,0],[2,1],[-1,-2]],
    '3->2': [[-2,0],[1,0],[-2,-1],[1,2]],
    '3->0': [[1,0],[-2,0],[1,-2],[-2,1]],
    '0->3': [[-1,0],[2,0],[-1,2],[2,-1]],
  },
  'default': {
    '0->1': [[-1,0],[-1,1],[0,-2],[-1,-2]],
    '1->0': [[1,0],[1,-1],[0,2],[1,2]],
    '1->2': [[1,0],[1,-1],[0,2],[1,2]],
    '2->1': [[-1,0],[-1,1],[0,-2],[-1,-2]],
    '2->3': [[1,0],[1,1],[0,-2],[1,-2]],
    '3->2': [[-1,0],[-1,-1],[0,2],[-1,2]],
    '3->0': [[-1,0],[-1,-1],[0,2],[-1,2]],
    '0->3': [[1,0],[1,1],[0,-2],[1,-2]],
  }
};

function tryRotate(board, type, rot, x, y, dir) {
  const toRot = ((rot + dir) % 4 + 4) % 4;
  const key = `${rot}->${toRot}`;
  const kicks = (type === 'I' ? SRS_KICKS['I'] : SRS_KICKS['default'])[key] || [];
  if (isValid(board, type, toRot, x, y)) return { rot: toRot, x, y };
  for (const [kx, ky] of kicks) {
    const nx = x + kx, ny = y + ky;
    if (isValid(board, type, toRot, nx, ny)) return { rot: toRot, x: nx, y: ny };
  }
  return null;
}

// Fast placement finder for AI lookahead:
// Hard-drop only (O(rots*cols)) — no BFS, safe for deep lookahead
// Also tries SRS wall kicks for T-spin detection
function getAllPlacementsFast(board, type) {
  const results = [];
  const visited = new Set();
  const cols = board[0].length;
  const add = (rot, x, wasKicked) => {
    if (!isValid(board, type, rot, x, 0)) return;
    const y = hardDropY(board, type, rot, x, 0);
    const key = `${rot},${x},${y}`;
    if (visited.has(key)) return;
    visited.add(key);
    const spin = detectSpin(board, type, rot, x, y, wasKicked);
    const placed = placePiece(board, type, rot, x, y);
    const { board: cleared, lines } = clearLines(placed);
    results.push({ rot, x, y, board: cleared, lines, spin, type, needsSoftDrop: false });
  };
  for (let rot = 0; rot < 4; rot++) {
    for (let x = -2; x < cols + 2; x++) add(rot, x, false);
  }
  // Spin wall kicks: try each kick offset too
  const kickTypes = ['T', 'S', 'Z', 'L', 'J', 'I'];
  if (kickTypes.includes(type)) {
    for (let fromRot = 0; fromRot < 4; fromRot++) {
      for (const dir of [1, -1]) {
        const toRot = ((fromRot + dir) % 4 + 4) % 4;
        const key2 = `${fromRot}->${toRot}`;
        const kicks = (type === 'I' ? SRS_KICKS['I'] : SRS_KICKS['default'])[key2] || [];
        for (const [kx] of kicks) {
          for (let x = -2; x < cols + 2; x++) add(toRot, x + kx, true);
        }
      }
    }
  }
  return results;
}

// Full BFS-based placement finder for the CURRENT piece only (used once per move, not in lookahead)
// Finds ALL reachable placements including those only reachable via soft drop
function getAllPlacementsBFS(board, type) {
  const results = [];
  const lockedKeys = new Set();
  const visitedStates = new Set();
  const queue = [];
  const cols = board[0].length;

  const enqueue = (rot, x, y) => {
    const key = `${rot},${x},${y}`;
    if (visitedStates.has(key)) return;
    visitedStates.add(key);
    queue.push({ rot, x, y });
  };

  // Compute direct-drop positions (for needsSoftDrop flag)
  const directDrop = new Set();
  for (let rot = 0; rot < 4; rot++) {
    for (let x = -2; x < cols + 2; x++) {
      if (!isValid(board, type, rot, x, 0)) continue;
      directDrop.add(`${rot},${x},${hardDropY(board, type, rot, x, 0)}`);
    }
  }

  for (let rot = 0; rot < 4; rot++) {
    for (let x = -2; x < cols + 2; x++) {
      if (isValid(board, type, rot, x, 0)) enqueue(rot, x, 0);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const { rot, x, y } = queue[qi++];
    for (const [dx, dy] of [[-1,0],[1,0],[0,1]]) {
      const nx = x+dx, ny = y+dy;
      if (isValid(board, type, rot, nx, ny)) enqueue(rot, nx, ny);
    }
    for (const dir of [1, -1]) {
      const res = tryRotate(board, type, rot, x, y, dir);
      if (res) enqueue(res.rot, res.x, res.y);
    }
    if (!isValid(board, type, rot, x, y+1)) {
      const lockKey = `${rot},${x},${y}`;
      if (!lockedKeys.has(lockKey)) {
        lockedKeys.add(lockKey);
        const spin = detectSpin(board, type, rot, x, y, false);
        const placed = placePiece(board, type, rot, x, y);
        const { board: cleared, lines } = clearLines(placed);
        const needsSoftDrop = !directDrop.has(lockKey);
        results.push({ rot, x, y, board: cleared, lines, spin, type, needsSoftDrop });
      }
    }
  }
  return results;
}

// ── Perfect Clear Solver (4-line PC専用・高性能版) ─────────────────
//
// 設計:
//   1. 盤面が4行以下のときのみ起動
//   2. 既知の4PC openerパターンを最優先で試行
//   3. DFSで全探索（ビームサーチ+積極的剪定）
//   4. PC後はpcCycleカウンタを維持して継続PC狙い
//
// 4PC feasibility:
//   空盤から10ミノで40セル = 4行ぴったり埋まる
//   開幕: I,T,S,Z,L,J,O + 3枚追加 = 10枚で1サイクル
// ─────────────────────────────────────────────────────────────────────

// ── Perfect Clear Solver v2 ───────────────────────────────────────
// 大幅強化版:
//   - 列連結性チェック（孤立空洞の早期検出）
//   - 埋まりやすさスコアでソート（PC達成方向を優先探索）
//   - 最小必要ミノ数を事前計算して不要な深さを枝刈り
//   - 穴ゼロ厳守（filled列が連続している形のみ通過）
//   - 孤立セル数チェック（T/S/Zで埋められない形を排除）
// ─────────────────────────────────────────────────────────────────

// 盤面の「空きセルの連結成分」が全て4の倍数サイズかチェック
// PCには空きセルが4の倍数で連結されている必要がある
function checkConnectivity(board) {
  const TOTAL = ROWS + HIDDEN;
  const cols = board[0].length;
  const visited = Array.from({length: TOTAL}, () => Array(cols).fill(false));
  const components = [];

  for (let r = 0; r < TOTAL; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c] && !visited[r][c]) {
        // BFS to find connected empty cells
        let size = 0;
        const queue = [[r, c]];
        visited[r][c] = true;
        let qi = 0;
        while (qi < queue.length) {
          const [cr, cc] = queue[qi++];
          size++;
          for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nr = cr+dr, nc = cc+dc;
            if (nr >= 0 && nr < TOTAL && nc >= 0 && nc < cols && !board[nr][nc] && !visited[nr][nc]) {
              visited[nr][nc] = true;
              queue.push([nr, nc]);
            }
          }
        }
        components.push(size);
      }
    }
  }

  // すべての連結成分が4の倍数サイズでなければPCは不可能
  return components.every(s => s % 4 === 0);
}

// 列ごとの最高ブロック行を返す（高い列=index小）
function getBoardHeights(board) {
  const cols = board[0].length;
  const heights = Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < ROWS + HIDDEN; r++) {
      if (board[r][c]) { heights[c] = ROWS + HIDDEN - r; break; }
    }
  }
  return heights;
}

// 盤面の「PC近さスコア」: 低いほど良い（ソート用）
function pcProximityScore(board, filledCells) {
  const cols = board[0].length;
  // 穴・高さ・凸凹度を組み合わせたヒューリスティック
  const heights = getBoardHeights(board);
  const maxH = Math.max(...heights);
  const bumpiness = heights.reduce((a, h, i) => i > 0 ? a + Math.abs(h - heights[i-1]) : a, 0);
  let holes = 0;
  for (let c = 0; c < cols; c++) {
    let inBlock = false;
    for (let r = 0; r < ROWS + HIDDEN; r++) {
      if (board[r][c]) inBlock = true;
      else if (inBlock) holes++;
    }
  }
  // スコアが低いほど良い配置 (ソートで昇順)
  return holes * 100 + bumpiness * 10 + maxH * 5;
}

// 4PCに特化した高速DFS v2
// board: 現在の盤面（0=空）
// pieces: 試すミノ列（最大10）
// timeLimitMs: 時間制限
function findPCSequence(board, pieces, timeLimitMs = 1000) {
  const cols = board[0].length;
  // 盤面の最高行を求める
  let highestRow = -1;
  for (let r = 0; r < ROWS + HIDDEN; r++) {
    if (board[r].some(c => c !== 0)) { highestRow = r; break; }
  }
  const occupiedHeight = highestRow === -1 ? 0 : ROWS + HIDDEN - highestRow;

  // 高すぎる場合は諦める（4PC狙いの場合8行、緊急時は6行まで）
  if (occupiedHeight > 8) return null;

  // 埋まっているセル数
  let filled = 0;
  for (let r = 0; r < ROWS + HIDDEN; r++)
    for (let c = 0; c < cols; c++)
      if (board[r][c]) filled++;

  const limit = Math.min(pieces.length, 10);

  // feasibility check: filled + n*4 が10の倍数になる最小nを求める
  let minPieces = -1;
  for (let n = 1; n <= limit; n++) {
    if ((filled + n * 4) % 10 === 0) { minPieces = n; break; }
  }
  if (minPieces < 0) return null;

  // 初期連結性チェック（空きセルが4の倍数でない列配置は不可能）
  const totalEmpty = ROWS * cols - filled; // visible rows only approx
  // NOTE: 厳密な連結性は初期盤面では省略（速度優先）

  const deadline = Date.now() + timeLimitMs;
  let best = null;

  // ── 高速な盤面評価ヘルパー ────────────────────────────────────
  function getBoardInfo(b) {
    let filled = 0, holes = 0, maxH = 0;
    const heights = Array(cols).fill(0);
    for (let c = 0; c < cols; c++) {
      let inBlock = false, colH = 0;
      for (let r = 0; r < ROWS + HIDDEN; r++) {
        const v = b[r][c];
        if (v) { filled++; inBlock = true; if (!colH) colH = ROWS + HIDDEN - r; }
        else if (inBlock) holes++;
      }
      heights[c] = colH;
      if (colH > maxH) maxH = colH;
    }
    const bumpiness = heights.reduce((a, h, i) => i > 0 ? a + Math.abs(h - heights[i-1]) : a, 0);
    return { filled, holes, maxH, bumpiness, heights };
  }

  // PC到達可能性の高速チェック
  function canReachPC(filledCells, restLen) {
    for (let n = 0; n <= restLen; n++) {
      if ((filledCells + n * 4) % 10 === 0) return true;
    }
    return false;
  }

  function dfs(b, remaining, seq, parentInfo) {
    if (best || Date.now() > deadline) return;
    if (!remaining.length) return;

    const type = remaining[0];
    const rest = remaining.slice(1);

    const placements = getAllPlacementsFast(b, type);
    if (!placements.length) return;

    // PC達成に必要な最小ミノ数を計算（枝刈り用）
    const minForPC = (() => {
      for (let n = 1; n <= remaining.length; n++) {
        if ((parentInfo.filled + n * 4) % 10 === 0) return n;
      }
      return Infinity;
    })();

    // プレースメントをスコアでソート（PC到達が速い順）
    // ライン消去 > 穴ゼロ > 低bumpiness > 低maxH
    const scored = placements.map(p => {
      const info = getBoardInfo(p.board);
      // PC達成ならスコア最高
      if (p.board.every(row => row.every(c => c === 0))) return { p, score: -1e9, info };
      // 穴があったら大ペナルティ
      const holePenalty = info.holes * 200;
      // 高さペナルティ
      const heightPenalty = info.maxH * 8;
      // 凸凹ペナルティ
      const bumpPenalty = info.bumpiness * 12;
      // ライン消去ボーナス
      const lineBonus = p.lines * 80;
      return { p, score: holePenalty + heightPenalty + bumpPenalty - lineBonus, info };
    });
    scored.sort((a, z) => a.score - z.score);

    for (const { p, score, info } of scored) {
      if (best || Date.now() > deadline) return;

      // PC達成チェック
      if (p.board.every(row => row.every(c => c === 0))) {
        best = [...seq, { type, rot: p.rot, x: p.x }];
        return;
      }

      // ── 枝刈り ──────────────────────────────────────────────
      // 1: 高さ制限（4PC圏外）
      if (info.maxH > 8) continue;

      // 2: 穴があったらカット（穴ゼロ厳守）
      if (info.holes > 0) continue;

      // 3: 残りミノでPC到達可能か
      if (!canReachPC(info.filled, rest.length)) continue;

      // 4: 列連結性チェック（隔離された空きセルがあればPC不可）
      // コストが高いので最終段階のみ実施
      if (rest.length <= 3 && info.maxH <= 6) {
        if (!checkConnectivity(p.board)) continue;
      }

      // 5: 孤立セル（幅1の列の深さ）チェック
      // 幅1の溝が3マス以上深ければほぼ埋められない
      let hasDeepShaft = false;
      for (let c = 0; c < cols; c++) {
        const lh = c > 0 ? info.heights[c-1] : 99;
        const rh = c < cols-1 ? info.heights[c+1] : 99;
        const shaft = Math.min(lh, rh) - info.heights[c];
        if (shaft >= 4) { hasDeepShaft = true; break; }
      }
      if (hasDeepShaft) continue;

      if (rest.length > 0) {
        dfs(p.board, rest, [...seq, { type, rot: p.rot, x: p.x }], info);
      }
    }
  }

  const initInfo = getBoardInfo(board);
  dfs(board, pieces.slice(0, limit), [], initInfo);
  return best;
}

// ── 4PC評価ボーナス ────────────────────────────────────────────────
// 盤面がPCに向いているかを評価する追加スコア
function evaluatePC4Fitness(board, heights) {
  let score = 0;
  const cols = board[0].length;
  const maxH = Math.max(...heights);
  const minH = Math.min(...heights);

  // 4行以下ならPCボーナス
  if (maxH <= 4) score += 2000;
  else if (maxH <= 6) score += 800;
  else if (maxH <= 8) score += 200;

  // フラットな盤面を強く評価
  const bumpiness = heights.reduce((a, h, i) => i > 0 ? a + Math.abs(h - heights[i-1]) : a, 0);
  if (bumpiness <= 2) score += 500;
  else if (bumpiness <= 4) score += 200;

  // 穴がゼロなら大ボーナス
  let holes = 0;
  for (let c = 0; c < cols; c++) {
    let hasBlock = false;
    for (let r = 0; r < ROWS + HIDDEN; r++) {
      if (board[r][c]) hasBlock = true;
      else if (hasBlock) holes++;
    }
  }
  if (holes === 0) score += 1000;
  else score -= holes * 500;

  return score;
}

// ── Bot AI decision making ──────────────────────────────────────



function botChoosePlacement(board, type, nextTypes, holdType, b2b, combo, level, botLevel, ren, pcBonus=0) {
  const cols = board[0].length;
  // ── Garbage detection ──────────────────────────────────────────
  // Count garbage rows and compute max stack height
  let garbageRowCount = 0;
  for (let r = 0; r < ROWS+HIDDEN; r++) {
    if (board[r].some(c => c === 'G')) garbageRowCount++;
  }
  const heights = Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < ROWS+HIDDEN; r++) {
      if (board[r][c]) { heights[c] = ROWS+HIDDEN - r; break; }
    }
  }
  const maxHeight = Math.max(...heights);

  // Garbage priority mode: when garbage is significant, boost line-clearing placements
  const garbagePriority = garbageRowCount >= 4 || (garbageRowCount >= 2 && maxHeight >= 12);

  // depth=2 max — depth=3 would be 43000+ calls and hang the server
  // 4wide mode has fewer placements, so we can afford more depth for better REN planning
  let depth = botLevel >= 2 ? 2 : 1;
  if (cols <= 4 && botLevel >= 3) depth = 3;
  
  // Beam width: limits candidates per ply so depth stays fast
  const beamWidth = botLevel >= 5 ? 12 : botLevel >= 4 ? 8 : botLevel >= 3 ? 5 : 3;

  function evalDeep(b, pieces, d, isB2B, cmb, r) {
    if (d === 0 || pieces.length === 0) return evaluateBoard(b, 0, null, false, 0, level, r);
    const pl = getAllPlacementsFast(b, pieces[0]); // fast only in lookahead!
    if (pl.length === 0) return -99999;
    // Beam pruning
    const scored = pl.map(p => {
      const newR = p.lines > 0 ? r + 1 : 0;
      const iB2B2 = isB2B && (p.lines===4||(p.spin&&p.spin!=='MINI_TSPIN'&&p.lines>0));
      const nc = cmb+(p.lines>0?1:0);
      return { p, sc: evaluateBoard(p.board, p.lines, p.spin, iB2B2, nc, level, newR) + addBonuses(p) };
    }).sort((a, b2) => b2.sc - a.sc).slice(0, beamWidth);
    let best = -Infinity;
    for (const { p, sc } of scored) {
      const newR = p.lines > 0 ? r + 1 : 0;
      const iB2B2 = isB2B && (p.lines===4||(p.spin&&p.spin!=='MINI_TSPIN'&&p.lines>0));
      const nc = cmb+(p.lines>0?1:0);
      const fut = d > 1 ? evalDeep(p.board, pieces.slice(1), d-1, iB2B2, nc, newR) * 0.6 : 0;
      if (sc + fut > best) best = sc + fut;
    }
    return best;
  }

  function addBonuses(p) {
    let b = 0;
    if (p.lines === 4) b += 800;

    // PC達成ボーナス
    if (p.board && p.board.every(row => row.every(c => c === 0))) {
      b += 80000 + pcBonus; // PCは最優先
      return b;
    }

    // ── T-spin ボーナス強化 ────────────────────────────────────
    if (p.spin === 'TSPIN') {
      if (p.lines === 1) b += 1200;
      else if (p.lines === 2) b += 2800; // TSD
      else if (p.lines === 3) b += 4500; // TST
    } else if (p.spin === 'MINI_TSPIN' && p.lines > 0) {
      b += 200; // mini T-spin is still fine
    } else if (p.spin && p.spin !== 'NONE' && p.lines > 0) {
      // S/Z/L/J/I spin
      b += p.lines * 600;
    }

    // ── T-spinセットアップ保持ボーナス (T以外のピース) ──────────
    if (p.type !== 'T' && p.board) {
      b += evaluateTspinSetup(p.board, (() => {
        const cols = p.board[0].length;
        return Array.from({ length: cols }, (_, c) => {
          for (let r = 0; r < ROWS + HIDDEN; r++) {
            if (p.board[r][c]) return ROWS + HIDDEN - r;
          }
          return 0;
        });
      })()) * 0.5;
    }

    // PC-friendly: pcBonusが大きいとき（pcHuntMode）は
    // 盤面を低く・フラットに保つことを強く報酬
    if (pcBonus > 0 && p.board) {
      const ph = [];
      const cols = p.board[0].length;
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < ROWS + HIDDEN; r++) {
          if (p.board[r][c]) { ph.push(ROWS + HIDDEN - r); break; }
          if (r === ROWS + HIDDEN - 1) ph.push(0);
        }
      }
      b += evaluatePC4Fitness(p.board, ph) * (pcBonus / 60000);
    }

    // Garbage priority: heavily reward any line clear when garbage is threatening
    if (garbagePriority && p.lines > 0) {
      b += p.lines * garbageRowCount * 200;
      if (p.lines >= 2) b += 500;
      if (p.lines >= 4) b += 1500;
    }
    return b;
  }

  // Jitter: small random noise to avoid perfectly deterministic play
  // Higher botLevel = less jitter. Level5=±20, Level3=±120, Level1=±400
  const jitterAmp = [0, 400, 220, 120, 60, 20, 0][botLevel] || 0;

  // BFS for current piece (finds soft-drop reachable placements)
  function evalPlacementsBFS(useType, useHold) {
    const placements = getAllPlacementsBFS(board, useType);
    let bestScore = -Infinity, bestPlacement = null;
    for (const p of placements) {
      const newRen = p.lines > 0 ? (ren||0) + 1 : 0;
      const iB2B = b2b && (p.lines===4||(p.spin&&p.spin!=='MINI_TSPIN'&&p.lines>0));
      const nc = combo + (p.lines > 0 ? 1 : 0);
      let sc = evaluateBoard(p.board, p.lines, p.spin, iB2B, nc, level, newRen);
      sc += addBonuses(p);
      if (depth >= 2 && nextTypes.length > 0)
        sc += evalDeep(p.board, nextTypes, depth-1, iB2B, nc, newRen) * 0.6;
      sc += (Math.random() * 2 - 1) * jitterAmp;
      if (sc > bestScore) { bestScore = sc; bestPlacement = { ...p, useHold }; }
    }
    return { bestScore, bestPlacement };
  }

  const { bestScore: sc1, bestPlacement: p1 } = evalPlacementsBFS(type, false);
  let result = p1, resultScore = sc1;

  const holdPenalty = botLevel >= 4 ? 0 : botLevel >= 3 ? 40 : 100;

  if (holdType) {
    const { bestScore: sc2, bestPlacement: p2 } = evalPlacementsBFS(holdType, true);
    if (p2 && sc2 - holdPenalty > resultScore) { result = p2; resultScore = sc2 - holdPenalty; }
  } else if (nextTypes.length > 0) {
    const placementsNext = getAllPlacementsBFS(board, nextTypes[0]);
    let bestScoreA = -Infinity, bestPA = null;
    for (const p of placementsNext) {
      const newRen = p.lines > 0 ? (ren||0) + 1 : 0;
      const iB2B = b2b && (p.lines===4||(p.spin&&p.spin!=='MINI_TSPIN'&&p.lines>0));
      const nc = combo + (p.lines > 0 ? 1 : 0);
      let sc = evaluateBoard(p.board, p.lines, p.spin, iB2B, nc, level, newRen);
      sc += addBonuses(p);
      if (depth >= 2 && nextTypes.length > 1)
        sc += evalDeep(p.board, nextTypes.slice(1), depth-1, iB2B, nc, newRen) * 0.6;
      if (sc > bestScoreA) { bestScoreA = sc; bestPA = { ...p, useHold: true }; }
    }
    if (bestPA && bestScoreA - holdPenalty > resultScore) {
      result = bestPA;
    }
  }

  return result;
}

// ── BotPlayer ──────────────────────────────────────────────────────
class BotPlayer {
  constructor(id, name, level, roomId, bag, customCode) {
    this.id = id; this.name = name; this.level = level; this.roomId = roomId;
    this.isBot = true; this.botLevel = level;
    // Determine column count from the room if possible, otherwise default to 10
    const room = rooms[roomId];
    this.cols = (room && room.roomSettings && room.roomSettings.fourWideMode) ? COLS_4WIDE : COLS;
    this.board = Array.from({length:ROWS+HIDDEN},()=>Array(this.cols).fill(0));
    this.bag = bag;
    this.nextQueue = [];
    for (let i = 0; i < 6; i++) this.nextQueue.push(this.bag.next());
    this.holdPiece = null; this.holdUsed = false;
    this.score = 0; this.lines = 0; this.lvl = 1;
    this.combo = -1; this.b2b = false; this.alive = true; this.ren = 0;
    this.garbageQueue = [];
    this.thinkTimer = null;
    this.currentPiece = null;
    // Custom bot code
    this.customCode = customCode || null;
    this._customFn = null;
    if (this.customCode) {
      try {
        // If the user defines function decide(state){...}, call it.
        // Otherwise just evaluate the code directly.
        this._customFn = new Function('state', this.customCode + '\nreturn (typeof decide==="function"?decide(state):void 0);');
      }
      catch(e) {
        console.warn(`[BOT] Invalid custom code for ${name}:`, e.message);
        // パースエラーをルーム全員へ通知
        const room = rooms[roomId];
        if (room) io.to(roomId).emit('bot_code_error', { type: 'parse', botName: name, message: e.message });
      }
    }
    // PC hunt state
    this.pcHuntMode = true;      // 常時PC狙いモード
    this.pcPiecesPlaced = 0;     // 累計配置数
    this.pcCycle = 0;            // 何回目のPCサイクルか
    this.pcFailed = 0;           // 連続失敗回数（多すぎたら一時停止）
    this.lastPlacements = [];
    
    // Stats tracking
    this.startTime = Date.now();
    this.pieceCount = 0;
    this.totalAttackSent = 0;
    this.totalGarbageCleared = 0;
    this.pps = 0;
    this.apm = 0;
    this.vs = 0;
    this.b2bCount = 0;

    this.spawnPiece();

    // Cold Clear (level 6) の場合はここで即時初期化する。
    // _thinkColdClear での遅延初期化だとキューのタイミングがズレるため。
    this._ccBot = null;
    this._ccPending = false;
    this._ccInitFailed = false;
    this._ccQueueSentCount = 0;
    if (this.botLevel === 6) {
      this._ccInit();
    }
  }

  get thinkDelay() { return [0, 2200, 1400, 700, 280, 80][this.level] || 400; }
  get moveStepDelay() { return [0, 120, 80, 45, 20, 8][this.level] || 40; }

  spawnPiece() {
    this.pieceCount++;
    const now = Date.now();
    const elapsedSec = (now - this.startTime) / 1000;
    if (elapsedSec > 1) {
      this.pps = this.pieceCount / elapsedSec;
      this.apm = (this.totalAttackSent / elapsedSec) * 60;
      this.vs = ((this.totalAttackSent + this.totalGarbageCleared) / elapsedSec) * 60;
    }
    const type = this.nextQueue.shift();
    this.nextQueue.push(this.bag.next());
    const spawnX = Math.floor((this.cols - 4) / 2);
    this.currentPiece = { type, rotation: 0, x: spawnX, y: -2 };
    this.holdUsed = false;
    if (!isValid(this.board, type, 0, spawnX, -1)) this.alive = false;
  }

  // 盤面の実効高さを返す
  _boardHeight() {
    for (let r = 0; r < ROWS + HIDDEN; r++)
      if (this.board[r].some(c => c !== 0)) return ROWS + HIDDEN - r;
    return 0;
  }

  // PCソルバーを試行し、手順を返す（なければnull）
  // nextを最大限活用して多くの組み合わせを試す
  _tryFindPC(timeLimitMs) {
    const h = this._boardHeight();
    if (h > 8) return null; // 8行超は諦める

    const cur = this.currentPiece.type;
    const next = this.nextQueue.slice(0, 9); // 最大9枚先読み
    const hold = this.holdPiece;

    // 試す組み合わせを優先順位付きでリスト化
    // [ピース列, holdFirstフラグ, 説明]
    const candidates = [];

    // パターン1: current → next（最基本）
    candidates.push({ pieces: [cur, ...next], holdFirst: false });

    if (hold) {
      // パターン2: hold → current → next（holdを先に使う）
      candidates.push({ pieces: [hold, cur, ...next.slice(0, 8)], holdFirst: true });

      // パターン3: current → hold → next（holdをnext[0]の代わりに使う）
      // holdをnext[0]の位置に差し込む
      candidates.push({ pieces: [cur, hold, ...next.slice(0, 8)], holdFirst: false, swapHold: true });
    } else if (next.length > 0) {
      // holdなし: next[0]をholdとして先使いするパターン
      // (current → next[1..] + next[0]ホールド保留)
      candidates.push({ pieces: [cur, next[0], ...next.slice(1, 9)], holdFirst: false });
    }

    // 各候補に時間を配分して試行
    const timePerCandidate = Math.floor(timeLimitMs / candidates.length);
    const startTime = Date.now();

    for (const cand of candidates) {
      // 残り時間が少なければ打ち切り
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeLimitMs - 10) break;

      const remaining = timeLimitMs - elapsed;
      const allocate = Math.min(timePerCandidate, remaining);

      const seq = findPCSequence(this.board, cand.pieces, allocate);
      if (seq && seq.length > 0) {
        return { seq, holdFirst: cand.holdFirst };
      }
    }

    return null;
  }

  _buildCustomState() {
    const room = rooms[this.roomId];
    const opponents = room ? [...room.players, ...room.bots]
      .filter(p => p.id !== this.id && p.alive)
      .map(p => ({
        name: p.name,
        board: p.board ? p.board.map(r => [...r]) : null,
        score: p.score || 0,
        lines: p.lines || 0,
        level: p.level || 1,
        alive: p.alive,
        combo: p.combo !== undefined ? p.combo : 0,
        b2b: !!p.b2b,
        isBot: !!p.isBot
      })) : [];
    return {
      board: this.board.map(r => [...r]),
      currentPiece: { ...this.currentPiece },
      nextPieces: this.nextQueue.slice(0, 5).map(t => t),
      holdPiece: this.holdPiece,
      combo: Math.max(0, this.combo),
      b2b: this.b2b,
      lines: this.lines,
      score: this.score,
      level: this.lvl,
      ren: this.ren,
      garbageQueue: this.garbageQueue.map(g => ({ ...g })),
      opponents,
      cols: this.cols,
      rows: ROWS,
      isFourWide: this.cols <= 4
    };
  }

  // ── Cold Clear (real library) ─────────────────────────────────
  // ── Cold Clear (real library) ────────────────────────────────────
  // cold-clear.js (koffi FFI) による本物の Cold Clear 実装
  // ─────────────────────────────────────────────────────────────────
  // CC ピース番号 ↔ ゲーム内ピース文字列の対応
  // CC: I=0 O=1 T=2 L=3 J=4 S=5 Z=6
  static _ccPieceId(type) {
    return { I:0, O:1, T:2, L:3, J:4, S:5, Z:6 }[type] ?? -1;
  }

  // 内部ボード（top-down, 0=cell, 非0=filled）→ CC 用 40行×10列 bool配列（bottom-up）
  _ccBuildField() {
    const TOTAL = ROWS + HIDDEN;
    const field = Array.from({length:40}, () => Array(10).fill(false));
    for (let r = 0; r < TOTAL; r++) {
      const ccRow = TOTAL - 1 - r; // bottom-up
      for (let c = 0; c < 10; c++) {
        field[ccRow][c] = !!this.board[r][c];
      }
    }
    return field;
  }

  // CC の expected_x/expected_y (4 cells, bottom-up) から
  // ゲーム内の rot と x を直接逆算し、BFS合法手リストから該当配置を返す。
  _ccMoveToBfsPlacement(ccMove, type, bfsPlacements) {
    const xs = Array.from(ccMove.expected_x);
    const ys = Array.from(ccMove.expected_y);

    // CC の y は bottom-up (0=bottom)。ゲーム内 y は top-down。
    const TOTAL = ROWS + HIDDEN;
    // ゲーム内座標 (top-down)
    const gCells = xs.map((cx, i) => ({ x: cx, y: TOTAL - 1 - ys[i] }));

    // CCの4セル座標と PIECE_SHAPES の各 rot を照合して rot と x を特定する。
    // アルゴリズム:
    //   shape の各 rot について、セルのリストを (row, col) で列挙。
    //   gCells の x最小値 - shape の col最小値 = piece_x
    //   gCells の y最小値 - shape の row最小値 = piece_y (top-left corner)
    //   その piece_x/piece_y でセルを生成して gCells と完全一致すれば rot 確定。

    let targetRot = -1;
    let targetX = -1;
    let targetY = -1;

    for (let rot = 0; rot < 4; rot++) {
      const shape = PIECE_SHAPES[type][rot];
      // shape のセル (srow, scol) を列挙
      const sCells = [];
      for (let srow = 0; srow < shape.length; srow++)
        for (let scol = 0; scol < shape[srow].length; scol++)
          if (shape[srow][scol]) sCells.push({ row: srow, col: scol });

      if (sCells.length !== gCells.length) continue;

      // piece_x = gCells.x_min - sCells.col_min
      const gXmin = Math.min(...gCells.map(c => c.x));
      const gYmin = Math.min(...gCells.map(c => c.y));
      const sColMin = Math.min(...sCells.map(c => c.col));
      const sRowMin = Math.min(...sCells.map(c => c.row));

      const px = gXmin - sColMin;
      const py = gYmin - sRowMin;

      // piece (px, py, rot) のセルが gCells と完全一致するか確認
      const genCells = sCells.map(s => ({ x: px + s.col, y: py + s.row }));
      const match = gCells.every(gc => genCells.some(c => c.x === gc.x && c.y === gc.y));

      if (match) {
        targetRot = rot;
        targetX = px;
        targetY = py;
        break;
      }
    }

    if (targetRot === -1) {
      // 逆算失敗: BFS全配置と照合してセル一致数最大のものを選ぶ（フォールバック）
      console.warn(`[CC] _ccMoveToBfsPlacement: failed to decode rot for ${type}, falling back to cell-match`);
      let bestP = null;
      let bestMatch = -1;
      for (const p of bfsPlacements) {
        const shape = PIECE_SHAPES[type][p.rot];
        const cells = [];
        for (let row = 0; row < shape.length; row++)
          for (let col = 0; col < shape[row].length; col++)
            if (shape[row][col]) cells.push({ x: p.x + col, y: p.y + row });
        let matches = 0;
        for (const gc of gCells)
          if (cells.some(c => c.x === gc.x && c.y === gc.y)) matches++;
        if (matches > bestMatch) { bestMatch = matches; bestP = p; }
        if (matches === 4) break;
      }
      return bestP;
    }

    // BFSリストから rot/x が一致するものを返す（y は hardDrop で決まるので無視）
    const found = bfsPlacements.find(p => p.rot === targetRot && p.x === targetX);
    if (found) return found;

    // BFSに存在しない（到達不可能）場合: rot/x だけ一致するものを探す
    // （BFS未到達でも hardDrop で置ける場合がある）
    console.warn(`[CC] placement rot=${targetRot} x=${targetX} not in BFS for ${type}`);
    return null;
  }

  // CC インスタンスの初期化（ゲーム開始時 or reset 時）
  _ccInit() {
    if (this._ccBot) return;
    try {
      const { ColdClearBot, defaultOptions, PcPriority } = require('./cold-clear');

      // CC の cc_launch_async に渡す queue は「current piece から始まるピース列」。
      // current piece が先頭、続いて nextQueue の順で渡す。
      // (CC内部: queue[0] が現在のピース、queue[1]以降がnext)
      const queue = [
        this.currentPiece.type,
        ...this.nextQueue,
      ].map(t => BotPlayer._ccPieceId(t)).filter(n => n >= 0);

      const options = defaultOptions({
        pcloop:    PcPriority.ATTACK,
        use_hold:  true,
        speculate: true,
        threads:   2,
        min_nodes: 10_000,
        max_nodes: 4_000_000_000,
      });

      this._ccBot = new ColdClearBot({ options, queue });
      this._ccPending = false;
      this._ccInitFailed = false;
      // CCへのキュー供給済み枚数を追跡する。
      // launch時に current(1) + nextQueue(6) = 7枚渡してある。
      // spawnPiece()のたびに nextQueue末尾の1枚を addNextPiece で追加する。
      // 何枚供給済みかを記録して二重送信を防ぐ。
      this._ccQueueSentCount = queue.length;
      console.log(`[CC] Initialized for bot ${this.name}, queue=${queue.length}`);
    } catch(e) {
      console.error('[CC] Failed to initialize ColdClearBot:', e.message);
      console.error('[CC] Stack:', e.stack);
      this._ccBot = null;
      this._ccInitFailed = true;
    }
  }

  // reset後にCC側のキューを現在のゲーム状態で再同期する
  _ccReSyncQueue() {
    if (!this._ccBot) return;
    try {
      // resetはフィールドのみリセットし、キューはCC内部で保持される。
      // ただし投機が外れたケースのためにcurrent+nextを再通知する。
      // CCはreset後も内部キューを維持するため、ここでは
      // 「resetで失われたキュー」を補充するだけにとどめる。
      // 安全のため: 現在のcurrent + nextQueue を全てaddNextPieceで送る
      // (CCは重複分は無視するわけではないので、resetを使う際は
      //  新しいBotインスタンスを作る方が確実)
      const allPieces = [
        this.currentPiece.type,
        ...this.nextQueue,
      ].map(t => BotPlayer._ccPieceId(t)).filter(n => n >= 0);
      for (const pid of allPieces) {
        this._ccBot.addNextPiece(pid);
      }
      this._ccQueueSentCount = allPieces.length;
    } catch(e) {
      console.error('[CC] _ccReSyncQueue failed:', e.message);
    }
  }

  // Level 5 AI に直接フォールバック（再帰を避ける）
  _fallbackAI(onDone) {
    const placement = botChoosePlacement(
      this.board, this.currentPiece.type,
      this.nextQueue.slice(0, 5),
      this.holdPiece,
      this.b2b, Math.max(0, this.combo),
      this.lvl, 5, this.ren, 0
    );
    if (placement) {
      this.executePlacement(placement, onDone);
    } else if (onDone) {
      onDone();
    }
  }

  _thinkColdClear(onDone) {
    if (!this.alive || !this.currentPiece) { if (onDone) onDone(); return; }
    // CC ライブラリが使えない場合は手番をスキップ（lv5にフォールバックしない）
    if (this._ccInitFailed) {
      console.error('[CC] Library unavailable, skipping turn.');
      if (onDone) onDone();
      return;
    }

    // 初回初期化
    if (!this._ccBot) this._ccInit();
    if (!this._ccBot) {
      console.error('[CC] Bot not available, skipping turn.');
      if (onDone) onDone();
      return;
    }

    const bot = this._ccBot;

    // 手の要求（まだ発行していなければ）
    if (!this._ccPending) {
      const incoming = this.garbageQueue.reduce((s, g) => s + g.lines, 0);
      try {
        bot.requestNextMove(incoming);
        this._ccPending = true;
      } catch(e) {
        console.error('[CC] requestNextMove failed:', e.message);
        if (onDone) onDone();
        return;
      }
    }

    // ポーリング（最大 4000ms）
    const startPoll = Date.now();
    const POLL_LIMIT = 4000;

    const pollLoop = () => {
      if (!this.alive) { if (onDone) onDone(); return; }

      let res;
      try {
        res = bot.pollNextMove();
      } catch(e) {
        console.error('[CC] pollNextMove error:', e.message);
        this._ccPending = false;
        if (onDone) onDone();
        return;
      }

      if (res.status === 'provided') {
        this._ccPending = false;
        this._applyCC(res.move, onDone);
        return;
      }

      if (res.status === 'dead') {
        console.warn('[CC] Bot died, reinitializing...');
        try { bot.destroy(); } catch(e) {}
        this._ccBot = null;
        this._ccPending = false;
        this._ccInitFailed = false;
        this._ccInit();
        // 再初期化後は次の手番から使う。今の手番はスキップ。
        if (onDone) onDone();
        return;
      }

      // waiting
      if (Date.now() - startPoll > POLL_LIMIT) {
        console.warn('[CC] Poll timeout after', POLL_LIMIT, 'ms, skipping turn.');
        this._ccPending = false;
        if (onDone) onDone();
        return;
      }

      setTimeout(pollLoop, 10);
    };

    pollLoop();
  }

  // CC の move を受け取り、ゲーム内配置に変換して実行する
  _applyCC(mv, onDone) {
    if (!this.alive || !this.currentPiece) { if (onDone) onDone(); return; }

    const useHold = !!mv.hold;

    // ── 配置するピースを特定 ──────────────────────────────────
    let type;
    if (useHold) {
      if (this.holdPiece) {
        type = this.holdPiece;
      } else {
        type = this.nextQueue[0];
      }
    } else {
      type = this.currentPiece.type;
    }

    // ── デバッグ: CCの生の出力をログ ──────────────────────────
    const rawXs = Array.from(mv.expected_x);
    const rawYs = Array.from(mv.expected_y);
    console.log(`[CC DEBUG] type=${type} hold=${useHold} raw_x=[${rawXs}] raw_y=[${rawYs}]`);

    // ── BFS合法手と照合 ──────────────────────────────────────
    const bfsPlacements = getAllPlacementsBFS(this.board, type);
    let placement = null;

    if (bfsPlacements.length > 0) {
      placement = this._ccMoveToBfsPlacement(mv, type, bfsPlacements);
    }

    if (!placement) {
      console.warn('[CC] No valid placement found for', type);
      if (onDone) onDone();
      return;
    }

    this.executePlacement({ ...placement, useHold }, onDone);
  }


  think(onDone) {
    if (!this.alive || !this.currentPiece) { if(onDone)onDone(); return; }

    // ── COLD CLEAR MODE ──────────────────────────────────────────
    if (this.botLevel === 6) {
      this._thinkColdClear(onDone);
      return;
    }

    // ── CUSTOM BOT CODE PATH ──────────────────────────────────────
    if (this._customFn) {
      try {
        const state = this._buildCustomState();
        const result = this._customFn(state);
        if (result && result.x !== undefined && result.rotation !== undefined) {
          const r = ((result.rotation % 4) + 4) % 4;
          const x = result.x;
          // Verify placement is reachable via BFS from spawn
          const bfsPlacements = getAllPlacementsBFS(this.board, this.currentPiece.type);
          const matched = bfsPlacements.find(p => p.rot === r && p.x === x);
          if (matched) {
            this.executePlacement({ ...matched, useHold: !!result.useHold }, onDone);
            return;
          } else if (isValid(this.board, this.currentPiece.type, r, x, 0)) {
            // Fallback: placement is valid at y=0, use BFS path
            const targetY = hardDropY(this.board, this.currentPiece.type, r, x, 0);
            this.executePlacement({ rot: r, x, y: targetY, useHold: !!result.useHold, needsSoftDrop: true }, onDone);
            return;
          } else {
            console.warn(`[BOT] Custom placement invalid for ${this.name}: type=${this.currentPiece.type} rot=${r} x=${x}`);
          }
        } else {
          console.warn(`[BOT] Custom code returned invalid result for ${this.name}:`, JSON.stringify(result));
        }
      } catch(e) {
        console.warn(`[BOT] Custom code error for ${this.name}:`, e.message);
        // 実行時エラーをルームへ通知
        io.to(this.roomId).emit('bot_code_error', { type: 'runtime', botName: this.name, message: e.message });
      }
      // Fall through to normal AI if custom code fails/invalid
    }

    // ── PC HUNT MODE ─────────────────────────────────────────────
    // 連続失敗が多すぎる場合は一時的に通常AIに切り替え（閾値を12に緩和）
    // 4wideモードではPC狙いは無効化する
    const pcActive = this.pcHuntMode && this.pcFailed < 12 && this.cols >= 10;

    if (pcActive) {
      // ── キャッシュされたPC手順を消化する ──────────────────────
      // 前ターンにDFSで見つけたシーケンスが残っていれば再探索せずに使う
      if (this._pcSeqCache && this._pcSeqCache.length > 0) {
        const first = this._pcSeqCache[0];
        // 現在のピースと一致するかチェック
        const curType = this.currentPiece.type;
        const expectedType = this._pcSeqCache[0].type;
        if (curType === expectedType || (this._pcCacheHoldFirst && this.holdPiece === expectedType)) {
          const useType = this._pcCacheHoldFirst ? this.holdPiece : curType;
          const needHold = this._pcCacheHoldFirst || curType !== expectedType;
          const bfsPlacements = getAllPlacementsBFS(this.board, useType || curType);
          const placement = bfsPlacements.find(p => p.rot === first.rot && p.x === first.x);
          if (placement) {
            this._pcSeqCache.shift(); // 消化
            if (this._pcSeqCache.length === 0) this._pcSeqCache = null;
            this.executePlacement({ ...placement, useHold: needHold }, onDone);
            return;
          }
        }
        // キャッシュが合わなければ破棄して再探索
        this._pcSeqCache = null;
      }

      // ── DFS でPCシーケンスを探索（時間を80msに制限）──────────
      const result = this._tryFindPC(1000);

      if (result && result.seq.length > 0) {
        this.pcFailed = 0;
        const first = result.seq[0];

        if (result.holdFirst && !this.holdPiece) {
          // holdがない状態でholdFirst→通常フォールバック
        } else {
          const useType = result.holdFirst ? this.holdPiece : first.type;
          const needHold = result.holdFirst || first.type !== this.currentPiece.type;

          const bfsPlacements = getAllPlacementsBFS(this.board, useType || this.currentPiece.type);
          const placement = bfsPlacements.find(p => p.rot === first.rot && p.x === first.x);
          if (placement) {
            // 残りのシーケンスをキャッシュ（次ターン以降も使う）
            if (result.seq.length > 1) {
              this._pcSeqCache = result.seq.slice(1);
              this._pcCacheHoldFirst = false; // 2手目以降はholdFirstなし
            }
            this.executePlacement({ ...placement, useHold: needHold }, onDone);
            return;
          }
        }
      } else {
        this.pcFailed++;
        // 失敗が続いたらキャッシュも破棄
        if (this.pcFailed >= 3) this._pcSeqCache = null;
      }
    }

    // ── NORMAL AI (PC-FRIENDLY評価) ──────────────────────────────
    const h = this._boardHeight();
    const pcBonus = pcActive ? (h <= 4 ? 80000 : h <= 6 ? 40000 : h <= 8 ? 15000 : 0) : 0;

    let placement = botChoosePlacement(
      this.board, this.currentPiece.type,
      this.nextQueue.slice(0, 5),
      this.holdPiece,
      this.b2b, Math.max(0, this.combo),
      this.lvl, this.level, this.ren,
      pcBonus
    );

    if (placement) {
      this.executePlacement(placement, onDone);
    } else {
      // ── GAME OVER (Block Out) ──────────────────────────────────
      // AI could not find any valid reachable placement
      console.log(`[BOT] No placement found for ${this.name}. Triggering game over.`);
      this.alive = false;
      const room = rooms[this.roomId];
      if (room) {
        io.to(this.roomId).emit('player_dead', { id: this.id, name: this.name });
        checkGameEnd(this.roomId);
      }
      if (onDone) onDone();
    }
  }

  executePlacement(placement, onDone) {
    if (!this.alive || !this.currentPiece) { if(onDone)onDone(); return; }
    const { rot, x, useHold } = placement;

    if (useHold) {
      if (this.holdPiece) {
        // ホールドにピースがある: 現在のピースとホールドを交換
        const prev = this.holdPiece;
        this.holdPiece = this.currentPiece.type;
        const _hspX = Math.floor((this.cols - 4) / 2);
        this.currentPiece = { type: prev, rotation: 0, x: _hspX, y: 0 };
        this.holdUsed = true;
        // fall-through → currentPiece.type は交換後のピース
      } else {
        // ホールドが空: 現在をホールドに退避し、next[0] をスポーン
        // _applyCC が事前に rot/x をそのピース用に解決済みなので
        // spawnPiece() だけして下の _animatePlacement に fall-through する
        this.holdPiece = this.currentPiece.type;
        this.holdUsed = true;
        this.spawnPiece();
        // fall-through
      }
    }

    const type = this.currentPiece.type;
    const targetY = hardDropY(this.board, type, rot, x, 0);
    const needsSoftDrop = placement.needsSoftDrop || false;

    this._animatePlacement(type, rot, x, targetY, needsSoftDrop, () => {
      this._lockPiece(type, rot, x, targetY);
      if (onDone) onDone();
    });
  }

  // Animated movement with BFS path (uses soft drop only when needed)
  _animatePlacement(type, rot, x, targetY, needsSoftDrop, done) {
    let path;
    // Always try BFS first to ensure we find a valid path
    // _buildDirectPath can get stuck if the board is tall
    if (needsSoftDrop) {
      path = this._findPath(type, rot, x, targetY);
    } else {
      path = this._buildDirectPath(type, rot, x, targetY);
      // Verify the direct path actually lands at the right place
      // If last step doesn't match target, fall back to BFS
      const last = path[path.length - 1];
      if (!last || last.x !== x || last.rot !== rot) {
        path = this._findPath(type, rot, x, targetY);
      }
    }

    const stepDelay = this.moveStepDelay;
    let si = 0;

    const broadcast = (r, px, py) => {
      const room = rooms[this.roomId]; if (!room) return;
      io.to(this.roomId).emit('bot_piece_update', {
        id: this.id, currentPiece: { type, rotation: r, x: px, y: py, customShape: null }
      });
    };

    broadcast(0, Math.floor((this.cols - 4) / 2), 0);
    const tick = () => {
      if (!rooms[this.roomId]) { done(); return; }
      if (!path || si >= path.length) { done(); return; }
      const s = path[si++];
      broadcast(s.rot, s.x, s.y);
      setTimeout(tick, stepDelay);
    };
    setTimeout(tick, stepDelay);
  }

  // Direct path (hard drop): rotate at top, slide, drop
  _buildDirectPath(type, rot, x, targetY) {
    const board = this.board;
    const steps = [];
    const spawnX = Math.floor((this.cols - 4) / 2);
    let cr = 0, cx = spawnX, cy = -2; // start from actual spawn position

    // Rotate using SRS (with wall kicks), try both CW and CCW
    const cwSteps = ((rot - 0) % 4 + 4) % 4;  // clockwise rotations to reach target
    const ccwSteps = (4 - cwSteps) % 4;         // counter-clockwise
    const rotSteps = cwSteps <= ccwSteps ? cwSteps : ccwSteps;
    const rotDir   = cwSteps <= ccwSteps ? 1 : -1;
    for (let i = 0; i < rotSteps; i++) {
      const res = tryRotate(board, type, cr, cx, cy, rotDir);
      if (res) { cr = res.rot; cx = res.x; cy = res.y; }
      else {
        // Can't rotate at spawn — try at y=0
        const res2 = tryRotate(board, type, cr, cx, 0, rotDir);
        if (res2) { cr = res2.rot; cx = res2.x; cy = 0; }
      }
      steps.push({ rot: cr, x: cx, y: Math.max(cy, -2) });
    }

    // Move to y=0 area before sliding (ensure piece is in visible zone for sliding)
    // Actually slide at current height if valid
    const slideY = cy;

    // Slide horizontally
    while (cx !== x) {
      const dir = cx < x ? 1 : -1;
      if (isValid(board, type, cr, cx+dir, slideY)) cx += dir;
      else if (isValid(board, type, cr, cx+dir, 0)) { cx += dir; cy = 0; }
      else break;
      steps.push({ rot: cr, x: cx, y: Math.max(cy, -2) });
    }

    // Hard drop (instant — show final position)
    steps.push({ rot: cr, x: cx, y: targetY });
    return steps;
  }

  // BFS path (soft drop): navigate through gaps
  _findPath(type, targetRot, targetX, targetY) {
    const board = this.board;
    const targetKey = `${targetRot},${targetX},${targetY}`;

    const visited = new Map();
    const _fspX = Math.floor((this.cols - 4) / 2);
    // Spawn at y=-2 (hidden zone), must search from there
    const spawnY = -2;
    const queue = [{ rot: 0, x: _fspX, y: spawnY }];
    visited.set(`0,${_fspX},${spawnY}`, null);

    let qi = 0, found = false;
    outer: while (qi < queue.length) {
      const { rot, x, y } = queue[qi++];
      const curKey = `${rot},${x},${y}`;

      for (const [dx, dy] of [[-1,0],[1,0],[0,1]]) {
        const nx = x+dx, ny = y+dy;
        const nk = `${rot},${nx},${ny}`;
        if (!visited.has(nk) && isValid(board, type, rot, nx, ny)) {
          visited.set(nk, curKey);
          if (nk === targetKey) { found = true; break outer; }
          queue.push({ rot, x: nx, y: ny });
        }
      }
      for (const dir of [1, -1]) {
        const res = tryRotate(board, type, rot, x, y, dir);
        if (res) {
          const nk = `${res.rot},${res.x},${res.y}`;
          if (!visited.has(nk)) {
            visited.set(nk, curKey);
            if (nk === targetKey) { found = true; break outer; }
            queue.push({ rot: res.rot, x: res.x, y: res.y });
          }
        }
      }
    }

    if (!found) return this._buildDirectPath(type, targetRot, targetX, targetY);

    const path = [];
    let k = targetKey;
    while (k !== null) {
      const [r, px, py] = k.split(',').map(Number);
      path.unshift({ rot: r, x: px, y: py });
      k = visited.get(k);
    }
    return path.slice(1); // skip spawn state
  }

  _lockPiece(type, rot, x, y) {
    // Safety check: verify placement is actually valid
    // If y is very small (near top of hidden zone) and piece wasn't supposed to be there, skip
    if (!isValid(this.board, type, rot, x, y)) {
      // Try to find the correct Y for this position (board may have changed since think())
      let foundY = y;
      // Search upward first (piece may be inside blocks after garbage arrived)
      while (foundY > -2 && !isValid(this.board, type, rot, x, foundY)) foundY--;
      if (foundY >= -2 && isValid(this.board, type, rot, x, foundY)) {
        // Found valid Y above — use it
        y = foundY;
      } else {
        // Try dropping it further (piece may be above blocks now)
        foundY = y;
        while (isValid(this.board, type, rot, x, foundY + 1)) foundY++;
        if (isValid(this.board, type, rot, x, foundY)) {
          y = foundY;
        } else {
          // Still invalid — try shifting x by -1, 0, +1, -2, +2
          let found = false;
          for (const dx of [0, -1, 1, -2, 2]) {
            const nx = x + dx;
            if (nx < 0 || nx >= this.cols) continue;
            let ny = y;
            while (isValid(this.board, type, rot, nx, ny + 1)) ny++;
            if (isValid(this.board, type, rot, nx, ny)) {
              x = nx; y = ny; found = true; break;
            }
          }
          if (!found) {
            // Truly can't place — skip
            console.warn(`[BOT] Invalid placement skipped: ${type} rot=${rot} x=${x} y=${y}`);
            this.spawnPiece();
            return;
          }
        }
      }
    }
    // Also verify it's actually resting (can't go one lower) — if it can go lower, drop it there
    while (isValid(this.board, type, rot, x, y + 1)) y++;

    // Track placement column for anti-repeat logic
    this.lastPlacements.push(x);
    if (this.lastPlacements.length > 5) this.lastPlacements.shift();
    this.pcPiecesPlaced++;
    // 長期間PCできなければ失敗カウントを増やす（thinkで判定）
    // pcHuntModeは常時オン（continual PC cycle）

    let b = placePiece(this.board, type, rot, x, y);
    
    // Track garbage cleared for VS score
    let garbageCountInClear = 0;
    for (let r = 0; r < b.length; r++) {
      if (b[r].every(c => c !== 0)) {
        if (b[r].some(c => c === 'G')) garbageCountInClear++;
      }
    }
    this.totalGarbageCleared += garbageCountInClear;

    const { board: cleared, lines } = clearLines(b);
    const spin = detectSpin(this.board, type, rot, x, y, false); // BOT placement: kick tracking simplified
    const isTSpin = spin === 'TSPIN';
    const isMini = spin === 'MINI_TSPIN';
    const isAnySpin = !!spin && spin !== 'MINI_TSPIN';
    const isB2Bable = lines === 4 || (!!spin && lines > 0);
    const wasB2B = this.b2b;
    const isB2B = wasB2B && isB2Bable;

    let attack = 0;
    if (lines === 4) attack = 4;
    else if (isTSpin && lines === 3) attack = 6;
    else if (isTSpin && lines === 2) attack = 4;
    else if (isTSpin && lines === 1) attack = 2;
    else if (isMini && lines === 2) attack = 1;
    else if (isMini && lines === 1) attack = 0;
    else if (isAnySpin && lines >= 1) attack = lines; // S/Z/L/J/I spin
    else if (lines === 3) attack = 2;
    else if (lines === 2) attack = 1;
    else if (lines === 1) attack = 0;

    // B2B Chain Scaling (TETR.IO like)
    if (isB2B && attack > 0) {
      let b2bBonus = 1;
      if (this.b2bCount >= 24) b2bBonus = 4;
      else if (this.b2bCount >= 8) b2bBonus = 3;
      else if (this.b2bCount >= 3) b2bBonus = 2;
      attack += b2bBonus;
    }

    // B2B Break: floor(b2bCount / 2) lines are sent/cancelled
    if (wasB2B && !isB2Bable && lines > 0) {
      attack += Math.floor(this.b2bCount / 2);
    }

    if (lines > 0) {
      this.combo++;
      this.ren++;
    } else {
      this.combo = -1;
      this.ren = 0;
    }

    // Update B2B state
    if (lines > 0) {
      if (isB2Bable) {
        if (this.b2b) this.b2bCount++;
        else this.b2bCount = 1;
        this.b2b = true;
      } else {
        this.b2b = false;
        this.b2bCount = 0;
      }
    }

    this.board = cleared;
    this.lines += lines;
    this.lvl = Math.floor(this.lines/10)+1;
    this.score += lines*100*this.lvl + (isTSpin?lines*200:0);

    // ── Perfect Clear detection ──────────────────────────────────
    const allClear = this.board.every(r=>r.every(c=>c===0));
    if (allClear) {
      attack += 6;
      this.pcCycle++;      // PCサイクル達成！
      this.pcFailed = 0;   // 失敗カウントリセット
      this.pcHuntMode = true; // 次のPCサイクルへ
      // 次サイクル開始: 盤面が空なのでDFSがすぐ動く
      console.log(`[BOT] Perfect Clear #${this.pcCycle}!`);
    }

    // 最終的な送るライン数 = ln(attack + ren * 1.25)
    attack = Math.max(0, Math.floor(Math.log(attack + this.ren * 1.25)));

    // ── Garbage cancellation logic ──────────────────────────────────
    // 相殺: Pendingのゴミ（queue全体）を対象にする
    let cancelPower = attack;
    // 到着が近い順（readyAtが小さい順）に相殺
    this.garbageQueue.sort((a,b)=>a.readyAt - b.readyAt);
    for (let i=0; i < this.garbageQueue.length && cancelPower > 0; i++) {
      const canCancel = Math.min(this.garbageQueue[i].lines, cancelPower);
      this.garbageQueue[i].lines -= canCancel;
      cancelPower -= canCancel;
    }
    this.garbageQueue = this.garbageQueue.filter(g => g.lines > 0);
    // 送信される攻撃は相殺後の残り
    attack = cancelPower;

    // すぐにせり上がるゴミ（armed）を判定
    const now = Date.now();
    const armed = this.garbageQueue.filter(g => g.readyAt <= now);
    this.garbageQueue = this.garbageQueue.filter(g => g.readyAt > now);

    // Remaining garbage after cancellation goes to board
    const remaining = armed.filter(g => g.lines > 0);
    // コンボ中（ren>=1）はゴミを適用しない
    let _garbageApplied = false;
    if (remaining.length > 0 && this.ren < 1) {
      let linesToAdd = 0;
      const CAP = 8;
      
      for (const g of remaining) {
        if (linesToAdd >= CAP) {
          this.garbageQueue.unshift({...g, readyAt: now + 500});
          continue;
        }
        let hc = g.holeCol!==undefined ? g.holeCol : Math.floor(Math.random()*this.cols);
        for (let i=0;i<g.lines;i++){
          if (linesToAdd >= CAP) {
            this.garbageQueue.unshift({lines: g.lines - i, fromId: g.fromId, readyAt: now + 500, holeCol: hc});
            break;
          }
          const row=Array(this.cols).fill('G');row[hc]=0;this.board.push(row);this.board.shift();
          linesToAdd++;
        }
      }
      _garbageApplied = linesToAdd > 0;
      // Cold Clear: ゴミで盤面が変わったのでBotをリセット。
      // 新しいBotインスタンスを作るとフィールドが空になるため、
      // reset APIでフィールドを更新した後、キューを再送信する。
      if (_garbageApplied && this._ccBot && this.botLevel === 6) {
        try {
          this._ccBot.reset(this._ccBuildField(), this.b2b, Math.max(0, this.combo + 1));
          // reset後はCC内部キューが不定なので current + nextQueue を再通知
          const pieces = [
            this.currentPiece.type,
            ...this.nextQueue,
          ].map(t => BotPlayer._ccPieceId(t)).filter(n => n >= 0);
          for (const pid of pieces) {
            try { this._ccBot.addNextPiece(pid); } catch(e) {}
          }
          this._ccPending = false;
        } catch(e) {
          console.error('[CC] reset/resync failed:', e.message);
          // 失敗時はBotを再作成
          try { this._ccBot.destroy(); } catch(_) {}
          this._ccBot = null;
          this._ccPending = false;
          this._ccInit();
        }
      }
      // コンボ中は相殺されなかったゴミをキューに戻す
      for (const g of remaining) this.garbageQueue.unshift(g);
    }

    const room = rooms[this.roomId];
    if (room && attack > 0) {
      this.totalAttackSent += attack;
      const humanTargets = room.players.filter(p => p.id !== this.id && p.alive);
      for (const t of humanTargets) {
        const hc = Math.floor(Math.random()*this.cols);
        io.to(t.id).emit('receive_garbage', { lines: attack, fromId: this.id, holeCol: hc });
        io.to(this.roomId).emit('attack_sent', { fromId: this.id, toId: t.id, attack, clearRows: [] });
      }
      const botTargets = room.bots.filter(bt => bt.id !== this.id && bt.alive);
      for (const bt of botTargets) bt.queueGarbage(attack, this.id);
    }

    if (room) {
      const garbageLines=this.garbageQueue?this.garbageQueue.reduce((s,g)=>s+g.lines,0):0;
      io.to(this.roomId).emit('bot_update', {
        id: this.id,
        board: this.board.map(r=>r.map(c=>c||0)),
        score: this.score, lines: this.lines, level: this.lvl,
        nextPieces: this.nextQueue.slice(0,5),
        holdPiece: this.holdPiece,
        garbageLines,
        pps: this.pps,
        apm: this.apm,
        garbageQueue: this.garbageQueue
      });
    }

    this.spawnPiece();

    // Cold Clear: 新しいピースをキューに通知
    if (this._ccBot && this.botLevel === 6) {
      const nid = BotPlayer._ccPieceId(this.nextQueue[this.nextQueue.length - 1]);
      if (nid >= 0) { try { this._ccBot.addNextPiece(nid); } catch(e) {} }
    }

    if (!this.alive) {
      if (room) {
        io.to(this.roomId).emit('player_dead', { id: this.id, name: this.name });
        checkGameEnd(this.roomId);
      }
    }
  }

  queueGarbage(lines, fromId) {
    const hc = Math.floor(Math.random()*this.cols);
    this.garbageQueue.push({ lines, fromId, readyAt: Date.now()+3000, holeCol: hc });
  }

  startAutonomous(extraDelay = 0) {
    if (this.thinkTimer) return;
    const tick = () => {
      if (!this.alive) return;
      const room = rooms[this.roomId];
      if (!room || !room.started || room.shogiMode) return;
      // Use setTimeout(0) to yield to other pending timers (other bots)
      this.thinkTimer = setTimeout(() => {
        this.think(() => {
          if (this.alive) this.thinkTimer = setTimeout(tick, 50);
        });
      }, 0);
    };
    this.thinkTimer = setTimeout(tick, extraDelay + this.thinkDelay);
  }

  stop() {
    if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
    if (this._ccBot) { try { this._ccBot.destroy(); } catch(e) {} this._ccBot = null; }
  }
}


// ── Room helpers ──────────────────────────────────────────────────
function createRoom(roomId) {
  rooms[roomId] = {
    players: [], bots: [], started: false, host: null, chat: [],
    bagSeed: Math.floor(Math.random()*1000000),
    mutationMode: false, mutationSeed: 0, shogiMode: false,
    lastActivity: Date.now(),
    roomSettings: {
      mutationRate: 60, gravityBase: 1000, gravityDec: 80,
      gravityMin: 50, lockDelay: 1000, botLevel: 3, shogiMode: false,
      recordTraining: false,  // ホストが設置データ記録を有効化できる
      soloMode: false,         // 1人でもゲーム開始できる
      fortyLineMode: false,    // 40ラインモード
      blitzMode: false,        // 2分間スコアアタックモード
      fourWideMode: false      // 4Wideモード（ボード幅4列）
    }
  };
}
function getRoom(roomId) { return rooms[roomId]; }
function allPlayers(room) { return [...room.players, ...room.bots]; }

function broadcastRoomUpdate(room, roomId) {
  room.lastActivity = Date.now();
  const allP = allPlayers(room).map(p => ({
    id: p.id, name: p.name, isBot: !!p.isBot, botLevel: p.botLevel || null
  }));
  io.to(roomId).emit('room_update', {
    players: allP, host: room.host, started: room.started,
    mutationMode: room.mutationMode, mutationSeed: room.mutationSeed,
    roomSettings: room.roomSettings,
    hasCustomCode: !!(room.customBot||customBotCode.has(roomId))
  });
}

function checkGameEnd(roomId) {
  const room = getRoom(roomId); if (!room || !room.started) return;
  const alive = allPlayers(room).filter(p => p.alive);
  const humanAlive = room.players.filter(p => p.alive);

  // ソロモード: プレイヤーが死んだら即ゲーム終了
  // 通常モード: BOTだけ生き残っていてもゲームは続ける
  //   → 終了条件: 生存者が1人以下 かつ その1人はBOTではない（= 人間1人が最後の生存者）
  //   または: 全員死亡
  //   BOTのみ残りの場合はゲーム継続（ボットバトル観戦）→ボットが1体になった時に終了
  const humanDead = humanAlive.length === 0;
  const shouldEnd = room.isSolo
    ? humanDead
    : (alive.length <= 1);

  if (shouldEnd) {
    room.started = false;
    room.bots.forEach(b => b.stop());
    const winner = room.isSolo ? null : (alive[0] || null);
    const scores = allPlayers(room).map(p => ({ id: p.id, name: p.name, score: p.score||0, lines: p.lines||0 }));
    io.to(roomId).emit('game_end', {
      winner: winner ? winner.id : null,
      winnerName: winner ? winner.name : (room.isSolo ? 'Game Over' : 'Draw'),
      scores,
      isSolo: !!room.isSolo
    });
    // 学習データ保存
    stopRecording(roomId, { winner: winner ? winner.id : null, scores });
    room.players.forEach(p => { p.alive=true; p.board=null; });
    room.bots = [];
    room.isSolo = false;
    if (room.spectators) room.spectators = [];
  }
}

let _botCounter = 0;
function makeBotId() { return `bot_${Date.now()}_${_botCounter++}`; }
const BOT_NAMES = ['NOVA','APEX','ZETA','ORION','VOLT','FLUX','NEXUS','CIPHER'];
const customBotCode = new Map(); // roomId -> { code, filename }

// ── Socket.IO ─────────────────────────────────────────────────────
function broadcastOnlinePlayers() {
  const list = Object.values(onlinePlayers);
  io.emit('online_players', list);
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);
  socket.playerName = null;

  socket.on('set_name', ({name}) => {
    if (!name) return;
    socket.playerName = name;
    onlinePlayers[socket.id] = name;
    broadcastOnlinePlayers();
  });

  socket.on('create_room', ({ name, roomId: requestedId }) => {
    if (requestedId) {
      const er = getRoom(requestedId.toUpperCase());
      if (er) {
        const rid = requestedId.toUpperCase();
        if (er.started) { socket.emit('error',{msg:'Game already started'}); return; }
        if (er.players.find(p=>p.name===name)) { socket.emit('error',{msg:'Name already in room'}); return; }
        er.players.push({id:socket.id,name,board:null,score:0,lines:0,level:1,alive:true,combo:0,b2b:false});
        socket.join(rid); socket.roomId=rid; socket.playerName=name; lastRoom[name]=rid;
        if (!onlinePlayers[socket.id]) { onlinePlayers[socket.id] = name; broadcastOnlinePlayers(); }
        socket.emit('room_joined',{roomId:rid,players:allPlayers(er)});
        broadcastRoomUpdate(er,rid); return;
      }
    }
    const roomId = requestedId&&requestedId.length>=4 ? requestedId.toUpperCase() : Math.random().toString(36).substr(2,6).toUpperCase();
    createRoom(roomId);
    const room=getRoom(roomId);
    room.host=socket.id;
    room.players.push({id:socket.id,name,board:null,score:0,lines:0,level:1,alive:true,combo:0,b2b:false});
    socket.join(roomId); socket.roomId=roomId; socket.playerName=name; lastRoom[name]=roomId;
    if (!onlinePlayers[socket.id]) { onlinePlayers[socket.id] = name; broadcastOnlinePlayers(); }
    socket.emit('room_created',{roomId,players:allPlayers(room)});
    broadcastRoomUpdate(room,roomId);
  });

  socket.on('join_room', ({roomId,name}) => {
    const room=getRoom(roomId);
    if (!room) { socket.emit('error',{msg:'Room not found'}); return; }
    if (room.started) {
      // 試合中は観戦者として入室
      if (!room.spectators) room.spectators=[];
      room.spectators.push({id:socket.id,name});
      socket.join(roomId); socket.roomId=roomId; socket.playerName=name; lastRoom[name]=roomId;
      socket.emit('spectate_joined',{
        roomId,
        players:allPlayers(room).map(p=>({id:p.id,name:p.name,isBot:!!p.isBot,botLevel:p.botLevel||null,board:p.board,score:p.score,lines:p.lines,level:p.level,alive:p.alive})),
        host:room.host
      });
      return;
    }
    room.players.push({id:socket.id,name,board:null,score:0,lines:0,level:1,alive:true,combo:0,b2b:false});
    socket.join(roomId); socket.roomId=roomId; socket.playerName=name; lastRoom[name]=roomId;
    socket.emit('room_joined',{roomId,players:allPlayers(room)});
    broadcastRoomUpdate(room,roomId);
  });

  socket.on('add_bot', ({botLevel,botFileName,botCode}) => {
    const room=getRoom(socket.roomId); if (!room) return;
    if (socket.id!==room.host) return;
    // ── 1体制限 ─────────────────────────────────────────────────
    if (room.bots.length >= 1) {
      socket.emit('error',{msg:'ボットは1体までです。先にKICKしてください。'});
      return;
    }
    // ファイルコードが一緒に送られた場合はここでアップロードも処理
    if (botCode && botFileName) {
      room.customBot = {code: botCode, filename: botFileName};
      customBotCode.set(socket.roomId, {code: botCode, filename: botFileName});
      io.to(socket.roomId).emit('bot_code_status',{active:true});
    }
    const botId=makeBotId();
    const usedNames=allPlayers(room).map(p=>p.name);


    const lvl=Math.max(1,Math.min(6,parseInt(botLevel)||room.roomSettings.botLevel||3));
    const cbc=room.customBot||customBotCode.get(socket.roomId);
    const baseName = botFileName || (cbc ? cbc.filename : null) || 'CUSTOM';
    let fullName;
    if(cbc||botFileName){
      let n=baseName;let i=2;
      while(usedNames.includes('🤖'+n)){n=baseName+'_'+i;i++;}
      fullName='🤖'+n;
    } else {
      const bname=BOT_NAMES.find(n=>!usedNames.includes('🤖'+n))||('BOT'+(room.bots.length+1));
      fullName='🤖'+bname;
    }
    room.bots.push({id:botId,name:fullName,isBot:true,botLevel:lvl,alive:true});
    broadcastRoomUpdate(room,socket.roomId);
    const lvlLabel = lvl === 6 ? 'CC' : `Lv.${lvl}`;
    addChatSys(socket.roomId,`🤖 ${fullName} (${lvlLabel}) joined the room!`);
  });

  socket.on('upload_bot_code', ({code,filename}) => {
    const room=getRoom(socket.roomId); if (!room) return;
    if (socket.id!==room.host) return;
    const fname=filename||'CUSTOM';
    room.customBot = {code, filename:fname};
    customBotCode.set(socket.roomId, {code,filename:fname});
    io.to(socket.roomId).emit('bot_code_status',{active:true});
    addChatSys(socket.roomId, `📦 Custom bot code "${fname}" uploaded!`);
  });

  socket.on('clear_bot_code', () => {
    const room=getRoom(socket.roomId);
    if(room)delete room.customBot;
    customBotCode.delete(socket.roomId);
    io.to(socket.roomId).emit('bot_code_status',{active:false});
    addChatSys(socket.roomId, '🗑 Custom bot code cleared.');
  });

  socket.on('kick_bot', ({botId}) => {
    const room=getRoom(socket.roomId); if (!room) return;
    if (socket.id!==room.host) return;
    const bot=room.bots.find(b=>b.id===botId);
    if (bot) {
      if (bot.stop) bot.stop();
      room.bots=room.bots.filter(b=>b.id!==botId);
      broadcastRoomUpdate(room,socket.roomId);
      addChatSys(socket.roomId,`🤖 ${bot.name} was kicked.`);
    }
  });

  socket.on('rejoin_last_room', ({name}) => {
    const roomId=lastRoom[name]; if (!roomId){socket.emit('rejoin_result',{success:false});return;}
    const room=getRoom(roomId);
    if (!room||room.started||room.players.find(p=>p.name===name)){socket.emit('rejoin_result',{success:false});return;}
    room.players.push({id:socket.id,name,board:null,score:0,lines:0,level:1,alive:true,combo:0,b2b:false});
    socket.join(roomId); socket.roomId=roomId; socket.playerName=name;
    socket.emit('rejoin_result',{success:true,roomId,players:allPlayers(room),host:room.host,mutationMode:room.mutationMode,mutationSeed:room.mutationSeed,roomSettings:room.roomSettings});
    broadcastRoomUpdate(room,roomId);
  });

  socket.on('set_mutation', ({enabled,seed}) => {
    const room=getRoom(socket.roomId); if (!room||socket.id!==room.host) return;
    room.mutationMode=!!enabled; room.mutationSeed=seed||0;
    io.to(socket.roomId).emit('mutation_update',{enabled:room.mutationMode,seed:room.mutationSeed});
    broadcastRoomUpdate(room,socket.roomId);
  });

  socket.on('set_room_settings', (ns) => {
    const room=getRoom(socket.roomId); if (!room||socket.id!==room.host) return;
    const rs=room.roomSettings;
    if (ns.mutationRate!==undefined) rs.mutationRate=Math.max(0,Math.min(100,parseInt(ns.mutationRate)||60));
    if (ns.gravityBase!==undefined) rs.gravityBase=Math.max(100,Math.min(3000,parseInt(ns.gravityBase)||1000));
    if (ns.gravityDec!==undefined) rs.gravityDec=Math.max(0,Math.min(200,parseInt(ns.gravityDec)||80));
    if (ns.gravityMin!==undefined) rs.gravityMin=Math.max(20,Math.min(500,parseInt(ns.gravityMin)||50));
    if (ns.lockDelay!==undefined) rs.lockDelay=Math.max(200,Math.min(3000,parseInt(ns.lockDelay)||1000));
    if (ns.botLevel!==undefined) rs.botLevel=Math.max(1,Math.min(6,parseInt(ns.botLevel)||3));
    if (ns.shogiMode!==undefined) rs.shogiMode=!!ns.shogiMode;
    if (ns.recordTraining!==undefined) rs.recordTraining=!!ns.recordTraining;
    if (ns.soloMode!==undefined) rs.soloMode=!!ns.soloMode;
    if (ns.allspinMode!==undefined) rs.allspinMode=!!ns.allspinMode;
    if (ns.fortyLineMode!==undefined) rs.fortyLineMode=!!ns.fortyLineMode;
    if (ns.blitzMode!==undefined) rs.blitzMode=!!ns.blitzMode;
    if (ns.fourWideMode!==undefined) rs.fourWideMode=!!ns.fourWideMode;
    broadcastRoomUpdate(room,socket.roomId);
  });

  socket.on('start_game', () => {
    const room=getRoom(socket.roomId);
    if (!room||socket.id!==room.host) return;
    const rs = room.roomSettings;
    // ソロモード: 1人でも開始可能 (AllSpinモードも同様)
    const minPlayers = (rs.soloMode || rs.allspinMode || rs.fortyLineMode || rs.blitzMode || rs.fourWideMode) ? 1 : 2;
    if (allPlayers(room).length < minPlayers) {
      socket.emit('error',{msg: (rs.soloMode||rs.allspinMode||rs.fortyLineMode||rs.blitzMode||rs.fourWideMode) ? 'Need at least 1 player' : 'Need at least 2 players (add a BOT!)'}); return;
    }
    room.started=true;
    room.bagSeed=Math.floor(Math.random()*1000000);
    if (room.mutationMode&&!room.mutationSeed) room.mutationSeed=Math.floor(Math.random()*1000000);
    room.players.forEach(p=>{p.board=null;p.score=0;p.lines=0;p.level=1;p.alive=true;p.combo=0;p.b2b=false;});

    const humanCount=room.players.length;
    const isSolo = (humanCount === 1 && room.bots.length === 0 && !rs.allspinMode && !rs.fortyLineMode && !rs.blitzMode && !rs.fourWideMode) || !!(rs.soloMode);
    const doShogi=room.roomSettings.shogiMode&&humanCount===1&&room.bots.length>=1;
    room.shogiMode=doShogi;
    room.isSolo=isSolo;
    room.fortyLineMode=!!(rs.fortyLineMode);
    room.fortyLineStartTime = rs.fortyLineMode ? Date.now() : null;
    room.blitzMode=!!(rs.blitzMode);
    room.blitzStartTime = rs.blitzMode ? Date.now() : null;
    room.fourWideMode=!!(rs.fourWideMode);
    // Blitz: 120秒タイマー
    if (rs.blitzMode) {
      if (room._blitzTimer) clearTimeout(room._blitzTimer);
      room._blitzTimer = setTimeout(() => {
        if (!room.started || !room.blitzMode) return;
        const elapsed = room.blitzStartTime ? Date.now() - room.blitzStartTime : 120000;
        room.started = false;
        room.bots.forEach(b => b.stop && b.stop());
        // 最高スコアのプレイヤーを勝者に
        const alive = [...room.players, ...room.bots];
        const sorted = alive.sort((a,b) => (b.score||0)-(a.score||0));
        const winner = sorted[0] || null;
        const scores = alive.map(p => ({ id: p.id, name: p.name, score: p.score||0, lines: p.lines||0 }));
        io.to(room._roomId||socket.roomId).emit('blitz_end', {
          winner: winner ? winner.id : null,
          winnerName: winner ? winner.name : 'Draw',
          scores, elapsedMs: elapsed
        });
        io.to(room._roomId||socket.roomId).emit('game_end', {
          winner: winner ? winner.id : null,
          winnerName: winner ? winner.name : 'Draw',
          scores, isSolo: true, blitz: true
        });
        room.players.forEach(p => { p.alive=true; p.board=null; });
        room.bots = [];
        room.isSolo = false;
        room.blitzMode = false;
        room._blitzTimer = null;
      }, 120000);
      room._roomId = socket.roomId;
    }
    const cbcRoom = room.customBot || customBotCode.get(socket.roomId);
    const botCode = cbcRoom ? cbcRoom.code : null;
    const realBots=room.bots.map(entry=>{
      const bag=new Bag(room.bagSeed); // 人間と同じシードで同じミノ順を共有
      const bot=new BotPlayer(entry.id,entry.name,entry.botLevel,socket.roomId,bag,botCode);
      return bot;
    });
    room.bots=realBots;

    io.to(socket.roomId).emit('game_start',{
      players:allPlayers(room).map(p=>({id:p.id,name:p.name,isBot:!!p.isBot,botLevel:p.botLevel||null})),
      bagSeed:room.bagSeed,mutationMode:room.mutationMode,mutationSeed:room.mutationSeed,
      roomSettings:room.roomSettings,shogiMode:doShogi,isSolo,
      allspinMode:!!(room.roomSettings&&room.roomSettings.allspinMode),
      fortyLineMode:!!(room.roomSettings&&room.roomSettings.fortyLineMode),
      blitzMode:!!(room.roomSettings&&room.roomSettings.blitzMode),
      fourWideMode:!!(room.roomSettings&&room.roomSettings.fourWideMode)
    });

    // 学習データ記録: AIモードが有効 かつ ホストがrecordTrainingをオンにしている場合
    // ソロ・1v1・対ボット問わず人間プレイヤーの手を記録する
    if (rs.recordTraining && room.players.length >= 1) {
      startRecording(socket.roomId, room.players);
    }

    if (isSolo) {
      // ソロモード: ゲーム終了条件はそのプレイヤーが死んだとき
      addChatSys(socket.roomId,'🎮 Solo mode — good luck!');
    } else if (!doShogi) {
      realBots.forEach(b => b.startAutonomous(3700));
    } else {
      addChatSys(socket.roomId,'♟ SHOGI MODE: BOT waits for your move!');
    }
  });

  socket.on('shogi_human_placed', () => {
    const room=getRoom(socket.roomId); if (!room||!room.started||!room.shogiMode) return;
    room.bots.forEach(bot=>{
      if (!bot.alive) return;
      setTimeout(()=>bot.think(()=>{}), 150);
    });
  });

  socket.on('piece_update', ({currentPiece}) => {
    const room=getRoom(socket.roomId); if (!room) return;
    socket.to(socket.roomId).emit('opponent_piece_update',{id:socket.id,currentPiece});
  });

  socket.on('board_update', ({board,score,lines,level,currentPiece,nextPieces,holdPiece,pps,apm,vs,garbageQueue}) => {
    const room=getRoom(socket.roomId); if (!room) return;
    const player=room.players.find(p=>p.id===socket.id); if (!player) return;
    player.board=board; player.score=score; player.lines=lines; player.level=level;
    player.currentPiece=currentPiece; player.nextPieces=nextPieces; player.holdPiece=holdPiece;
    player.pps=pps; player.apm=apm; player.vs=vs; player.garbageQueue=garbageQueue;
    const garbageLines=garbageQueue?garbageQueue.reduce((s,g)=>s+g.lines,0):0;
    socket.to(socket.roomId).emit('opponent_update',{id:socket.id,board,score,lines,level,currentPiece,nextPieces,holdPiece,garbageLines,pps,apm,vs,garbageQueue});
  });

  // ── Training data: piece placement event ──────────────────────
  // Fired by client when a piece locks down (1v1 player-only match only)
  socket.on('piece_placed', ({boardBefore, placedPiece, nextPieces, holdPiece, linesCleared, boardAfter}) => {
    const room = getRoom(socket.roomId);
    if (!room || !room.started) return;
    const session = recordingSessions[socket.roomId];
    if (!session) {
      // セッションがない場合はここで開始（遅延参加対策）
      return;
    }
    const frame = {
      timestamp: Date.now(),
      boardBefore,
      placedPiece,
      nextPieces: Array.isArray(nextPieces) ? nextPieces : [],
      holdPiece: holdPiece || null,
      linesCleared: linesCleared || 0,
      boardAfter
    };
    recordPlacement(socket.roomId, socket.id, frame);
  });

  socket.on('lines_cleared', ({attack,allClear,spinType,clearRows,totalLines}) => {
    const room=getRoom(socket.roomId); if (!room) return;

    // ── 40ラインモード: 達成チェック ────────────────────────────
    if (room.fortyLineMode && totalLines >= 40) {
      const elapsed = room.fortyLineStartTime ? Date.now() - room.fortyLineStartTime : 0;
      room.started = false;
      room.bots.forEach(b => b.stop && b.stop());
      const scores = allPlayers(room).map(p => ({ id: p.id, name: p.name, score: p.score||0, lines: p.lines||0 }));
      io.to(socket.roomId).emit('forty_line_clear', {
        playerId: socket.id,
        playerName: socket.playerName,
        elapsedMs: elapsed,
        scores
      });
      io.to(socket.roomId).emit('game_end', {
        winner: socket.id,
        winnerName: socket.playerName,
        scores,
        isSolo: true,
        fortyLine: true,
        elapsedMs: elapsed
      });
      room.players.forEach(p => { p.alive=true; p.board=null; });
      room.bots = [];
      room.isSolo = false;
      room.fortyLineMode = false;
      return;
    }

    const total=attack||0;
    if (total>0) {
      const others=allPlayers(room).filter(p=>p.id!==socket.id&&p.alive);
      others.forEach(p=>{
        if (p.isBot&&p.queueGarbage) p.queueGarbage(total,socket.id);
        else io.to(p.id).emit('receive_garbage',{lines:total,fromId:socket.id});
        socket.emit('attack_sent',{fromId:socket.id,toId:p.id,attack:total,clearRows:clearRows||[]});
      });
      io.to(socket.roomId).emit('attack_sent',{fromId:socket.id,toId:others[0]?.id,attack:total,clearRows:clearRows||[]});
    }
  });

  socket.on('spin_effect', ({spinType}) => { socket.to(socket.roomId).emit('opponent_spin',{id:socket.id,spinType}); });

  socket.on('line_clear_effect', ({count,spinType,isB2B,ren,allClear}) => {
    socket.to(socket.roomId).emit('opponent_line_clear',{id:socket.id,count,spinType,isB2B,ren,allClear});
  });

  socket.on('get_rooms', () => {
    const list=Object.entries(rooms)
      .filter(([,r])=>!r.started&&allPlayers(r).length<3)
      .map(([id,r])=>({id,players:allPlayers(r).map(p=>p.name),count:allPlayers(r).length}));
    socket.emit('rooms_list',list);
  });

  socket.on('get_online_players', () => {
    socket.emit('online_players', Object.values(onlinePlayers));
  });

  socket.on('rejoin_room', ({roomId:rid,name}) => {
    const room=getRoom(rid);
    if (!room){socket.emit('rejoin_result',{success:false});socket.emit('error',{msg:'Room no longer exists'});return;}

    if (room.started) {
      // 試合中は観戦者として入室
      if (!room.spectators) room.spectators=[];
      // 既に同名の観戦者がいれば置き換え
      room.spectators=room.spectators.filter(s=>s.name!==name);
      room.spectators.push({id:socket.id,name});
      socket.join(rid); socket.roomId=rid; socket.playerName=name; lastRoom[name]=rid;
      socket.emit('spectate_joined',{
        roomId:rid,
        players:allPlayers(room).map(p=>({id:p.id,name:p.name,isBot:!!p.isBot,botLevel:p.botLevel||null,board:p.board,score:p.score,lines:p.lines,level:p.level,alive:p.alive})),
        host:room.host
      });
      return;
    }
    
    // 既に同名がいる場合は既存エントリをそのまま更新（順序とホストを維持）
    const existing=room.players.find(p=>p.name===name);
    if(existing){
      const wasHost=existing.id===room.host;
      existing.id=socket.id;
      existing.board=null;
      existing.score=0;
      existing.lines=0;
      existing.level=1;
      existing.alive=true;
      existing.combo=0;
      existing.b2b=false;
      if(wasHost)room.host=socket.id;
    } else {
      room.players.push({id:socket.id,name,board:null,score:0,lines:0,level:1,alive:true,combo:0,b2b:false});
      const isNewHost=!room.host||!room.players.find(p=>p.id===room.host);
      if(isNewHost)room.host=socket.id;
    }
    socket.join(rid); socket.roomId=rid; socket.playerName=name; lastRoom[name]=rid;
    socket.emit('rejoin_result',{
      success:true,roomId:rid,
      players:allPlayers(room).map(p=>({id:p.id,name:p.name,isBot:!!p.isBot,botLevel:p.botLevel||null})),
      host:room.host,
      mutationMode:room.mutationMode,mutationSeed:room.mutationSeed,
      roomSettings:room.roomSettings
    });
    broadcastRoomUpdate(room,rid);
  });

  socket.on('force_end_game', () => {
    const room=getRoom(socket.roomId);
    if (!room||socket.id!==room.host||!room.started) return;
    room.started=false;
    room.bots.forEach(b=>b.stop());
    const scores=allPlayers(room).map(p=>({id:p.id,name:p.name,score:p.score||0,lines:p.lines||0}));
    io.to(socket.roomId).emit('game_end',{winner:null,winnerName:'FORCE ENDED',scores,isSolo:!!room.isSolo,forceEnded:true});
    stopRecording(socket.roomId,{winner:null,scores,forceEnded:true});
    room.players.forEach(p=>{p.alive=true;p.board=null;});
    room.bots=[];room.isSolo=false;
    if(room.spectators)room.spectators=[];
    addChatSys(socket.roomId,'⚠ Game force-ended by host.');
  });

  socket.on('game_over', () => {
    const room=getRoom(socket.roomId); if (!room) return;
    const player=room.players.find(p=>p.id===socket.id);
    if (player) player.alive=false;
    io.to(socket.roomId).emit('player_dead',{id:socket.id,name:player?player.name:''});
    checkGameEnd(socket.roomId);
  });

  socket.on('chat_message', ({message,name:clientName}) => {
    const name=socket.playerName||clientName||'Anonymous';
    const msg={id:socket.id,name,message,time:Date.now()};
    if (socket.roomId&&getRoom(socket.roomId)){const room=getRoom(socket.roomId);room.chat.push(msg);if(room.chat.length>50)room.chat.shift();}
    io.emit('chat_message',msg);
  });

  socket.on('clear_last_room', () => { if (socket.playerName) delete lastRoom[socket.playerName]; socket.roomId=null; });

  socket.on('leave_room', () => {
    const room=getRoom(socket.roomId); if (!room) return;
    room.players=room.players.filter(p=>p.id!==socket.id);
    socket.leave(socket.roomId);
    if (room.players.length===0&&room.bots.length===0){delete rooms[socket.roomId];customBotCode.delete(socket.roomId);socket.roomId=null;return;}
    if (room.host===socket.id&&room.players.length>0) room.host=room.players[0].id;
    io.to(socket.roomId).emit('player_left',{id:socket.id});
    broadcastRoomUpdate(room,socket.roomId);
    socket.roomId=null;
  });

  socket.on('disconnect', () => {
    if (socket.playerName && onlinePlayers[socket.id]) {
      delete onlinePlayers[socket.id];
      broadcastOnlinePlayers();
    }
    const room=getRoom(socket.roomId); if (!room) return;
    room.players=room.players.filter(p=>p.id!==socket.id);
    if (room.spectators) room.spectators=room.spectators.filter(s=>s.id!==socket.id);
    if (room.players.length===0&&room.bots.length===0){delete rooms[socket.roomId];customBotCode.delete(socket.roomId);return;}
    if (room.host===socket.id&&room.players.length>0) room.host=room.players[0].id;
    io.to(socket.roomId).emit('player_left',{id:socket.id});
    broadcastRoomUpdate(room,socket.roomId);
    if (room.started){room.bots.forEach(b=>b.stop());checkGameEnd(socket.roomId);}
  });
});

function addChatSys(roomId, text) {
  io.to(roomId).emit('chat_message',{id:'system',name:'SYSTEM',message:text});
}

// ══════════════════════════════════════════════════════════════════
// External Bot REST API
// ══════════════════════════════════════════════════════════════════
// Parse JSON bodies for API routes

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Tetrix server on http://localhost:${PORT}`));

// Empty room cleanup (rooms with no players for 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [rid, room] of Object.entries(rooms)) {
    if (allPlayers(room).length === 0) {
      delete rooms[rid];
      console.log(`[cleanup] Empty room ${rid} deleted`);
    }
  }
}, 60000);