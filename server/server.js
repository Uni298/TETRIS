const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

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

// ── Constants (mirror client) ──────────────────────────────────────
const COLS = 10, ROWS = 20, HIDDEN = 3;
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

function emptyBoard() { return Array.from({length:ROWS+HIDDEN},()=>Array(COLS).fill(0)); }
function cloneBoard(b) { return b.map(r=>[...r]); }
function getShape(type, rot) { return PIECE_SHAPES[type][((rot%4)+4)%4]; }

function isValid(board, type, rot, x, y) {
  const shape = getShape(type, rot);
  for (let r = 0; r < shape.length; r++) for (let c = 0; c < shape[r].length; c++) {
    if (!shape[r][c]) continue;
    const nx = x+c, ny = y+r;
    if (nx < 0 || nx >= COLS || ny >= ROWS+HIDDEN) return false;
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
  for (let r = 0; r < shape.length; r++) for (let c = 0; c < shape[r].length; c++) {
    if (!shape[r][c]) continue;
    const ny = y+r, nx = x+c;
    if (ny >= 0 && ny < ROWS+HIDDEN && nx >= 0 && nx < COLS) b[ny][nx] = type;
  }
  return b;
}

function clearLines(board) {
  const b = cloneBoard(board);
  const cleared = [];
  for (let r = ROWS+HIDDEN-1; r >= 0; r--) {
    if (b[r].every(c => c !== 0)) cleared.push(r);
  }
  for (const r of [...cleared].sort((a,v)=>v-a)) { b.splice(r,1); b.unshift(Array(COLS).fill(0)); }
  return { board: b, lines: cleared.length };
}

function detectTspin(board, type, rot, x, y) {
  if (type !== 'T') return null;
  const corners = [[0,0],[2,0],[0,2],[2,2]];
  const filled = corners.filter(([cx,cy]) => {
    const nx=x+cx, ny=y+cy;
    return (nx<0||nx>=COLS||ny<0||ny>=ROWS+HIDDEN)||(ny>=0&&board[ny]&&board[ny][nx]);
  });
  if (filled.length < 3) return null;
  const front = {0:[[0,0],[2,0]],1:[[2,0],[2,2]],2:[[0,2],[2,2]],3:[[0,0],[0,2]]}[rot];
  const ff = front.filter(([cx,cy]) => {
    const nx=x+cx, ny=y+cy;
    return (nx<0||nx>=COLS||ny<0||ny>=ROWS+HIDDEN)||(ny>=0&&board[ny]&&board[ny][nx]);
  });
  return ff.length >= 2 ? 'TSPIN' : 'MINI_TSPIN';
}

function evaluateBoard(board, linesCleared, spinType, isB2B, combo, level, ren) {
  // Column heights
  const heights = Array(COLS).fill(0);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS+HIDDEN; r++) {
      if (board[r][c]) { heights[c] = ROWS+HIDDEN - r; break; }
    }
  }
  const maxH = Math.max(...heights);
  const sumH  = heights.reduce((a,b)=>a+b,0);
  const avgH  = sumH / COLS;

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
  for (let c = 0; c < COLS; c++) {
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
    for (let c = 0; c < COLS; c++) {
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
  for (let c = 0; c < COLS-1; c++) bumpiness += Math.abs(heights[c]-heights[c+1]);

  let score = 0;

  // ── Line clear bonuses ─────────────────────────────────────────
  const linePts = [0, 50, 250, 600, 1800];
  score += linePts[Math.min(linesCleared, 4)] || 0;
  // Extra bonus for clearing when stack is dangerous
  if (linesCleared > 0 && maxH > 10) score += linesCleared * (maxH - 10) * 40;
  if (spinType === 'TSPIN')      score += linesCleared===3 ? 4000 : linesCleared===2 ? 2600 : 900;
  if (spinType === 'MINI_TSPIN') score += 120;
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
  for (let c = 0; c < COLS - 1; c++) {
    const leftWall  = c > 0        ? heights[c-1] : heights[c] + 4;
    const rightWall = c < COLS - 2 ? heights[c+2] : heights[c+1] + 4;
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
    for (let c = 0; c < COLS; c++) {
      const lh = c > 0      ? heights[c-1] : 99;
      const rh = c < COLS-1 ? heights[c+1] : 99;
      const w = Math.min(lh - heights[c], rh - heights[c]);
      if (w >= 2) {
        wellCount++;
        if (w > bestWellDepth) { bestWellDepth = w; bestWellCol = c; }
      }
    }
    if (bestWellDepth >= 2) {
      const edgeDist = Math.min(bestWellCol, COLS-1-bestWellCol);
      const edgeMult = edgeDist === 0 ? 1.5 : edgeDist === 1 ? 0.8 : 0.2;
      score += Math.min(bestWellDepth, 6) * 14 * edgeMult;
    }
    if (wellCount >= 2) score -= (wellCount - 1) * 300;
  }

  // T-spin setup reward (only when stack is manageable)
  if (maxH <= 12) score += evaluateTspinSetup(board, heights);

  // Variance penalty (flat is good)
  const variance = heights.reduce((a,h)=>a+Math.pow(h-avgH,2),0) / COLS;
  score -= variance * 0.8;

  // ── 2-wide pit penalty ─────────────────────────────────────────
  for (let c = 0; c < COLS - 1; c++) {
    const leftNeighH  = c > 0        ? heights[c-1] : heights[c+2] || 0;
    const rightNeighH = c < COLS - 2 ? heights[c+2] : heights[c-1] || 0;
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
  let bonus = 0;
  for (let c = 1; c < COLS-1; c++) {
    const lh = heights[c-1], ch = heights[c], rh = heights[c+1];
    const ld = lh - ch, rd = rh - ch;
    if (ld >= 2 && rd >= 2 && ch >= 2) {
      bonus += 80;
      const bRow = ROWS+HIDDEN - ch;
      if (bRow >= 0 && bRow < ROWS+HIDDEN) {
        const hasL = c > 0      && board[bRow] && board[bRow][c-1];
        const hasR = c < COLS-1 && board[bRow] && board[bRow][c+1];
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
  const add = (rot, x) => {
    if (!isValid(board, type, rot, x, 0)) return;
    const y = hardDropY(board, type, rot, x, 0);
    const key = `${rot},${x},${y}`;
    if (visited.has(key)) return;
    visited.add(key);
    const spin = detectTspin(board, type, rot, x, y);
    const placed = placePiece(board, type, rot, x, y);
    const { board: cleared, lines } = clearLines(placed);
    results.push({ rot, x, y, board: cleared, lines, spin, type, needsSoftDrop: false });
  };
  for (let rot = 0; rot < 4; rot++) {
    for (let x = -2; x < COLS + 2; x++) add(rot, x);
  }
  // T-spin wall kicks: try each kick offset too
  if (type === 'T') {
    for (let fromRot = 0; fromRot < 4; fromRot++) {
      for (const dir of [1, -1]) {
        const toRot = ((fromRot + dir) % 4 + 4) % 4;
        const key2 = `${fromRot}->${toRot}`;
        const kicks = SRS_KICKS['default'][key2] || [];
        for (const [kx] of kicks) {
          for (let x = -2; x < COLS + 2; x++) add(toRot, x + kx);
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

  const enqueue = (rot, x, y) => {
    const key = `${rot},${x},${y}`;
    if (visitedStates.has(key)) return;
    visitedStates.add(key);
    queue.push({ rot, x, y });
  };

  // Compute direct-drop positions (for needsSoftDrop flag)
  const directDrop = new Set();
  for (let rot = 0; rot < 4; rot++) {
    for (let x = -2; x < COLS + 2; x++) {
      if (!isValid(board, type, rot, x, 0)) continue;
      directDrop.add(`${rot},${x},${hardDropY(board, type, rot, x, 0)}`);
    }
  }

  for (let rot = 0; rot < 4; rot++) {
    for (let x = -2; x < COLS + 2; x++) {
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
        const spin = detectTspin(board, type, rot, x, y);
        const placed = placePiece(board, type, rot, x, y);
        const { board: cleared, lines } = clearLines(placed);
        const needsSoftDrop = !directDrop.has(lockKey);
        results.push({ rot, x, y, board: cleared, lines, spin, type, needsSoftDrop });
      }
    }
  }
  return results;
}

// ── Perfect Clear Solver ──────────────────────────────────────────
// Searches for a placement sequence that empties the board.
// Uses time-limited DFS with aggressive pruning.
function findPCSequence(board, pieces, timeLimitMs=25) {
  // Count filled cells
  let filled = 0;
  for (let r = 0; r < ROWS + HIDDEN; r++)
    for (let c = 0; c < COLS; c++)
      if (board[r][c]) filled++;

  // Only on very low boards
  const maxRow = board.reduce((m, row, i) => row.some(c => c !== 0) ? i : m, -1);
  const occupiedHeight = maxRow === -1 ? 0 : ROWS + HIDDEN - maxRow;
  if (occupiedHeight > 4) return null;

  const limit = Math.min(pieces.length, 5);
  // Feasibility: filled + n*4 must be divisible by 10 for some n ≤ limit
  let feasible = false;
  for (let n = 1; n <= limit; n++) {
    if ((filled + n * 4) % 10 === 0) { feasible = true; break; }
  }
  if (!feasible) return null;

  const deadline = Date.now() + timeLimitMs;
  let best = null;

  function dfs(b, remaining, seq) {
    if (best || Date.now() > deadline) return;
    if (!remaining.length) return;
    const type = remaining[0];
    const placements = getAllPlacementsFast(b, type);
    // Sort: prefer placements that clear lines first
    placements.sort((a, z) => z.lines - a.lines);
    for (const p of placements) {
      if (best || Date.now() > deadline) return;
      // Check if this achieved PC
      if (p.board.every(row => row.every(c => c === 0))) {
        best = [...seq, { type, rot: p.rot, x: p.x }];
        return;
      }
      // Prune: board must stay ≤ 4 rows high
      let highestFilled = -1;
      for (let r = 0; r < ROWS + HIDDEN; r++)
        if (p.board[r].some(c => c !== 0)) { highestFilled = r; break; }
      const newH = highestFilled === -1 ? 0 : ROWS + HIDDEN - highestFilled;
      if (newH > 4) continue;
      // Prune: check feasibility of remaining pieces
      let newFilled = 0;
      for (let r = 0; r < ROWS + HIDDEN; r++)
        for (let c2 = 0; c2 < COLS; c2++)
          if (p.board[r][c2]) newFilled++;
      let canPC = false;
      for (let n = 0; n <= remaining.length - 1; n++) {
        if ((newFilled + n * 4) % 10 === 0) { canPC = true; break; }
      }
      if (!canPC) continue;
      if (remaining.length > 1) {
        dfs(p.board, remaining.slice(1), [...seq, { type, rot: p.rot, x: p.x }]);
      }
    }
  }

  dfs(board, pieces.slice(0, limit), []);
  return best;
}

// ── Bot AI decision making ──────────────────────────────────────

function botChoosePlacement(board, type, nextTypes, holdType, b2b, combo, level, botLevel, ren, pcBonus=0) {
  // ── Garbage detection ──────────────────────────────────────────
  // Count garbage rows and compute max stack height
  let garbageRowCount = 0;
  for (let r = 0; r < ROWS+HIDDEN; r++) {
    if (board[r].some(c => c === 'G')) garbageRowCount++;
  }
  const heights = Array(COLS).fill(0);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS+HIDDEN; r++) {
      if (board[r][c]) { heights[c] = ROWS+HIDDEN - r; break; }
    }
  }
  const maxHeight = Math.max(...heights);

  // Garbage priority mode: when garbage is significant, boost line-clearing placements
  const garbagePriority = garbageRowCount >= 4 || (garbageRowCount >= 2 && maxHeight >= 12);

  // depth=2 max — depth=3 would be 43000+ calls and hang the server
  const depth = botLevel >= 2 ? 2 : 1;
  // Beam width: limits candidates per ply so depth=2 stays fast
  const beamWidth = botLevel >= 5 ? 12 : botLevel >= 4 ? 8 : botLevel >= 3 ? 5 : 3;

  function evalDeep(b, pieces, d, isB2B, cmb, r) {
    if (d === 0 || pieces.length === 0) return evaluateBoard(b, 0, null, false, 0, level, r);
    const pl = getAllPlacementsFast(b, pieces[0]); // fast only in lookahead!
    if (pl.length === 0) return -99999;
    // Beam pruning
    const scored = pl.map(p => {
      const newR = p.lines > 0 ? r + 1 : 0;
      const iB2B2 = isB2B && (p.lines===4||(p.spin==='TSPIN'&&p.lines>0));
      const nc = cmb+(p.lines>0?1:0);
      return { p, sc: evaluateBoard(p.board, p.lines, p.spin, iB2B2, nc, level, newR) + addBonuses(p) };
    }).sort((a, b2) => b2.sc - a.sc).slice(0, beamWidth);
    let best = -Infinity;
    for (const { p, sc } of scored) {
      const newR = p.lines > 0 ? r + 1 : 0;
      const iB2B2 = isB2B && (p.lines===4||(p.spin==='TSPIN'&&p.lines>0));
      const nc = cmb+(p.lines>0?1:0);
      const fut = d > 1 ? evalDeep(p.board, pieces.slice(1), d-1, iB2B2, nc, newR) * 0.6 : 0;
      if (sc + fut > best) best = sc + fut;
    }
    return best;
  }

  function addBonuses(p) {
    let b = 0;
    if (p.spin === 'TSPIN' && p.lines >= 2) b += 1200 * p.lines;
    if (p.spin === 'TSPIN' && p.lines === 3) b += 2000;
    if (p.spin === 'TSPIN' && p.lines === 1) b += 500;
    if (p.lines === 4) b += 800;
    if (p.board && p.board.every(row => row.every(c => c === 0))) b += 50000 + pcBonus;
    // Garbage priority: heavily reward any line clear when garbage is threatening
    if (garbagePriority && p.lines > 0) {
      b += p.lines * garbageRowCount * 200; // escalates with garbage count
      if (p.lines >= 2) b += 500; // extra for multi-line clears
      if (p.lines >= 4) b += 1500; // tetris against garbage is ideal
    }
    return b;
  }

  // Jitter: small random noise to avoid perfectly deterministic play
  // Higher botLevel = less jitter. Level5=±20, Level3=±120, Level1=±400
  const jitterAmp = [0, 400, 220, 120, 60, 20][botLevel] || 100;

  // BFS for current piece (finds soft-drop reachable placements)
  function evalPlacementsBFS(useType, useHold) {
    const placements = getAllPlacementsBFS(board, useType);
    let bestScore = -Infinity, bestPlacement = null;
    for (const p of placements) {
      const newRen = p.lines > 0 ? (ren||0) + 1 : 0;
      const iB2B = b2b && (p.lines===4||(p.spin==='TSPIN'&&p.lines>0));
      const nc = combo + (p.lines > 0 ? 1 : 0);
      let sc = evaluateBoard(p.board, p.lines, p.spin, iB2B, nc, level, newRen);
      sc += addBonuses(p);
      if ((ren||0) >= 2 && p.lines > 0) sc += (ren||0) * 180;
      if (depth >= 2 && nextTypes.length > 0)
        sc += evalDeep(p.board, nextTypes, depth-1, iB2B, nc, newRen) * 0.6;
      // Add per-placement jitter so the bot doesn't always pick identically
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
      const iB2B = b2b && (p.lines===4||(p.spin==='TSPIN'&&p.lines>0));
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
  constructor(id, name, level, roomId, bag) {
    this.id = id; this.name = name; this.level = level; this.roomId = roomId;
    this.isBot = true; this.botLevel = level;
    this.board = emptyBoard();
    this.bag = bag;
    this.nextQueue = [];
    for (let i = 0; i < 6; i++) this.nextQueue.push(this.bag.next());
    this.holdPiece = null; this.holdUsed = false;
    this.score = 0; this.lines = 0; this.lvl = 1;
    this.combo = -1; this.b2b = false; this.alive = true; this.ren = 0;
    this.garbageQueue = [];
    this.thinkTimer = null;
    this.currentPiece = null;
    this.pcHuntMode = true;   // Try perfect clear at game start
    this.pcPiecesPlaced = 0;  // Count pieces placed
    this.lastPlacements = []; // Track last N column placements to avoid same-spot
    this.spawnPiece();
  }

  get thinkDelay() { return [0, 2200, 1400, 700, 280, 80][this.level] || 400; }
  // moveStepDelay: how long each step in the animation takes (lower level = slower moves)
  get moveStepDelay() { return [0, 120, 80, 45, 20, 8][this.level] || 40; }

  spawnPiece() {
    const type = this.nextQueue.shift();
    this.nextQueue.push(this.bag.next());
    this.currentPiece = { type, rotation: 0, x: 3, y: -2 };
    this.holdUsed = false;
    if (!isValid(this.board, type, 0, 3, -1)) this.alive = false;
  }

  think(onDone) {
    if (!this.alive || !this.currentPiece) { if(onDone)onDone(); return; }

    // PC hunt mode: try to find a perfect clear sequence
    if (this.pcHuntMode && this.pcPiecesPlaced < 14) {
      const occupiedRows = this.board.filter(row => row.some(c => c !== 0)).length;
      if (occupiedRows <= 4) {
        // Build piece list: current + hold (if any) interleaved + next queue
        const piecesNoHold = [this.currentPiece.type, ...this.nextQueue.slice(0, 5)];
        const piecesWithHold = this.holdPiece
          ? [this.holdPiece, this.currentPiece.type, ...this.nextQueue.slice(0, 4)]
          : null;

        let pcSeq = findPCSequence(this.board, piecesNoHold, 25);
        let useHoldFirst = false;
        if (!pcSeq && piecesWithHold) {
          pcSeq = findPCSequence(this.board, piecesWithHold, 20);
          if (pcSeq) useHoldFirst = true;
        }

        if (pcSeq && pcSeq.length > 0) {
          const first = pcSeq[0];
          const needHold = useHoldFirst || first.type !== this.currentPiece.type;
          // Find the matching placement via BFS (includes soft-drop paths)
          const bfsPlacements = getAllPlacementsBFS(this.board,
            needHold && this.holdPiece ? this.holdPiece : first.type);
          const placement = bfsPlacements.find(p => p.rot === first.rot && p.x === first.x);
          if (placement) {
            this.executePlacement({ ...placement, useHold: needHold }, onDone);
            return;
          }
        }
      }
    }

    // Normal AI
    const pcBonus = (this.pcHuntMode && this.pcPiecesPlaced < 10) ? 20000 : 0;

    let placement = botChoosePlacement(
      this.board, this.currentPiece.type,
      this.nextQueue.slice(0,5),
      this.holdPiece,
      this.b2b, Math.max(0, this.combo),
      this.lvl, this.level, this.ren,
      pcBonus
    );

    if (placement) this.executePlacement(placement, onDone);
    else if (onDone) onDone();
  }

  executePlacement(placement, onDone) {
    if (!this.alive || !this.currentPiece) { if(onDone)onDone(); return; }
    const { rot, x, useHold } = placement;

    if (useHold) {
      if (this.holdPiece) {
        const prev = this.holdPiece;
        this.holdPiece = this.currentPiece.type;
        this.currentPiece = { type: prev, rotation: 0, x: 3, y: 0 };
        this.holdUsed = true;
        // Broadcast hold action then continue with new current piece
        // The placement already has the right rot/x for the held piece
      } else {
        // No hold yet: stash current, spawn next, re-decide
        this.holdPiece = this.currentPiece.type;
        this.holdUsed = true;
        this.spawnPiece();
        const p2 = botChoosePlacement(
          this.board, this.currentPiece.type, this.nextQueue.slice(0,5),
          this.holdPiece, this.b2b, Math.max(0,this.combo), this.lvl, this.level, this.ren
        );
        if (p2) this.executePlacement(p2, onDone); else if(onDone)onDone();
        return;
      }
    }

    const type = this.currentPiece.type;
    const targetY = hardDropY(this.board, type, rot, x, 0);

    // Decide: soft drop needed? (piece can't be reached by pure hard drop from spawn)
    const directY = hardDropY(this.board, type, rot, x, 0);
    // Check if target rot/x is reachable from (rot=0, x=3) without soft drop
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

    broadcast(0, 3, 0);
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
    let cr = 0, cx = 3;

    // Rotate
    const rotSteps = rot <= 2 ? rot : 4 - rot;
    const rotDir   = rot <= 2 ? 1 : -1;
    for (let i = 0; i < rotSteps; i++) {
      const res = tryRotate(board, type, cr, cx, 0, rotDir);
      if (res) { cr = res.rot; cx = res.x; }
      steps.push({ rot: cr, x: cx, y: 0 });
    }

    // Slide horizontally
    while (cx !== x) {
      const dir = cx < x ? 1 : -1;
      if (isValid(board, type, cr, cx+dir, 0)) cx += dir;
      else break;
      steps.push({ rot: cr, x: cx, y: 0 });
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
    const queue = [{ rot: 0, x: 3, y: 0 }];
    visited.set('0,3,0', null);

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
      // Placement is invalid — just spawn next piece without placing
      console.warn(`[BOT] Invalid placement skipped: ${type} rot=${rot} x=${x} y=${y}`);
      this.spawnPiece();
      return;
    }
    // Also verify it's actually resting (can't go one lower) — if it can go lower, drop it there
    while (isValid(this.board, type, rot, x, y + 1)) y++;

    // Track placement column for anti-repeat logic
    this.lastPlacements.push(x);
    if (this.lastPlacements.length > 5) this.lastPlacements.shift();
    this.pcPiecesPlaced++;
    // If board is not clean after 12 pieces, stop PC hunt
    if (this.pcPiecesPlaced > 12) this.pcHuntMode = false;

    const now = Date.now();
    const armed = this.garbageQueue.filter(g => g.readyAt <= now);
    this.garbageQueue = this.garbageQueue.filter(g => g.readyAt > now);

    let b = placePiece(this.board, type, rot, x, y);
    const { board: cleared, lines } = clearLines(b);
    const spin = detectTspin(this.board, type, rot, x, y);
    const isTSpin = spin === 'TSPIN';
    const isMini = spin === 'MINI_TSPIN';
    const isB2B = this.b2b && (lines === 4 || (isTSpin && lines > 0));

    let attack = 0;
    if (lines === 4) attack = 4;
    else if (isTSpin && lines === 3) attack = 6;
    else if (isTSpin && lines === 2) attack = 4;
    else if (isTSpin && lines === 1) attack = 2;
    else if (isMini && lines === 2) attack = 1;
    else if (lines === 3) attack = 2;
    else if (lines === 2) attack = 1;
    else if (lines === 1) attack = 0;
    if (isB2B && attack > 0) attack += 1;

    if (lines > 0) {
      this.combo++;
      this.ren++;
      const renAttack = [0,0,1,1,2,2,3,3,4,4,4,5][Math.min(this.ren, 11)] || 5;
      if (this.ren >= 2) attack += renAttack;
      if (this.combo > 0) attack += Math.floor(this.combo / 2);
    } else {
      this.combo = -1;
      this.ren = 0;
    }
    this.b2b = lines === 4 || (isTSpin && lines > 0);

    // Cancel garbage with cleared lines; remaining goes on board
    let cancelLines = lines;
    for (const g of armed) { const sub=Math.min(g.lines,cancelLines); g.lines-=sub; cancelLines-=sub; }
    let finalBoard = cleared;
    for (const g of armed.filter(g=>g.lines>0)) {
      const hc = g.holeCol!==undefined ? g.holeCol : Math.floor(Math.random()*COLS);
      for (let i=0;i<g.lines;i++){const row=Array(COLS).fill('G');row[hc]=0;finalBoard.push(row);finalBoard.shift();}
    }

    this.board = finalBoard;
    this.lines += lines;
    this.lvl = Math.floor(this.lines/10)+1;
    this.score += lines*100*this.lvl + (isTSpin?lines*200:0);

    const allClear = this.board.every(r=>r.every(c=>c===0));
    if (allClear) { attack = 10; this.pcHuntMode = false; } // reset PC hunt after achieving it

    const room = rooms[this.roomId];
    if (room && attack > 0) {
      const humanTargets = room.players.filter(p => p.id !== this.id && p.alive);
      for (const t of humanTargets) {
        const hc = Math.floor(Math.random()*COLS);
        io.to(t.id).emit('receive_garbage', { lines: attack, fromId: this.id, holeCol: hc });
        io.to(this.roomId).emit('attack_sent', { fromId: this.id, toId: t.id, attack, clearRows: [] });
      }
      const botTargets = room.bots.filter(bt => bt.id !== this.id && bt.alive);
      for (const bt of botTargets) bt.queueGarbage(attack, this.id);
    }

    if (room) {
      io.to(this.roomId).emit('bot_update', {
        id: this.id,
        board: this.board.map(r=>r.map(c=>c||0)),
        score: this.score, lines: this.lines, level: this.lvl,
        nextPieces: this.nextQueue.slice(0,5),
        holdPiece: this.holdPiece
      });
    }

    this.spawnPiece();
    if (!this.alive) {
      if (room) {
        io.to(this.roomId).emit('player_dead', { id: this.id, name: this.name });
        checkGameEnd(this.roomId);
      }
    }
  }

  queueGarbage(lines, fromId) {
    const hc = Math.floor(Math.random()*COLS);
    this.garbageQueue.push({ lines, fromId, readyAt: Date.now()+3000, holeCol: hc });
  }

  startAutonomous(extraDelay = 0) {
    if (this.thinkTimer) return;
    const tick = () => {
      if (!this.alive) return;
      const room = rooms[this.roomId];
      if (!room || !room.started || room.shogiMode) return;
      this.think(() => {
        if (this.alive) this.thinkTimer = setTimeout(tick, 50);
      });
    };
    this.thinkTimer = setTimeout(tick, extraDelay + this.thinkDelay);
  }

  stop() { if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; } }
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
      soloMode: false         // 1人でもゲーム開始できる
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
    roomSettings: room.roomSettings
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

// ── Socket.IO ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('create_room', ({ name, roomId: requestedId }) => {
    if (requestedId) {
      const er = getRoom(requestedId.toUpperCase());
      if (er) {
        const rid = requestedId.toUpperCase();
        if (er.started) { socket.emit('error',{msg:'Game already started'}); return; }
        if (er.players.find(p=>p.name===name)) { socket.emit('error',{msg:'Name already in room'}); return; }
        er.players.push({id:socket.id,name,board:null,score:0,lines:0,level:1,alive:true,combo:0,b2b:false});
        socket.join(rid); socket.roomId=rid; socket.playerName=name; lastRoom[name]=rid;
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

  socket.on('add_bot', ({botLevel}) => {
    const room=getRoom(socket.roomId); if (!room) return;
    if (socket.id!==room.host) return;
    const lvl=Math.max(1,Math.min(5,parseInt(botLevel)||room.roomSettings.botLevel||3));
    const botId=makeBotId();
    const usedNames=allPlayers(room).map(p=>p.name);
    const bname=BOT_NAMES.find(n=>!usedNames.includes('🤖'+n))||('BOT'+(room.bots.length+1));
    const fullName='🤖'+bname;
    room.bots.push({id:botId,name:fullName,isBot:true,botLevel:lvl,alive:true});
    broadcastRoomUpdate(room,socket.roomId);
    addChatSys(socket.roomId,`🤖 ${fullName} (Lv.${lvl}) joined the room!`);
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
    if (ns.botLevel!==undefined) rs.botLevel=Math.max(1,Math.min(5,parseInt(ns.botLevel)||3));
    if (ns.shogiMode!==undefined) rs.shogiMode=!!ns.shogiMode;
    if (ns.recordTraining!==undefined) rs.recordTraining=!!ns.recordTraining;
    if (ns.soloMode!==undefined) rs.soloMode=!!ns.soloMode;
    broadcastRoomUpdate(room,socket.roomId);
  });

  socket.on('start_game', () => {
    const room=getRoom(socket.roomId);
    if (!room||socket.id!==room.host) return;
    const rs = room.roomSettings;
    // ソロモード: 1人でも開始可能
    const minPlayers = rs.soloMode ? 1 : 2;
    if (allPlayers(room).length < minPlayers) {
      socket.emit('error',{msg: rs.soloMode ? 'Need at least 1 player' : 'Need at least 2 players (add a BOT!)'}); return;
    }
    room.started=true;
    room.bagSeed=Math.floor(Math.random()*1000000);
    if (room.mutationMode&&!room.mutationSeed) room.mutationSeed=Math.floor(Math.random()*1000000);
    room.players.forEach(p=>{p.board=null;p.score=0;p.lines=0;p.level=1;p.alive=true;p.combo=0;p.b2b=false;});

    const humanCount=room.players.length;
    const isSolo = humanCount === 1 && room.bots.length === 0;
    const doShogi=room.roomSettings.shogiMode&&humanCount===1&&room.bots.length>=1;
    room.shogiMode=doShogi;
    room.isSolo=isSolo;

    const realBots=room.bots.map(entry=>{
      const bag=new Bag(room.bagSeed); // 人間と同じシードで同じミノ順を共有
      const bot=new BotPlayer(entry.id,entry.name,entry.botLevel,socket.roomId,bag);
      return bot;
    });
    room.bots=realBots;

    io.to(socket.roomId).emit('game_start',{
      players:allPlayers(room).map(p=>({id:p.id,name:p.name,isBot:!!p.isBot,botLevel:p.botLevel||null})),
      bagSeed:room.bagSeed,mutationMode:room.mutationMode,mutationSeed:room.mutationSeed,
      roomSettings:room.roomSettings,shogiMode:doShogi,isSolo
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
      realBots.forEach(b=>b.startAutonomous(3700));
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

  socket.on('board_update', ({board,score,lines,level,currentPiece,nextPieces,holdPiece}) => {
    const room=getRoom(socket.roomId); if (!room) return;
    const player=room.players.find(p=>p.id===socket.id); if (!player) return;
    player.board=board; player.score=score; player.lines=lines; player.level=level;
    player.currentPiece=currentPiece; player.nextPieces=nextPieces; player.holdPiece=holdPiece;
    socket.to(socket.roomId).emit('opponent_update',{id:socket.id,board,score,lines,level,currentPiece,nextPieces,holdPiece});
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

  socket.on('lines_cleared', ({attack,allClear,spinType,clearRows}) => {
    const room=getRoom(socket.roomId); if (!room) return;
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
    
    // 既に同名がいる場合は既存エントリを置き換え（同じタブで再接続した場合）
    const existing=room.players.find(p=>p.name===name);
    if(existing){room.players=room.players.filter(p=>p.name!==name);}
    room.players.push({id:socket.id,name,board:null,score:0,lines:0,level:1,alive:true,combo:0,b2b:false});
    socket.join(rid); socket.roomId=rid; socket.playerName=name; lastRoom[name]=rid;
    const isNewHost=!room.host||!room.players.find(p=>p.id===room.host);
    if(isNewHost)room.host=socket.id;
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
    if (room.players.length===0&&room.bots.length===0){delete rooms[socket.roomId];socket.roomId=null;return;}
    if (room.host===socket.id&&room.players.length>0) room.host=room.players[0].id;
    io.to(socket.roomId).emit('player_left',{id:socket.id});
    broadcastRoomUpdate(room,socket.roomId);
    socket.roomId=null;
  });

  socket.on('disconnect', () => {
    const room=getRoom(socket.roomId); if (!room) return;
    room.players=room.players.filter(p=>p.id!==socket.id);
    if (room.spectators) room.spectators=room.spectators.filter(s=>s.id!==socket.id);
    if (room.players.length===0&&room.bots.length===0){delete rooms[socket.roomId];return;}
    if (room.host===socket.id&&room.players.length>0) room.host=room.players[0].id;
    io.to(socket.roomId).emit('player_left',{id:socket.id});
    broadcastRoomUpdate(room,socket.roomId);
    if (room.started){room.bots.forEach(b=>b.stop());checkGameEnd(socket.roomId);}
  });
});

function addChatSys(roomId, text) {
  io.to(roomId).emit('chat_message',{id:'system',name:'SYSTEM',message:text});
}

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
