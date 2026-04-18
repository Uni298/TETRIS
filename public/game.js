// ===== TETRIX ONLINE =====

// ---- Settings ----
let settings={ghostOpacity:40,quality:'ultra',particles:'high',shake:'on',sfxVolume:70,tilt:'on'};
function loadSettings(){try{const s=document.cookie.split(';').find(c=>c.trim().startsWith('tetrix_settings='));if(s)settings={...settings,...JSON.parse(decodeURIComponent(s.split('=')[1]))};}catch(e){}}
function saveSettings(){document.cookie='tetrix_settings='+encodeURIComponent(JSON.stringify(settings))+'; max-age=31536000; path=/';}
function updateSetting(key,val){
  if(key==='ghost'){settings.ghostOpacity=parseInt(val);document.getElementById('ghost-val').textContent=val+'%';}
  else if(key==='quality'){settings.quality=val;document.getElementById('quality-val').textContent=val.toUpperCase();}
  else if(key==='particles')settings.particles=val;
  else if(key==='shake')settings.shake=val;
  else if(key==='sfx'){settings.sfxVolume=parseInt(val);document.getElementById('sfx-val').textContent=val+'%';sfxVol=parseInt(val)/100;}
  else if(key==='tilt')settings.tilt=val;
  saveSettings();
}
function toggleSettings(){document.getElementById('settings-modal').classList.toggle('open');}
loadSettings();

// ---- Socket ----
const socket=io();
let myId=null,roomId=null,myName='',isHost=false,roomPlayers=[];
socket.on('connect',()=>{myId=socket.id;});

// ---- Screen ----
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('settings-btn').style.display=id==='game'?'block':'none';
}

// ---- Lobby ----
let _lastUsedRoomId=null; // ロビー戻り時に両フィールドへ復元するために保持

function createRoom(){
  const name=document.getElementById('player-name').value.trim();
  if(!name){showError('Enter your name');return;}
  const rid=document.getElementById('room-id-input').value.trim().toUpperCase();
  myName=name;
  // RoomIDが入力されていればそのコードで部屋を作る
  if(rid){socket.emit('create_room',{name,roomId:rid});}
  else{socket.emit('create_room',{name});}
}
function joinRoom(){const name=document.getElementById('player-name').value.trim();const rid=document.getElementById('room-id-input').value.trim().toUpperCase();if(!name){showError('Enter your name');return;}if(!rid){showError('Enter room ID');return;}myName=name;socket.emit('join_room',{roomId:rid,name});}
function showError(msg){document.getElementById('lobby-error').textContent=msg;}
function leaveRoom(){socket.emit('leave_room');location.reload();}
function startGame(){socket.emit('start_game');}

function backToLobby(){
  document.getElementById('result-overlay').classList.remove('open');
  stopDAS();stopSoftDrop();removeInput();
  if(gameState){try{gameState.cancelLock();}catch(e){}gameState=null;}
  renderer=null;
  if(gameApp){try{gameApp.destroy(true);}catch(e){}gameApp=null;}
  const prevRoomId=roomId||_lastUsedRoomId;
  roomId=null;roomPlayers=[];
  document.getElementById('chat-messages').innerHTML='';
  document.getElementById('start-btn').style.display='none';
  // lastRoomのマッピングをサーバーからクリア（古いルームに再接続されないように）
  socket.emit('clear_last_room');
  showScreen('lobby');
  if(myName)document.getElementById('player-name').value=myName;
  if(prevRoomId)document.getElementById('room-id-input').value=prevRoomId;
  showError('');
}

socket.on('rejoin_result',({success,roomId:rid,players,host})=>{
  if(!success){showScreen('lobby');return;}
  roomId=rid;roomPlayers=players;
  isHost=(socket.id===host);
  document.getElementById('room-id-display').textContent=rid;
  updatePlayerList(players);
  document.getElementById('start-btn').style.display=isHost&&players.length>=2?'block':'none';
  document.getElementById('wait-status').textContent=players.length<2?'Waiting for players... (min 2)':`${players.length} players ready`;
  showScreen('waiting');
});

socket.on('room_created',({roomId:rid,players})=>{roomId=rid;_lastUsedRoomId=rid;roomPlayers=players;isHost=true;document.getElementById('room-id-display').textContent=rid;showScreen('waiting');updatePlayerList(players);});
socket.on('room_joined',({roomId:rid,players})=>{roomId=rid;_lastUsedRoomId=rid;roomPlayers=players;document.getElementById('room-id-display').textContent=rid;showScreen('waiting');updatePlayerList(players);});
socket.on('room_update',({players,host,started})=>{
  roomPlayers=players;isHost=(socket.id===host);updatePlayerList(players);
  document.getElementById('start-btn').style.display=isHost&&players.length>=2?'block':'none';
  document.getElementById('wait-status').textContent=players.length<2?'Waiting for players... (min 2)':`${players.length} players ready`;
});
socket.on('player_left',()=>addChatSystem('Player left'));
socket.on('error',({msg})=>showError(msg));

function updatePlayerList(players){
  document.getElementById('player-list').innerHTML=players.map((p,i)=>`<div class="player-item"><div class="player-avatar">${p.name[0].toUpperCase()}</div><span>${p.name}</span>${i===0?'<span class="host-badge">HOST</span>':''}</div>`).join('');
}

// ---- Countdown then start ----
socket.on('game_start',({players,bagSeed})=>{roomPlayers=players;showScreen('game');showCountdown(bagSeed,()=>initGame(players,bagSeed));});

const ANIM_SPEED = 0.75;

// PixiJS tickerのFPS上限を上げる（デフォルト60→120）
PIXI.Ticker.shared.maxFPS = 0; // 0 = 無制限 (ブラウザのrAFに任せる)

// ---- Seeded RNG ----
function seededRng(seed){
  let s=seed>>>0;
  return function(){
    s=(Math.imul(s,1664525)+1013904223)>>>0;
    return s/0x100000000;
  };
}

function showCountdown(bagSeed,cb){
  const container=document.getElementById('pixi-container');
  container.innerHTML='';
  const W=container.clientWidth||window.innerWidth,H=container.clientHeight||window.innerHeight;
  const res=settings.quality==='low'?1:settings.quality==='medium'?1.5:settings.quality==='ultra'?2.5:2;
  gameApp=new PIXI.Application({width:W,height:H,backgroundColor:0x030712,antialias:settings.quality!=='low',resolution:res,autoDensity:true});
  gameApp.ticker.maxFPS=0; // 無制限（ブラウザのrAFレートに従う）
  container.appendChild(gameApp.view);
  gameState=new TetrisGame(bagSeed);
  renderer=new GameRenderer(gameApp,roomPlayers,gameState);
  renderer.drawBoard();renderer.drawGhost();renderer.drawCurrent();
  renderer.drawNextPieces();renderer.drawHold();renderer.updateScoreUI();

  const wrap=document.createElement('div');
  wrap.style.cssText='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:10;pointer-events:none;';
  const num=document.createElement('div');
  num.style.cssText='font-family:Orbitron,sans-serif;font-size:10rem;font-weight:900;color:#00f5ff;text-shadow:0 0 60px #00f5ff;';
  wrap.appendChild(num);container.appendChild(wrap);
  const colors=['#ff006e','#ffbe0b','#00f5ff'];
  let n=3;
  const tick=()=>{
    num.textContent=n;
    num.style.color=colors[n-1]||'#00f5ff';
    num.style.transition='none';num.style.transform='scale(2.5)';num.style.opacity='0';num.style.filter='blur(6px)';
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      num.style.transition='transform 0.45s cubic-bezier(0.17,0.67,0.35,1.25),opacity 0.3s,filter 0.35s';
      num.style.transform='scale(1)';num.style.opacity='1';num.style.filter='blur(0)';
    }));
    SFX.countdownBeep(n);
    setTimeout(()=>{num.style.transition='all 0.3s ease-in';num.style.opacity='0';num.style.filter='blur(4px)';},650);
    n--;
    if(n>0)setTimeout(tick,1000);
    else setTimeout(()=>{
      num.textContent='GO!';num.style.color='#ffbe0b';
      num.style.transition='none';num.style.transform='scale(2.5)';num.style.opacity='0';num.style.filter='blur(6px)';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        num.style.transition='all 0.4s cubic-bezier(0.17,0.67,0.35,1.3)';
        num.style.transform='scale(1)';num.style.opacity='1';num.style.filter='blur(0)';
      }));
      SFX.countdownGo();
      setTimeout(()=>{wrap.remove();cb();},700);
    },1000);
  };
  tick();
}

// ---- Audio ----
let sfxVol=settings.sfxVolume/100;
const AudioCtx=window.AudioContext||window.webkitAudioContext;
let audioCtx=null;
function getAudio(){if(!audioCtx)audioCtx=new AudioCtx();return audioCtx;}
function playTone(freq,type,dur,vol=1,detuneCents=0){
  try{
    const ctx=getAudio(),osc=ctx.createOscillator(),g=ctx.createGain();
    osc.connect(g);g.connect(ctx.destination);
    osc.type=type;
    osc.frequency.setValueAtTime(freq,ctx.currentTime);
    if(detuneCents)osc.detune.setValueAtTime(detuneCents,ctx.currentTime);
    g.gain.setValueAtTime(vol*sfxVol,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+dur);
    osc.start();osc.stop(ctx.currentTime+dur);
  }catch(e){}
}
function playNoise(dur,vol=0.3,bandFreq=800){
  try{const ctx=getAudio(),buf=ctx.createBuffer(1,ctx.sampleRate*dur,ctx.sampleRate),data=buf.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;const src=ctx.createBufferSource(),g=ctx.createGain(),f=ctx.createBiquadFilter();f.type='bandpass';f.frequency.value=bandFreq;src.buffer=buf;src.connect(f);f.connect(g);g.connect(ctx.destination);g.gain.setValueAtTime(vol*sfxVol,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+dur);src.start();src.stop(ctx.currentTime+dur);}catch(e){}
}

// REN音程: ゲーム開始時にリセット、1RENごとに半音(2^(1/12)倍)上がる
let renSemitone=0;
const REN_BASE_FREQ=280; // 基準周波数

const SFX={
  move:()=>playTone(200,'square',0.04,0.25),
  rotate:()=>playTone(440,'square',0.07,0.35),
  lock:()=>{playNoise(0.1,0.45);playTone(100,'sawtooth',0.12,0.25);},
  spinLock:()=>{
    playNoise(0.04,0.9,1500);playTone(900,'square',0.03,0.7);
    setTimeout(()=>{playNoise(0.03,0.5,600);playTone(400,'sawtooth',0.05,0.3);},35);
  },
  clear1:()=>{playTone(523,'square',0.1,0.5);setTimeout(()=>playTone(659,'square',0.1,0.4),60);},
  clear2:()=>{[523,659,784].forEach((f,i)=>setTimeout(()=>playTone(f,'square',0.1,0.5),i*50));},
  clear3:()=>{[523,659,784,1047].forEach((f,i)=>setTimeout(()=>playTone(f,'square',0.1,0.55),i*45));},
  tetris:()=>{[523,659,784,1047,1319].forEach((f,i)=>setTimeout(()=>playTone(f,'square',0.13,0.65),i*45));setTimeout(()=>playNoise(0.25,0.3),200);},
  tspin:()=>{[700,550,400,700].forEach((f,i)=>setTimeout(()=>playTone(f,'sawtooth',0.09,0.55),i*55));},
  hardDrop:()=>{playTone(130,'sawtooth',0.09,0.5);playNoise(0.07,0.4);},
  hold:()=>playTone(320,'triangle',0.09,0.4),
  garbage:()=>{playTone(90,'sawtooth',0.18,0.5);playNoise(0.12,0.35,400);},
  garbageReceive:()=>{
    playTone(55,'sawtooth',0.35,0.65);playNoise(0.25,0.55,180);
    setTimeout(()=>playTone(75,'square',0.2,0.45),90);
    setTimeout(()=>playTone(60,'sawtooth',0.28,0.4),200);
  },
  gameover:()=>{[440,415,392,370,349,330].forEach((f,i)=>setTimeout(()=>playTone(f,'sawtooth',0.28,0.5),i*130));},
  // REN: ren数を直接受け取って半音計算 — グローバル変数不要で確実
  ren:(renCount)=>{
    // renCount=2から始まる（2連続=REN2）
    const semitone=renCount-1; // 1半音ずつ: REN2=1半音, REN3=2半音...
    const freq=REN_BASE_FREQ*Math.pow(2,semitone/12);
    playTone(freq,'square',0.15,0.6);
    if(renCount>=4)setTimeout(()=>playTone(freq*2,'square',0.08,0.3),45);
  },
  renReset:()=>{},
  b2b:()=>{playTone(880,'square',0.12,0.5);setTimeout(()=>playTone(1100,'square',0.09,0.35),80);},
  allClear:()=>{[523,659,784,1047,1319,1047,784,1319].forEach((f,i)=>setTimeout(()=>playTone(f,'square',0.12,0.75),i*55));},
  countdownBeep:(n)=>playTone(n===1?880:440,'square',0.14,0.55),
  countdownGo:()=>{[440,660,880,1100].forEach((f,i)=>setTimeout(()=>playTone(f,'square',0.12,0.7),i*70));},
  attack:()=>{playTone(220,'sawtooth',0.08,0.45);setTimeout(()=>playTone(330,'square',0.06,0.3),60);},
};

// ---- Constants ----
const COLS=10,ROWS=20,HIDDEN=3;
// Sミノを黄緑(0x8BC34A)に変更
const PIECE_COLORS={I:0x00f5ff,O:0xffbe0b,T:0xcc00ff,S:0x8BC34A,Z:0xff006e,J:0x4361ee,L:0xff8500,G:0x445566};
const PIECE_SHAPES={
  I:[[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],[[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],[[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],[[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]]],
  O:[[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],[[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]]],
  T:[[[0,1,0],[1,1,1],[0,0,0]],[[0,1,0],[0,1,1],[0,1,0]],[[0,0,0],[1,1,1],[0,1,0]],[[0,1,0],[1,1,0],[0,1,0]]],
  S:[[[0,1,1],[1,1,0],[0,0,0]],[[0,1,0],[0,1,1],[0,0,1]],[[0,0,0],[0,1,1],[1,1,0]],[[1,0,0],[1,1,0],[0,1,0]]],
  Z:[[[1,1,0],[0,1,1],[0,0,0]],[[0,0,1],[0,1,1],[0,1,0]],[[0,0,0],[1,1,0],[0,1,1]],[[0,1,0],[1,1,0],[1,0,0]]],
  J:[[[1,0,0],[1,1,1],[0,0,0]],[[0,1,1],[0,1,0],[0,1,0]],[[0,0,0],[1,1,1],[0,0,1]],[[0,1,0],[0,1,0],[1,1,0]]],
  L:[[[0,0,1],[1,1,1],[0,0,0]],[[0,1,0],[0,1,0],[0,1,1]],[[0,0,0],[1,1,1],[1,0,0]],[[1,1,0],[0,1,0],[0,1,0]]]
};
const KICK_JLSTZ={'0->1':[[-1,0],[-1,1],[0,-2],[-1,-2]],'1->0':[[1,0],[1,-1],[0,2],[1,2]],'1->2':[[1,0],[1,-1],[0,2],[1,2]],'2->1':[[-1,0],[-1,1],[0,-2],[-1,-2]],'2->3':[[1,0],[1,1],[0,-2],[1,-2]],'3->2':[[-1,0],[-1,-1],[0,2],[-1,2]],'3->0':[[-1,0],[-1,-1],[0,2],[-1,2]],'0->3':[[1,0],[1,1],[0,-2],[1,-2]]};
const KICK_I={'0->1':[[-2,0],[1,0],[-2,-1],[1,2]],'1->0':[[2,0],[-1,0],[2,1],[-1,-2]],'1->2':[[-1,0],[2,0],[-1,2],[2,-1]],'2->1':[[1,0],[-2,0],[1,-2],[-2,1]],'2->3':[[2,0],[-1,0],[2,1],[-1,-2]],'3->2':[[-2,0],[1,0],[-2,-1],[1,2]],'3->0':[[1,0],[-2,0],[1,-2],[-2,1]],'0->3':[[-1,0],[2,0],[-1,2],[2,-1]]};
const PIECE_TYPES=['I','O','T','S','Z','J','L'];

// ---- Seeded Bag ----
class Bag{
  constructor(seed){
    this.rng=seededRng(seed||Math.floor(Math.random()*1000000));
    this.bag=[];
  }
  fill(){
    const arr=[...PIECE_TYPES];
    for(let i=arr.length-1;i>0;i--){
      const j=Math.floor(this.rng()*(i+1));
      [arr[i],arr[j]]=[arr[j],arr[i]];
    }
    this.bag=arr;
  }
  next(){if(!this.bag.length)this.fill();return this.bag.pop();}
}

// ---- Game State ----
let gameState=null,gameApp=null,renderer=null;

// ミノのスポーン位置: 枠の外の上から登場させる
const SPAWN_Y = HIDDEN - 1; // 枠上部から見えるように

class TetrisGame{
  constructor(bagSeed){
    this.board=Array.from({length:ROWS+HIDDEN},()=>Array(COLS).fill(0));
    this.bag=new Bag(bagSeed);this.nextQueue=[];
    for(let i=0;i<6;i++)this.nextQueue.push(this.bag.next());
    this.holdPiece=null;this.holdUsed=false;
    this.score=0;this.lines=0;this.level=1;
    this.combo=-1;this.b2b=false;this.b2bCount=0;this.ren=0;
    this.alive=true;this.locking=false;
    this.lockTimer=null;this.lockDelay=1000;
    this.lastSpin=null;this.lastSpinType=null;
    this.garbageQueue=[];
    this.gravityMs=0;
    renSemitone=0;
    this.spawnPiece();
  }

  spawnPiece(){
    const type=this.nextQueue.shift();
    this.nextQueue.push(this.bag.next());
    this.current={type,rotation:0,x:3,y:0};
    this.holdUsed=false;this.lastSpin=null;this.lastSpinType=null;this.locking=false;
    if(renderer)renderer._wallBumpActive=false;
    if(!this.isValid(this.current)){this.alive=false;}
  }

  getShape(type,rot){return PIECE_SHAPES[type][((rot%4)+4)%4];}

  isValid(piece,dx=0,dy=0){
    const shape=this.getShape(piece.type,piece.rotation);
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;
      const nx=piece.x+c+dx,ny=piece.y+r+dy;
      if(nx<0||nx>=COLS)return false;
      if(ny>=ROWS+HIDDEN)return false;
      if(ny>=0&&this.board[ny][nx])return false;
    }
    return true;
  }

  rotate(dir){
    const oldRot=this.current.rotation;
    const newRot=((oldRot+(dir>0?1:3))%4+4)%4;
    const key=`${oldRot}->${newRot}`;
    const kicks=this.current.type==='I'?KICK_I[key]:KICK_JLSTZ[key];
    const base={...this.current,rotation:newRot};
    if(this.isValid(base)){
      this.current=base;this.checkSpin(0,0,false);this.tryResetLock();SFX.rotate();
      if(this.lastSpin){renderer&&renderer.onSpinTilt(dir);renderer&&renderer.onSpinRotateSparkle(this.current,this.lastSpinType);}
      return true;
    }
    if(kicks)for(const[kx,ky]of kicks){
      const t={...base,x:base.x+kx,y:base.y-ky};
      if(this.isValid(t)){
        this.current=t;this.checkSpin(kx,ky,true);this.tryResetLock();SFX.rotate();
        if(this.lastSpin){renderer&&renderer.onSpinTilt(dir);renderer&&renderer.onSpinRotateSparkle(this.current,this.lastSpinType);}
        return true;
      }
    }
    return false;
  }

  checkSpin(kx,ky,kicked){
    this.lastSpin=null;this.lastSpinType=null;
    const type=this.current.type,x=this.current.x,y=this.current.y,rot=this.current.rotation;
    if(type==='T'){
      const corners=[[0,0],[2,0],[0,2],[2,2]];
      const filled=corners.filter(([cx,cy])=>{const nx=x+cx,ny=y+cy;return(nx<0||nx>=COLS||ny<0||ny>=ROWS+HIDDEN)||(ny>=0&&!!this.board[ny]?.[nx]);});
      if(filled.length>=3){
        const front={0:[[0,0],[2,0]],1:[[2,0],[2,2]],2:[[0,2],[2,2]],3:[[0,0],[0,2]]}[rot];
        const ff=front.filter(([cx,cy])=>{const nx=x+cx,ny=y+cy;return(nx<0||nx>=COLS||ny<0||ny>=ROWS+HIDDEN)||(ny>=0&&!!this.board[ny]?.[nx]);});
        this.lastSpin='T';this.lastSpinType=ff.length>=2?'TSPIN':'MINI_TSPIN';
      }
    }
    if(['S','Z','L','J'].includes(type)&&kicked){
      const shape=this.getShape(type,rot);let bb=false;
      outer:for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
        if(!shape[r][c])continue;const ny=y+r+1;
        if(ny>=ROWS+HIDDEN||(ny>=0&&this.board[ny]?.[x+c])){bb=true;break outer;}
      }
      if(bb){this.lastSpin=type;this.lastSpinType=type+'SPIN';}
    }
    if(type==='I'&&kicked&&(Math.abs(kx)>=1||Math.abs(ky)>=1)){this.lastSpin='I';this.lastSpinType='ISPIN';}
  }

  move(dx){
    if(this.isValid(this.current,dx,0)){
      this.current.x+=dx;this.lastSpin=null;this.tryResetLock();SFX.move();
      return true;
    } else {
      renderer&&renderer.onWallBump(dx);
      return false;
    }
  }

  tryResetLock(){
    if(this.lockTimer&&!this.isValid(this.current,0,1)){clearTimeout(this.lockTimer);this.lockTimer=null;this.startLockTimer();}
  }

  softDrop(){
    if(this.isValid(this.current,0,1)){this.current.y++;this.score+=1;return true;}
    else{this.startLockTimer();return false;}
  }

  hardDrop(){
    let d=0;while(this.isValid(this.current,0,1)){this.current.y++;d++;}
    this.score+=d*2;SFX.hardDrop();
    renderer&&renderer.onHardDrop(d);
    this.lockPiece();
  }

  ghostY(){let gy=this.current.y;while(this.isValid({...this.current,y:gy+1}))gy++;return gy;}

  startLockTimer(){if(this.lockTimer)return;this.lockTimer=setTimeout(()=>{if(!this.isValid(this.current,0,1))this.lockPiece();},this.lockDelay);}
  cancelLock(){if(this.lockTimer){clearTimeout(this.lockTimer);this.lockTimer=null;}}

  lockPiece(){
    if(this.locking)return;
    this.locking=true;this.cancelLock();
    const shape=this.getShape(this.current.type,this.current.rotation);
    const wasSpin=!!this.lastSpin,spinType=this.lastSpinType;
    this._lockX=this.current.x;this._lockY=this.current.y;this._lockType=this.current.type;
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;
      const ny=this.current.y+r,nx=this.current.x+c;
      if(ny>=0&&ny<ROWS+HIDDEN&&nx>=0&&nx<COLS)this.board[ny][nx]=this.current.type;
    }
    if(wasSpin){SFX.spinLock();socket.emit('spin_effect',{spinType});renderer&&renderer.onSpinSparkle(this._lockX,this._lockY,this._lockType);}
    else SFX.lock();
    this.clearLines();
  }

  clearLines(){
    const cleared=[];
    for(let r=ROWS+HIDDEN-1;r>=0;r--){
      if(this.board[r].every(c=>c!==0))cleared.push(r);
    }
    const count=cleared.length;
    const spinType=this.lastSpinType,isSpin=!!this.lastSpin,isMini=spinType&&spinType.startsWith('MINI'),isTSpin=this.lastSpin==='T';

    let allClear=false;
    if(count>0){
      const testBoard=this.board.map(r=>[...r]);
      const desc=[...cleared].sort((a,b)=>b-a);
      for(const idx of desc)testBoard.splice(idx,1);
      allClear=testBoard.every(row=>row.every(c=>c===0));
    }

    if(count>0){
      // ガベージキャンセル処理 (armed分はここではboardに追加しない — アニメ後に追加)
      const now=performance.now();
      const armed=this.garbageQueue.filter(g=>g.readyAt<=now);
      this.garbageQueue=this.garbageQueue.filter(g=>g.readyAt>now);
      let cancel=count;
      for(let i=0;i<armed.length&&cancel>0;i++){
        const sub=Math.min(armed[i].lines,cancel);armed[i].lines-=sub;cancel-=sub;
      }
      const remaining=armed.filter(g=>g.lines>0);
      if(remaining.length>0){
        const groups=groupByBatch(remaining);
        for(const grp of groups){
          const holeCol=grp[0].holeCol!==undefined?grp[0].holeCol:Math.floor(Math.random()*COLS);
          for(const chunk of grp){
            const col=chunk.holeCol!==undefined?chunk.holeCol:holeCol;
            for(let i=0;i<chunk.lines;i++){const row=Array(COLS).fill('G');row[col]=0;this.board.push(row);this.board.shift();}
          }
        }
        SFX.garbage();renderer&&renderer.onGarbageApplied(remaining.reduce((a,b)=>a+b.lines,0));
      }
      const desc=[...cleared].sort((a,b)=>b-a);
      for(const idx of desc)this.board.splice(idx,1);
      for(let i=0;i<count;i++)this.board.unshift(Array(COLS).fill(0));

      this.combo++;this.ren++;
      if(this.ren>1)SFX.ren(this.ren);
      const isB2B=this.b2b&&(count===4||(isSpin&&!isMini));
      if(count===4||(isSpin&&!isMini)){if(this.b2b){this.b2bCount++;SFX.b2b();}this.b2b=true;}
      else{this.b2bCount=0;this.b2b=false;}

      const pts=this.calcScore(count,isTSpin,isMini,isB2B,this.combo);
      this.score+=pts;this.lines+=count;this.level=Math.floor(this.lines/10)+1;

      let attack=0;
      if(allClear){attack=10;}
      else{
        if(isTSpin&&!isMini)attack={1:2,2:4,3:6}[count]||0;
        else if(isMini)attack={1:0,2:1}[count]||0;
        else attack={1:0,2:1,3:2,4:4}[count]||0;
        if(isB2B&&attack>0)attack+=1;
        if(this.combo>0)attack+=Math.floor(this.combo/2);
      }
      if(attack>0)socket.emit('lines_cleared',{attack,allClear,spinType,clearRows:cleared});

      if(count===1)SFX.clear1();else if(count===2)SFX.clear2();else if(count===3)SFX.clear3();else SFX.tetris();
      if(isSpin&&isTSpin)SFX.tspin();
      if(allClear)SFX.allClear();

      renderer&&renderer.onLineClear(cleared,count,spinType,isB2B,this.combo,this.ren,allClear,attack);
    } else {
      if(this.ren>0){SFX.renReset();}
      this.combo=-1;this.ren=0;
      renderer&&renderer.endComboLabel();
      // ガベージ即時適用（ラインなし時）
      const now=performance.now();
      const armed=this.garbageQueue.filter(g=>g.readyAt<=now);
      this.garbageQueue=this.garbageQueue.filter(g=>g.readyAt>now);
      if(armed.length){
        const total=armed.reduce((a,b)=>a+b.lines,0);
        if(total>0){
          // 同じ穴のものをセットで0.1秒ごとにアニメーション付きで追加
          this._applyGarbageAnimated(armed,total);
        }
      }
    }

    this.lastSpin=null;this.lastSpinType=null;
    this.spawnPiece();
    this._emitBoardUpdate();
    if(!this.alive){socket.emit('game_over');renderer&&renderer.onGameOver();}
  }

  // おじゃまミノ: 同じ穴のものをセットで、0.1秒ごとにグループを追加 + 振動
  _applyGarbageAnimated(armed,total){
    // 穴位置でグループ化
    const groups=[];
    for(const chunk of armed){
      const col=chunk.holeCol!==undefined?chunk.holeCol:Math.floor(Math.random()*COLS);
      let merged=false;
      for(const g of groups){
        if(g.col===col){g.count+=chunk.lines;merged=true;break;}
      }
      if(!merged)groups.push({col,count:chunk.lines});
    }
    // 各グループの行データを作成
    const groupRows=groups.map(g=>{
      const rows=[];
      for(let i=0;i<g.count;i++){const row=Array(COLS).fill('G');row[g.col]=0;rows.push(row);}
      return rows;
    });
    let idx=0;
    const applyGroup=()=>{
      if(idx>=groupRows.length)return;
      const rows=groupRows[idx];
      for(const row of rows){this.board.push(row);this.board.shift();}
      idx++;
      if(renderer){
        renderer.onGarbageRowAdded(rows.length); // まとめて振動
      }
      if(idx<groupRows.length)setTimeout(applyGroup,100);
    };
    SFX.garbageReceive();
    renderer&&renderer.onGarbageApplied(total);
    applyGroup();
  }

  _emitBoardUpdate(){
    socket.emit('board_update',{
      board:this.board.map(row=>row.map(c=>c||0)),
      score:this.score,lines:this.lines,level:this.level,
      currentPiece:{...this.current},nextPieces:this.nextQueue.slice(0,5),holdPiece:this.holdPiece
    });
  }

  // 現在ミノ位置のみ軽量送信（毎フレーム近い頻度で呼ばれる）
  _emitCurrentPiece(){
    if(!this.current)return;
    socket.emit('piece_update',{currentPiece:{...this.current}});
  }

  queueGarbage(lines,fromId){
    const readyAt=performance.now()+3000;
    const holeCol=Math.floor(Math.random()*COLS);
    this.garbageQueue.push({lines,fromId,readyAt,holeCol});
    renderer&&renderer.onGarbageIncoming(lines,fromId);
  }

  calcScore(count,isTSpin,isMini,isB2B,combo){
    const base={1:100,2:300,3:500,4:800};
    const ts={0:400,1:800,2:1200,3:1600};
    const mini={1:200,2:400};
    let pts=isTSpin&&!isMini?(ts[count]||0):isMini?(mini[count]||100):(base[count]||0);
    if(isB2B)pts=Math.floor(pts*1.5);
    pts*=this.level;
    if(combo>0)pts+=50*combo*this.level;
    return pts;
  }

  hold(){
    if(this.holdUsed)return;
    this.holdUsed=true;
    const type=this.current.type;
    if(this.holdPiece){
      const next=this.holdPiece;this.holdPiece=type;
      this.current={type:next,rotation:0,x:3,y:0};
      this.lastSpin=null;this.lastSpinType=null;this.locking=false;
      if(renderer)renderer._wallBumpActive=false;
    }else{this.holdPiece=type;this.spawnPiece();}
    this.cancelLock();SFX.hold();
  }

  updateGravity(dt){
    if(!this.alive)return;
    const msPerDrop=Math.max(50,1000-(this.level-1)*80);
    this.gravityMs+=dt;
    if(this.gravityMs>=msPerDrop){
      this.gravityMs=0;
      if(this.isValid(this.current,0,1))this.current.y++;
      else this.startLockTimer();
    }
  }
}

function groupByBatch(items){
  const groups=[];
  for(const item of items){
    let found=false;
    for(const g of groups){if(Math.abs(g[0].readyAt-item.readyAt)<200){g.push(item);found=true;break;}}
    if(!found)groups.push([item]);
  }
  return groups;
}

// ---- PixiJS Renderer ----
const CELL=28,BOARD_W=COLS*CELL,BOARD_H=ROWS*CELL;
const ABOVE_BOARD=CELL*2;

function initGame(players,bagSeed){
  setupInput();
  let lastTime=performance.now();
  let lastEmit=0;
  const EMIT_INTERVAL=50; // 50ms = 20fps で現在ミノ位置を送信
  gameApp.ticker.add(()=>{
    const now=performance.now();
    const rawDt=Math.min(now-lastTime,100);
    lastTime=now;
    if(gameState&&gameState.alive){
      gameState.updateGravity(rawDt);
      // 現在ミノ位置を定期的にリアルタイム送信
      if(now-lastEmit>=EMIT_INTERVAL){
        lastEmit=now;
        gameState._emitCurrentPiece();
      }
    }
    renderer&&renderer.update(rawDt*ANIM_SPEED);
  });
}

// ---- Floating Label ----
class FloatLabel{
  constructor(app,x,y,text,color,persistent=false){
    this.app=app;this.alive=true;this.persistent=persistent;
    this._ended=false;this.baseX=x;this.baseY=y;
    this._timer=0;this._fadeDelay=persistent?999999:2200;this._fadeDur=700;
    const sz=persistent?20:17;
    const st=new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:sz,fill:color,fontWeight:'900',letterSpacing:2,
      dropShadow:true,dropShadowColor:0x000000,dropShadowDistance:3,dropShadowBlur:4});
    this.txt=new PIXI.Text(text,st);
    this.txt.anchor.set(0,0.5);this.txt.x=x;this.txt.y=y;this.txt.alpha=0;this.txt.scale.set(1.5);
    app.stage.addChild(this.txt);
    this._popT=0;this._popping=true;
  }
  update(dt){
    if(!this.alive)return;
    if(this._popping){
      this._popT+=dt;const p=Math.min(1,this._popT/250);const ease=1-(1-p)*(1-p);
      this.txt.scale.set(1.5-0.5*ease);this.txt.alpha=ease;
      if(p>=1){this._popping=false;this.txt.scale.set(1);this.txt.alpha=1;}
      return;
    }
    this._timer+=dt;
    if(this.persistent&&!this._ended)return;
    if(this._timer>=this._fadeDelay){
      const ft=this._timer-this._fadeDelay;const a=Math.max(0,1-ft/this._fadeDur);
      this.txt.alpha=a;this.txt.x=this.baseX+(ft*0.04);
      if(a<=0){this.alive=false;try{this.txt.destroy();}catch(e){}}
    }
  }
  updateText(t){
    if(!this.txt||!this.alive)return;
    const old=this.txt.text;this.txt.text=t;
    if(old!==t){this._popping=true;this._popT=0;this.txt.scale.set(1.4);}
  }
  end(){this._ended=true;this._timer=0;this._fadeDelay=900;}
  destroy(){this.alive=false;try{this.txt.destroy();}catch(e){}}
}

class GameRenderer{
  constructor(app,players,gs){
    this.app=app;this.players=players;this.gs=gs;
    this.W=app.screen.width;this.H=app.screen.height;
    this.myPlayer=players.find(p=>p.id===myId);
    this.opponentPlayers=players.filter(p=>p.id!==myId);
    this.boardOffsetY=0;this.boardOffsetX=0;
    this.tiltAngle=0;this.tiltTarget=0;this.shakePower=0;
    // 壁バウンス: 押し込み中は繰り返さない
    this.wallBumpX=0;this._wallBumpActive=false;
    this.particles=[];this.projectiles=[];this.floatLabels=[];
    this.comboLabel=null;this.attackLabel=null;this._attackAccum=0;
    this.opBoardData={};this._flashAlpha=0;
    this._gameOverTick=null;
    this.root=new PIXI.Container();app.stage.addChild(this.root);
    this.buildLayout();this.createBg();
    this.buildOpponentBoards();this.buildMainBoard();this.buildSideUI();
    this.effectsLayer=new PIXI.Container();app.stage.addChild(this.effectsLayer);
    this.projLayer=new PIXI.Container();app.stage.addChild(this.projLayer);
  }

  buildLayout(){
    this.mainBX=this.W/2-BOARD_W/2-30;
    this.mainBY=(this.H-(BOARD_H+ABOVE_BOARD))/2+ABOVE_BOARD;
  }

  createBg(){
    this.bgLayer=new PIXI.Container();this.root.addChild(this.bgLayer);
    if(settings.quality!=='low'){
      const g=new PIXI.Graphics();g.lineStyle(0.5,0x001133,0.18);
      for(let x=0;x<this.W;x+=40){g.moveTo(x,0);g.lineTo(x,this.H);}
      this.bgLayer.addChild(g);
    }
  }

  buildOpponentBoards(){
    const oCell=12,oBW=COLS*oCell;
    const showAbove=2,oBH=(ROWS+showAbove)*oCell;
    this.opponentPlayers.forEach((p,i)=>{
      const bx=i===0?(this.mainBX+BOARD_W+90):(this.mainBX-oBW-90);
      const by=this.H/2-oBH/2;
      const cont=new PIXI.Container();cont.x=bx;cont.y=by;this.root.addChild(cont);
      const bg=new PIXI.Graphics();
      bg.beginFill(0x000010,0.9);bg.drawRect(0,0,oBW,oBH);bg.endFill();
      bg.lineStyle(1,0x00f5ff,0.2);bg.drawRect(0,0,oBW,oBH);
      cont.addChild(bg);
      const nst=new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:10,fill:0x00f5ff,letterSpacing:2});
      const ntxt=new PIXI.Text(p.name.toUpperCase(),nst);ntxt.x=0;ntxt.y=-16;cont.addChild(ntxt);
      const boardGfx=new PIXI.Graphics();cont.addChild(boardGfx);
      // 相手NEXT (右側に小さく表示)
      const nextGfx=[];
      for(let j=0;j<3;j++){const ng=new PIXI.Graphics();ng.x=oBW+4;ng.y=j*30;cont.addChild(ng);nextGfx.push(ng);}
      const sst=new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:9,fill:0x666666});
      const stxt=new PIXI.Text('0000000',sst);stxt.x=0;stxt.y=oBH+4;cont.addChild(stxt);
      this.opBoardData[p.id]={
        cont,boardGfx,scoreTxt:stxt,nextGfx,cell:oCell,origX:bx,origY:by,
        board:null,currentPiece:null,nextPieces:null,
        shakeX:0,shakeY:0,tilt:0,tiltTarget:0,dead:false,
        boardW:oBW,boardH:oBH,showAbove,
        // ゲームオーバーアニメ用
        gameOverTick:null,origXcenter:bx+oBW/2,origYcenter:by+oBH/2
      };
    });
  }

  buildMainBoard(){
    this.boardWrap=new PIXI.Container();
    this.boardWrap.x=this.mainBX+BOARD_W/2;
    this.boardWrap.y=this.mainBY+BOARD_H/2;
    this.root.addChild(this.boardWrap);
    this.boardCont=new PIXI.Container();
    this.boardCont.pivot.set(BOARD_W/2,BOARD_H/2);
    this.boardWrap.addChild(this.boardCont);
    const aboveBg=new PIXI.Graphics();
    // 上部エリアは透明（ミノが隠れないようにbgなし）
    aboveBg.lineStyle(0.4,0x001133,0.08);
    for(let c=0;c<=COLS;c++){aboveBg.moveTo(c*CELL,-ABOVE_BOARD);aboveBg.lineTo(c*CELL,0);}
    this.boardCont.addChild(aboveBg);
    const bg=new PIXI.Graphics();
    bg.beginFill(0x000010,0.95);bg.drawRect(0,0,BOARD_W,BOARD_H);bg.endFill();
    // ボード全体のグリッド線（1ブロック間隔）
    bg.lineStyle(0.5,0x0a2a4a,0.85);
    for(let c=0;c<=COLS;c++){bg.moveTo(c*CELL,0);bg.lineTo(c*CELL,BOARD_H);}
    for(let r=0;r<=ROWS;r++){bg.moveTo(0,r*CELL);bg.lineTo(BOARD_W,r*CELL);}
    this.boardCont.addChild(bg);
    this.boardBorder=new PIXI.Graphics();
    this.boardBorder.lineStyle(2,0x00f5ff,0.8);
    this.boardBorder.drawRect(-2,-ABOVE_BOARD,BOARD_W+4,BOARD_H+ABOVE_BOARD+4);
    this.boardCont.addChild(this.boardBorder);
    this.boardGfx=new PIXI.Graphics();this.boardCont.addChild(this.boardGfx);
    this.ghostGfx=new PIXI.Graphics();this.boardCont.addChild(this.ghostGfx);
    this.currentGfx=new PIXI.Graphics();this.boardCont.addChild(this.currentGfx);
    this.flashGfx=new PIXI.Graphics();this.flashGfx.alpha=0;this.boardCont.addChild(this.flashGfx);
    this.gMeterCont=new PIXI.Container();
    this.gMeterCont.x=-BOARD_W/2-16;this.gMeterCont.y=-BOARD_H/2;
    this.boardWrap.addChild(this.gMeterCont);
    this.gMeterGfx=new PIXI.Graphics();this.gMeterCont.addChild(this.gMeterGfx);
  }

  buildSideUI(){
    const px=this.mainBX+BOARD_W+12,py=this.mainBY;
    this.uiCont=new PIXI.Container();this.uiCont.x=px;this.uiCont.y=py;this.root.addChild(this.uiCont);
    const lbl=(t,x,y,col=0x888888)=>Object.assign(new PIXI.Text(t,new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:11,fill:col,letterSpacing:3})),{x,y});
    this.uiCont.addChild(lbl('SCORE',0,0));
    // スコア文字色: 白
    this.scoreTxt=Object.assign(new PIXI.Text('0000000',new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:19,fill:0xffffff,fontWeight:'700'})),{x:0,y:14});
    this.uiCont.addChild(this.scoreTxt);
    this.uiCont.addChild(lbl('LINES',0,48));
    this.linesTxt=Object.assign(new PIXI.Text('0',new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:14,fill:0xffbe0b})),{x:0,y:62});this.uiCont.addChild(this.linesTxt);
    this.uiCont.addChild(lbl('LEVEL',0,90));
    this.levelTxt=Object.assign(new PIXI.Text('1',new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:14,fill:0xffbe0b})),{x:0,y:104});this.uiCont.addChild(this.levelTxt);
    // NEXT
    this.nextCont=new PIXI.Container();this.nextCont.x=px;this.nextCont.y=py+145;this.root.addChild(this.nextCont);
    this.nextCont.addChild(lbl('NEXT',0,0));
    this.nextGfx=[];for(let i=0;i<5;i++){const g=new PIXI.Graphics();g.y=18+i*50;this.nextCont.addChild(g);this.nextGfx.push(g);}
    // HOLD
    this.holdCont=new PIXI.Container();this.holdCont.x=this.mainBX-90;this.holdCont.y=this.mainBY;this.root.addChild(this.holdCont);
    this.holdCont.addChild(lbl('HOLD',0,0));
    this.holdGfx=new PIXI.Graphics();this.holdGfx.y=18;this.holdCont.addChild(this.holdGfx);
    const n=Object.assign(new PIXI.Text((this.myPlayer?this.myPlayer.name:'').toUpperCase(),new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:12,fill:0x00f5ff,letterSpacing:3})),{x:this.mainBX,y:this.mainBY-22});
    this.root.addChild(n);
  }

  drawCell(gfx,x,y,size,type,alpha=1){
    const color=PIECE_COLORS[type]||0x334455,s=size-1;
    gfx.beginFill(color,alpha);gfx.drawRect(x+1,y+1,s-1,s-1);gfx.endFill();
    gfx.beginFill(0xffffff,alpha*0.35);gfx.drawRect(x+1,y+1,s-1,3);gfx.drawRect(x+1,y+1,3,s-1);gfx.endFill();
    gfx.beginFill(0x000000,alpha*0.4);gfx.drawRect(x+1,y+s-2,s-1,2);gfx.drawRect(x+s-2,y+1,2,s-1);gfx.endFill();
    if(settings.quality!=='low'){gfx.lineStyle(1,color,alpha*0.45);gfx.drawRect(x+1,y+1,s-1,s-1);gfx.lineStyle(0);}
  }

  drawBoard(){
    const g=this.boardGfx;g.clear();
    for(let r=0;r<ROWS+HIDDEN;r++)for(let c=0;c<COLS;c++){
      const v=this.gs.board[r][c];if(!v)continue;
      const dy=(r-HIDDEN)*CELL;
      this.drawCell(g,c*CELL,dy,CELL,v,r<HIDDEN?0.55:1);
    }
  }

  drawGhost(){
    const g=this.ghostGfx;g.clear();const gs=this.gs;if(!gs.current)return;
    const gy=gs.ghostY();
    if(gy===gs.current.y)return; // ミノと同じ位置なら非表示
    const shape=gs.getShape(gs.current.type,gs.current.rotation);
    const cellAlpha=0.18; // 薄いグリッドのみ
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;
      const dr=gy+r-HIDDEN;
      const cx=(gs.current.x+c)*CELL,cy=dr*CELL,s=CELL-1;
      // 薄い灰色の枠線のみ（塗りなし）
      g.lineStyle(1,0x888888,cellAlpha*2);
      g.beginFill(0x888888,cellAlpha);
      g.drawRect(cx+1,cy+1,s-1,s-1);
      g.endFill();
      g.lineStyle(0);
    }
  }

  drawCurrent(){
    const g=this.currentGfx;g.clear();const gs=this.gs;if(!gs.current)return;
    const shape=gs.getShape(gs.current.type,gs.current.rotation);
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;const dr=gs.current.y+r-HIDDEN;
      this.drawCell(g,(gs.current.x+c)*CELL,dr*CELL,CELL,gs.current.type,dr<0?0.75:1);
    }
  }

  drawNextPieces(){
    const mc=14;
    this.nextGfx.forEach((gfx,i)=>{
      gfx.clear();const type=this.gs.nextQueue[i];if(!type)return;
      const shape=PIECE_SHAPES[type][0],a=i===0?1:Math.max(0.3,0.85-i*0.15);
      for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++)if(shape[r][c])this.drawCell(gfx,c*mc,r*mc,mc,type,a);
    });
  }

  drawHold(){
    const g=this.holdGfx;g.clear();const type=this.gs.holdPiece;if(!type)return;
    const mc=14,shape=PIECE_SHAPES[type][0],a=this.gs.holdUsed?0.3:1;
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++)if(shape[r][c])this.drawCell(g,c*mc,r*mc,mc,type,a);
  }

  drawOpponentBoard(pid){
    const d=this.opBoardData[pid];if(!d||d.dead)return;
    const g=d.boardGfx;g.clear();const cell=d.cell;
    const {boardW:oBW,boardH:oBH,showAbove}=d;
    if(!d.board){g.beginFill(0x000010,0.5);g.drawRect(0,0,oBW,oBH);g.endFill();}
    else{
      const offset=d.board.length>ROWS?HIDDEN:0;
      for(let r=-showAbove;r<ROWS;r++){
        const row=d.board[r+offset];if(!row)continue;
        for(let c=0;c<COLS;c++){
          const v=row[c];if(!v)continue;
          const dy=(r+showAbove)*cell;
          this.drawCell(g,c*cell,dy,cell,v,r<0?0.4:1);
        }
      }
      // 相手の現在操作中のミノ
      if(d.currentPiece){
        const cp=d.currentPiece;
        const shapes=PIECE_SHAPES[cp.type];if(shapes){
          const shape=shapes[((cp.rotation%4)+4)%4];
          for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
            if(!shape[r][c])continue;
            const dr=cp.y+r-HIDDEN;
            const dy=(dr+showAbove)*cell;
            if(dy<-(cell*2)||dy>=oBH)continue;
            this.drawCell(g,(cp.x+c)*cell,dy,cell,cp.type,dr<0?0.5:1);
          }
        }
      }
    }
    // 相手NEXT
    if(d.nextPieces&&d.nextGfx){
      const mc=8;
      d.nextGfx.forEach((ng,i)=>{
        ng.clear();const type=d.nextPieces[i];if(!type)return;
        const shape=PIECE_SHAPES[type][0],a=i===0?0.9:0.5;
        for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++)if(shape[r][c])this.drawCell(ng,c*mc,r*mc,mc,type,a);
      });
    }
    // 傾き・シェイク
    d.tilt+=(d.tiltTarget-d.tilt)*0.15;
    d.shakeX*=0.82;d.shakeY*=0.82;
    if(Math.abs(d.shakeX)<0.1)d.shakeX=0;if(Math.abs(d.shakeY)<0.1)d.shakeY=0;
    if(!d.gameOverTick){
      d.cont.rotation=d.tilt;
      d.cont.pivot.set(oBW/2,oBH/2);
      d.cont.x=d.origX+oBW/2+d.shakeX;
      d.cont.y=d.origY+oBH/2+d.shakeY;
    }
  }

  drawGarbageMeter(){
    const g=this.gMeterGfx;g.clear();
    const queue=this.gs.garbageQueue;if(!queue.length){this._prevReadyCount=0;return;}
    const now=performance.now();
    g.beginFill(0x111122,0.5);g.drawRect(0,0,10,BOARD_H);g.endFill();
    let y=BOARD_H;
    let readyCount=0;
    let readyLines=0;
    for(const item of queue){
      const h=Math.min(item.lines*(CELL*0.85),y);y-=h;
      const pct=Math.max(0,(item.readyAt-now)/3000);
      const col=pct>0.5?0xffbe0b:pct>0.2?0xff8500:0xff006e;
      g.beginFill(col,0.85);g.drawRect(0,y,10,h);g.endFill();
      if(pct<=0){
        const pulse=0.5+0.5*Math.abs(Math.sin(now*0.008));
        g.lineStyle(2,0xff006e,pulse);g.drawRect(0,y,10,h);g.lineStyle(0);
        readyCount++;readyLines+=item.lines;
      }
    }
    // readyCountが増えた瞬間だけワンショット揺れ
    if(readyCount>(this._prevReadyCount||0)&&settings.shake==='on'){
      const amp=Math.min(6+readyLines*0.7,14);
      this.wallBumpX=amp*(Math.random()>0.5?1:-1);
      setTimeout(()=>{this.wallBumpX*=-0.6;},60);
    }
    this._prevReadyCount=readyCount;
  }

  updateScoreUI(){
    this.scoreTxt.text=this.gs.score.toString().padStart(7,'0');
    this.linesTxt.text=this.gs.lines.toString();
    this.levelTxt.text=this.gs.level.toString();
  }

  // スピン確定時のみ傾く
  onSpinTilt(dir){
    if(settings.tilt!=='on')return;
    this.tiltTarget=dir>0?0.065:-0.065;
    setTimeout(()=>{this.tiltTarget=0;},350);
  }

  // 回転した瞬間のスピンキラキラ（小さめ・控えめ）
  onSpinRotateSparkle(piece,spinType){
    if(settings.particles==='off')return;
    const color=PIECE_COLORS[piece.type]||0xffffff;
    // Tスピンは紫系アクセント、他は自色
    const sparkColor=piece.type==='T'?0xee88ff:color;
    const shape=this.gs.getShape(piece.type,piece.rotation);
    const n=settings.particles==='high'?4:2;
    const isMini=spinType&&spinType.startsWith('MINI');
    // miniは更に少なく
    const count=isMini?Math.max(1,n-1):n;
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;
      const dr=piece.y+r-HIDDEN;
      const px=this.mainBX+(piece.x+c)*CELL+CELL/2;
      const py=this.mainBY+dr*CELL+CELL/2;
      for(let i=0;i<count;i++){
        const g=new PIXI.Graphics();
        // 星形と小円を混ぜる
        const sz=Math.random()*1.8+0.6;
        if(i%2===0){
          // 小さいひし形（星っぽく）
          g.beginFill(sparkColor,0.9);
          g.moveTo(0,-sz*2);g.lineTo(sz*0.6,0);g.lineTo(0,sz*2);g.lineTo(-sz*0.6,0);
          g.closePath();g.endFill();
        } else {
          g.beginFill(sparkColor,0.85);g.drawCircle(0,0,sz);g.endFill();
        }
        g.x=px+(Math.random()-0.5)*CELL*0.9;
        g.y=py+(Math.random()-0.5)*CELL*0.9;
        this.effectsLayer.addChild(g);
        const angle=Math.random()*Math.PI*2;
        const speed=Math.random()*2.2+0.8;
        this.particles.push({
          gfx:g,
          vx:Math.cos(angle)*speed,
          vy:Math.sin(angle)*speed-1.2,
          life:0.85,
          decay:0.045+Math.random()*0.025
        });
      }
    }
  }

  // 壁バウンス: 押し込み中は繰り返さない
  onWallBump(dx){
    if(this._wallBumpActive)return;
    this._wallBumpActive=true;
    const bumpAmt=dx>0?6:-6;
    this.wallBumpX=bumpAmt;
    // バウンス復帰後にフラグ解除
    setTimeout(()=>{this.wallBumpX=0;setTimeout(()=>{this._wallBumpActive=false;},50);},130);
  }

  onHardDrop(dropped){
    const depth=Math.min(16,Math.floor(dropped*0.48)+4); // 0.8倍
    this.boardOffsetY=Math.max(this.boardOffsetY,depth);
    if(settings.particles!=='off'){
      const gs=this.gs;const gy=gs.ghostY();
      const shape=gs.getShape(gs.current.type,gs.current.rotation);
      for(let c=0;c<shape[0].length;c++){
        if(shape[shape.length-1]?.[c]){
          const px=this.mainBX+(gs.current.x+c)*CELL+CELL/2;
          const py=this.mainBY+(gy+shape.length-1-HIDDEN)*CELL+CELL;
          const col=PIECE_COLORS[gs.current.type]||0xffffff;
          for(let i=0;i<10;i++)this.spawnParticle(px,py,col,true);
        }
      }
    }
  }

  // spin確定時: ミノ位置に控えめなキラキラを表示
  onSpinSparkle(lockX,lockY,pieceType){
    if(settings.particles==='off')return;
    const color=PIECE_COLORS[pieceType]||0xffffff;
    const shape=PIECE_SHAPES[pieceType][0];
    const n=settings.particles==='high'?5:3;
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;
      const dr=lockY+r-HIDDEN;if(dr<0)continue;
      const px=this.mainBX+(lockX+c)*CELL+CELL/2;
      const py=this.mainBY+dr*CELL+CELL/2;
      for(let i=0;i<n;i++){
        const g=new PIXI.Graphics();
        const sz=Math.random()*2+0.8; // 小さく
        g.beginFill(color,0.85);g.drawCircle(0,0,sz);g.endFill();
        g.x=px+(Math.random()-0.5)*CELL*0.8;
        g.y=py+(Math.random()-0.5)*CELL*0.8;
        this.effectsLayer.addChild(g);
        const angle=Math.random()*Math.PI*2;
        const speed=Math.random()*2.5+0.5;
        this.particles.push({gfx:g,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-1.5,life:0.9,decay:0.032+Math.random()*0.02});
      }
    }
  }

  endComboLabel(){if(this.comboLabel){this.comboLabel.end();this.comboLabel=null;}}

  _getClearRowsCenterY(cleared){
    if(!cleared||!cleared.length)return this.mainBY+BOARD_H*0.5;
    const avgRow=cleared.reduce((a,b)=>a+b,0)/cleared.length;
    return this.mainBY+(avgRow-HIDDEN)*CELL+CELL/2;
  }

  onLineClear(cleared,count,spinType,isB2B,combo,ren,allClear,attack){
    this.flashGfx.clear();this._flashAlpha=1;
    cleared.forEach(r=>{const dr=r-HIDDEN;if(dr<0)return;this.flashGfx.beginFill(0xffffff,0.9);this.flashGfx.drawRect(0,dr*CELL,BOARD_W,CELL);this.flashGfx.endFill();});
    if(settings.shake==='on')this.shakePower=Math.min(16,count*3+(spinType?5:0)+(allClear?12:0));
    if(count>=4||allClear)this.boardOffsetY=Math.max(this.boardOffsetY,24);
    else if(count>=2)this.boardOffsetY=Math.max(this.boardOffsetY,10);
    if(settings.tilt==='on'&&spinType&&spinType!=='MINI_TSPIN'){
      this.tiltTarget=spinType.startsWith('T')?0.07:-0.07;
      setTimeout(()=>{this.tiltTarget=0;},350);
    }
    if(settings.particles!=='off'){
      cleared.forEach(r=>{
        const dr=r-HIDDEN;if(dr<0)return;
        const n=settings.particles==='high'?14:5;
        for(let c=0;c<COLS;c++){
          const col=PIECE_COLORS[this.gs.board[r]?.[c]]||0xffffff;
          for(let i=0;i<n;i++)this.spawnParticle(this.mainBX+c*CELL+CELL/2,this.mainBY+dr*CELL+CELL/2,col);
        }
        for(let i=0;i<25;i++)this.spawnParticle(this.mainBX+BOARD_W/2,this.mainBY+dr*CELL+CELL/2,0xffffff,false,true);
      });
    }

    const lx=this.mainBX+BOARD_W+18;let ly=this.mainBY+BOARD_H*0.25;
    let lbl='';
    if(spinType){
      if(spinType==='TSPIN')lbl={0:'T-SPIN',1:'T-SPIN SINGLE',2:'T-SPIN DOUBLE',3:'T-SPIN TRIPLE'}[count]||'T-SPIN';
      else if(spinType==='MINI_TSPIN')lbl='MINI T-SPIN';
      else lbl=spinType.replace('SPIN',' SPIN');
    }
    if(count===4&&!spinType)lbl='TETRIS';
    if(allClear)lbl='★ ALL CLEAR ★';
    if(isB2B&&lbl)lbl='B2B '+lbl;
    if(ren>2)lbl+=(lbl?' │ ':'')+`REN ${ren}`;
    if(lbl){
      const col=allClear?0xffff44:isB2B?0xffbe0b:spinType?0xff44ff:0x00f5ff;
      this.floatLabels.push(new FloatLabel(this.app,lx,ly,lbl,col,false));ly+=38;
    }
    if(combo>0){
      if(!this.comboLabel||!this.comboLabel.alive){
        this.comboLabel=new FloatLabel(this.app,lx,ly,`COMBO ×${combo}`,0x06d6a0,true);
        this.floatLabels.push(this.comboLabel);
      } else {
        this.comboLabel.updateText(`COMBO ×${combo}`);
        this.comboLabel.baseY=ly;this.comboLabel.txt.y=ly;
      }
      ly+=38;
    } else {this.endComboLabel();}
    if(attack>0&&count>1){
      this._attackAccum+=attack;
      if(!this.attackLabel||!this.attackLabel.alive){
        this._attackAccum=attack;
        this.attackLabel=new FloatLabel(this.app,lx,this.mainBY+BOARD_H*0.6,`⚔ +${this._attackAccum}`,0xff6060,false);
        this.attackLabel._fadeDelay=2800;this.floatLabels.push(this.attackLabel);
      } else {this.attackLabel.updateText(`⚔ +${this._attackAccum}`);this.attackLabel._timer=0;}
      clearTimeout(this._attackAccumTimer);
      this._attackAccumTimer=setTimeout(()=>{this._attackAccum=0;},3500);
    }
    if(attack>0){
      const launchY=this._getClearRowsCenterY(cleared);
      this.opponentPlayers.forEach(op=>{
        if(this.opBoardData[op.id]&&!this.opBoardData[op.id].dead)
          this.onAttackProjectile(op.id,attack,launchY);
      });
    }
  }

  // おじゃまグループ追加時のシェイク（行数に応じた振動）
  onGarbageRowAdded(count=1){
    if(settings.shake==='on'){
      const power=Math.min(8,3+count*1.5);
      this.shakePower=Math.max(this.shakePower,power);
      // 振動: 短いパルスを追加で与える
      clearTimeout(this._garbageShakePulse);
      this._garbageShakePulse=setTimeout(()=>{
        this.shakePower=Math.max(this.shakePower,power*0.6);
      },60);
    }
    this.boardBorder.tint=0xff3333;
    setTimeout(()=>{if(this.boardBorder)this.boardBorder.tint=0xffffff;},200);
  }

  onGarbageIncoming(lines,fromId){
    const d=this.opBoardData[fromId];if(!d)return;
    const sx=d.origX+(COLS*d.cell)/2,sy=d.origY+(d.boardH||ROWS*d.cell)/2;
    const tx=this.mainBX-8,ty=this.mainBY+BOARD_H*0.5;
    this.spawnProjectile(sx,sy,tx,ty,0xff3333,lines);
  }

  onAttackProjectile(targetId,attack,launchY){
    const d=this.opBoardData[targetId];if(!d)return;
    const sx=this.mainBX+BOARD_W/2;
    const sy=launchY!==undefined?launchY:this.mainBY+BOARD_H*0.5;
    const tx=d.origX+(COLS*d.cell)/2,ty=d.origY+(d.boardH||ROWS*d.cell)/2;
    this.spawnProjectile(sx,sy,tx,ty,0x00f5ff,attack);
    SFX.attack();
  }

  onGarbageApplied(lines){
    // シェイクはonGarbageRowAddedで行う
  }

  // 自分のゲームオーバー: 横揺れ→斜め落下
  onGameOver(){
    SFX.gameover();
    const wrap=this.boardWrap;
    const origX=this.mainBX+BOARD_W/2;
    const origY=this.mainBY+BOARD_H/2;
    let phase='shake',t=0;
    const shakeDur=800,shakeAmp=22;
    const fallVX=(Math.random()>0.5?1:-1)*2.5;
    let vx=fallVX,vy=0,curX=origX,curY=origY;
    this._gameOverTick=(dt)=>{
      t+=dt/ANIM_SPEED;
      if(phase==='shake'){
        const prog=t/shakeDur,decay=1-prog;
        wrap.x=origX+Math.sin(prog*Math.PI*8)*shakeAmp*decay;
        wrap.y=origY+Math.sin(prog*Math.PI*12)*shakeAmp*0.3*decay;
        if(t>=shakeDur){phase='fall';t=0;curX=wrap.x;curY=wrap.y;vx=fallVX;vy=0;}
      } else {
        vx*=0.995;vy+=0.6;curX+=vx;curY+=vy;
        wrap.x=curX;wrap.y=curY;wrap.rotation+=0.018;
        wrap.alpha=Math.max(0,1-(curY-origY)/500);
      }
    };
  }

  // 相手のゲームオーバー: 横揺れ→斜め落下
  opponentGameOver(pid){
    const d=this.opBoardData[pid];if(!d||d.dead)return;
    d.dead=true;
    const {oBW:bw,oBH:bh}=d;
    const oBW=d.boardW,oBH=d.boardH;
    const origX=d.origX+oBW/2,origY=d.origY+oBH/2;
    let phase='shake',t=0;
    const shakeDur=600,shakeAmp=14;
    const fallVX=(Math.random()>0.5?1:-1)*2;
    let vx=fallVX,vy=0,curX=origX,curY=origY;
    d.cont.pivot.set(oBW/2,oBH/2);
    d.gameOverTick=(dt)=>{
      t+=dt/ANIM_SPEED;
      if(phase==='shake'){
        const prog=t/shakeDur,decay=1-prog;
        d.cont.x=origX+Math.sin(prog*Math.PI*8)*shakeAmp*decay;
        d.cont.y=origY+Math.sin(prog*Math.PI*10)*shakeAmp*0.3*decay;
        if(t>=shakeDur){phase='fall';t=0;vx=fallVX;vy=0;}
      } else {
        vx*=0.995;vy+=0.5;curX+=vx;curY+=vy;
        d.cont.x=curX;d.cont.y=curY;
        d.cont.rotation+=0.015;
        d.cont.alpha=Math.max(0,1-(curY-origY)/400);
      }
    };
    // ELIMINATEDテキスト
    const elim=new PIXI.Text('ELIMINATED',new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:11,fill:0xff006e,fontWeight:'900',letterSpacing:2}));
    elim.anchor.set(0.5);
    elim.x=origX;elim.y=origY;
    this.app.stage.addChild(elim);
  }

  triggerOpponentSpin(pid,spinType){
    const d=this.opBoardData[pid];if(!d||d.dead)return;
    const isTSpin=spinType&&spinType.startsWith('T');
    if(!isTSpin&&!spinType)return;
    d.tiltTarget=isTSpin?0.08:-0.06;
    d.shakeX=(Math.random()-0.5)*10;d.shakeY=(Math.random()-0.5)*5;
    setTimeout(()=>{if(d)d.tiltTarget=0;},400);
  }

  updateBoardAnim(dt){
    if(this.boardOffsetY>0){this.boardOffsetY*=0.72;if(this.boardOffsetY<0.3)this.boardOffsetY=0;}
    this.tiltAngle+=(this.tiltTarget-this.tiltAngle)*0.14;
    if(Math.abs(this.tiltAngle)<0.0005&&Math.abs(this.tiltTarget)<0.0005)this.tiltAngle=0;
    if(settings.tilt==='on')this.boardCont.rotation=this.tiltAngle;else this.boardCont.rotation=0;
    if(this.shakePower>0){
      this.boardOffsetX=(Math.random()-0.5)*this.shakePower*2;
      this.shakePower*=0.8;
      if(this.shakePower<0.2){this.shakePower=0;this.boardOffsetX=0;}
    }
    // 壁バウンスは滑らかに戻す
    this.wallBumpX*=0.7;
    if(Math.abs(this.wallBumpX)<0.2)this.wallBumpX=0;

    if(this._gameOverTick){
      this._gameOverTick(dt);
    } else {
      this.boardWrap.x=this.mainBX+BOARD_W/2+this.boardOffsetX+this.wallBumpX;
      this.boardWrap.y=this.mainBY+BOARD_H/2+this.boardOffsetY;
    }
    // 相手のゲームオーバーアニメ
    for(const pid of Object.keys(this.opBoardData)){
      const d=this.opBoardData[pid];
      if(d.gameOverTick)d.gameOverTick(dt);
    }
    if(this._flashAlpha>0){this._flashAlpha-=0.06;this.flashGfx.alpha=Math.max(0,this._flashAlpha);}
  }

  spawnParticle(x,y,color,downward=false,burst=false){
    const g=new PIXI.Graphics();
    const sz=burst?(Math.random()*3+1.5):(Math.random()*5+2);
    g.beginFill(color,1);
    if(burst)g.drawCircle(0,0,sz);else g.drawRect(-sz/2,-sz/2,sz,sz);
    g.endFill();
    g.x=x+(Math.random()-0.5)*CELL;g.y=y+(Math.random()-0.5)*CELL;
    this.effectsLayer.addChild(g);
    const a=downward?(Math.PI*0.8+Math.random()*Math.PI*0.4):(Math.random()*Math.PI*2);
    const sp=burst?(Math.random()*10+3):(Math.random()*8+2);
    this.particles.push({gfx:g,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-(downward?0:3),life:1,decay:0.022+Math.random()*0.028});
  }

  spawnProjectile(sx,sy,tx,ty,color,power){
    const cont=new PIXI.Container();cont.x=sx;cont.y=sy;this.projLayer.addChild(cont);
    const r=4+Math.min(power*0.9,12);
    const glow=new PIXI.Graphics();glow.lineStyle(4,color,0.35);glow.drawCircle(0,0,r*2.2);cont.addChild(glow);
    const ring=new PIXI.Graphics();ring.lineStyle(2,0xffffff,0.5);ring.drawCircle(0,0,r*1.3);cont.addChild(ring);
    const core=new PIXI.Graphics();core.beginFill(color,1);core.drawCircle(0,0,r);core.endFill();
    core.beginFill(0xffffff,0.85);core.drawCircle(-r*0.28,-r*0.28,r*0.42);core.endFill();
    cont.addChild(core);
    if(power>=2){
      const pt=new PIXI.Text(power.toString(),new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:10,fill:0xffffff,fontWeight:'900'}));
      pt.anchor.set(0.5);cont.addChild(pt);
    }
    const dx=tx-sx,dy=ty-sy,dist=Math.sqrt(dx*dx+dy*dy);
    const mx=(sx+tx)/2,my=(sy+ty)/2-Math.min(180,dist*0.45);
    const frames=Math.round(55+Math.random()*10);
    this.projectiles.push({cont,glow,ring,sx,sy,tx,ty,mx,my,color,frames,f:0,power,r});
  }

  updateParticlesEtc(dt){
    this.particles=this.particles.filter(p=>{
      p.gfx.x+=p.vx;p.gfx.y+=p.vy;p.vy+=0.28;p.life-=p.decay;p.gfx.alpha=p.life;
      if(p.life<=0){try{p.gfx.destroy();}catch(e){}return false;}return true;
    });
    this.floatLabels=this.floatLabels.filter(fl=>{fl.update(dt);return fl.alive;});
    this.projectiles=this.projectiles.filter(p=>{
      p.f++;
      const t=p.f/p.frames;
      // ease in-out cubic
      const te=t<0.5?4*t*t*t:(t-1)*(2*t-2)*(2*t-2)+1;
      const bx=(1-te)*(1-te)*p.sx+2*(1-te)*te*p.mx+te*te*p.tx;
      const by=(1-te)*(1-te)*p.sy+2*(1-te)*te*p.my+te*te*p.ty;
      p.cont.x=bx;p.cont.y=by;
      p.cont.rotation+=0.12; // 1.2倍
      const sc=1+0.14*Math.sin(p.f*0.35);
      p.cont.scale.set(sc);
      p.glow.alpha=0.25+0.3*Math.sin(p.f*0.45);
      p.ring.alpha=0.4+0.3*Math.cos(p.f*0.3);
      if(p.f%2===0&&settings.particles!=='off'){
        const tg=new PIXI.Graphics();tg.beginFill(p.color,0.6);tg.drawCircle(0,0,p.r*0.5*(1-t*0.5));tg.endFill();
        tg.x=bx+(Math.random()-0.5)*4;tg.y=by+(Math.random()-0.5)*4;
        this.effectsLayer.addChild(tg);
        this.particles.push({gfx:tg,vx:(Math.random()-0.5)*1.5,vy:(Math.random()-0.5)*1.5,life:0.65,decay:0.06});
      }
      if(p.f>=p.frames){
        const n=settings.particles==='high'?28:12;
        for(let i=0;i<n;i++){
          const g=new PIXI.Graphics();g.beginFill(p.color,1);
          const sz=Math.random()*4+1.5;
          if(i%3===0)g.drawCircle(0,0,sz);else g.drawRect(-sz/2,-sz/2,sz,sz);
          g.endFill();g.x=p.tx+(Math.random()-0.5)*10;g.y=p.ty+(Math.random()-0.5)*10;
          this.effectsLayer.addChild(g);
          const a=Math.random()*Math.PI*2,sp=Math.random()*10+4;
          this.particles.push({gfx:g,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:1,decay:0.048+Math.random()*0.04});
        }
        if(settings.quality!=='low'){
          const sw=new PIXI.Graphics();sw.lineStyle(3,p.color,0.9);sw.drawCircle(0,0,6);
          sw.x=p.tx;sw.y=p.ty;this.effectsLayer.addChild(sw);
          let sr=6,sa=0.9;
          const swT=()=>{sr+=5;sa-=0.055;sw.clear();sw.lineStyle(3,p.color,sa);sw.drawCircle(0,0,sr);
            if(sa>0)requestAnimationFrame(swT);else try{sw.destroy();}catch(e){}};
          requestAnimationFrame(swT);
        }
        try{p.cont.destroy({children:true});}catch(e){}return false;
      }
      return true;
    });
  }

  update(dt){
    this.drawBoard();this.drawGhost();this.drawCurrent();
    this.drawNextPieces();this.drawHold();
    this.updateScoreUI();
    this.updateBoardAnim(dt);
    this.opponentPlayers.forEach(p=>this.drawOpponentBoard(p.id));
    this.drawGarbageMeter();
    this.updateParticlesEtc(dt);
  }
}

// ---- Input ----
let das=null,arr=null,softDropTimer=null,keyState={};
function setupInput(){document.addEventListener('keydown',handleKeyDown);document.addEventListener('keyup',handleKeyUp);}
function removeInput(){document.removeEventListener('keydown',handleKeyDown);document.removeEventListener('keyup',handleKeyUp);}
function handleKeyDown(e){
  if(!gameState||!gameState.alive)return;
  if(document.getElementById('chat-input')===document.activeElement)return;
  if(keyState[e.code])return;
  keyState[e.code]=true;
  switch(e.code){
    case 'ArrowLeft':gameState.move(-1);startDAS(-1);break;
    case 'ArrowRight':gameState.move(1);startDAS(1);break;
    case 'ArrowUp':case 'KeyX':gameState.rotate(1);break;
    case 'KeyZ':gameState.rotate(-1);break;
    case 'ArrowDown':startSoftDrop();break;
    case 'Space':e.preventDefault();gameState.hardDrop();break;
    case 'ShiftLeft':case 'ShiftRight':case 'KeyC':gameState.hold();break;
  }
}
function handleKeyUp(e){
  keyState[e.code]=false;
  if(e.code==='ArrowLeft'||e.code==='ArrowRight'){
    stopDAS();
    if(renderer)renderer._wallBumpActive=false;
  }
  if(e.code==='ArrowDown')stopSoftDrop();
}
function startDAS(dir){
  stopDAS();
  das=setTimeout(()=>{
    arr=setInterval(()=>{
      if(!gameState||!gameState.alive){stopDAS();return;}
      gameState.move(dir);
    },20);
  },133);
}
function stopDAS(){if(das){clearTimeout(das);das=null;}if(arr){clearInterval(arr);arr=null;}}
function startSoftDrop(){stopSoftDrop();if(!gameState||!gameState.alive)return;gameState.softDrop();softDropTimer=setInterval(()=>{if(!gameState||!gameState.alive){stopSoftDrop();return;}gameState.softDrop();},50);}
function stopSoftDrop(){if(softDropTimer){clearInterval(softDropTimer);softDropTimer=null;}}

// ---- Multiplayer ----
socket.on('opponent_update',({id,board,score,lines,level,currentPiece,nextPieces,holdPiece})=>{
  if(!renderer)return;
  const d=renderer.opBoardData[id];if(!d)return;
  d.board=board;
  d.currentPiece=currentPiece;
  if(nextPieces)d.nextPieces=nextPieces;
  const p=renderer.players.find(pl=>pl.id===id);
  if(p){p.score=score;p.lines=lines;p.level=level;}
  if(d.scoreTxt)d.scoreTxt.text=(score||0).toString().padStart(7,'0');
});

// 現在ミノのリアルタイム位置更新
socket.on('opponent_piece_update',({id,currentPiece})=>{
  if(!renderer)return;
  const d=renderer.opBoardData[id];if(!d)return;
  d.currentPiece=currentPiece;
});

socket.on('receive_garbage',({lines,fromId})=>{
  if(!gameState)return;
  gameState.queueGarbage(lines,fromId);
});

socket.on('player_dead',({id,name})=>{
  addChatSystem(`💀 ${name} eliminated!`);
  // 相手のゲームオーバーアニメ（横揺れ→落下）
  if(renderer)renderer.opponentGameOver(id);
});

socket.on('opponent_spin',({id,spinType})=>{
  if(renderer)renderer.triggerOpponentSpin(id,spinType);
});

socket.on('attack_sent',({fromId,toId,attack,clearRows})=>{
  if(!renderer)return;
  if(fromId===myId){
    const launchY=renderer._getClearRowsCenterY(clearRows);
    renderer.onAttackProjectile(toId,attack,launchY);
  }
});

socket.on('game_end',({winner,winnerName,scores})=>{
  stopDAS();stopSoftDrop();
  if(gameState)gameState.alive=false;
  setTimeout(()=>showResult(winner,winnerName,scores),2000);
});

// ゲーム終了後に強制ロビー退出
socket.on('force_leave_room',()=>{
  // リザルト表示中でも強制的にロビーへ
  setTimeout(()=>{
    backToLobby();
  },5000); // リザルト表示5秒後に強制退出
});

function showResult(winner,winnerName,scores){
  const o=document.getElementById('result-overlay');
  document.getElementById('result-title').textContent=winner===myId?'🏆 VICTORY!':'GAME OVER';
  document.getElementById('result-title').style.color=winner===myId?'#ffbe0b':'#ff006e';
  document.getElementById('result-winner').textContent=`Winner: ${winnerName}`;
  document.getElementById('result-scores').innerHTML=scores.sort((a,b)=>b.score-a.score).map(s=>
    `<div class="result-score-row"><span>${s.name}${s.id===myId?' (YOU)':''}</span><span style="color:var(--neon-cyan)">${s.score.toString().padStart(7,'0')}</span></div>`).join('');
  o.classList.add('open');
  if(winner===myId)SFX.allClear();else SFX.gameover();
}

// ---- Chat ----
function addChatMessage(msg){
  const el=document.getElementById('chat-messages');
  const d=document.createElement('div');d.className='chat-msg';
  d.innerHTML=`<span class="chat-name">${esc(msg.name)}</span>: ${esc(msg.message)}`;
  el.insertBefore(d,el.firstChild);
}
function addChatSystem(text){
  const el=document.getElementById('chat-messages');
  const d=document.createElement('div');d.className='chat-msg system';d.textContent=text;
  el.insertBefore(d,el.firstChild);
}
function sendChat(){const i=document.getElementById('chat-input');const m=i.value.trim();if(!m)return;socket.emit('chat_message',{message:m});i.value='';}
socket.on('chat_message',addChatMessage);
function esc(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ---- Settings UI ----
document.addEventListener('DOMContentLoaded',()=>{
  loadSettings();
  document.getElementById('ghost-opacity').value=settings.ghostOpacity;
  document.getElementById('ghost-val').textContent=settings.ghostOpacity+'%';
  document.getElementById('quality-select').value=settings.quality;
  document.getElementById('quality-val').textContent=settings.quality.toUpperCase();
  document.getElementById('particles-select').value=settings.particles;
  document.getElementById('shake-select').value=settings.shake;
  document.getElementById('sfx-volume').value=settings.sfxVolume;
  document.getElementById('sfx-val').textContent=settings.sfxVolume+'%';
  document.getElementById('tilt-select').value=settings.tilt;
  sfxVol=settings.sfxVolume/100;
  document.getElementById('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});
});
