# TETRIX ONLINE - Multiplayer Tetris

## Setup

1. Install Node.js (v16+)
2. Install dependencies:
   ```
   npm install
   ```
3. Start server:
   ```
   npm start
   ```
4. Open browser: http://localhost:3000

## Gameplay

### Controls
| Key | Action |
|-----|--------|
| ← → | Move piece |
| ↑ or X | Rotate clockwise |
| Z | Rotate counter-clockwise |
| ↓ | Soft drop |
| Space | Hard drop |
| Shift / C | Hold piece |

### Features
- **Multiplayer**: Up to 3 players via Room ID
- **T-Spin / S-Spin / Z-Spin / I-Spin detection** with SRS kick tables
- **Garbage lines**: Attack opponents based on clears
  - 2-line: 1 garbage
  - 3-line: 2 garbage
  - Tetris: 4 garbage
  - T-Spin Single: 2 garbage
  - T-Spin Double: 4 garbage
  - T-Spin Triple: 6 garbage
  - B2B bonus: +1 garbage
  - Combo bonus: floor(combo/2) garbage
- **Back-to-Back (B2B)**: Consecutive Tetris/T-Spins bonus
- **REN/Combo**: Consecutive clear bonus
- **5 NEXT pieces** visible
- **Hold piece** system
- **Ghost piece** with adjustable opacity
- **Lock delay**: 1 second on ground (for T-Spin setups)
- **Board shake** on attacks/clears
- **Spin tilt**: Board tilts in rotation direction on spin
- **Crumble animation**: Players crumble on game over
- **Chat**: In-game chat panel
- **Particle effects** on line clears

### Graphics Settings (saved in cookies)
- **Ghost opacity**: 0-100%
- **Quality**: Low / Medium / High / Ultra (immersive)
- **Particles**: Off / Low / High
- **Board shake**: On/Off
- **SFX Volume**: 0-100%
- **Spin tilt effect**: On/Off

### Garbage Algorithm
Based on Tetris guideline:
- Single: 0 lines
- Double: 1 line
- Triple: 2 lines
- Tetris: 4 lines
- T-Spin Mini: 0 lines
- T-Spin Mini Single: 0 lines
- T-Spin Single: 2 lines
- T-Spin Double: 4 lines
- T-Spin Triple: 6 lines
- B2B modifier: +1 to all attacks
- Combo: floor(combo/2) extra lines

## Tech Stack
- **Frontend**: PixiJS 7, Socket.io client
- **Backend**: Node.js, Express, Socket.io
- **Fonts**: Orbitron, Share Tech Mono (Google Fonts)
- **Audio**: Web Audio API (procedural SFX)
