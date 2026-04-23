#!/usr/bin/env python3
"""
Tetrix AI Training Script
=========================
Loads match JSON files from training_data/ and trains a neural network
to imitate human placement decisions.

Input features per frame:
  - Board state (23×10 = 230 cells, encoded as 0/1)
  - Current piece type (7-dim one-hot)
  - Hold piece type (8-dim one-hot, 0=empty)
  - Next 5 pieces (5×7 = 35-dim one-hot)
  Total: 230 + 7 + 8 + 35 = 280 features

Output (placement action):
  - Column x  (0-9)
  - Rotation  (0-3)
  → Encoded as single class: rot * 10 + x  → 40 classes

Usage:
  pip install torch numpy scikit-learn tqdm
  python train_ai.py                        # train with all data in ./training_data/
  python train_ai.py --data ./training_data --epochs 50 --out model.pt
  python train_ai.py --eval model.pt        # evaluate existing model
"""

import argparse
import json
import os
import sys
import glob
import numpy as np
from pathlib import Path

# ── Constants (must match server) ──────────────────────────────────
COLS = 10
ROWS = 20
HIDDEN = 3
TOTAL_ROWS = ROWS + HIDDEN  # 23
PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']
PIECE_INDEX = {t: i for i, t in enumerate(PIECE_TYPES)}
NUM_CLASSES = 4 * COLS  # rot(0-3) × col(0-9) = 40

# ── Feature encoding ────────────────────────────────────────────────

def encode_board(board):
    """Encode 23×10 board as flat binary array (0=empty, 1=filled)."""
    arr = np.zeros(TOTAL_ROWS * COLS, dtype=np.float32)
    for r in range(min(len(board), TOTAL_ROWS)):
        for c in range(min(len(board[r]), COLS)):
            if board[r][c] not in (0, None, '0'):
                arr[r * COLS + c] = 1.0
    return arr

def encode_piece(piece_type):
    """One-hot encode a piece type (7-dim). None/null → all zeros."""
    arr = np.zeros(len(PIECE_TYPES), dtype=np.float32)
    if piece_type and piece_type in PIECE_INDEX:
        arr[PIECE_INDEX[piece_type]] = 1.0
    return arr

def encode_hold(hold_type):
    """One-hot encode hold slot (8-dim: 7 pieces + 1 empty)."""
    arr = np.zeros(len(PIECE_TYPES) + 1, dtype=np.float32)
    if hold_type and hold_type in PIECE_INDEX:
        arr[PIECE_INDEX[hold_type]] = 1.0
    else:
        arr[-1] = 1.0  # empty hold
    return arr

def encode_next(next_pieces, n=5):
    """Encode up to n next pieces as stacked one-hots (n×7-dim)."""
    arr = np.zeros(n * len(PIECE_TYPES), dtype=np.float32)
    for i, p in enumerate(next_pieces[:n]):
        if p and p in PIECE_INDEX:
            arr[i * len(PIECE_TYPES) + PIECE_INDEX[p]] = 1.0
    return arr

def encode_frame(frame):
    """
    Encode one training frame into (features, label).
    Returns (np.ndarray shape [280], int label) or None if invalid.
    """
    placed = frame.get('placedPiece', {})
    piece_type = placed.get('type')
    x = placed.get('x')
    rotation = placed.get('rotation', 0)

    if piece_type is None or x is None:
        return None
    if not (0 <= x < COLS) or not (0 <= rotation < 4):
        return None

    board = frame.get('boardBefore') or frame.get('boardAfter', [])
    hold = frame.get('holdPiece')
    next_pieces = frame.get('nextPieces', [])

    features = np.concatenate([
        encode_board(board),          # 230
        encode_piece(piece_type),     # 7
        encode_hold(hold),            # 8
        encode_next(next_pieces, 5),  # 35
    ])  # total = 280

    label = rotation * COLS + x  # 0..39
    return features, label

# ── Data loading ────────────────────────────────────────────────────

def load_training_data(data_dir):
    files = glob.glob(os.path.join(data_dir, '*.json'))
    if not files:
        print(f"[!] No JSON files found in {data_dir}")
        sys.exit(1)

    X, y = [], []
    total_frames = 0
    skipped = 0

    print(f"Loading {len(files)} match file(s)...")
    for fpath in sorted(files):
        try:
            with open(fpath) as f:
                match = json.load(f)
        except Exception as e:
            print(f"  [skip] {fpath}: {e}")
            continue

        for pid, pdata in match.get('players', {}).items():
            for frame in pdata.get('frames', []):
                total_frames += 1
                result = encode_frame(frame)
                if result is None:
                    skipped += 1
                    continue
                feat, label = result
                X.append(feat)
                y.append(label)

    print(f"  Loaded {len(X)} frames ({skipped} skipped) from {len(files)} matches")
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int64)

# ── Model ────────────────────────────────────────────────────────────

def build_model(input_dim=280, num_classes=NUM_CLASSES, hidden=[512, 256, 128]):
    """Build a simple MLP model."""
    try:
        import torch
        import torch.nn as nn
    except ImportError:
        print("[!] PyTorch not found. Install: pip install torch")
        sys.exit(1)

    layers = []
    prev = input_dim
    for h in hidden:
        layers += [nn.Linear(prev, h), nn.BatchNorm1d(h), nn.ReLU(), nn.Dropout(0.3)]
        prev = h
    layers.append(nn.Linear(prev, num_classes))
    return nn.Sequential(*layers)

# ── Training ─────────────────────────────────────────────────────────

def train(args):
    try:
        import torch
        import torch.nn as nn
        from torch.utils.data import TensorDataset, DataLoader
        from sklearn.model_selection import train_test_split
    except ImportError as e:
        print(f"[!] Missing dependency: {e}")
        print("Install: pip install torch scikit-learn")
        sys.exit(1)

    X, y = load_training_data(args.data)
    if len(X) < 100:
        print(f"[!] Only {len(X)} samples — need more training data. Play more matches with 🔴 Recording ON.")
        sys.exit(1)

    print(f"\nDataset: {len(X)} samples, {X.shape[1]} features, {NUM_CLASSES} classes")

    # Train/val split
    X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.15, random_state=42, stratify=y if len(np.unique(y)) > 1 else None)
    print(f"Train: {len(X_train)}  Val: {len(X_val)}")

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"Device: {device}")

    # Datasets
    train_ds = TensorDataset(torch.tensor(X_train), torch.tensor(y_train))
    val_ds   = TensorDataset(torch.tensor(X_val),   torch.tensor(y_val))
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=0)
    val_dl   = DataLoader(val_ds,   batch_size=args.batch, shuffle=False, num_workers=0)

    model = build_model().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    criterion = nn.CrossEntropyLoss()

    best_val_acc = 0.0
    best_epoch = 0

    print(f"\nTraining for {args.epochs} epochs...\n{'─'*60}")
    for epoch in range(1, args.epochs + 1):
        # Train
        model.train()
        train_loss, train_correct, train_total = 0.0, 0, 0
        for xb, yb in train_dl:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            logits = model(xb)
            loss = criterion(logits, yb)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * len(xb)
            train_correct += (logits.argmax(1) == yb).sum().item()
            train_total += len(xb)
        scheduler.step()

        # Validate
        model.eval()
        val_loss, val_correct, val_total = 0.0, 0, 0
        with torch.no_grad():
            for xb, yb in val_dl:
                xb, yb = xb.to(device), yb.to(device)
                logits = model(xb)
                val_loss += criterion(logits, yb).item() * len(xb)
                val_correct += (logits.argmax(1) == yb).sum().item()
                val_total += len(xb)

        train_acc = train_correct / train_total * 100
        val_acc   = val_correct   / val_total   * 100
        avg_train_loss = train_loss / train_total
        avg_val_loss   = val_loss   / val_total

        marker = ''
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_epoch = epoch
            torch.save({
                'epoch': epoch,
                'model_state_dict': model.state_dict(),
                'val_acc': val_acc,
                'input_dim': X.shape[1],
                'num_classes': NUM_CLASSES,
                'piece_types': PIECE_TYPES,
                'cols': COLS,
            }, args.out)
            marker = '  ← best saved'

        if epoch % 5 == 0 or epoch == 1 or marker:
            print(f"Epoch {epoch:3d}/{args.epochs}  "
                  f"loss={avg_train_loss:.4f}/{avg_val_loss:.4f}  "
                  f"acc={train_acc:.1f}%/{val_acc:.1f}%{marker}")

    print(f"\n{'─'*60}")
    print(f"✅ Training complete! Best val acc: {best_val_acc:.2f}% (epoch {best_epoch})")
    print(f"   Model saved → {args.out}")

    # Top-5 accuracy on validation set
    model.eval()
    top5_correct = 0
    with torch.no_grad():
        X_val_t = torch.tensor(X_val).to(device)
        y_val_t = torch.tensor(y_val).to(device)
        logits = model(X_val_t)
        top5 = logits.topk(5, dim=1).indices
        top5_correct = (top5 == y_val_t.unsqueeze(1)).any(dim=1).sum().item()
    print(f"   Top-5 val acc: {top5_correct/len(y_val)*100:.1f}%")

# ── Evaluation ───────────────────────────────────────────────────────

def evaluate(args):
    try:
        import torch
    except ImportError:
        print("[!] PyTorch not found. Install: pip install torch")
        sys.exit(1)

    if not os.path.exists(args.eval):
        print(f"[!] Model file not found: {args.eval}")
        sys.exit(1)

    checkpoint = torch.load(args.eval, map_location='cpu')
    print(f"Model: {args.eval}")
    print(f"  Trained to epoch {checkpoint.get('epoch','?')}")
    print(f"  Val acc at save: {checkpoint.get('val_acc',0):.2f}%")
    print(f"  Input dim: {checkpoint.get('input_dim','?')}")
    print(f"  Num classes: {checkpoint.get('num_classes','?')}")

    if args.data and os.path.isdir(args.data):
        X, y = load_training_data(args.data)
        device = torch.device('cpu')
        model = build_model(checkpoint.get('input_dim', 280), checkpoint.get('num_classes', NUM_CLASSES))
        model.load_state_dict(checkpoint['model_state_dict'])
        model.eval()
        with torch.no_grad():
            logits = model(torch.tensor(X))
            top1 = (logits.argmax(1) == torch.tensor(y)).float().mean().item()
            top5 = (logits.topk(5, dim=1).indices == torch.tensor(y).unsqueeze(1)).any(dim=1).float().mean().item()
        print(f"\nFull dataset evaluation:")
        print(f"  Top-1 accuracy: {top1*100:.2f}%")
        print(f"  Top-5 accuracy: {top5*100:.2f}%")

        # Per-piece breakdown
        print(f"\nPer-piece accuracy:")
        for pt in PIECE_TYPES:
            mask = np.array([
                encode_frame({'boardBefore':[[0]*COLS]*TOTAL_ROWS,'placedPiece':{'type':p,'x':0,'rotation':0},'holdPiece':None,'nextPieces':[]}) is not None
                for p in [pt]*len(y)  # dummy
            ])
            # Re-derive which samples used this piece type
            piece_mask = []
            files = glob.glob(os.path.join(args.data, '*.json'))
            for fpath in sorted(files):
                with open(fpath) as f:
                    match = json.load(f)
                for pid, pdata in match.get('players', {}).items():
                    for frame in pdata.get('frames', []):
                        pp = (frame.get('placedPiece') or {}).get('type')
                        piece_mask.append(pp == pt)
            piece_mask = np.array(piece_mask[:len(y)])
            if piece_mask.sum() == 0:
                continue
            with torch.no_grad():
                logits_p = model(torch.tensor(X[piece_mask]))
                acc_p = (logits_p.argmax(1) == torch.tensor(y[piece_mask])).float().mean().item()
            print(f"  {pt}: {acc_p*100:.1f}%  ({piece_mask.sum()} samples)")

# ── Dataset stats ────────────────────────────────────────────────────

def stats(args):
    files = glob.glob(os.path.join(args.data, '*.json'))
    print(f"Training data in: {args.data}")
    print(f"Match files: {len(files)}\n")
    total_frames = 0
    piece_counts = {t: 0 for t in PIECE_TYPES}
    player_names = set()
    for fpath in sorted(files):
        try:
            with open(fpath) as f:
                match = json.load(f)
        except:
            continue
        for pid, pdata in match.get('players', {}).items():
            player_names.add(pdata.get('name', '?'))
            for frame in pdata.get('frames', []):
                total_frames += 1
                pt = (frame.get('placedPiece') or {}).get('type')
                if pt in piece_counts:
                    piece_counts[pt] += 1
    print(f"Total frames: {total_frames}")
    print(f"Players: {', '.join(sorted(player_names))}")
    print(f"\nPiece distribution:")
    for pt, cnt in sorted(piece_counts.items(), key=lambda x: -x[1]):
        bar = '█' * (cnt * 40 // max(piece_counts.values(), default=1))
        print(f"  {pt}: {cnt:5d}  {bar}")

# ── Main ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Tetrix AI Training')
    parser.add_argument('--data',   default='./training_data', help='Directory with match JSON files')
    parser.add_argument('--out',    default='model.pt',         help='Output model path')
    parser.add_argument('--epochs', type=int, default=40,       help='Training epochs')
    parser.add_argument('--batch',  type=int, default=256,      help='Batch size')
    parser.add_argument('--lr',     type=float, default=1e-3,   help='Learning rate')
    parser.add_argument('--eval',   default=None,               help='Evaluate existing model (path to .pt)')
    parser.add_argument('--stats',  action='store_true',        help='Show dataset statistics')
    args = parser.parse_args()

    if args.stats:
        stats(args)
    elif args.eval:
        evaluate(args)
    else:
        train(args)

if __name__ == '__main__':
    main()
