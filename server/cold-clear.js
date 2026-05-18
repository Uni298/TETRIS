'use strict';

/**
 * cold-clear.js
 * Node.js FFI wrapper for Cold Clear Tetris bot (C API)
 * Requires: npm install koffi
 * Build:    cargo build --release -p c-api
 */

const koffi = require('koffi');
const path  = require('path');

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const Piece = { I: 0, O: 1, T: 2, L: 3, J: 4, S: 5, Z: 6 };
const PieceName = ['I', 'O', 'T', 'L', 'J', 'S', 'Z'];

const Movement = { LEFT: 0, RIGHT: 1, CW: 2, CCW: 3, DROP: 4 };
const MovementName = ['LEFT', 'RIGHT', 'CW', 'CCW', 'DROP'];

const MovementMode = { ZERO_G: 0, TWENTY_G: 1, HARD_DROP_ONLY: 2 };
const SpawnRule    = { ROW_19_OR_20: 0, ROW_21_AND_FALL: 1 };
const PcPriority   = { OFF: 0, FASTEST: 1, ATTACK: 2 };
const PollStatus   = { PROVIDED: 0, WAITING: 1, DEAD: 2 };

// ---------------------------------------------------------------------------
// 型定義（モジュールロード時に1回だけ実行。koffi は型名の重複登録を禁止）
// ---------------------------------------------------------------------------

const CCAsyncBot = koffi.opaque('CCAsyncBot');
const CCBook     = koffi.opaque('CCBook');

const CCOptions = koffi.struct('CCOptions', {
    mode:       'int',
    spawn_rule: 'int',
    pcloop:     'int',
    min_nodes:  'uint32',
    max_nodes:  'uint32',
    threads:    'uint32',
    use_hold:   'bool',
    speculate:  'bool',
});

const CCWeights = koffi.struct('CCWeights', {
    back_to_back:      'int32',
    bumpiness:         'int32',
    bumpiness_sq:      'int32',
    row_transitions:   'int32',
    height:            'int32',
    top_half:          'int32',
    top_quarter:       'int32',
    jeopardy:          'int32',
    cavity_cells:      'int32',
    cavity_cells_sq:   'int32',
    overhang_cells:    'int32',
    overhang_cells_sq: 'int32',
    covered_cells:     'int32',
    covered_cells_sq:  'int32',
    tslot:             koffi.array('int32', 4),
    well_depth:        'int32',
    max_well_depth:    'int32',
    well_column:       koffi.array('int32', 10),
    b2b_clear:         'int32',
    clear1:            'int32',
    clear2:            'int32',
    clear3:            'int32',
    clear4:            'int32',
    tspin1:            'int32',
    tspin2:            'int32',
    tspin3:            'int32',
    mini_tspin1:       'int32',
    mini_tspin2:       'int32',
    perfect_clear:     'int32',
    combo_garbage:     'int32',
    move_time:         'int32',
    wasted_t:          'int32',
    use_bag:           'bool',
    timed_jeopardy:    'bool',
    stack_pc_damage:   'bool',
});

const CCMove = koffi.struct('CCMove', {
    hold:           'bool',
    expected_x:     koffi.array('uint8', 4),
    expected_y:     koffi.array('uint8', 4),
    movement_count: 'uint8',
    movements:      koffi.array('int', 32),
    nodes:          'uint32',
    depth:          'uint32',
    original_rank:  'uint32',
});

const CCPlanPlacement = koffi.struct('CCPlanPlacement', {
    piece:         'int',
    tspin:         'int',
    expected_x:    koffi.array('uint8', 4),
    expected_y:    koffi.array('uint8', 4),
    cleared_lines: koffi.array('int32', 4),
});

// ---------------------------------------------------------------------------
// ライブラリ読み込み（同じパスは1回だけロード）
// ---------------------------------------------------------------------------

const _libCache = new Map();

function loadLibrary(libPath) {
    const resolved = libPath
        ? path.resolve(libPath)
        : defaultLibPath();

    if (_libCache.has(resolved)) return _libCache.get(resolved);

    const lib = koffi.load(resolved);

    const fns = {
        cc_default_options:   lib.func('void cc_default_options(CCOptions *out)'),
        cc_default_weights:   lib.func('void cc_default_weights(CCWeights *out)'),
        cc_fast_weights:      lib.func('void cc_fast_weights(CCWeights *out)'),
        cc_launch_async:      lib.func('CCAsyncBot *cc_launch_async(CCOptions *opt, CCWeights *w, CCBook *book, uint8 *queue, uint32 count)'),
        cc_destroy_async:     lib.func('void cc_destroy_async(CCAsyncBot *bot)'),
        cc_reset_async:       lib.func('void cc_reset_async(CCAsyncBot *bot, uint8 *field, bool b2b, uint32 combo)'),
        cc_add_next_piece:    lib.func('void cc_add_next_piece_async(CCAsyncBot *bot, int piece)'),
        cc_request_next_move: lib.func('void cc_request_next_move(CCAsyncBot *bot, uint32 incoming)'),
        cc_poll_next_move:    lib.func('int cc_poll_next_move(CCAsyncBot *bot, _Out_ CCMove *move, CCPlanPlacement *plan, uint32 *plan_length)'),
        cc_block_next_move:   lib.func('int cc_block_next_move(CCAsyncBot *bot, _Out_ CCMove *move, CCPlanPlacement *plan, uint32 *plan_length)'),
        cc_load_book_file:    lib.func('CCBook *cc_load_book_from_file(char *path)'),
        cc_destroy_book:      lib.func('void cc_destroy_book(CCBook *book)'),
    };

    _libCache.set(resolved, fns);
    return fns;
}

function defaultLibPath() {
    const ext = process.platform === 'win32' ? '.dll'
              : process.platform === 'darwin' ? '.dylib'
              : '.so';
    const name = process.platform === 'win32' ? 'cold_clear' : 'libcold_clear';
    return path.resolve(`target/release/${name}${ext}`);
}

// ---------------------------------------------------------------------------
// デフォルト設定ヘルパー
// ---------------------------------------------------------------------------

function defaultOptions(overrides = {}) {
    return {
        mode:       MovementMode.ZERO_G,
        spawn_rule: SpawnRule.ROW_19_OR_20,
        pcloop:     PcPriority.OFF,
        min_nodes:  0,
        max_nodes:  4_000_000_000,
        threads:    1,
        use_hold:   true,
        speculate:  true,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// ColdClearBot クラス
// ---------------------------------------------------------------------------

class ColdClearBot {
    constructor(opts = {}) {
        this._fns  = loadLibrary(opts.libPath);
        this._dead = false;

        const weights = opts.weights ?? (() => {
            const w = {};
            this._fns.cc_default_weights(w);
            return w;
        })();

        const options = defaultOptions(opts.options ?? {});

        this._book = opts.bookPath
            ? this._fns.cc_load_book_file(opts.bookPath)
            : null;

        const queue = opts.queue ?? [];
        const queueBuf = queue.length > 0 ? Buffer.from(queue) : null;

        this._bot = this._fns.cc_launch_async(options, weights, this._book, queueBuf, queue.length);
        if (!this._bot) throw new Error('cc_launch_async failed (returned null)');
    }

    addNextPiece(piece) {
        this._assertAlive();
        this._fns.cc_add_next_piece(this._bot, piece);
    }

    requestNextMove(incoming = 0) {
        this._assertAlive();
        this._fns.cc_request_next_move(this._bot, incoming);
    }

    pollNextMove() {
        this._assertAlive();
        const move = {};
        const status = this._fns.cc_poll_next_move(this._bot, move, null, null);
        return this._toResult(status, move);
    }

    blockNextMove() {
        this._assertAlive();
        const move = {};
        const status = this._fns.cc_block_next_move(this._bot, move, null, null);
        return this._toResult(status, move);
    }

    reset(field, b2b = false, combo = 0) {
        this._assertAlive();
        const buf = Buffer.alloc(400);
        for (let row = 0; row < 40; row++)
            for (let col = 0; col < 10; col++)
                buf[row * 10 + col] = field[row]?.[col] ? 1 : 0;
        this._fns.cc_reset_async(this._bot, buf, b2b, combo);
    }

    destroy() {
        if (this._dead) return;
        this._fns.cc_destroy_async(this._bot);
        if (this._book) this._fns.cc_destroy_book(this._book);
        this._dead = true;
    }

    _assertAlive() {
        if (this._dead) throw new Error('ColdClearBot is already destroyed');
    }

    _toResult(statusCode, rawMove) {
        if (statusCode === PollStatus.PROVIDED) {
            const toArray = (v, len) => {
                if (!v) return Array(len).fill(0);
                if (Array.isArray(v)) return Array.from(v);
                return Array.from({ length: len }, (_, i) => v[i] ?? 0);
            };
            const count = rawMove.movement_count ?? 0;
            const movements = toArray(rawMove.movements, 32)
                .slice(0, count)
                .map(m => MovementName[m] ?? `?${m}`);
            return {
                status: 'provided',
                move: {
                    hold:          rawMove.hold ?? false,
                    expected_x:    toArray(rawMove.expected_x, 4),
                    expected_y:    toArray(rawMove.expected_y, 4),
                    movements,
                    nodes:         rawMove.nodes ?? 0,
                    depth:         rawMove.depth ?? 0,
                    original_rank: rawMove.original_rank ?? 0,
                },
            };
        }
        if (statusCode === PollStatus.DEAD) {
            this._dead = true;
            return { status: 'dead' };
        }
        return { status: 'waiting' };
    }
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

module.exports = {
    ColdClearBot,
    defaultOptions,
    Piece,
    PieceName,
    Movement,
    MovementName,
    MovementMode,
    SpawnRule,
    PcPriority,
    PollStatus,
};
