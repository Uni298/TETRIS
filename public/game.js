// ===== TETRIX ONLINE =====

// ---- Settings ----
let mobileControlsEnabled = false; // Mobile controls toggle
let settings={ghostOpacity:40,quality:'ultra',particles:'high',shake:'on',sfxVolume:70,tilt:'on',softDropInterval:50,dasDelay:133,arrInterval:20,dcdDelay:0,
  uiLayout:{boardOffsetY:0,boardScale:100,sideUiOffsetY:0,sideUiFontScale:100},
  dpad:{cross:{x:2,y:55,size:160,opacity:80},shift:{x:68,y:80,size:80,opacity:80},harddrop:{x:79,y:68,size:80,opacity:80},z:{x:90,y:80,size:80,opacity:80},swapCenterDown:false}};
function loadSettings(){
  try{
    const s=document.cookie.split(';').find(c=>c.trim().startsWith('tetrix_settings='));
    if(s){
      const saved=JSON.parse(decodeURIComponent(s.split('=')[1]));
      const savedDpad=saved.dpad;
      const savedUiLayout=saved.uiLayout;
      settings={...settings,...saved};
      if(savedDpad&&savedDpad.cross&&savedDpad.shift&&savedDpad.z){
        settings.dpad={
          cross:{...settings.dpad.cross,...savedDpad.cross},
          shift:{...settings.dpad.shift,...savedDpad.shift},
          z:{...settings.dpad.z,...savedDpad.z},
          harddrop:savedDpad.harddrop?{...settings.dpad.harddrop,...savedDpad.harddrop}:{x:20,y:80,size:80,opacity:80},
          swapCenterDown:savedDpad.swapCenterDown??false
        };
      } else {
        // 古い形式または不正 → デフォルトを維持
        settings.dpad={cross:{x:2,y:55,size:160,opacity:80},shift:{x:2,y:80,size:80,opacity:80},harddrop:{x:20,y:80,size:80,opacity:80},z:{x:38,y:80,size:80,opacity:80},swapCenterDown:false};
      }
      if(savedUiLayout){settings.uiLayout={...settings.uiLayout,...savedUiLayout};}
    }
  }catch(e){}
}
function saveSettings(){document.cookie='tetrix_settings='+encodeURIComponent(JSON.stringify(settings))+'; max-age=31536000; path=/';}
function updateSetting(key,val){
  if(key==='ghost'){settings.ghostOpacity=parseInt(val);document.getElementById('ghost-val').textContent=val+'%';}
  else if(key==='quality'){settings.quality=val;document.getElementById('quality-val').textContent=val==='minimum'?'MINIMUM':val==='ultra'?'ULTRA':val.toUpperCase();}
  else if(key==='particles')settings.particles=val;
  else if(key==='shake')settings.shake=val;
  else if(key==='sfx'){settings.sfxVolume=parseInt(val);document.getElementById('sfx-val').textContent=val+'%';sfxVol=parseInt(val)/100;}
  else if(key==='tilt')settings.tilt=val;
  else if(key==='softDropInterval'){settings.softDropInterval=parseInt(val);document.getElementById('soft-drop-val').textContent=val+'ms';}
  else if(key==='dasDelay'){settings.dasDelay=parseInt(val);document.getElementById('das-delay-val').textContent=val+'ms';}
  else if(key==='arrInterval'){settings.arrInterval=parseInt(val);document.getElementById('arr-interval-val').textContent=val+'ms';}
  else if(key==='dcdDelay'){settings.dcdDelay=parseInt(val);document.getElementById('dcd-delay-val').textContent=val+'ms';}
  else if(key==='dpad'){if(val.part){settings.dpad[val.part]={...settings.dpad[val.part],...val.data};}else{settings.dpad={...settings.dpad,...val};}applyDpadLayout();}
  else if(key==='uiLayout'){settings.uiLayout={...settings.uiLayout,...val};applyUiLayout();}
  saveSettings();
}
function toggleSettings(){document.getElementById('settings-modal').classList.toggle('open');}
function resetAllSettings(){
  if(!confirm('全ての設定・名前・レイアウトをリセットしますか？')) return;
  document.cookie.split(';').forEach(c=>{
    const key=c.trim().split('=')[0];
    document.cookie=key+'=; max-age=0; path=/';
  });
  location.reload();
}
loadSettings();
// マイグレーション: 古いcookieにharddropがない場合はデフォルト値を補完
if (!settings.dpad.harddrop) {
  settings.dpad.harddrop = {x:20,y:80,size:80,opacity:80};
  saveSettings();
}
// マイグレーション: 古い位置(x>=68)のshift/harddrop/zを新しい左側配置にリセット
if (settings.dpad.shift.x >= 60 || settings.dpad.z.x >= 60) {
  settings.dpad.shift    = {x:2,  y:80, size:settings.dpad.shift.size||80, opacity:settings.dpad.shift.opacity||80};
  settings.dpad.harddrop = {x:20, y:80, size:settings.dpad.harddrop.size||80, opacity:settings.dpad.harddrop.opacity||80};
  settings.dpad.z        = {x:38, y:80, size:settings.dpad.z.size||80, opacity:settings.dpad.z.opacity||80};
  saveSettings();
}
// マイグレーション: harddropがzと同じy:80で重なっている場合は上にずらす
if (settings.dpad.harddrop.y === 80 && settings.dpad.harddrop.x >= 75 && settings.dpad.harddrop.x <= 85) {
  settings.dpad.harddrop.y = 68;
  saveSettings();
}

// ---- Socket ----
const socket=io({
  reconnection:true,
  reconnectionAttempts:Infinity,
  reconnectionDelay:1000,
  reconnectionDelayMax:5000,
});
let myId=null,roomId=null,myName='',isHost=false,roomPlayers=[];
let _reconnecting=false;
let shogiMode=false;
let isSoloGame=false;
let isSpectator=false; // 観戦モードフラグ
socket.on('connect',()=>{
  myId=socket.id;
  if(_reconnecting){
    _reconnecting=false;
    const banner=document.getElementById('reconnect-banner');
    if(banner)banner.remove();
    // 切断前のルームへ再接続
    if(_lastUsedRoomId&&myName){
      socket.emit('rejoin_room',{roomId:_lastUsedRoomId,name:myName});
    }
  }
});
socket.on('disconnect',()=>{
  _reconnecting=true;
  // 再接続バナーを表示
  let banner=document.getElementById('reconnect-banner');
  if(!banner){
    banner=document.createElement('div');
    banner.id='reconnect-banner';
    banner.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(255,0,110,0.85);color:#fff;font-family:Orbitron,sans-serif;font-size:0.8rem;text-align:center;padding:0.5rem;letter-spacing:0.1em;';
    banner.textContent='⚠ CONNECTION LOST — RECONNECTING...';
    document.body.appendChild(banner);
  }
});
socket.on('reconnect',()=>{
  const banner=document.getElementById('reconnect-banner');
  if(banner){banner.textContent='✓ RECONNECTED';setTimeout(()=>banner.remove(),1500);}
});

// ---- Screen ----
function applyUiLayout(){
  // ゲーム中なら boardWrap のY座標だけリアルタイム更新（スケール・その他は次ゲームで反映）
  if(typeof renderer!=='undefined'&&renderer&&renderer.boardWrap&&typeof renderer.mainBY==='number'){
    const ui=settings.uiLayout||{};
    const sc=renderer._uiScale||1;
    // BOARD_H=560, BOARD_W=280 (定数はグローバルスコープにある)
    const bh=(typeof BOARD_H!=='undefined'?BOARD_H:560)*sc;
    renderer.boardWrap.y=renderer.mainBY+bh/2+(renderer.boardOffsetY||0);
  }
}
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  // 設定ボタンはゲーム画面・ロビー・待機室でも表示
  const inGame=(id==='game');
  const showSettingsBtn=(id==='game'||id==='game-lobby'||id==='waiting');
  document.getElementById('settings-btn').style.display=showSettingsBtn?'block':'none';
  const sdBtn=document.getElementById('mobile-softdrop-btn');
  const lBtns=document.getElementById('mobile-left-btns');
  if(sdBtn)sdBtn.style.display='none';
  if(lBtns)lBtns.style.display='none';
  showDpad(inGame);
  const dpadBtnWrap=document.getElementById('dpad-layout-btn-wrap');
  if(dpadBtnWrap)dpadBtnWrap.style.display=(mobileControlsEnabled&&id==='game-lobby')?'block':'none';
}

// ---- Name Modal (initial screen) ----
function getSavedName(){
  try{const m=document.cookie.split(';').find(c=>c.trim().startsWith('tetrix_name='));return m?decodeURIComponent(m.split('=')[1].trim()):''}catch(e){return '';}
}
function saveName(name){
  document.cookie='tetrix_name='+encodeURIComponent(name)+'; max-age=31536000; path=/';
}
function submitNameModal(){
  const inp=document.getElementById('name-modal-input');
  const name=inp.value.trim();
  if(!name){document.getElementById('name-modal-error').textContent='Please enter a name';return;}
  myName=name;
  saveName(name);
  document.getElementById('name-modal').classList.add('hidden');
  showGameLobby(null);
}

// ---- Mutation Mode ----
let mutationMode=false;
let mutationSeed=0;
let roomSettings={mutationRate:60,gravityBase:1000,gravityDec:80,gravityMin:50,lockDelay:1000};

function toggleMutation(enabled){
  if(!isHost)return;
  mutationMode=enabled;
  socket.emit('set_mutation',{enabled,seed:mutationMode?Math.floor(Math.random()*1000000):0});
}

socket.on('mutation_update',({enabled,seed})=>{
  mutationMode=enabled;
  mutationSeed=seed;
  const row=document.getElementById('mutation-row-wrap');
  if(row){
    const cb=document.getElementById('mutation-toggle');
    if(cb)cb.checked=enabled;
  }
  addChatSystem(enabled?'⚡ MUTATION MODE: ON':'⚡ MUTATION MODE: OFF');
});

// ---- Seeded RNG for mutation (deterministic per piece index) ----
function mutationRng(seed){
  let s=seed>>>0;
  return function(){s=(Math.imul(s,1664525)+1013904223)>>>0;return s/0x100000000;};
}

// Global piece counter for deterministic mutation seed
let _pieceCounter=0;

// Apply mutation to a piece shape (returns new shape matrix or null if no mutation)
function applyMutation(type, shapeMatrix){
  if(!mutationMode) return null;
  // Each piece gets a deterministic mutation based on global piece index + mutationSeed
  const rng = mutationRng(mutationSeed ^ (_pieceCounter * 6364136223846793005 + 1442695040888963407 | 0));
  _pieceCounter++;

  // Use roomSettings.mutationRate (0-100) as the threshold
  const threshold = (roomSettings.mutationRate !== undefined ? roomSettings.mutationRate : 60) / 100;
  if(rng() > threshold) return null;

  // Deep copy the shape
  const shape = shapeMatrix.map(r=>[...r]);
  // Collect all filled cells and empty cells
  const filled=[];
  const empty=[];
  for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
    if(shape[r][c])filled.push([r,c]);
    else empty.push([r,c]);
  }
  if(filled.length===0) return null;

  // Pick mutation type by weighted random
  // 10% stack (double vertical), 20% remove1, 20% remove2, 20% add1, 10% remove3, 20% move1
  const roll=rng();
  // stack:0-0.10, remove1:0.10-0.30, remove2:0.30-0.50, add1:0.50-0.70, remove3:0.70-0.80, move1:0.80-1.0
  if(roll<0.10){
    // STACK: type-dependent direction
    // S, Z → stack vertically (縦につなげる)
    // L, J → stack horizontally (横につなげる)
    // Others → vertical (default)
    const stackHoriz = (type==='L'||type==='J');
    const newShape=shape.map(r=>[...r]);
    if(stackHoriz){
      // Horizontal stack: find rightmost col, attach same shape to the right
      const maxC=Math.max(...filled.map(([,c])=>c));
      const shift=maxC+1;
      for(const[r,c]of filled){
        const nc=c+shift;
        while(newShape[r].length<=nc)newShape[r].push(0);
        newShape[r][nc]=1;
      }
      // Ensure all rows same length
      const ml=Math.max(...newShape.map(r=>r.length));
      for(const r2 of newShape)while(r2.length<ml)r2.push(0);
    } else {
      // Vertical stack (S, Z, and all others): stack below
      const maxR=Math.max(...filled.map(([r])=>r));
      for(const[r,c]of filled){
        const nr=r+maxR+1;
        while(newShape.length<=nr)newShape.push(Array(shape[0].length).fill(0));
        newShape[nr][c]=1;
      }
    }
    return newShape;
  } else if(roll<0.30){
    // REMOVE 1 block
    if(filled.length<=1)return null;
    const idx=Math.floor(rng()*filled.length);
    const[r,c]=filled[idx];
    shape[r][c]=0;
    return shape;
  } else if(roll<0.50){
    // REMOVE 2 blocks
    if(filled.length<=2)return null;
    const idxA=Math.floor(rng()*filled.length);
    let idxB=Math.floor(rng()*(filled.length-1));
    if(idxB>=idxA)idxB++;
    shape[filled[idxA][0]][filled[idxA][1]]=0;
    shape[filled[idxB][0]][filled[idxB][1]]=0;
    return shape;
  } else if(roll<0.70){
    // ADD 1 block (I-piece: make lowercase "i" by moving far-end block 2 cells ahead)
    if(type==='I'){
      const minC=Math.min(...filled.map(([,c])=>c));
      const maxC=Math.max(...filled.map(([,c])=>c));
      const minR=Math.min(...filled.map(([r])=>r));
      const maxR=Math.max(...filled.map(([r])=>r));
      const isHoriz=(maxC-minC)>(maxR-minR);
      const newShape=shape.map(r=>[...r]);
      if(isHoriz){
        // Horizontal I: remove rightmost block, place it 2 further right -> [x][x][x][ ][x]
        const row=filled.find(([,c])=>c===maxC)[0];
        newShape[row][maxC]=0;
        const destC=maxC+2;
        while(newShape[row].length<=destC)newShape[row].push(0);
        newShape[row][destC]=1;
        const ml=Math.max(...newShape.map(r=>r.length));
        for(const r2 of newShape)while(r2.length<ml)r2.push(0);
      } else {
        // Vertical I: remove bottom block, place it 2 further down
        const col=filled.find(([r])=>r===maxR)[1];
        newShape[maxR][col]=0;
        const destR=maxR+2;
        while(newShape.length<=destR)newShape.push(Array(newShape[0].length).fill(0));
        newShape[destR][col]=1;
      }
      return newShape;
    } else {
      // Add 1 block adjacent to a random filled cell
      if(empty.length===0)return null;
      // Find empty cells adjacent to filled cells
      const adjEmpty=[];
      for(const[r,c]of filled){
        for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
          const nr=r+dr,nc=c+dc;
          if(nr>=0&&nr<shape.length&&nc>=0&&nc<shape[0].length&&!shape[nr][nc]){
            adjEmpty.push([nr,nc]);
          }
        }
      }
      if(adjEmpty.length===0)return null;
      const pick=adjEmpty[Math.floor(rng()*adjEmpty.length)];
      shape[pick[0]][pick[1]]=1;
      return shape;
    }
  } else if(roll<0.80){
    // REMOVE 3 blocks
    if(filled.length<=3)return null;
    const toRemove=[];
    const tmp=[...filled];
    for(let i=0;i<3;i++){
      const idx=Math.floor(rng()*tmp.length);
      toRemove.push(tmp.splice(idx,1)[0]);
    }
    for(const[r,c]of toRemove)shape[r][c]=0;
    return shape;
  } else {
    // MOVE 1 block to an adjacent empty cell
    if(filled.length<=1)return null;
    const idx=Math.floor(rng()*filled.length);
    const[r,c]=filled[idx];
    const dirs=[[-1,0],[1,0],[0,-1],[0,1]];
    const validMoves=dirs.filter(([dr,dc])=>{
      const nr=r+dr,nc=c+dc;
      return nr>=0&&nr<shape.length&&nc>=0&&nc<shape[0].length&&!shape[nr][nc];
    });
    if(validMoves.length===0)return null;
    const[dr,dc]=validMoves[Math.floor(rng()*validMoves.length)];
    shape[r][c]=0;
    shape[r+dr][c+dc]=1;
    return shape;
  }
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
function showError(msg){const el=document.getElementById('lobby-error');if(el)el.textContent=msg;}
function leaveRoom(){
  socket.emit('leave_room');
  roomId=null;roomPlayers=[];
  document.getElementById('start-btn').style.display='none';
  if(myName){showGameLobby(null);}
  else{showScreen('lobby');}
}
function startGame(){socket.emit('start_game');}

function returnToRoom(){
  if(_autoReturnTimer){clearTimeout(_autoReturnTimer);_autoReturnTimer=null;}
  document.getElementById('result-overlay').classList.remove('open');
  const sb=document.getElementById('spectate-banner');if(sb)sb.remove();
  const fb=document.getElementById('force-end-btn');if(fb)fb.remove();
  stopDAS();stopSoftDrop();removeInput();
  if(gameState){try{gameState.cancelLock();}catch(e){}gameState=null;}
  renderer=null;isSpectator=false;
  if(gameApp){try{gameApp.destroy(true);}catch(e){}gameApp=null;}
  const prevRoomId=_lastUsedRoomId;
  roomId=null;roomPlayers=[];
  document.getElementById('start-btn').style.display='none';
  if(myName&&prevRoomId){
    // 前のルームへ再参加を試みる
    socket.emit('rejoin_room',{roomId:prevRoomId,name:myName});
  } else if(myName){
    showGameLobby(null);
  } else {
    showScreen('lobby');
  }
  showError('');
}

function backToLobby(){
  if(_autoReturnTimer){clearTimeout(_autoReturnTimer);_autoReturnTimer=null;}
  document.getElementById('result-overlay').classList.remove('open');
  const sb=document.getElementById('spectate-banner');if(sb)sb.remove();
  const fb=document.getElementById('force-end-btn');if(fb)fb.remove();
  stopDAS();stopSoftDrop();removeInput();
  if(gameState){try{gameState.cancelLock();}catch(e){}gameState=null;}
  renderer=null;isSpectator=false;
  if(gameApp){try{gameApp.destroy(true);}catch(e){}gameApp=null;}
  const prevRoomId=roomId||_lastUsedRoomId;
  // ルームから正しく退出
  if(roomId){socket.emit('leave_room');}
  roomId=null;roomPlayers=[];
  document.getElementById('start-btn').style.display='none';
  if(myName){
    showGameLobby(prevRoomId);
  } else {
    showScreen('lobby');
  }
  showError('');
}

// ---- Game Lobby ----
function showGameLobby(prevRoomId){
  document.getElementById('gl-player-name').textContent=myName.toUpperCase();
  document.getElementById('gl-error').textContent='';
  // 前の部屋バナー
  const banner=document.getElementById('prev-room-banner');
  if(prevRoomId){
    document.getElementById('prev-room-id-display').textContent=prevRoomId;
    banner.style.display='flex';
    _lastUsedRoomId=prevRoomId;
  } else {
    banner.style.display='none';
  }
  showScreen('game-lobby');
  refreshRooms();
}

function refreshRooms(){
  socket.emit('get_rooms');
}

socket.on('rooms_list',(list)=>{
  const el=document.getElementById('rooms-list');
  if(!el)return;
  if(!list||list.length===0){
    el.innerHTML='<div class="no-rooms">No open rooms</div>';return;
  }
  el.innerHTML=list.map(r=>`
    <div class="room-item" onclick="glJoinById('${r.id}')">
      <div>
        <div class="room-item-id">${r.id}</div>
        <div class="room-item-players">${r.players.join(', ')}</div>
      </div>
      <div class="room-item-join">${r.count}/3 JOIN ▶</div>
    </div>`).join('');
});

function glCreateRoom(){
  const rid=document.getElementById('gl-room-id-input').value.trim().toUpperCase();
  document.getElementById('gl-error').textContent='';
  if(rid)socket.emit('create_room',{name:myName,roomId:rid});
  else socket.emit('create_room',{name:myName});
}

function glJoinRoom(){
  const rid=document.getElementById('gl-join-id-input').value.trim().toUpperCase();
  if(!rid){document.getElementById('gl-error').textContent='Enter a Room ID';return;}
  glJoinById(rid);
}

function glJoinById(rid){
  document.getElementById('gl-error').textContent='';
  socket.emit('rejoin_room',{roomId:rid,name:myName});
}

function rejoinPrevRoom(){
  if(!_lastUsedRoomId)return;
  document.getElementById('gl-error').textContent='';
  socket.emit('rejoin_room',{roomId:_lastUsedRoomId,name:myName});
}

function glBackToTitle(){
  myName='';roomId=null;_lastUsedRoomId=null;
  // Show name modal again instead of old lobby
  document.getElementById('name-modal').classList.remove('hidden');
  document.getElementById('screens').querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
}

// game-lobbyのerrorはgl-errorに表示
const _origShowError=showError;
socket.on('error',({msg})=>{
  const glErr=document.getElementById('gl-error');
  if(document.getElementById('game-lobby').classList.contains('active')&&glErr){
    glErr.textContent=msg;
  } else {
    showError(msg);
  }
});

socket.on('rejoin_result',({success,roomId:rid,players,host,mutationMode:mu,mutationSeed:ms,roomSettings:rs})=>{
  if(!success){showScreen('lobby');return;}
  roomId=rid;roomPlayers=players;
  isHost=(socket.id===host);
  if(mu!==undefined){mutationMode=mu;mutationSeed=ms||0;}
  if(rs){roomSettings={...roomSettings,...rs};}
  document.getElementById('room-id-display').textContent=rid;
  updatePlayerList(players);
  document.getElementById('start-btn').style.display=isHost&&players.length>=2?'block':'none';
  document.getElementById('wait-status').textContent=players.length<2?'Waiting for players... (min 2)':`${players.length} players ready`;
  const mrow=document.getElementById('mutation-row-wrap');
  if(mrow)mrow.style.display=isHost?'flex':'none';
  const cb=document.getElementById('mutation-toggle');if(cb)cb.checked=!!mu;
  if(rs)updateRoomSettingsUI(rs);
  const hostControls=document.getElementById('host-settings-wrap');
  const viewOnly=document.getElementById('settings-view-wrap');
  if(hostControls)hostControls.style.display=isHost?'block':'none';
  if(viewOnly)viewOnly.style.display=!isHost&&rs?'block':'none';
  showScreen('waiting');
});

socket.on('room_created',({roomId:rid,players})=>{
  roomId=rid;_lastUsedRoomId=rid;roomPlayers=players;isHost=true;
  document.getElementById('room-id-display').textContent=rid;
  showScreen('waiting');updatePlayerList(players);
  resetRoomInactivityTimer();
  document.getElementById('mutation-row-wrap').style.display='flex';
  document.getElementById('host-settings-wrap').style.display='block';
  document.getElementById('settings-view-wrap').style.display='none';
  updateRoomSettingsUI(roomSettings);
  // Push initial settings to server
  socket.emit('set_room_settings', roomSettings);
});
socket.on('room_joined',({roomId:rid,players})=>{
  roomId=rid;_lastUsedRoomId=rid;roomPlayers=players;isHost=false;
  document.getElementById('room-id-display').textContent=rid;
  showScreen('waiting');updatePlayerList(players);
  document.getElementById('mutation-row-wrap').style.display='none';
  document.getElementById('host-settings-wrap').style.display='none';
});
socket.on('room_update',({players,host,started,mutationMode:mu,mutationSeed:ms,roomSettings:rs})=>{
  roomPlayers=players;isHost=(socket.id===host);updatePlayerList(players);
  if(!started)resetRoomInactivityTimer();
  else{if(_roomInactivityTimer)clearTimeout(_roomInactivityTimer);_removeInactivityBtn();}
  const total=players.length;
  const isSoloAllowed=rs&&rs.soloMode;
  const canStart=isHost&&!started&&(total>=2||(isSoloAllowed&&total>=1));
  document.getElementById('start-btn').style.display=canStart?'block':'none';
  const feb=document.getElementById('force-end-waiting-btn');
  if(feb)feb.style.display=(isHost&&started)?'block':'none';
  document.getElementById('wait-status').textContent=started?'⚔ Match in progress...':(total<2?(isSoloAllowed?`${total} player — solo mode ON`:'Waiting for players... (add a BOT or friend)'):`${total} players ready`);
  if(mu!==undefined){mutationMode=mu;mutationSeed=ms||0;const cb=document.getElementById('mutation-toggle');if(cb)cb.checked=mu;}
  if(rs){roomSettings={...roomSettings,...rs};updateRoomSettingsUI(rs);}
  const hostControls=document.getElementById('host-settings-wrap');
  const viewOnlySettings=document.getElementById('settings-view-wrap');
  if(hostControls)hostControls.style.display=isHost?'block':'none';
  if(viewOnlySettings)viewOnlySettings.style.display=!isHost?'block':'none';
  const mrow=document.getElementById('mutation-row-wrap');
  if(mrow)mrow.style.display=isHost?'flex':'none';
});
socket.on('player_left',()=>addChatSystem('Player left'));

// 観戦モード: 試合中に入室した場合
socket.on('spectate_joined',({roomId:rid,players,host})=>{
  roomId=rid;_lastUsedRoomId=rid;roomPlayers=players;
  isHost=(socket.id===host);
  isSpectator=true;
  addChatSystem('👁 Spectating match in progress...');
  showScreen('game');
  showDpad(false);
  const container=document.getElementById('pixi-container');
  container.innerHTML='';
  const W=container.clientWidth||window.innerWidth,H=container.clientHeight||window.innerHeight;
  const res=settings.quality==='minimum'||settings.quality==='low'?1:settings.quality==='medium'?1.5:settings.quality==='ultra'?2.5:2;
  gameApp=new PIXI.Application({width:W,height:H,backgroundColor:0x030712,antialias:settings.quality!=='minimum'&&settings.quality!=='low',resolution:res,autoDensity:true});
  container.appendChild(gameApp.view);
  gameState=null;
  // 観戦専用レンダラー: 全プレイヤーのボードを均等に並べて表示
  renderer=new SpectatorRenderer(gameApp,players);
  // 既存ボードデータを反映
  players.forEach(p=>{
    const d=renderer.opBoardData[p.id];
    if(d&&p.board)d.board=p.board;
  });
  renderer.drawAll();
  gameApp.ticker.add(()=>renderer.update(16));
  // 観戦中バナー
  const banner=document.createElement('div');
  banner.id='spectate-banner';
  banner.style.cssText='position:fixed;top:10px;left:50%;transform:translateX(-50%);background:rgba(255,190,11,0.15);border:1px solid rgba(255,190,11,0.5);color:#ffbe0b;padding:0.4rem 1.2rem;border-radius:20px;font-family:Orbitron,sans-serif;font-size:0.75rem;letter-spacing:0.1em;z-index:100;pointer-events:none;';
  banner.textContent='👁 SPECTATING';
  document.body.appendChild(banner);
  // ホストなら強制終了ボタンを表示
  if(isHost){
    const fbtn=document.createElement('button');
    fbtn.id='force-end-btn';
    fbtn.textContent='⏹ FORCE END';
    fbtn.style.cssText='position:fixed;top:10px;right:12px;background:rgba(255,0,110,0.2);border:1px solid rgba(255,0,110,0.6);color:#ff006e;padding:0.4rem 1rem;border-radius:8px;font-family:Orbitron,sans-serif;font-size:0.7rem;cursor:pointer;z-index:100;letter-spacing:0.05em;';
    fbtn.onclick=forceEndGame;
    document.body.appendChild(fbtn);
  }
});

function forceEndGame(){
  if(!confirm('試合を強制終了しますか？')) return;
  socket.emit('force_end_game');
}

function updateRoomSettingsUI(rs){
  const mr=document.getElementById('mutation-rate-input');if(mr){mr.value=rs.mutationRate??60;document.getElementById('mutation-rate-val').textContent=(rs.mutationRate??60)+'%';}
  const gb=document.getElementById('gravity-base-input');if(gb){gb.value=rs.gravityBase??1000;document.getElementById('gravity-base-val').textContent=(rs.gravityBase??1000)+'ms';}
  const gd=document.getElementById('gravity-dec-input');if(gd){gd.value=rs.gravityDec??80;document.getElementById('gravity-dec-val').textContent=(rs.gravityDec??80)+'ms';}
  const gm=document.getElementById('gravity-min-input');if(gm){gm.value=rs.gravityMin??50;document.getElementById('gravity-min-val').textContent=(rs.gravityMin??50)+'ms';}
  const ld=document.getElementById('lock-delay-input');if(ld){ld.value=rs.lockDelay??1000;document.getElementById('lock-delay-val').textContent=(rs.lockDelay??1000)+'ms';}
  const bl=document.getElementById('bot-level-input');if(bl){bl.value=rs.botLevel??3;document.getElementById('bot-level-val').textContent=getBotLevelLabel(rs.botLevel??3);}
  const sg=document.getElementById('shogi-toggle');if(sg)sg.checked=!!(rs.shogiMode);
  const soloTog=document.getElementById('solo-toggle');if(soloTog)soloTog.checked=!!(rs.soloMode);
  const recTog=document.getElementById('record-training-toggle');if(recTog)recTog.checked=!!(rs.recordTraining);
  const vo=document.getElementById('settings-view-content');
  if(vo&&rs){
    const modeStr=mutationMode?`ON (${rs.mutationRate??60}%)`:'OFF';
    const spd=rs.gravityBase??1000;
    const spdLabel=spd>=1500?'SLOW':spd>=900?'NORMAL':spd>=500?'FAST':'VERY FAST';
    const bots=roomPlayers.filter(p=>p.isBot);
    const botStr=bots.length>0?bots.map(b=>`${b.name} Lv.${b.botLevel}`).join(', '):'None';
    vo.innerHTML=`<div class="settings-view-row"><span>⚡ Mutation</span><span style="color:var(--neon-cyan)">${modeStr}</span></div><div class="settings-view-row"><span>⏩ Speed</span><span style="color:var(--neon-yellow)">${spdLabel}</span></div><div class="settings-view-row"><span>🔒 Lock Delay</span><span style="color:var(--neon-yellow)">${rs.lockDelay??1000}ms</span></div><div class="settings-view-row"><span>🤖 BOT(s)</span><span style="color:var(--neon-cyan)">${botStr}</span></div>${rs.shogiMode?'<div class="settings-view-row"><span>♟ Shogi</span><span style="color:var(--neon-yellow)">ON</span></div>':''}${rs.soloMode?'<div class="settings-view-row"><span>🎮 Solo</span><span style="color:var(--neon-cyan)">ON</span></div>':''}${rs.recordTraining?'<div class="settings-view-row"><span>🔴 Recording</span><span style="color:#ff006e">ON</span></div>':''}`;
  }
}
function getBotLevelLabel(lvl){
  return ['','BEGINNER','EASY','STRONG','EXPERT','GOD'][lvl]||'STRONG';
}

function updateRoomSetting(key,val){
  const boolKeys=['shogiMode','soloMode','recordTraining'];
  const parsed=boolKeys.includes(key)?(!!val):(parseInt(val)||0);
  roomSettings[key]=parsed;
  socket.emit('set_room_settings',{[key]:parsed});
  updateRoomSettingsUI(roomSettings);
}

function addBot(){
  const lvl=parseInt(document.getElementById('bot-level-input')?.value)||roomSettings.botLevel||3;
  socket.emit('add_bot',{botLevel:lvl});
}

function kickBot(botId){
  socket.emit('kick_bot',{botId});
}

function updateBotList(players){
  const bots=players.filter(p=>p.isBot);
  const el=document.getElementById('bot-list');
  if(!el)return;
  el.innerHTML=bots.map(b=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span style="color:rgba(255,255,255,0.7);font-size:0.75rem">${esc(b.name)} <span style="color:var(--neon-yellow)">Lv.${b.botLevel}</span></span><button onclick="kickBot('${b.id}')" style="background:rgba(255,0,110,0.2);border:1px solid rgba(255,0,110,0.4);color:#ff006e;border-radius:4px;padding:0.15rem 0.5rem;cursor:pointer;font-size:0.7rem">KICK</button></div>`).join('');
}

function updatePlayerList(players){
  document.getElementById('player-list').innerHTML=players.map((p,i)=>`<div class="player-item"><div class="player-avatar" style="${p.isBot?'background:rgba(255,190,11,0.2);border-color:rgba(255,190,11,0.5);color:#ffbe0b':''}">${p.name[0].toUpperCase()}</div><span>${p.name}${p.isBot?` <span style="color:var(--neon-yellow);font-size:0.7rem">Lv.${p.botLevel}</span>`:''}</span>${i===0&&!p.isBot?'<span class="host-badge">HOST</span>':''}</div>`).join('');
  if(isHost)updateBotList(players);
}

// ---- Countdown then start ----
socket.on('game_start',({players,bagSeed,mutationMode:mu,mutationSeed:ms,roomSettings:rs,shogiMode:sm,isSolo:solo})=>{
  // ゲーム開始時は非アクティブタイマーをクリア
  if(_roomInactivityTimer)clearTimeout(_roomInactivityTimer);
  _removeInactivityBtn();
  roomPlayers=players;
  mutationMode=!!mu;
  mutationSeed=ms||0;
  shogiMode=!!sm;
  isSoloGame=!!solo;
  if(rs)roomSettings={...roomSettings,...rs};
  _pieceCounter=0;
  showScreen('game');
  showDpad(true);
  setupDpadButtons();
  showCountdown(bagSeed,()=>initGame(players,bagSeed));
  if(sm)addChatSystem('♟ SHOGI MODE: BOT responds to each of your moves!');
  if(solo)addChatSystem('🎮 SOLO MODE — survive as long as possible!');
  if(rs&&rs.recordTraining)addChatSystem('🔴 Recording training data...');
});

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
  const res=settings.quality==='minimum'||settings.quality==='low'?1:settings.quality==='medium'?1.5:settings.quality==='ultra'?2.5:2;
  gameApp=new PIXI.Application({width:W,height:H,backgroundColor:0x030712,antialias:settings.quality!=='minimum'&&settings.quality!=='low',resolution:res,autoDensity:true});
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
    // renCount=2から: 全音(2半音)ずつ上がる
    const semitone=(renCount-1)*2;
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

// ---- Matrix rotation helper (for mutated piece shapes) ----
function rotateMatrix(matrix, dir) {
  // dir: +1 = clockwise, -1 = counter-clockwise
  const rows = matrix.length;
  const cols = Math.max(...matrix.map(r => r.length));
  // Pad all rows to same length
  const padded = matrix.map(r => { const a = [...r]; while(a.length < cols) a.push(0); return a; });
  if (dir > 0) {
    // CW: transpose then reverse each row
    const T = Array.from({length: cols}, (_,c) => Array.from({length: rows}, (_,r) => padded[r][c]));
    return T.map(r => r.reverse());
  } else {
    // CCW: reverse each row then transpose
    const rev = padded.map(r => [...r].reverse());
    return Array.from({length: cols}, (_,c) => Array.from({length: rows}, (_,r) => rev[r][c]));
  }
}

// ---- Game State ----
let gameState=null,gameApp=null,renderer=null;

// ミノのスポーン位置: 枠の外の上から登場させる（1マス上）
const SPAWN_Y = -3;

class TetrisGame{
  constructor(bagSeed){
    this.board=Array.from({length:ROWS+HIDDEN},()=>Array(COLS).fill(0));
    this.bag=new Bag(bagSeed);this.nextQueue=[];
    // Fill nextQueue with pre-computed {type, customShape} entries
    for(let i=0;i<6;i++)this.nextQueue.push(this._makeNextEntry(this.bag.next()));
    this.holdPiece=null;this.holdCustomShape=null;this.holdUsed=false;
    this.score=0;this.lines=0;this.level=1;
    this.combo=-1;this.b2b=false;this.b2bCount=0;this.ren=0;
    this.alive=true;this.locking=false;
    this.lockTimer=null;this.lockDelay=roomSettings.lockDelay||1000;
    this.lastSpin=null;this.lastSpinType=null;
    this.garbageQueue=[];
    this.gravityMs=0;
    renSemitone=0;
    this.spawnPiece();
  }

  // Pre-compute a next queue entry with its customShape
  _makeNextEntry(type){
    const baseShape=PIECE_SHAPES[type][0];
    const mutated=applyMutation(type,baseShape);
    return {type, customShape: mutated||null};
  }

  spawnPiece(){
    const entry=this.nextQueue.shift();
    this.nextQueue.push(this._makeNextEntry(this.bag.next()));
    const {type, customShape}=entry;
    this.current={type,rotation:0,x:3,y:SPAWN_Y,customShape};
    this.holdUsed=false;this.lastSpin=null;this.lastSpinType=null;this.locking=false;
    if(renderer)renderer._wallBumpActive=false;
    // Game over: スポーンしたミノが盤面の既存ブロックと重なったらゲームオーバー
    // SPAWN_Y=-3, HIDDEN=3 なのでミノは board[-3..0] 付近にスポーン
    // ny が負の場合は配列外だが、isValid で使う board インデックスは ny+HIDDEN_OFFSET になる
    // ここでは isValid を直接使って重なりをチェック
    const spawnShape=this.getShape(this.current.type,0,this.current.customShape||null);
    let overlaps=false;
    outer2: for(let r=0;r<spawnShape.length;r++){
      for(let c=0;c<spawnShape[r].length;c++){
        if(!spawnShape[r][c])continue;
        const ny=this.current.y+r,nx=this.current.x+c;
        // ny が 0以上 = 盤面内（board[ny][nx]をチェック）
        // ny が 負 = 盤面上部の隠れ行。HIDDEN offsetを加えた絶対行でチェック
        // ただし SPAWN_Y=-3, HIDDEN=3 なのでスポーン直後のrは0なので
        // ny = -3 + 0 = -3 → 盤面外なのでチェック不要
        // ny = -3 + 1 = -2 → 盤面外
        // ny = -3 + 2 = -1 → 盤面外  
        // ny = -3 + 3 = 0 → board[0]（HIDDEN行の最初）= チェック必要
        // つまり積み上がってHIDDEN行内にブロックがあれば当たる
        if(ny>=0&&ny<ROWS+HIDDEN&&nx>=0&&nx<COLS&&this.board[ny][nx]){overlaps=true;break outer2;}
      }
    }
    if(overlaps){this.alive=false;}
    // 追加チェック: ミノの最下行がスポーンのy+形状の高さに来た時、
    // 可視領域の一番上(HIDDEN行目)に既存ブロックがあればゲームオーバー
    if(!overlaps){
      // isValid でスポーン位置が無効 = 即ゲームオーバー
      if(!this.isValid(this.current)){this.alive=false;}
    }
  }

  getShape(type,rot,customShape){
    // If customShape provided, use it (mutation mode — rotation not applied to mutated shapes)
    if(customShape)return customShape;
    return PIECE_SHAPES[type][((rot%4)+4)%4];
  }

  _getShapeForPiece(piece){
    return this.getShape(piece.type,piece.rotation,piece.customShape||null);
  }

  isValid(piece,dx=0,dy=0){
    const shape=this._getShapeForPiece(piece);
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
    // For custom-shaped pieces, rotate the shape matrix itself
    if(this.current.customShape){
      const rotated=rotateMatrix(this.current.customShape,dir>0?1:-1);
      const base={...this.current,rotation:newRot,customShape:rotated};
      if(this.isValid(base)){
        this.current=base;this.checkSpin(0,0,false);this.tryResetLock();SFX.rotate();
        if(this.lastSpin){renderer&&renderer.onSpinTilt(dir);renderer&&renderer.onSpinRotateSparkle(this.current,this.lastSpinType);}
        return true;
      }
      // Try simple kicks for custom pieces
      for(const[kx,ky]of [[-1,0],[1,0],[0,-1],[0,1],[-2,0],[2,0]]){
        const t={...base,x:base.x+kx,y:base.y-ky};
        if(this.isValid(t)){
          this.current=t;this.checkSpin(kx,ky,true);this.tryResetLock();SFX.rotate();
          if(this.lastSpin){renderer&&renderer.onSpinTilt(dir);renderer&&renderer.onSpinRotateSparkle(this.current,this.lastSpinType);}
          return true;
        }
      }
      return false;
    }
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
    if(this.current.customShape)return; // skip spin detection for mutated pieces
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
      const shape=this.getShape(type,rot,null);let bb=false;
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

  startLockTimer(){if(this.lockTimer)return;this.lockStartTime=performance.now();this.lockTimer=setTimeout(()=>{if(!this.isValid(this.current,0,1))this.lockPiece();},this.lockDelay);}
  cancelLock(){if(this.lockTimer){clearTimeout(this.lockTimer);this.lockTimer=null;this.lockStartTime=null;}}

  lockPiece(){
    if(this.locking)return;
    this.locking=true;this.cancelLock();
    const shape=this._getShapeForPiece(this.current);
    const wasSpin=!!this.lastSpin,spinType=this.lastSpinType;
    this._lockX=this.current.x;this._lockY=this.current.y;this._lockType=this.current.type;
    this._lockRot=this.current.rotation||0;
    // T-spin afterimage: capture shape+position BEFORE locking
    if(wasSpin&&this.current.type==='T'){
      renderer&&renderer.triggerAfterimage(this.current,this._getShapeForPiece(this.current));
    }
    // Snapshot board state BEFORE placement for training data
    this._boardBefore=roomSettings.recordTraining?this.board.map(r=>r.map(c=>c||0)):null;
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
    this._lastLinesCleared=count; // for training data
    const spinType=this.lastSpinType,isSpin=!!this.lastSpin,isMini=spinType&&spinType.startsWith('MINI'),isTSpin=this.lastSpin==='T';

    let allClear=false;
    if(count>0){
      const testBoard=this.board.map(r=>[...r]);
      const desc=[...cleared].sort((a,b)=>b-a);
      for(const idx of desc)testBoard.splice(idx,1);
      allClear=testBoard.every(row=>row.every(c=>c===0));
    }

    if(count>0){
      // *** FIX: Remove cleared lines FIRST before adding garbage ***
      // This prevents index shifting bugs when garbage is added simultaneously
      const desc=[...cleared].sort((a,b)=>b-a);
      for(const idx of desc)this.board.splice(idx,1);
      for(let i=0;i<count;i++)this.board.unshift(Array(COLS).fill(0));

      // Now cancel garbage with cleared lines, then apply remainder
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

      this.combo++;this.ren++;
      if(this.ren>1)SFX.ren(this.ren);
      // 5-line clear (mutation mode): always B2B-eligible, not counted in standard B2B chain
      const isPenta=count===5;
      const isB2B=this.b2b&&(count===4||isPenta||(isSpin&&!isMini));
      if(count===4||isPenta||(isSpin&&!isMini)){if(this.b2b){this.b2bCount++;SFX.b2b();}this.b2b=true;}
      else{this.b2bCount=0;this.b2b=false;}

      const pts=this.calcScore(count,isTSpin,isMini,isB2B,this.combo);
      this.score+=pts;this.lines+=count;this.level=Math.floor(this.lines/10)+1;

      let attack=0;
      if(allClear){attack=10;}
      else if(isPenta){
        // 5-line clear = 6 lines attack (mutation bonus)
        attack=6;
        if(isB2B)attack+=1;
        if(this.combo>0)attack+=Math.floor(this.combo/2);
      }
      else{
        if(isTSpin&&!isMini)attack={1:2,2:4,3:6}[count]||0;
        else if(isMini)attack={1:0,2:1}[count]||0;
        else attack={1:0,2:1,3:2,4:4}[count]||0;
        if(isB2B&&attack>0)attack+=1;
        if(this.combo>0)attack+=Math.floor(this.combo/2);
        // REN攻撃テーブル（1段でもREN2以上なら攻撃）
        const renAttackTable=[0,0,1,1,2,2,3,3,4,4,4,5];
        const renAtk=renAttackTable[Math.min(this.ren,11)]||5;
        if(this.ren>=2)attack+=renAtk;
      }
      if(attack>0)socket.emit('lines_cleared',{attack,allClear,spinType,clearRows:cleared});
      // 相手に視覚エフェクトを送信
      socket.emit('line_clear_effect',{count,spinType,isB2B:isB2B||false,ren:this.ren,allClear});

      if(count===1)SFX.clear1();
      else if(count===2)SFX.clear2();
      else if(count===3)SFX.clear3();
      else if(count===5){SFX.tetris();SFX.b2b();} // penta clear special SFX
      else SFX.tetris();
      if(isSpin&&isTSpin)SFX.tspin();
      if(allClear)SFX.allClear();

      renderer&&renderer.onLineClear(cleared,count,spinType,isB2B,this.combo,this.ren,allClear,attack);
    } else {
      if(this.ren>0){SFX.renReset();}
      this.combo=-1;this.ren=0;
      renderer&&renderer.endComboLabel();
      // 相手にRENリセットを通知
      socket.emit('line_clear_effect',{count:0,spinType:null,isB2B:false,ren:0,allClear:false});
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
    // ── Training data: emit piece_placed ────────────────────────
    if(roomSettings.recordTraining&&this._boardBefore){
      try{
        socket.emit('piece_placed',{
          boardBefore: this._boardBefore,
          placedPiece: {type:this._lockType, rotation:this._lockRot, x:this._lockX, y:this._lockY},
          nextPieces: this.nextQueue.slice(0,5).map(p=>(typeof p==='string'?p:(p&&p.type)||p||'')),
          holdPiece: this.holdPiece||null,
          linesCleared: this._lastLinesCleared||0,
          boardAfter: this.board.map(r=>r.map(c=>c||0))
        });
      }catch(err){console.warn('[record] piece_placed error',err);}
    }
    this.spawnPiece();
    this._emitBoardUpdate();
    // Shogi mode: notify server that human placed a piece
    if(shogiMode)socket.emit('shogi_human_placed');
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

    // If total queued garbage exceeds 20 lines, force-apply the overflow immediately
    const total=this.garbageQueue.reduce((s,g)=>s+g.lines,0);
    if(total>20){
      const overflow=total-20;
      // Force the oldest entries to fire now
      let remaining=overflow;
      for(const g of this.garbageQueue){
        if(remaining<=0)break;
        const take=Math.min(g.lines,remaining);
        g.lines-=take;
        remaining-=take;
        g.readyAt=performance.now(); // force ready
      }
      this.garbageQueue=this.garbageQueue.filter(g=>g.lines>0);
      // Immediately apply forced garbage
      const forced=this.garbageQueue.filter(g=>g.readyAt<=performance.now()+10);
      this.garbageQueue=this.garbageQueue.filter(g=>g.readyAt>performance.now()+10);
      if(forced.length>0){
        const ft=forced.reduce((s,g)=>s+g.lines,0);
        if(ft>0)this._applyGarbageAnimated(forced,ft);
      }
    }
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
    const customShape=this.current.customShape||null;
    if(this.holdPiece!==null){
      const nextType=this.holdPiece;
      const nextCustomShape=this.holdCustomShape||null;
      this.holdPiece=type;
      this.holdCustomShape=customShape;
      this.current={type:nextType,rotation:0,x:3,y:SPAWN_Y,customShape:nextCustomShape};
      this.lastSpin=null;this.lastSpinType=null;this.locking=false;
      if(renderer)renderer._wallBumpActive=false;
    }else{
      this.holdPiece=type;
      this.holdCustomShape=customShape;
      this.spawnPiece();
    }
    this.cancelLock();SFX.hold();
  }

  updateGravity(dt){
    if(!this.alive)return;
    const base=roomSettings.gravityBase||1000;
    const dec=roomSettings.gravityDec||80;
    const min=roomSettings.gravityMin||50;
    const msPerDrop=Math.max(min,base-(this.level-1)*dec);
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
    // B2B 雷エフェクト
    this._b2bCount=0;this._lightningBolts=[];this._lightningTimer=0;
    // 煙エフェクト（危機状態）
    this._smokeParticles=[];this._smokeTick=0;
    this.root=new PIXI.Container();app.stage.addChild(this.root);
    this.buildLayout();this.createBg();
    this.buildOpponentBoards();this.buildMainBoard();this.buildSideUI();
    this.effectsLayer=new PIXI.Container();app.stage.addChild(this.effectsLayer);
    this.projLayer=new PIXI.Container();app.stage.addChild(this.projLayer);
  }

  buildLayout(){
    const ui=settings.uiLayout||{};
    const offY=ui.boardOffsetY||0;
    const sc=(ui.boardScale||100)/100;
    // スケールはボードの中心を保ちながらオフセット計算に反映
    this._uiScale=sc;
    this.mainBX=this.W/2-BOARD_W*sc/2-30;
    this.mainBY=(this.H-(BOARD_H*sc+ABOVE_BOARD*sc))/2+ABOVE_BOARD*sc+offY;
  }

  createBg(){
    this.bgLayer=new PIXI.Container();this.root.addChild(this.bgLayer);
    if(settings.quality!=='low'&&settings.quality!=='minimum'){
      const g=new PIXI.Graphics();g.lineStyle(0.5,0x001133,0.18);
      for(let x=0;x<this.W;x+=40){g.moveTo(x,0);g.lineTo(x,this.H);}
      this.bgLayer.addChild(g);
    }
    // ULTRA: animated scan-line + ambient glow background
    if(settings.quality==='ultra'){
      this._bgScanline=new PIXI.Graphics();this.bgLayer.addChild(this._bgScanline);
      this._bgScanlineY=0;
      // subtle vignette
      const vg=new PIXI.Graphics();
      const cx=this.W/2,cy=this.H/2;
      for(let i=5;i>0;i--){
        vg.beginFill(0x000000,(i/5)*0.35);
        vg.drawEllipse(cx,cy,cx*(1+i*0.25),cy*(1+i*0.25));
        vg.endFill();
      }
      this.bgLayer.addChild(vg);
    }
  }

  buildOpponentBoards(){
    const oCell=12,oBW=COLS*oCell;
    const showAbove=2,oBH=(ROWS+showAbove)*oCell;
    const sc=this._uiScale||1;
    // 全対戦相手のボードを作成（表示/非表示はupdateVisibleOpponentsで制御）
    const RX=this.mainBX+BOARD_W*sc+90; // 右スロット x
    const LX=this.mainBX-oBW-90;    // 左スロット x
    const by=this.H/2-oBH/2;
    this.opponentPlayers.forEach((p)=>{
      const cont=new PIXI.Container();cont.x=RX;cont.y=by;cont.visible=false;this.root.addChild(cont);
      const isBot=!!p.isBot;
      const borderCol=isBot?0xffbe0b:0x00f5ff;
      const bg=new PIXI.Graphics();
      bg.beginFill(0x000010,0.9);bg.drawRect(0,0,oBW,oBH);bg.endFill();
      bg.lineStyle(1,borderCol,isBot?0.45:0.2);bg.drawRect(0,0,oBW,oBH);
      // Grid lines for HIGH/ULTRA
      if(settings.quality==='high'||settings.quality==='ultra'){
        bg.lineStyle(0.3,0x001833,0.4);
        for(let c=1;c<COLS;c++){bg.moveTo(c*oCell,0);bg.lineTo(c*oCell,oBH);}
        for(let r=1;r<ROWS+showAbove;r++){bg.moveTo(0,r*oCell);bg.lineTo(oBW,r*oCell);}
      }
      cont.addChild(bg);
      const nameCol=isBot?0xffbe0b:0x00f5ff;
      const nst=new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:10,fill:nameCol,letterSpacing:2});
      const nameLabel=isBot?`${p.name.toUpperCase()} Lv.${p.botLevel||'?'}`:p.name.toUpperCase();
      const ntxt=new PIXI.Text(nameLabel,nst);ntxt.x=0;ntxt.y=-16;cont.addChild(ntxt);
      const boardGfx=new PIXI.Graphics();cont.addChild(boardGfx);
      const nextGfx=[];
      for(let j=0;j<3;j++){const ng=new PIXI.Graphics();ng.x=oBW+4;ng.y=j*30;cont.addChild(ng);nextGfx.push(ng);}
      const holdLbl=new PIXI.Text('HOLD',new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:8,fill:0x888888,letterSpacing:2}));
      holdLbl.x=-30;holdLbl.y=0;cont.addChild(holdLbl);
      const holdGfx=new PIXI.Graphics();holdGfx.x=-30;holdGfx.y=12;cont.addChild(holdGfx);
      const sst=new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:9,fill:0x666666});
      const stxt=new PIXI.Text('0000000',sst);stxt.x=0;stxt.y=oBH+4;cont.addChild(stxt);
      const flashGfx=new PIXI.Graphics();flashGfx.alpha=0;cont.addChild(flashGfx);
      const renGfx=new PIXI.Graphics();renGfx.alpha=0;cont.addChild(renGfx);
      // Lightning effect layer for opponent B2B
      const lightGfx=new PIXI.Graphics();lightGfx.alpha=0;cont.addChild(lightGfx);
      // 煙レイヤー（cont の外に出るため root に追加）
      const opSmokeLayer=new PIXI.Container();this.root.addChild(opSmokeLayer);
      this.opBoardData[p.id]={
        cont,boardGfx,scoreTxt:stxt,nextGfx,holdGfx,cell:oCell,origX:RX,origY:by,
        board:null,currentPiece:null,nextPieces:null,holdPiece:null,
        shakeX:0,shakeY:0,tilt:0,tiltTarget:0,dead:false,
        boardW:oBW,boardH:oBH,showAbove,isBot,
        gameOverTick:null,origXcenter:RX+oBW/2,origYcenter:by+oBH/2,
        score:0,
        flashGfx,flashAlpha:0,
        renGfx,lightGfx,b2bCount:0,lightTimer:0,
        ren:0,renColor:0x00f5ff,
        smokeLayer:opSmokeLayer,smokeParticles:[],smokeTick:0,
      };
    });
    // スロット位置を保存
    this._opSlotRX=RX;this._opSlotLX=LX;this._opSlotY=by;this._opBW=oBW;
    this.updateVisibleOpponents();
  }

  // 自分のスコアに近い2人を左右に表示する
  updateVisibleOpponents(){
    const myScore=gameState?gameState.score:0;
    const alive=this.opponentPlayers.filter(p=>{
      const d=this.opBoardData[p.id];return d&&!d.dead;
    });
    // スコア差でソート
    const sorted=[...alive].sort((a,b)=>{
      const da=Math.abs((this.opBoardData[a.id].score||0)-myScore);
      const db=Math.abs((this.opBoardData[b.id].score||0)-myScore);
      return da-db;
    });
    // 近い順に最大2人選択（右・左）
    const picks=sorted.slice(0,2);
    // 全員非表示にしてから選んだ2人を表示
    this.opponentPlayers.forEach(p=>{
      const d=this.opBoardData[p.id];if(!d)return;
      d.cont.visible=false;
    });
    picks.forEach((p,i)=>{
      const d=this.opBoardData[p.id];if(!d)return;
      const bx=i===0?this._opSlotRX:this._opSlotLX;
      d.cont.x=bx;d.cont.y=this._opSlotY;
      d.origX=bx;d.origXcenter=bx+this._opBW/2;
      d.cont.visible=true;
    });
  }

  buildMainBoard(){
    const sc=this._uiScale||1;
    this.boardWrap=new PIXI.Container();
    this.boardWrap.x=this.mainBX+BOARD_W*sc/2;
    this.boardWrap.y=this.mainBY+BOARD_H*sc/2;
    this.boardWrap.scale.set(sc);
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
    // Afterimage layer for T-spin residue (rendered above current piece)
    this.afterimageGfx=new PIXI.Graphics();this.afterimageGfx.alpha=0;this.boardCont.addChild(this.afterimageGfx);
    this._afterimageAlpha=0;
    this._afterimageData=null; // {shape, x, y, type}
    this.flashGfx=new PIXI.Graphics();this.flashGfx.alpha=0;this.boardCont.addChild(this.flashGfx);
    // 雷エフェクト（B2B継続中に枠を走る）
    this.lightningGfx=new PIXI.Graphics();this.lightningGfx.alpha=0;this.boardCont.addChild(this.lightningGfx);
    // 煙エフェクトレイヤー（boardCont の外 = 枠の外に出る）
    this.smokeLayer=new PIXI.Container();this.root.addChild(this.smokeLayer);
    this.gMeterCont=new PIXI.Container();
    this.gMeterCont.x=-BOARD_W/2-16;this.gMeterCont.y=-BOARD_H/2;
    this.boardWrap.addChild(this.gMeterCont);
    this.gMeterGfx=new PIXI.Graphics();this.gMeterCont.addChild(this.gMeterGfx);
  }

  buildSideUI(){
    const sc=this._uiScale||1;
    const ui=settings.uiLayout||{};
    const sOffY=ui.sideUiOffsetY||0;
    const fsc=(ui.sideUiFontScale||100)/100;
    const px=this.mainBX+BOARD_W*sc+12,py=this.mainBY+sOffY;
    this.uiCont=new PIXI.Container();this.uiCont.x=px;this.uiCont.y=py;this.root.addChild(this.uiCont);
    const lbl=(t,x,y,col=0x888888)=>Object.assign(new PIXI.Text(t,new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:Math.round(11*fsc),fill:col,letterSpacing:3})),{x,y});
    this.uiCont.addChild(lbl('SCORE',0,0));
    // スコア文字色: 白
    this.scoreTxt=Object.assign(new PIXI.Text('0000000',new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:Math.round(19*fsc),fill:0xffffff,fontWeight:'700'})),{x:0,y:14*fsc});
    this.uiCont.addChild(this.scoreTxt);
    this.uiCont.addChild(lbl('LINES',0,48*fsc));
    this.linesTxt=Object.assign(new PIXI.Text('0',new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:Math.round(14*fsc),fill:0xffbe0b})),{x:0,y:62*fsc});this.uiCont.addChild(this.linesTxt);
    this.uiCont.addChild(lbl('LEVEL',0,90*fsc));
    this.levelTxt=Object.assign(new PIXI.Text('1',new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:Math.round(14*fsc),fill:0xffbe0b})),{x:0,y:104*fsc});this.uiCont.addChild(this.levelTxt);
    // NEXT
    this.nextCont=new PIXI.Container();this.nextCont.x=px;this.nextCont.y=py+145*fsc;this.root.addChild(this.nextCont);
    this.nextCont.addChild(lbl('NEXT',0,0));
    this.nextGfx=[];for(let i=0;i<5;i++){const g=new PIXI.Graphics();g.y=18+i*50;this.nextCont.addChild(g);this.nextGfx.push(g);}
    // HOLD
    this.holdCont=new PIXI.Container();this.holdCont.x=this.mainBX-90;this.holdCont.y=this.mainBY+sOffY;this.root.addChild(this.holdCont);    this.holdCont.addChild(lbl('HOLD',0,0));
    this.holdGfx=new PIXI.Graphics();this.holdGfx.y=18;this.holdCont.addChild(this.holdGfx);
    const n=Object.assign(new PIXI.Text((this.myPlayer?this.myPlayer.name:'').toUpperCase(),new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:Math.round(12*fsc),fill:0x00f5ff,letterSpacing:3})),{x:this.mainBX,y:this.mainBY-22});
    this.root.addChild(n);
  }

  drawCell(gfx,x,y,size,type,alpha=1,lockFlash=0){
    const color=PIECE_COLORS[type]||0x334455,s=size-1;
    gfx.beginFill(color,alpha);gfx.drawRect(x+1,y+1,s-1,s-1);gfx.endFill();
    gfx.beginFill(0xffffff,alpha*0.35);gfx.drawRect(x+1,y+1,s-1,3);gfx.drawRect(x+1,y+1,3,s-1);gfx.endFill();
    gfx.beginFill(0x000000,alpha*0.4);gfx.drawRect(x+1,y+s-2,s-1,2);gfx.drawRect(x+s-2,y+1,2,s-1);gfx.endFill();
    if(settings.quality!=='low'&&settings.quality!=='minimum'){gfx.lineStyle(1,color,alpha*0.45);gfx.drawRect(x+1,y+1,s-1,s-1);gfx.lineStyle(0);}
    if(lockFlash>0){gfx.beginFill(0xffffff,alpha*lockFlash*0.55);gfx.drawRect(x+1,y+1,s-1,s-1);gfx.endFill();}
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
    if(gy===gs.current.y)return;
    const shape=gs._getShapeForPiece(gs.current);
    const pieceColor=PIECE_COLORS[gs.current.type]||0xffffff;
    const fillAlpha=0.22;
    const lineAlpha=0.90;
    const lineWidth=2.5;
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;
      const dr=gy+r-HIDDEN;
      const cx=(gs.current.x+c)*CELL,cy=dr*CELL,s=CELL-1;
      // Fill with piece color (semi-transparent)
      g.lineStyle(0);
      g.beginFill(pieceColor,fillAlpha);
      g.drawRect(cx+1,cy+1,s-1,s-1);
      g.endFill();
      // Bright outline with piece color
      g.lineStyle(lineWidth,pieceColor,lineAlpha);
      g.drawRect(cx+1,cy+1,s-1,s-1);
      g.lineStyle(0);
      // Inner highlight line (top + left) for 3D feel
      g.lineStyle(1,0xffffff,0.45);
      g.moveTo(cx+2,cy+s);g.lineTo(cx+2,cy+2);g.lineTo(cx+s,cy+2);
      g.lineStyle(0);
    }
  }

  drawCurrent(){
    const g=this.currentGfx;g.clear();const gs=this.gs;if(!gs.current)return;
    let lockFlash=0;
    if(gs.lockTimer&&gs.lockStartTime!=null){
      const elapsed=performance.now()-gs.lockStartTime;
      lockFlash=Math.max(0,1-(elapsed/gs.lockDelay));
    }
    const shape=gs._getShapeForPiece(gs.current);
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;const dr=gs.current.y+r-HIDDEN;
      this.drawCell(g,(gs.current.x+c)*CELL,dr*CELL,CELL,gs.current.type,dr<0?0.75:1,lockFlash);
    }
  }

  drawNextPieces(){
    const mc=14;
    this.nextGfx.forEach((gfx,i)=>{
      gfx.clear();
      const entry=this.gs.nextQueue[i];if(!entry)return;
      const type=entry.type||entry; // support old string format
      const customShape=entry.customShape||null;
      const shape=customShape||PIECE_SHAPES[type][0];
      const a=i===0?1:Math.max(0.3,0.85-i*0.15);
      for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++)if(shape[r][c])this.drawCell(gfx,c*mc,r*mc,mc,type,a);
    });
  }

  drawHold(){
    const g=this.holdGfx;g.clear();
    const type=this.gs.holdPiece;if(!type)return;
    const customShape=this.gs.holdCustomShape||null;
    const mc=14,shape=customShape||PIECE_SHAPES[type][0],a=this.gs.holdUsed?0.3:1;
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
        // Support customShape for mutated/bot pieces
        const shape=cp.customShape||PIECE_SHAPES[cp.type]?.[((cp.rotation%4)+4)%4];
        if(shape){
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
        ng.clear();
        const entry=d.nextPieces[i];if(!entry)return;
        const type=entry.type||entry;
        const customShape=entry.customShape||null;
        const shape=customShape||PIECE_SHAPES[type][0];
        const a=i===0?0.9:0.5;
        for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++)if(shape[r][c])this.drawCell(ng,c*mc,r*mc,mc,type,a);
      });
    }
    // 相手HOLD
    if(d.holdGfx){
      d.holdGfx.clear();
      if(d.holdPiece){
        const mc=8;
        const shape=PIECE_SHAPES[d.holdPiece]?.[0];
        if(shape){for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++)if(shape[r][c])this.drawCell(d.holdGfx,c*mc,r*mc,mc,d.holdPiece,0.8);}
      }
    }
    // 相手ボードのフラッシュエフェクト
    if(d.flashGfx&&d.flashAlpha>0){
      d.flashAlpha-=0.06;d.flashGfx.alpha=Math.max(0,d.flashAlpha);
    }
    // 相手ボードのREN表示
    if(d.renGfx&&d.ren>=2&&settings.quality!=='minimum'){
      // Animated border glow based on REN level
      const renColors=[0x00f5ff,0x06d6a0,0xffbe0b,0xff8c00,0xff3366,0xff00ff,0xcc44ff,0xffffff,0x00f5ff];
      const rc=renColors[Math.min(d.ren-2,renColors.length-1)];
      const pulse=0.4+0.3*Math.abs(Math.sin(performance.now()*0.006));
      const g2=d.boardGfx.parent;
      // Just tint the border using cont's child graphics already drawn (bg)
      // Draw glowing border on renGfx
      d.renGfx.clear();
      const lw=1+Math.min(d.ren*0.4,3);
      d.renGfx.lineStyle(lw,rc,pulse*Math.min(1,0.3+(d.ren-2)*0.1));
      d.renGfx.drawRect(0,0,d.boardW,d.boardH);
      d.renGfx.alpha=1;
    } else if(d.renGfx&&d.ren<2){
      d.renGfx.clear();d.renGfx.alpha=0;
    }
    // 相手B2B雷エフェクト更新
    if(d.lightGfx&&d.lightTimer>0&&settings.quality!=='low'&&settings.quality!=='minimum'){
      d.lightTimer-=16;
      const b2b=d.b2bCount||1;
      const lCol=b2b>=5?0xffffff:b2b>=3?0x00f5ff:0xffbe0b;
      d.lightGfx.clear();
      d.lightGfx.alpha=(0.5+0.4*Math.random())*Math.min(1,(d.lightTimer/40));
      const segs=4+Math.floor(b2b*1.2),amp=2+b2b*0.8,lw2=0.8+Math.min(b2b*0.3,1.8);
      d.lightGfx.lineStyle(lw2,lCol,0.9);
      this._drawZigzag(d.lightGfx,0,0,d.boardW,0,segs,amp,'h');
      this._drawZigzag(d.lightGfx,0,d.boardH,d.boardW,d.boardH,segs,amp,'h');
      this._drawZigzag(d.lightGfx,0,0,0,d.boardH,segs,amp,'v');
      this._drawZigzag(d.lightGfx,d.boardW,0,d.boardW,d.boardH,segs,amp,'v');
      if(d.lightTimer<=0){d.lightGfx.clear();d.lightGfx.alpha=0;}
    }
    if(d.shakeX!==0||d.shakeY!==0){
      d._shakeT=(d._shakeT||0)+0.9;
      const sx=Math.sin(d._shakeT*3.8)*Math.abs(d.shakeX)*Math.sign(d.shakeX||1);
      d.shakeX*=0.60;d.shakeY*=0.60;
      if(Math.abs(d.shakeX)<0.1){d.shakeX=0;d.shakeY=0;d._shakeT=0;}
      if(!d.gameOverTick){
        d.cont.rotation=d.tilt;
        d.cont.pivot.set(oBW/2,oBH/2);
        d.cont.x=d.origX+oBW/2+sx;
        d.cont.y=d.origY+oBH/2+d.shakeY;
      }
    } else if(!d.gameOverTick){
      d.cont.rotation=d.tilt;
      d.cont.pivot.set(oBW/2,oBH/2);
      d.cont.x=d.origX+oBW/2;
      d.cont.y=d.origY+oBH/2;
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
    this.updateVisibleOpponents();
  }

  // スピン確定時のみ傾く
  onSpinTilt(dir){
    if(settings.tilt!=='on')return;
    this.tiltTarget=dir>0?0.049:-0.049;
    setTimeout(()=>{this.tiltTarget=0;},292); // T-spin tilt 1.2倍速
  }

  // 回転した瞬間のスピンキラキラ（小さめ・控えめ）
  onSpinRotateSparkle(piece,spinType){
    if(settings.particles==='off'||settings.quality==='minimum')return;
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
    const depth=Math.min(16,Math.floor(dropped*0.48)+4);
    this.boardOffsetY=Math.max(this.boardOffsetY,depth);
    if(settings.particles!=='off'){
      const gs=this.gs;const gy=gs.ghostY();
      const shape=gs._getShapeForPiece(gs.current);
      const col=PIECE_COLORS[gs.current.type]||0xffffff;
      // Hard drop sparkle for ALL pieces (like T-spin sparkle but piece color)
      for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
        if(!shape[r][c])continue;
        const dr=gy+r-HIDDEN;if(dr<0)continue;
        const px=this.mainBX+(gs.current.x+c)*CELL+CELL/2;
        const py=this.mainBY+dr*CELL+CELL/2;
        const n=settings.particles==='high'?4:2;
        for(let i=0;i<n;i++){
          const g=new PIXI.Graphics();
          const sz=Math.random()*2+0.5;
          if(i%2===0){
            g.beginFill(col,0.9);g.moveTo(0,-sz*2);g.lineTo(sz*0.6,0);g.lineTo(0,sz*2);g.lineTo(-sz*0.6,0);g.closePath();g.endFill();
          }else{g.beginFill(col,0.85);g.drawCircle(0,0,sz);g.endFill();}
          g.x=px+(Math.random()-0.5)*CELL*0.7;g.y=py+(Math.random()-0.5)*CELL*0.7;
          this.effectsLayer.addChild(g);
          const angle=Math.random()*Math.PI*2;
          const speed=Math.random()*2.5+0.8;
          this.particles.push({gfx:g,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-2,life:0.85,decay:0.05+Math.random()*0.03});
        }
      }
      // Bottom impact particles
      for(let c=0;c<shape[0].length;c++){
        if(shape[shape.length-1]?.[c]){
          const px=this.mainBX+(gs.current.x+c)*CELL+CELL/2;
          const py=this.mainBY+(gy+shape.length-1-HIDDEN)*CELL+CELL;
          for(let i=0;i<6;i++)this.spawnParticle(px,py,col,true);
        }
      }
    }
  }

  // spin確定時: 白いキラキラを表示 (T-spinは白)
  triggerAfterimage(piece, shape){
    if(settings.particles==='off') return;
    // Store piece snapshot for afterimage rendering
    this._afterimageData = {
      shape: shape.map(r=>[...r]),
      x: piece.x,
      y: piece.y,
      type: piece.type
    };
    this._afterimageAlpha = 0.72; // start semi-transparent
    this._afterimageLife = 300; // ms to keep afterimage
    this.afterimageGfx.alpha = this._afterimageAlpha;
    // Draw immediately
    this._drawAfterimage();
  }

  _drawAfterimage(){
    const g = this.afterimageGfx;
    g.clear();
    const d = this._afterimageData;
    if(!d || this._afterimageAlpha <= 0.01) return;
    const shape = d.shape;
    for(let r=0;r<shape.length;r++) for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c]) continue;
      const dr = d.y + r - HIDDEN;
      if(dr < 0) continue;
      const px = d.x*CELL + c*CELL;
      const py = dr*CELL;
      const color = PIECE_COLORS[d.type] || 0xffffff;
      // Draw as outline + dim fill (pre-spin ghost look)
      g.beginFill(color, 0.25);
      g.lineStyle(1.5, color, 0.9);
      g.drawRect(px+1, py+1, CELL-2, CELL-2);
      g.endFill();
      g.lineStyle(0);
    }
  }

  onSpinSparkle(lockX,lockY,pieceType){
    if(settings.particles==='off')return;
    // T-spin sparkle is WHITE; other spin sparkles use piece color
    const color=0xffffff; // always white for T-spin
    const shape=PIECE_SHAPES[pieceType]?.[0]||[];
    const n=settings.particles==='high'?7:4;
    for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c])continue;
      const dr=lockY+r-HIDDEN;if(dr<0)continue;
      const px=this.mainBX+(lockX+c)*CELL+CELL/2;
      const py=this.mainBY+dr*CELL+CELL/2;
      for(let i=0;i<n;i++){
        const g=new PIXI.Graphics();
        const sz=Math.random()*3+1;
        // Star/cross shape for T-spin sparkle
        if(i%3===0){
          g.beginFill(color,0.95);
          g.moveTo(0,-sz*2.5);g.lineTo(sz*0.5,0);g.lineTo(0,sz*2.5);g.lineTo(-sz*0.5,0);
          g.closePath();g.endFill();
        }else{g.beginFill(color,0.9);g.drawCircle(0,0,sz);g.endFill();}
        g.x=px+(Math.random()-0.5)*CELL;g.y=py+(Math.random()-0.5)*CELL;
        this.effectsLayer.addChild(g);
        const angle=Math.random()*Math.PI*2;
        const speed=Math.random()*3+1;
        this.particles.push({gfx:g,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-2,life:1,decay:0.028+Math.random()*0.02});
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
    // T-SPIN DOUBLE/TRIPLE は色付きフラッシュ
    const isTDouble=spinType==='TSPIN'&&count===2;
    const isTTriple=spinType==='TSPIN'&&count===3;
    const flashColor=isTTriple?0xff00ff:isTDouble?0xcc44ff:allClear?0xffff00:0xffffff;
    cleared.forEach(r=>{const dr=r-HIDDEN;if(dr<0)return;this.flashGfx.beginFill(flashColor,0.9);this.flashGfx.drawRect(0,dr*CELL,BOARD_W,CELL);this.flashGfx.endFill();});
    if(settings.shake==='on')this.shakePower=Math.min(16,count*3+(spinType?5:0)+(allClear?12:0));
    if(count>=4||allClear)this.boardOffsetY=Math.max(this.boardOffsetY,24);
    else if(count>=2)this.boardOffsetY=Math.max(this.boardOffsetY,10);
    if(settings.tilt==='on'&&spinType&&spinType!=='MINI_TSPIN'){
      this.tiltTarget=spinType.startsWith('T')?0.0525:-0.0525;
      setTimeout(()=>{this.tiltTarget=0;},292);
    }
    if(settings.particles!=='off'&&settings.quality!=='minimum'){
      cleared.forEach(r=>{
        const dr=r-HIDDEN;if(dr<0)return;
        const n=settings.particles==='high'?14:5;
        for(let c=0;c<COLS;c++){
          const col=PIECE_COLORS[this.gs.board[r]?.[c]]||0xffffff;
          for(let i=0;i<n;i++)this.spawnParticle(this.mainBX+c*CELL+CELL/2,this.mainBY+dr*CELL+CELL/2,col);
        }
        for(let i=0;i<25;i++)this.spawnParticle(this.mainBX+BOARD_W/2,this.mainBY+dr*CELL+CELL/2,0xffffff,false,true);
      });
      // テトリス（4ライン消し）: 枠から破片が飛び出す演出
      if(count>=4&&settings.particles!=='off'){
        this._spawnBorderBreakEffect(count);
      }
      // T-SPIN DOUBLE: 2つの塊エフェクト
      if(isTDouble&&settings.particles!=='off')this._spawnTSpinChunks(cleared,2,0xcc44ff);
      // T-SPIN TRIPLE: 3つの塊エフェクト
      if(isTTriple&&settings.particles!=='off')this._spawnTSpinChunks(cleared,3,0xff00ff);
    }

    // B2B 雷エフェクト
    if(isB2B){
      this._b2bCount=(this._b2bCount||0)+1;
      this._triggerLightning(this._b2bCount);
    } else if(!isB2B&&!spinType&&count<4){
      this._b2bCount=0;
    }

    // === REN エスカレーティング・エフェクト ===
    if(ren>=2&&settings.quality!=='minimum'){
      this._triggerRenEffect(ren,cleared);
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
      const col=allClear?0xffff44:isB2B?0xffbe0b:isTTriple?0xff00ff:isTDouble?0xcc44ff:spinType?0xff44ff:0x00f5ff;
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

  // ===== REN エスカレーティング・エフェクト =====
  // RENが続くほどよりかっこよくなる
  _triggerRenEffect(ren, cleared){
    if(settings.particles==='off') return;
    const cx=this.mainBX+BOARD_W/2;
    const cy=this._getClearRowsCenterY(cleared);

    // RENレベルに応じた色テーブル
    const renColors=[
      0x00f5ff, // 2: cyan
      0x06d6a0, // 3: green
      0xffbe0b, // 4: yellow
      0xff8c00, // 5: orange
      0xff3366, // 6: pink-red
      0xff00ff, // 7: magenta
      0xcc44ff, // 8: purple
      0xffffff, // 9: white flash
      0x00f5ff, // 10: back to cyan but intense
    ];
    const colorIdx=Math.min(ren-2, renColors.length-1);
    const renColor=renColors[colorIdx];
    const intensity=Math.min(1, 0.3+(ren-2)*0.1); // 0.3 ~ 1.0

    // Tier 1 (REN 2-3): 軽いリングバースト
    if(ren>=2){
      if(settings.quality!=='low'&&settings.quality!=='minimum'){
        const ring=new PIXI.Graphics();
        ring.lineStyle(2+ren*0.3,renColor,0.9);
        ring.drawCircle(0,0,8);
        ring.x=cx;ring.y=cy;
        this.effectsLayer.addChild(ring);
        let rr=8,ra=0.9;
        const expandRing=()=>{
          rr+=8+ren*0.8;ra-=0.055+ren*0.005;
          ring.clear();ring.lineStyle(2+ren*0.3,renColor,Math.max(0,ra));
          ring.drawCircle(0,0,rr);
          if(ra>0)requestAnimationFrame(expandRing);else try{ring.destroy();}catch(e){}
        };
        requestAnimationFrame(expandRing);
      }
    }

    // Tier 2 (REN 4+): 四方に光の柱
    if(ren>=4&&settings.particles==='high'){
      const dirs=[[0,-1],[0,1],[-1,0],[1,0]];
      const n=Math.min(ren, 8);
      dirs.forEach(([dx,dy])=>{
        for(let i=0;i<n;i++){
          const g=new PIXI.Graphics();
          const sz=3+Math.random()*3;
          g.beginFill(renColor, 0.9);
          g.moveTo(0,-sz*2);g.lineTo(sz*0.5,0);g.lineTo(0,sz*2);g.lineTo(-sz*0.5,0);
          g.closePath();g.endFill();
          g.x=cx+(Math.random()-0.5)*BOARD_W*0.5;
          g.y=cy+(Math.random()-0.5)*CELL*4;
          this.effectsLayer.addChild(g);
          const speed=4+Math.random()*ren*0.7;
          this.particles.push({gfx:g,vx:dx*speed+(Math.random()-0.5)*2,vy:dy*speed+(Math.random()-0.5)*2-2,life:0.9,decay:0.03+Math.random()*0.02});
        }
      });
    }

    // Tier 3 (REN 6+): ボード全体フラッシュ + 螺旋
    if(ren>=6&&settings.quality!=='low'&&settings.quality!=='minimum'){
      // Board edge glow flash
      if(this.boardBorder){
        this.boardBorder.clear();
        this.boardBorder.lineStyle(3,renColor,0.95);
        this.boardBorder.drawRect(-2,-ABOVE_BOARD,BOARD_W+4,BOARD_H+ABOVE_BOARD+4);
        this._borderNormal=false;
        setTimeout(()=>{if(this.boardBorder){this._borderNormal=false;}},150);
      }
      // Screen flash overlay
      this._flashAlpha=Math.min(1.5, this._flashAlpha+0.4*intensity);
      this.flashGfx.beginFill(renColor, 0.25*intensity);
      this.flashGfx.drawRect(-BOARD_W*0.1, -BOARD_H*0.1, BOARD_W*1.2, BOARD_H*1.2);
      this.flashGfx.endFill();
      // 螺旋パーティクル
      if(settings.particles==='high'){
        const spiralN=Math.floor(8+ren*1.5);
        for(let i=0;i<spiralN;i++){
          const angle=(i/spiralN)*Math.PI*2;
          const r2=30+ren*5;
          const g=new PIXI.Graphics();
          const sz=2+Math.random()*3;
          g.beginFill(renColor,0.95);g.drawCircle(0,0,sz);g.endFill();
          g.x=cx+Math.cos(angle)*r2;g.y=cy+Math.sin(angle)*r2;
          this.effectsLayer.addChild(g);
          const speed=3+ren*0.5+Math.random()*2;
          const outDir=angle+Math.PI*0.5; // tangential
          this.particles.push({gfx:g,vx:Math.cos(outDir)*speed+(Math.random()-0.5)*2,vy:Math.sin(outDir)*speed-3,life:1,decay:0.02+Math.random()*0.02});
        }
      }
    }

    // Tier 4 (REN 9+): ULTRA フルスクリーン雷 + 爆発
    if(ren>=9&&settings.quality==='ultra'){
      // Extra lightning bolts from board edges
      this._triggerLightning(10);
      this._b2bCount=Math.max(this._b2bCount||0, 5); // force intense lightning color
      // Massive burst from center
      if(settings.particles==='high'){
        const n=40;
        for(let i=0;i<n;i++){
          const g=new PIXI.Graphics();
          const sz=Math.random()*7+2;
          g.beginFill(i%3===0?0xffffff:renColor, 0.95);
          if(i%2===0){g.drawCircle(0,0,sz);}
          else{g.moveTo(0,-sz*2.5);g.lineTo(sz*0.5,0);g.lineTo(0,sz*2.5);g.lineTo(-sz*0.5,0);g.closePath();}
          g.endFill();
          g.x=cx+(Math.random()-0.5)*BOARD_W;
          g.y=cy+(Math.random()-0.5)*BOARD_H*0.6;
          this.effectsLayer.addChild(g);
          const angle=Math.random()*Math.PI*2;
          const speed=4+Math.random()*8;
          this.particles.push({gfx:g,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-4,life:1,decay:0.018+Math.random()*0.018});
        }
        // Shockwave rings
        for(let k=0;k<3;k++){
          setTimeout(()=>{
            const sw=new PIXI.Graphics();sw.lineStyle(3+k,renColor,0.9);sw.drawCircle(0,0,6);
            sw.x=cx;sw.y=cy;this.effectsLayer.addChild(sw);
            let sr=6,sa=0.9;
            const swT=()=>{sr+=10+k*4;sa-=0.055;sw.clear();sw.lineStyle(3+k,renColor,Math.max(0,sa));sw.drawCircle(0,0,sr);
              if(sa>0)requestAnimationFrame(swT);else try{sw.destroy();}catch(e){}};
            requestAnimationFrame(swT);
          }, k*80);
        }
      }
    }

    // REN表示をかっこよく更新（ren数に応じてサイズ・色変化）
    this._showRenDisplay(ren, renColor, intensity);
  }

  // REN数をかっこよく画面左側に大きく表示
  _showRenDisplay(ren, color, intensity){
    if(settings.quality==='minimum') return;
    // 既存のRENラベルを削除
    if(this._renDisplayGfx){try{this._renDisplayGfx.destroy();}catch(e){}this._renDisplayGfx=null;}
    if(this._renLabelText){try{this._renLabelText.destroy();}catch(e){}this._renLabelText=null;}
    if(this._renNumText){try{this._renNumText.destroy();}catch(e){}this._renNumText=null;}

    const fontSize=Math.min(20+ren*4, 72); // 続くほど大きく
    const lx=this.mainBX-130;
    const ly=this.mainBY+BOARD_H*0.4;

    // 背景グロー
    if(settings.quality!=='low'){
      const bg=new PIXI.Graphics();
      const glowR=fontSize*1.5*intensity;
      bg.beginFill(color,0.12*intensity);bg.drawCircle(0,0,glowR);bg.endFill();
      bg.beginFill(color,0.06*intensity);bg.drawCircle(0,0,glowR*1.8);bg.endFill();
      bg.x=lx;bg.y=ly;
      this.effectsLayer.addChild(bg);
      this._renDisplayGfx=bg;
    }

    const numStyle=new PIXI.TextStyle({fontFamily:'Orbitron',fontSize,fill:color,fontWeight:'900',
      dropShadow:true,dropShadowColor:color,dropShadowDistance:0,dropShadowBlur:Math.min(30,8+ren*2),
      letterSpacing:2});
    const renNum=new PIXI.Text(ren.toString(),numStyle);
    renNum.anchor.set(0.5);renNum.x=lx;renNum.y=ly;
    renNum.alpha=0;renNum.scale.set(2);
    this.app.stage.addChild(renNum);
    this._renNumText=renNum;

    const lblStyle=new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:Math.min(11+ren,18),fill:color,fontWeight:'700',letterSpacing:4,
      dropShadow:true,dropShadowColor:color,dropShadowDistance:0,dropShadowBlur:6});
    const renLbl=new PIXI.Text('REN',lblStyle);
    renLbl.anchor.set(0.5);renLbl.x=lx;renLbl.y=ly-fontSize*0.9;
    renLbl.alpha=0;
    this.app.stage.addChild(renLbl);
    this._renLabelText=renLbl;

    // ポップインアニメ
    let t=0;
    const pop=()=>{
      t+=16;const p=Math.min(1,t/200);const ease=1-(1-p)*(1-p);
      renNum.scale.set(2-ease);renNum.alpha=ease;
      renLbl.alpha=ease;
      if(p<1)requestAnimationFrame(pop);
    };
    requestAnimationFrame(pop);

    // 自動フェードアウト
    setTimeout(()=>{
      let ft=0;
      const fade=()=>{
        ft+=16;const p=Math.min(1,ft/600);
        renNum.alpha=1-p;renLbl.alpha=1-p;
        if(this._renDisplayGfx)this._renDisplayGfx.alpha=(1-p)*0.12*intensity;
        if(p<1)requestAnimationFrame(fade);
        else{
          try{renNum.destroy();}catch(e){}try{renLbl.destroy();}catch(e){}
          if(this._renDisplayGfx){try{this._renDisplayGfx.destroy();}catch(e){}this._renDisplayGfx=null;}
          this._renNumText=null;this._renLabelText=null;
        }
      };
      requestAnimationFrame(fade);
    }, 1200);
  }

  // T-SPIN DOUBLE/TRIPLE 専用塊エフェクト
  _spawnTSpinChunks(cleared,chunkCount,color){
    const centerY=this._getClearRowsCenterY(cleared);
    const cx=this.mainBX+BOARD_W/2;
    for(let k=0;k<chunkCount;k++){
      // 各塊：角度を均等に分散
      const angle=(k/chunkCount)*Math.PI*2 - Math.PI/2;
      const g=new PIXI.Graphics();
      const sz=10+Math.random()*6;
      g.beginFill(color,0.95);
      g.drawRoundedRect(-sz/2,-sz/2,sz,sz,3);
      g.endFill();
      g.beginFill(0xffffff,0.5);
      g.drawRect(-sz/2,-sz/2,sz,4);
      g.endFill();
      // ラインアウトライン
      g.lineStyle(1.5,0xffffff,0.8);
      g.drawRoundedRect(-sz/2,-sz/2,sz,sz,3);
      g.lineStyle(0);
      g.x=cx;g.y=centerY;
      this.effectsLayer.addChild(g);
      const speed=6+Math.random()*4;
      this._lightningBolts.push({
        gfx:g,
        vx:Math.cos(angle)*speed,
        vy:Math.sin(angle)*speed-2,
        life:1,
        decay:0.025+Math.random()*0.015,
        rot:Math.random()*0.3-0.15,
        isChunk:true
      });
    }
  }

  // テトリス消し: 枠の4辺から「くの字」の棒が重力で落下する演出
  _spawnBorderBreakEffect(lineCount){
    if(settings.quality==='minimum'||settings.quality==='low')return;
    const sc2=this._uiScale||1;
    const bx=this.mainBX, by=this.mainBY;
    const bw=BOARD_W*sc2, bh2=BOARD_H*sc2;
    const numRods=settings.particles==='high'?14:8;
    // 枠の4辺からランダムにスポーン
    for(let i=0;i<numRods;i++){
      const side=Math.floor(Math.random()*4);
      let px,py;
      if(side===0){px=bx+Math.random()*bw;py=by;} // 上辺
      else if(side===1){px=bx+Math.random()*bw;py=by+bh2;} // 下辺
      else if(side===2){px=bx;py=by+Math.random()*bh2;} // 左辺
      else{px=bx+bw;py=by+Math.random()*bh2;} // 右辺
      // くの字の棒を描画（2本のセグメントを中心で折り曲げ）
      const g=new PIXI.Graphics();
      const len=CELL*(0.5+Math.random()*0.6)*sc2;
      const bendAngle=(Math.random()-0.5)*1.2; // 折れ曲がり角度
      const col=0x00f5ff;
      const col2=0xffffff;
      g.lineStyle(2,col,0.95);
      // 第1セグメント (中心から)
      const seg1X=Math.cos(bendAngle)*len*0.5;
      const seg1Y=-Math.sin(bendAngle)*len*0.5;
      g.moveTo(0,0);g.lineTo(seg1X,seg1Y);
      // 第2セグメント (折れ曲がって)
      const seg2Angle=bendAngle+(Math.random()-0.5)*1.5;
      const seg2X=seg1X+Math.cos(seg2Angle)*len*0.5;
      const seg2Y=seg1Y-Math.sin(seg2Angle)*len*0.5;
      g.lineTo(seg2X,seg2Y);
      // 端点に小さい丸
      g.lineStyle(0);
      g.beginFill(col2,0.9);g.drawCircle(0,0,2);g.endFill();
      g.beginFill(col,0.8);g.drawCircle(seg2X,seg2Y,1.5);g.endFill();
      g.x=px;g.y=py;
      this.effectsLayer.addChild(g);
      // 初速: ランダム方向、重力で下に落ちる
      const vx=(Math.random()-0.5)*4+((side===2)?-1:(side===3)?1:0);
      const vy=(Math.random()-0.5)*2+((side===0)?-2:0.5); // 上辺からは上方向に
      const rot=(Math.random()-0.5)*0.18;
      this._lightningBolts.push({
        gfx:g,vx,vy,life:1,decay:0.016+Math.random()*0.01,
        rot,isChunk:true
      });
    }
  }

  // B2B 雷エフェクト: 枠の周囲をジグザグの雷が走る
  _triggerLightning(b2bCount){
    if(settings.quality==='low'||settings.quality==='minimum')return;
    this._lightningTimer=Math.min(80,40+b2bCount*8); // B2Bが続くほど長く
    this._b2bIntensity=Math.min(1,0.4+b2bCount*0.12);
  }

  _drawLightning(dt){
    if(!this.lightningGfx)return;
    if(this._lightningTimer>0){
      this._lightningTimer-=dt;
      const g=this.lightningGfx;g.clear();
      const intensity=this._b2bIntensity||0.7;
      // B2Bが多いほど色が変わる: 黄→シアン→白
      const b2b=this._b2bCount||1;
      const lCol=b2b>=5?0xffffff:b2b>=3?0x00f5ff:0xffbe0b;
      g.alpha=intensity*(0.6+0.4*Math.random());
      // 枠の4辺それぞれに雷
      const bw=BOARD_W,bh=BOARD_H;
      const segs=6+Math.floor(b2b*1.5); // セグメント数
      const amp=3+b2b*1.2; // 振れ幅
      const lw=1+Math.min(b2b*0.4,2.5);
      g.lineStyle(lw,lCol,0.9);
      // 上辺
      this._drawZigzag(g,0,-ABOVE_BOARD,bw,-ABOVE_BOARD,segs,amp,'h');
      // 下辺
      this._drawZigzag(g,0,bh,bw,bh,segs,amp,'h');
      // 左辺
      this._drawZigzag(g,0,-ABOVE_BOARD,0,bh,segs,amp,'v');
      // 右辺
      this._drawZigzag(g,bw,-ABOVE_BOARD,bw,bh,segs,amp,'v');
      // B2B 5以上: 追加の内側フラッシュ
      if(b2b>=5){
        g.lineStyle(lw*0.6,0xffffff,0.4*Math.random());
        this._drawZigzag(g,4,-ABOVE_BOARD+4,bw-4,-ABOVE_BOARD+4,segs,amp*0.5,'h');
      }
    } else {
      if(this.lightningGfx.alpha>0){
        this.lightningGfx.alpha*=0.75;
        if(this.lightningGfx.alpha<0.03)this.lightningGfx.clear();
      }
    }
  }

  _drawZigzag(g,x1,y1,x2,y2,segs,amp,dir){
    g.moveTo(x1,y1);
    for(let i=1;i<=segs;i++){
      const t=i/segs;
      const offset=(Math.random()-0.5)*2*amp;
      const px=x1+(x2-x1)*t + (dir==='h'?0:offset);
      const py=y1+(y2-y1)*t + (dir==='v'?0:offset);
      g.lineTo(px,py);
    }
    g.lineTo(x2,y2);
  }

  // おじゃまグループ追加時のシェイク（行数に応じた振動）
  onGarbageRowAdded(count=1){
    if(settings.shake==='on'){
      const power=Math.min(12,4.5+count*2.25); // 1.5倍強度
      this.shakePower=Math.max(this.shakePower,power);
      clearTimeout(this._garbageShakePulse);
      this._garbageShakePulse=setTimeout(()=>{
        this.shakePower=Math.max(this.shakePower,power*0.7);
      },40); // 1.5倍速（60ms→40ms）
    }
    // ガベージフラッシュ: 枠を赤く再描画
    if(this.boardBorder){
      this.boardBorder.clear();
      this.boardBorder.lineStyle(3,0xff3333,1.0);
      this.boardBorder.drawRect(-2,-ABOVE_BOARD,BOARD_W+4,BOARD_H+ABOVE_BOARD+4);
    }
    this._garbageFlashing=true;
    this._borderNormal=false;
    setTimeout(()=>{if(this.boardBorder){
      this._garbageFlashing=false;
      this._borderNormal=false; // force redraw next frame
    }},133);
  }

  onGarbageIncoming(lines,fromId){
    const d=this.opBoardData[fromId];if(!d)return;
    const sx=d.origX+(COLS*d.cell)/2,sy=d.origY+(d.boardH||ROWS*d.cell)/2;
    const tx=this.mainBX-8,ty=this.mainBY+BOARD_H*0.5;
    const isBig=lines>=4;
    const color=isBig?0x00f5ff:0xff3333;
    const visualPower=isBig?lines+4:lines;
    this.spawnProjectile(sx,sy,tx,ty,color,visualPower);
  }

  onAttackProjectile(targetId,attack,launchY){
    const d=this.opBoardData[targetId];if(!d)return;
    const sx=this.mainBX+BOARD_W/2;
    const sy=launchY!==undefined?launchY:this.mainBY+BOARD_H*0.5;
    // ターゲット: 相手ボードのゲージメーター位置（ボード左端）
    const tx=d.origX-12;
    const ty=d.origY+d.boardH*0.5;
    this.spawnProjectile(sx,sy,tx,ty,0x00f5ff,attack);
    SFX.attack();
  }

  onGarbageApplied(lines){
    // シェイクはonGarbageRowAddedで行う
  }

  // 自分のゲームオーバー: ミノ単位でバラバラに落下 + 枠も斜めに落下
  onGameOver(){
    SFX.gameover();
    const wrap=this.boardWrap;
    wrap.visible=false;
    // 枠を独立したContainerとして斜め落下させる
    const sc2=this._uiScale||1;
    const frameGfx=new PIXI.Graphics();
    frameGfx.lineStyle(3,0x00f5ff,0.9);
    frameGfx.drawRect(-2,-ABOVE_BOARD*sc2,BOARD_W*sc2+4,BOARD_H*sc2+ABOVE_BOARD*sc2+4);
    frameGfx.x=this.mainBX;
    frameGfx.y=this.mainBY;
    this.effectsLayer.addChild(frameGfx);
    // ランダムに傾いて落下
    const frameVX=(Math.random()>0.5?1:-1)*(1.5+Math.random()*2);
    const frameVY=0;
    const frameRot=0;
    const frameRotSpeed=(Math.random()-0.5)*0.04;
    this._fallingFrame={gfx:frameGfx,vx:frameVX,vy:frameVY,vy0:0,rot:frameRotSpeed,alpha:1,pivotX:this.mainBX+BOARD_W*sc2/2,pivotY:this.mainBY+BOARD_H*sc2/2};

    const gs=this.gs;
    const originX=this.mainBX;
    const originY=this.mainBY;

    // Group connected cells of same type using flood-fill (BFS)
    // to approximate "mino pieces" without needing original placement data
    const board=gs.board;
    const visited=Array.from({length:ROWS+HIDDEN},()=>Array(COLS).fill(false));
    const groups=[];

    for(let r=0;r<ROWS+HIDDEN;r++){
      for(let c=0;c<COLS;c++){
        const v=board[r][c];
        if(!v||v===0||visited[r][c])continue;
        // BFS to find connected cells of same type (max 4 cells = one piece)
        const cells=[];
        const queue=[[r,c]];
        visited[r][c]=true;
        while(queue.length&&cells.length<4){
          const[cr,cc]=queue.shift();
          cells.push([cr,cc]);
          for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
            const nr=cr+dr,nc=cc+dc;
            if(nr>=0&&nr<ROWS+HIDDEN&&nc>=0&&nc<COLS&&
               !visited[nr][nc]&&board[nr][nc]===v){
              visited[nr][nc]=true;
              queue.push([nr,nc]);
            }
          }
        }
        groups.push({type:v,cells});
      }
    }

    // Build a PIXI container per group
    const minoParticles=[];
    for(const grp of groups){
      const color=PIECE_COLORS[grp.type]||0x445566;
      // Compute centroid in screen space
      let cx=0,cy=0;
      for(const[r,c]of grp.cells){
        cx+=originX+c*CELL+CELL/2;
        cy+=originY+(r-HIDDEN)*CELL+CELL/2;
      }
      cx/=grp.cells.length;
      cy/=grp.cells.length;
      if(cy<originY-CELL*3)continue; // skip groups completely above visible area

      const cont=new PIXI.Container();
      cont.x=cx;cont.y=cy;
      this.effectsLayer.addChild(cont);

      for(const[r,c]of grp.cells){
        const px=originX+c*CELL+CELL/2-cx;
        const py=originY+(r-HIDDEN)*CELL+CELL/2-cy;
        const g=new PIXI.Graphics();
        const s=CELL-2;
        g.beginFill(color,1);g.drawRect(-s/2,-s/2,s,s);g.endFill();
        g.beginFill(0xffffff,0.35);g.drawRect(-s/2,-s/2,s,3);g.drawRect(-s/2,-s/2,3,s);g.endFill();
        g.beginFill(0x000000,0.4);g.drawRect(-s/2,s/2-2,s,2);g.drawRect(s/2-2,-s/2,2,s);g.endFill();
        g.x=px;g.y=py;
        cont.addChild(g);
      }

      // Each mino gets a gentle random velocity (no big upward kick)
      const angle=Math.random()*Math.PI*2;
      const speed=Math.random()*1.8+0.4;
      const vx=Math.cos(angle)*speed;
      const vy=Math.sin(angle)*speed*0.5-0.8; // slight upward bias
      const rotSpeed=(Math.random()-0.5)*0.06;
      minoParticles.push({cont,vx,vy,rotSpeed,alpha:1});
    }

    let t=0;
    this._gameOverTick=(dt)=>{
      t+=dt;
      for(const p of minoParticles){
        if(p.alpha<=0)continue;
        p.vy+=0.12; // gentle gravity
        p.vx*=0.992;
        p.cont.x+=p.vx;
        p.cont.y+=p.vy;
        p.cont.rotation+=p.rotSpeed;
        // Fade out once well below the board
        const distBelow=p.cont.y-(originY+BOARD_H+60);
        if(distBelow>0){
          p.alpha=Math.max(0,1-distBelow/400);
          p.cont.alpha=p.alpha;
        }
      }
      // 枠の落下アニメ
      if(this._fallingFrame&&this._fallingFrame.alpha>0){
        const ff=this._fallingFrame;
        ff.vy0+=0.4;
        ff.gfx.x+=ff.vx;
        ff.gfx.y+=ff.vy0;
        ff.gfx.rotation+=ff.rot;
        // ピボット中心で回転するようにtransformOriginを調整
        const distB2=ff.gfx.y-(originY+BOARD_H+200);
        if(distB2>0){
          ff.alpha=Math.max(0,1-distB2/500);
          ff.gfx.alpha=ff.alpha;
        }
        if(ff.alpha<=0){try{ff.gfx.destroy();}catch(e){}this._fallingFrame=null;}
      }
    };
  }

  // 相手のゲームオーバー: 横揺れ→斜め落下
  opponentGameOver(pid){
    const d=this.opBoardData[pid];if(!d||d.dead)return;
    d.dead=true;
    // 煙をクリーンアップ
    if(d.smokeParticles){d.smokeParticles.forEach(p=>{try{p.gfx.destroy();}catch(e){}});d.smokeParticles=[];}
    if(d.smokeLayer){try{d.smokeLayer.destroy({children:true});}catch(e){}d.smokeLayer=null;}
    this.updateVisibleOpponents();
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

  triggerOpponentLineClear(pid,count,spinType,isB2B,ren,allClear){
    const d=this.opBoardData[pid];if(!d||d.dead)return;
    if(settings.quality==='minimum')return;

    // フラッシュ
    const isTDouble=spinType==='TSPIN'&&count===2;
    const isTTriple=spinType==='TSPIN'&&count===3;
    const flashColor=isTTriple?0xff00ff:isTDouble?0xcc44ff:allClear?0xffff00:0xffffff;
    if(d.flashGfx){
      d.flashGfx.clear();
      const oCell=d.cell,oBW=d.boardW,oBH=d.boardH;
      d.flashGfx.beginFill(flashColor,0.7);d.flashGfx.drawRect(0,0,oBW,oBH);d.flashGfx.endFill();
      d.flashAlpha=0.7;
    }

    // シェイク
    if(settings.shake==='on'){
      d.shakeX=Math.min(8,count*2+(spinType?3:0)+(allClear?8:0));
      d.shakeY=d.shakeX*0.5;
    }

    // REN更新
    d.ren=ren||0;
    const renColors=[0x00f5ff,0x06d6a0,0xffbe0b,0xff8c00,0xff3366,0xff00ff,0xcc44ff,0xffffff,0x00f5ff];
    d.renColor=renColors[Math.min(Math.max(0,ren-2),renColors.length-1)];

    // B2B雷
    if(isB2B&&settings.quality!=='low'){
      d.b2bCount=(d.b2bCount||0)+1;
      d.lightTimer=Math.min(80,40+d.b2bCount*8);
    }

    // テトリス/スピン: 傾き
    if(count>=4||allClear||(spinType&&spinType!=='MINI_TSPIN')){
      d.tiltTarget=(spinType&&spinType.startsWith('T'))?0.06:-0.06;
      setTimeout(()=>{if(d)d.tiltTarget=0;},350);
    }

    // パーティクル: 相手ボードの中心から噴出
    if(settings.particles!=='off'&&settings.quality!=='low'){
      const oBW=d.boardW,oBH=d.boardH;
      const pcx=d.origX+oBW/2;
      const pcy=d.origY+oBH*0.4;
      const color=allClear?0xffff44:isTTriple?0xff00ff:isTDouble?0xcc44ff:spinType?0xff44ff:0x00f5ff;
      const n=settings.particles==='high'?Math.min(12+count*3,24):6;
      for(let i=0;i<n;i++){
        const g=new PIXI.Graphics();
        const sz=Math.random()*3+1;
        g.beginFill(color,0.9);g.drawCircle(0,0,sz);g.endFill();
        g.x=pcx+(Math.random()-0.5)*oBW*0.6;
        g.y=pcy+(Math.random()-0.5)*oBH*0.3;
        this.effectsLayer.addChild(g);
        const angle=Math.random()*Math.PI*2;
        const speed=2+Math.random()*4;
        this.particles.push({gfx:g,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-3,life:0.9,decay:0.04+Math.random()*0.03});
      }
      // REN2+: リングエフェクト
      if(ren>=2&&settings.quality!=='low'&&settings.quality!=='minimum'){
        const rc=d.renColor;
        const ring=new PIXI.Graphics();
        ring.lineStyle(1.5+ren*0.2,rc,0.85);ring.drawCircle(0,0,5);
        ring.x=pcx;ring.y=pcy;
        this.effectsLayer.addChild(ring);
        let rr=5,ra=0.85;
        const expandRing=()=>{
          rr+=5+ren*0.5;ra-=0.07;
          ring.clear();ring.lineStyle(1.5+ren*0.2,rc,Math.max(0,ra));ring.drawCircle(0,0,rr);
          if(ra>0)requestAnimationFrame(expandRing);else try{ring.destroy();}catch(e){}
        };
        requestAnimationFrame(expandRing);
      }
    }
  }

  updateBoardAnim(dt){
    if(this.boardOffsetY>0){this.boardOffsetY*=0.63;if(this.boardOffsetY<0.3)this.boardOffsetY=0;}
    // T-spin afterimage fade
    if(this._afterimageAlpha>0.01){
      if(this._afterimageLife!==undefined&&this._afterimageLife>0){
        this._afterimageLife-=dt;
        // Hold at full alpha for 300ms, then fade
        if(this._afterimageLife>0){
          this.afterimageGfx.alpha=this._afterimageAlpha;
        } else {
          this._afterimageAlpha*=0.78;
          this.afterimageGfx.alpha=Math.max(0,this._afterimageAlpha);
        }
      } else {
        this._afterimageAlpha*=0.78;
        this.afterimageGfx.alpha=Math.max(0,this._afterimageAlpha);
      }
      this._drawAfterimage();
      if(this._afterimageAlpha<=0.01){this._afterimageAlpha=0;this.afterimageGfx.clear();this.afterimageGfx.alpha=0;}
    }
    this.tiltAngle+=(this.tiltTarget-this.tiltAngle)*0.21;
    if(Math.abs(this.tiltAngle)<0.0005&&Math.abs(this.tiltTarget)<0.0005)this.tiltAngle=0;
    if(settings.tilt==='on')this.boardCont.rotation=this.tiltAngle;else this.boardCont.rotation=0;
    if(this.shakePower>0){
      this._shakeT=(this._shakeT||0)+0.9;
      this.boardOffsetX=Math.sin(this._shakeT*3.8)*this.shakePower;
      this.shakePower*=0.52;
      if(this.shakePower<0.15){this.shakePower=0;this.boardOffsetX=0;this._shakeT=0;}
    }
    this.wallBumpX*=0.55;
    if(Math.abs(this.wallBumpX)<0.2)this.wallBumpX=0;

    if(this._gameOverTick){
      this._gameOverTick(dt);
    } else {
      const sc=this._uiScale||1;
      this.boardWrap.x=this.mainBX+BOARD_W*sc/2+this.boardOffsetX+this.wallBumpX;
      this.boardWrap.y=this.mainBY+BOARD_H*sc/2+this.boardOffsetY;
    }
    for(const pid of Object.keys(this.opBoardData)){
      const d=this.opBoardData[pid];
      if(d.gameOverTick)d.gameOverTick(dt);
    }
    if(this._flashAlpha>0){this._flashAlpha-=0.06;this.flashGfx.alpha=Math.max(0,this._flashAlpha);}

    // B2B 雷エフェクト更新
    this._drawLightning(dt);

    // 塊チャンク（_lightningBolts にまとめて格納）
    this._lightningBolts=this._lightningBolts.filter(p=>{
      if(!p.isChunk)return false;
      p.life-=p.decay;p.gfx.alpha=p.life;
      p.gfx.x+=p.vx;p.gfx.y+=p.vy;p.vy+=0.35;p.gfx.rotation+=p.rot;
      if(p.life<=0){try{p.gfx.destroy();}catch(e){}return false;}
      return true;
    });

    // 危機煙エフェクト
    this._updateSmoke(dt);
  }

  // 危機状態の煙エフェクト（リアル煙）
  _updateSmoke(dt){
    if(!this.gs||settings.particles==='off'||settings.quality==='minimum')return;

    // 積み上がりの最高行を計算（board配列上のインデックス）
    let topRow=ROWS+HIDDEN; // 何も積まれていない = 最大値
    for(let r=0;r<ROWS+HIDDEN;r++){
      for(let c=0;c<COLS;c++){
        if(this.gs.board[r][c]){topRow=r;break;}
      }
      if(topRow<ROWS+HIDDEN)break;
    }

    // 上から4行目（visible top = HIDDEN行目）まで積まれたら危機
    const dangerStart=HIDDEN+4;
    const danger=Math.max(0,Math.min(1,(dangerStart-topRow)/4)); // 0~1

    // 枠の色を danger に応じてシアン→赤に変化
    if(this.boardBorder&&!this._garbageFlashing){
      if(danger>0){
        const pulse=0.6+0.4*Math.abs(Math.sin(performance.now()*0.004));
        // boardBorder は Graphics なので tint ではなく再描画で色変更
        const r2=Math.min(255,Math.floor(0xff*danger));
        const g2=Math.min(255,Math.floor(0xf5*(1-danger)));
        const b2=Math.min(255,Math.floor(0xff*(1-danger*0.8)));
        const borderCol=(r2<<16)|(g2<<8)|b2;
        this.boardBorder.clear();
        this.boardBorder.lineStyle(2+danger*2,borderCol,0.6+0.4*pulse);
        this.boardBorder.drawRect(-2,-ABOVE_BOARD,BOARD_W+4,BOARD_H+ABOVE_BOARD+4);
        this.boardBorder.alpha=1;
      } else {
        if(!this._borderNormal){
          this._borderNormal=true;
          this.boardBorder.clear();
          this.boardBorder.lineStyle(2,0x00f5ff,0.8);
          this.boardBorder.drawRect(-2,-ABOVE_BOARD,BOARD_W+4,BOARD_H+ABOVE_BOARD+4);
        }
        this.boardBorder.alpha=1;
      }
    }
    if(danger>0)this._borderNormal=false;

    if(danger<=0){
      // 煙パーティクルをフェードアウト
      this._smokeParticles=this._smokeParticles.filter(p=>{
        p.life-=0.025;
        p.gfx.alpha=Math.max(0,p.life*p.maxAlpha);
        p.gfx.x+=p.vx;p.gfx.y+=p.vy;
        p.vx+=(Math.random()-0.5)*0.04; // 乱流
        p.gfx.scale.x*=p.expandX;p.gfx.scale.y*=p.expandY;
        p.gfx.rotation+=p.rot;
        if(p.life<=0){try{p.gfx.destroy();}catch(e){}return false;}return true;
      });
      return;
    }

    // 煙の生成レート: 危機度に応じて増加（量を抑制）
    this._smokeTick=(this._smokeTick||0)+dt;
    const rate=Math.max(80,220-danger*140);
    if(this._smokeTick>=rate){
      this._smokeTick=0;
      const n=settings.particles==='high'?Math.ceil(1+danger*2):1;
      // 枠の4角から煙が出る
      const sc2=this._uiScale||1;
      const bx=this.mainBX, by=this.mainBY, bw=BOARD_W*sc2, bh2=BOARD_H*sc2;
      const corners=[
        [bx+Math.random()*20-10,        by+Math.random()*20-10],        // 左上
        [bx+bw+Math.random()*20-10,     by+Math.random()*20-10],        // 右上
        [bx+Math.random()*20-10,        by+bh2+Math.random()*20-10],    // 左下
        [bx+bw+Math.random()*20-10,     by+bh2+Math.random()*20-10],    // 右下
      ];
      for(let i=0;i<n;i++){
        const corner=corners[Math.floor(Math.random()*4)];
        this._spawnNoiseSmokePuff(corner[0],corner[1],danger,this.smokeLayer,this._smokeParticles);
      }
    }
    // 既存煙を更新
    this._smokeParticles=this._smokeParticles.filter(p=>{
      p.life-=p.decay;
      // フェーズ別アルファ: 立ち上がり→最大→フェードアウト
      const lifeRatio=p.life/p.maxLife;
      let alpha;
      if(lifeRatio>0.8){alpha=p.maxAlpha*(1-lifeRatio)*5;}
      else if(lifeRatio>0.3){alpha=p.maxAlpha;}
      else{alpha=p.maxAlpha*(lifeRatio/0.3);}
      p.gfx.alpha=Math.max(0,alpha);
      p.gfx.x+=p.vx;p.gfx.y+=p.vy;
      // 乱流: ランダムな横揺れ
      p.vx+=(Math.random()-0.5)*0.06;
      p.vx*=0.98;
      // 上昇は徐々に遅くなる
      p.vy*=0.992;
      // 拡大（膨張）
      p.gfx.scale.x*=p.expandX;p.gfx.scale.y*=p.expandY;
      p.gfx.rotation+=p.rot;
      if(p.life<=0){try{p.gfx.destroy();}catch(e){}return false;}return true;
    });
  }

  // リアルな煙パフを1つスポーン（複数レイヤーで厚みを出す）
  _spawnRealisticSmokePuff(sx, sy, danger, layer, list){
    this._spawnNoiseSmokePuff(sx, sy, danger, layer, list);
  }

  // ノイズベースの煙パフ（吹き出す感じ）
  _spawnNoiseSmokePuff(sx, sy, danger, layer, list){
    const layerCount=1; // 量を抑制
    for(let L=0;L<layerCount;L++){
      const g=new PIXI.Graphics();
      const baseR=(6+Math.random()*12)*(0.5+danger*0.7);
      // 黒煙に白・黄色の成分を混ぜた炎風の色
      let col;
      const smoke_r=Math.random();
      if(danger>0.75){
        // 高危機: 黒煙 + 赤/橙/黄
        col=smoke_r<0.35?0x111111:(smoke_r<0.55?0x333333:(smoke_r<0.7?0xff4400:(smoke_r<0.85?0xff8800:0xffcc00)));
      } else if(danger>0.45){
        // 中危機: 濃い灰 + 橙
        col=smoke_r<0.4?0x1a1a1a:(smoke_r<0.65?0x444444:(smoke_r<0.82?0xcc5500:0xffaa00));
      } else {
        // 低危機: 黒〜濃灰 + 少し白
        col=smoke_r<0.45?0x111111:(smoke_r<0.75?0x333333:(smoke_r<0.9?0x777777:0xcccccc));
      }
      const baseAlpha=(0.18+danger*0.25);
      // ノイズ感を出すため複数の歪んだ楕円を重ねる
      g.beginFill(col,baseAlpha);
      const numBlobs=2+Math.floor(Math.random()*2);
      for(let b=0;b<numBlobs;b++){
        const ox=(Math.random()-0.5)*baseR*1.2;
        const oy=(Math.random()-0.5)*baseR*0.8;
        const rx=baseR*(0.5+Math.random()*0.9);
        const ry=rx*(0.4+Math.random()*0.5);
        g.drawEllipse(ox,oy,rx,ry);
      }
      g.endFill();
      // 少し明るい芯
      g.beginFill(0xffffff,baseAlpha*0.3);
      g.drawEllipse(0,0,baseR*0.25,baseR*0.15);
      g.endFill();
      g.x=sx+(Math.random()-0.5)*8;
      g.y=sy+(Math.random()-0.5)*8;
      g.alpha=0;
      g.rotation=Math.random()*Math.PI*2;
      layer.addChild(g);
      // 吹き出す方向（コーナーから外側へ）、1.5倍速
      const blowAngle=Math.atan2(sy-((this.mainBY||0)+(BOARD_H/2)), sx-((this.mainBX||0)+(BOARD_W/2)));
      const blowStrength=(0.9+Math.random()*1.8+danger*1.2)*1.5;
      const maxLife=0.8+Math.random()*0.6;
      list.push({
        gfx:g,
        vx:Math.cos(blowAngle)*blowStrength+(Math.random()-0.5)*0.8,
        vy:Math.sin(blowAngle)*blowStrength-(0.45+Math.random()*0.9),
        life:maxLife,
        maxLife:maxLife,
        decay:(0.010+Math.random()*0.009),
        maxAlpha:baseAlpha,
        expandX:1.010+Math.random()*0.008,
        expandY:1.008+Math.random()*0.006,
        rot:(Math.random()-0.5)*0.022,
      });
    }
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
    const r=7+Math.min(power*1.4,20); // larger base size

    // 外側の鋭いリング（攻撃的）
    const spike=new PIXI.Graphics();
    const spikes=6;
    for(let i=0;i<spikes;i++){
      const a=i/spikes*Math.PI*2;
      const a2=(i+0.5)/spikes*Math.PI*2;
      spike.beginFill(color,0.8);
      spike.moveTo(Math.cos(a)*r*0.6,Math.sin(a)*r*0.6);
      spike.lineTo(Math.cos(a2)*r*2.2,Math.sin(a2)*r*2.2);
      spike.lineTo(Math.cos(a+Math.PI*2/spikes)*r*0.6,Math.sin(a+Math.PI*2/spikes)*r*0.6);
      spike.endFill();
    }
    cont.addChild(spike);

    // コア
    const core=new PIXI.Graphics();
    core.beginFill(0xffffff,1);core.drawCircle(0,0,r*0.6);core.endFill();
    core.beginFill(color,0.9);core.drawCircle(0,0,r*0.42);core.endFill();
    cont.addChild(core);

    // パワー数字
    if(power>=2){
      const pt=new PIXI.Text(power.toString(),new PIXI.TextStyle({fontFamily:'Orbitron',fontSize:Math.min(10+power,16),fill:0xffffff,fontWeight:'900'}));
      pt.anchor.set(0.5);cont.addChild(pt);
    }

    // 直線距離・方向
    const dx=tx-sx,dy=ty-sy;
    const dist=Math.sqrt(dx*dx+dy*dy);
    // 速度: 速めに一定 (35~50フレーム)
    const frames=Math.round(35+Math.min(dist/30,15));
    this.projectiles.push({cont,spike,core,sx,sy,tx,ty,color,frames,f:0,power,r,dist,dx,dy});
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
      // ease-in（最初ゆっくり→急加速）で攻撃的に
      const te=t*t*t;
      const cx=p.sx+p.dx*te;
      const cy=p.sy+p.dy*te;
      p.cont.x=cx;p.cont.y=cy;
      // スパイクを高速回転
      p.spike.rotation+=0.28;
      // 突撃時にスケール震動
      const sc=1+0.22*Math.sin(p.f*0.7);
      p.cont.scale.set(sc);
      // 尾を引くトレイル（直線方向に伸びる）
      if(p.f%1===0&&settings.particles!=='off'){
        const tg=new PIXI.Graphics();
        const trailAlpha=0.55*(1-t);
        tg.beginFill(p.color,trailAlpha);
        // 楕円を進行方向に引き伸ばした軌跡
        const trailLen=p.r*1.8*(1-t*0.4);
        tg.drawCircle(0,0,p.r*0.35);
        tg.endFill();
        tg.x=cx-(p.dx/p.frames)*2;tg.y=cy-(p.dy/p.frames)*2;
        this.effectsLayer.addChild(tg);
        this.particles.push({gfx:tg,vx:0,vy:0,life:trailAlpha,decay:0.12});
      }
      if(p.f>=p.frames){
        // 着弾: 爆発的なバースト
        const n=settings.particles==='high'?32:14;
        for(let i=0;i<n;i++){
          const g=new PIXI.Graphics();g.beginFill(p.color,1);
          const sz=Math.random()*5+1.5;
          if(i%4===0)g.drawCircle(0,0,sz);else g.drawRect(-sz/2,-sz/2,sz,sz);
          g.endFill();g.x=p.tx+(Math.random()-0.5)*12;g.y=p.ty+(Math.random()-0.5)*12;
          this.effectsLayer.addChild(g);
          // 進行方向前方への集中バースト
          const baseAngle=Math.atan2(p.dy,p.dx);
          const spread=i<n*0.4?(Math.random()-0.5)*1.2:(Math.random()-0.5)*Math.PI*2;
          const a=baseAngle+spread;
          const sp=Math.random()*12+5;
          this.particles.push({gfx:g,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:1,decay:0.042+Math.random()*0.04});
        }
        // 衝撃波リング
        if(settings.quality!=='low'&&settings.quality!=='minimum'){
          const sw=new PIXI.Graphics();sw.lineStyle(3,p.color,0.9);sw.drawCircle(0,0,6);
          sw.x=p.tx;sw.y=p.ty;this.effectsLayer.addChild(sw);
          let sr=6,sa=0.9;
          const swT=()=>{sr+=7;sa-=0.065;sw.clear();sw.lineStyle(3,p.color,sa);sw.drawCircle(0,0,sr);
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
    this.opponentPlayers.forEach(p=>{this.drawOpponentBoard(p.id);this._updateOpponentSmoke(p.id,dt);});
    this.drawGarbageMeter();
    this.updateParticlesEtc(dt);
    // ULTRA: animated scanline
    if(settings.quality==='ultra'&&this._bgScanline){
      this._bgScanlineY=(this._bgScanlineY||0)+(dt*0.4);
      if(this._bgScanlineY>this.H)this._bgScanlineY=0;
      this._bgScanline.clear();
      this._bgScanline.beginFill(0x00f5ff,0.025);
      this._bgScanline.drawRect(0,this._bgScanlineY,this.W,2);
      this._bgScanline.endFill();
    }
  }

  // 敵ボードの煙エフェクト更新
  _updateOpponentSmoke(pid, dt){
    const d=this.opBoardData[pid];
    if(!d||d.dead||!d.smokeLayer||settings.particles==='off'||settings.quality==='minimum')return;
    if(!d.cont.visible)return;
    if(!d.board){return;}
    // 積み上がり計算
    const boardArr=d.board;
    const offset=boardArr.length>ROWS?HIDDEN:0;
    let topRow=ROWS+HIDDEN;
    for(let r=0;r<boardArr.length;r++){
      if(boardArr[r]&&boardArr[r].some(v=>v)){topRow=r;break;}
    }
    // 敵は小さいボード（showAbove行付き）。可視上部4行以内で危機
    const dangerStart=offset+4;
    const danger=Math.max(0,Math.min(1,(dangerStart-topRow)/4));

    if(danger<=0){
      d.smokeParticles=d.smokeParticles.filter(p=>{
        p.life-=0.025;p.gfx.alpha=Math.max(0,p.life*p.maxAlpha);
        p.gfx.x+=p.vx;p.gfx.y+=p.vy;p.vx+=(Math.random()-0.5)*0.03;
        p.gfx.scale.x*=p.expandX;p.gfx.scale.y*=p.expandY;p.gfx.rotation+=p.rot;
        if(p.life<=0){try{p.gfx.destroy();}catch(e){}return false;}return true;
      });
      return;
    }

    // 煙レイヤー位置を cont に追従させる
    d.smokeLayer.x=d.cont.x;d.smokeLayer.y=d.cont.y;

    d.smokeTick=(d.smokeTick||0)+dt;
    const rate=Math.max(120,280-danger*160);
    if(d.smokeTick>=rate){
      d.smokeTick=0;
      const n=1;
      // 敵ボードの4角から煙
      const corners2=[
        [0,0],[d.boardW,0],[0,d.boardH],[d.boardW,d.boardH]
      ];
      for(let i=0;i<n;i++){
        const corner2=corners2[Math.floor(Math.random()*4)];
        this._spawnNoiseSmokePuff(corner2[0],corner2[1],danger,d.smokeLayer,d.smokeParticles);
      }
    }
    d.smokeParticles=d.smokeParticles.filter(p=>{
      p.life-=p.decay;
      const lifeRatio=p.life/p.maxLife;
      let alpha;
      if(lifeRatio>0.8){alpha=p.maxAlpha*(1-lifeRatio)*5;}
      else if(lifeRatio>0.3){alpha=p.maxAlpha;}
      else{alpha=p.maxAlpha*(lifeRatio/0.3);}
      p.gfx.alpha=Math.max(0,alpha);
      p.gfx.x+=p.vx;p.gfx.y+=p.vy;
      p.vx+=(Math.random()-0.5)*0.04;p.vx*=0.98;p.vy*=0.992;
      p.gfx.scale.x*=p.expandX;p.gfx.scale.y*=p.expandY;p.gfx.rotation+=p.rot;
      if(p.life<=0){try{p.gfx.destroy();}catch(e){}return false;}return true;
    });
  }
} // end class GameRenderer

// ---- Input ----
// ---- SpectatorRenderer ----
// 観戦モード専用レンダラー: 全プレイヤーのボードを画面に均等配置
class SpectatorRenderer{
  constructor(app,players){
    this.app=app;this.players=players;
    this.W=app.screen.width;this.H=app.screen.height;
    this.opBoardData={};
    this.root=new PIXI.Container();app.stage.addChild(this.root);
    this._buildBoards();
  }
  _buildBoards(){
    const n=this.players.length;
    if(n===0)return;
    // セルサイズをプレイヤー数と画面幅から自動計算
    const maxCell=Math.floor(Math.min(this.W/(n*COLS+n+1), this.H/(ROWS+4)));
    const cell=Math.max(8,Math.min(22,maxCell));
    const bw=COLS*cell,bh=ROWS*cell;
    const totalW=n*bw+(n+1)*Math.floor(cell*0.8);
    const startX=(this.W-totalW)/2;
    const startY=(this.H-bh)/2;
    this.players.forEach((p,i)=>{
      const x=startX+i*(bw+Math.floor(cell*0.8));
      const cont=new PIXI.Container();cont.x=x;cont.y=startY;this.root.addChild(cont);
      const isBot=!!p.isBot;
      const borderCol=isBot?0xffbe0b:0x00f5ff;
      const bg=new PIXI.Graphics();
      bg.beginFill(0x000010,0.9);bg.drawRect(0,0,bw,bh);bg.endFill();
      bg.lineStyle(1,borderCol,0.5);bg.drawRect(0,0,bw,bh);
      // グリッド
      bg.lineStyle(0.3,0x0a2a4a,0.6);
      for(let c=1;c<COLS;c++){bg.moveTo(c*cell,0);bg.lineTo(c*cell,bh);}
      for(let r=1;r<ROWS;r++){bg.moveTo(0,r*cell);bg.lineTo(bw,r*cell);}
      cont.addChild(bg);
      const nameCol=isBot?0xffbe0b:0x00f5ff;
      const ntxt=new PIXI.Text(p.name.toUpperCase(),new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:Math.max(8,cell*0.55),fill:nameCol,letterSpacing:1}));
      ntxt.x=0;ntxt.y=-cell*1.2;cont.addChild(ntxt);
      const boardGfx=new PIXI.Graphics();cont.addChild(boardGfx);
      const sst=new PIXI.TextStyle({fontFamily:'Share Tech Mono',fontSize:Math.max(7,cell*0.5),fill:0x888888});
      const stxt=new PIXI.Text('0000000',sst);stxt.x=0;stxt.y=bh+4;cont.addChild(stxt);
      // 死亡オーバーレイ
      const deadOverlay=new PIXI.Graphics();
      deadOverlay.beginFill(0x000000,0.55);deadOverlay.drawRect(0,0,bw,bh);deadOverlay.endFill();
      deadOverlay.visible=false;cont.addChild(deadOverlay);
      const deadTxt=new PIXI.Text('💀',new PIXI.TextStyle({fontSize:cell*1.8}));
      deadTxt.anchor.set(0.5);deadTxt.x=bw/2;deadTxt.y=bh/2;deadTxt.visible=false;cont.addChild(deadTxt);
      this.opBoardData[p.id]={cont,boardGfx,scoreTxt:stxt,cell,bw,bh,board:null,currentPiece:null,dead:false,deadOverlay,deadTxt,score:0};
    });
  }
  drawAll(){
    this.players.forEach(p=>this._drawBoard(p.id));
  }
  _drawBoard(pid){
    const d=this.opBoardData[pid];if(!d)return;
    const g=d.boardGfx;g.clear();
    const {cell,bh}=d;
    const HIDDEN_ROWS=3;
    if(!d.board){g.beginFill(0x000010,0.3);g.drawRect(0,0,d.bw,bh);g.endFill();return;}
    for(let r=HIDDEN_ROWS;r<ROWS+HIDDEN_ROWS;r++){
      for(let c=0;c<COLS;c++){
        const v=d.board[r]&&d.board[r][c];if(!v)continue;
        const color=PIECE_COLORS[v]||0x334455;
        const dy=(r-HIDDEN_ROWS)*cell,dx=c*cell,s=cell-1;
        g.beginFill(color,1);g.drawRect(dx+1,dy+1,s-1,s-1);g.endFill();
        g.beginFill(0xffffff,0.3);g.drawRect(dx+1,dy+1,s-1,2);g.drawRect(dx+1,dy+1,2,s-1);g.endFill();
      }
    }
    // 現在ミノ
    if(d.currentPiece&&!d.dead){
      const {type,rotation,x,y}=d.currentPiece;
      const shape=PIECE_SHAPES[type]&&PIECE_SHAPES[type][((rotation%4)+4)%4];
      if(shape){
        const color=PIECE_COLORS[type]||0xffffff;
        for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++){
          if(!shape[r][c])continue;
          const dr=y+r-HIDDEN_ROWS;if(dr<0)continue;
          const dx=(x+c)*cell,dy=dr*cell,s=cell-1;
          g.beginFill(color,0.9);g.drawRect(dx+1,dy+1,s-1,s-1);g.endFill();
          g.beginFill(0xffffff,0.35);g.drawRect(dx+1,dy+1,s-1,2);g.drawRect(dx+1,dy+1,2,s-1);g.endFill();
        }
      }
    }
  }
  update(){
    this.players.forEach(p=>this._drawBoard(p.id));
  }
  markDead(pid){
    const d=this.opBoardData[pid];if(!d)return;
    d.dead=true;
    d.deadOverlay.visible=true;d.deadTxt.visible=true;
  }
}

let das=null,arr=null,softDropTimer=null,keyState={};
function setupInput(){document.addEventListener('keydown',handleKeyDown);document.addEventListener('keyup',handleKeyUp);}
function removeInput(){document.removeEventListener('keydown',handleKeyDown);document.removeEventListener('keyup',handleKeyUp);}
function handleKeyDown(e){
  if(!gameState||!gameState.alive)return;
  // チャット・入力欄にフォーカスがある時はゲーム操作を全てブロック
  const ae=document.activeElement;
  if(ae&&(ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'||ae.isContentEditable))return;
  if(keyState[e.code])return;
  keyState[e.code]=true;
  switch(e.code){
    case 'ArrowLeft':gameState.move(-1);_dasStartedAt=performance.now();startDAS(-1);break;
    case 'ArrowRight':gameState.move(1);_dasStartedAt=performance.now();startDAS(1);break;
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
    // DCD (DAS Cut Delay): スポーン直後のDAS誤爆防止
    const dcdMs=settings.dcdDelay||0;
    let dcdStart=_dasStartedAt||0;
    const elapsed=performance.now()-dcdStart;
    const dcdWait=Math.max(0,dcdMs-elapsed);
    setTimeout(()=>{
      arr=setInterval(()=>{
        if(!gameState||!gameState.alive){stopDAS();return;}
        gameState.move(dir);
      },settings.arrInterval||20);
    },dcdWait);
  },settings.dasDelay||133);
}
let _dasStartedAt=0;
function stopDAS(){if(das){clearTimeout(das);das=null;}if(arr){clearInterval(arr);arr=null;}}
function startSoftDrop(){stopSoftDrop();if(!gameState||!gameState.alive)return;gameState.softDrop();softDropTimer=setInterval(()=>{if(!gameState||!gameState.alive){stopSoftDrop();return;}gameState.softDrop();},settings.softDropInterval||50);}
function stopSoftDrop(){if(softDropTimer){clearInterval(softDropTimer);softDropTimer=null;}}

// ---- Multiplayer ----
socket.on('opponent_update',({id,board,score,lines,level,currentPiece,nextPieces,holdPiece})=>{
  if(!renderer)return;
  const d=renderer.opBoardData[id];if(!d)return;
  d.board=board;
  d.currentPiece=currentPiece;
  if(nextPieces)d.nextPieces=nextPieces;
  if(holdPiece!==undefined)d.holdPiece=holdPiece;
  if(score!==undefined)d.score=score;
  if(d.scoreTxt)d.scoreTxt.text=(score||0).toString().padStart(7,'0');
  if(isSpectator)return; // SpectatorRenderer は ticker で自動更新
  const p=renderer.players.find(pl=>pl.id===id);
  if(p){p.score=score;p.lines=lines;p.level=level;}
  renderer.updateVisibleOpponents&&renderer.updateVisibleOpponents();
});

// BOT board update (same structure as opponent_update)
socket.on('bot_update',({id,board,score,lines,level,nextPieces,holdPiece})=>{
  if(!renderer)return;
  const d=renderer.opBoardData[id];if(!d)return;
  d.board=board;
  if(nextPieces)d.nextPieces=nextPieces;
  if(holdPiece!==undefined)d.holdPiece=holdPiece;
  if(score!==undefined)d.score=score;
  if(d.scoreTxt)d.scoreTxt.text=(score||0).toString().padStart(7,'0');
  if(isSpectator)return;
  renderer.updateVisibleOpponents&&renderer.updateVisibleOpponents();
});

// BOT piece motion update
socket.on('bot_piece_update',({id,currentPiece})=>{
  if(!renderer)return;
  const d=renderer.opBoardData[id];if(!d)return;
  d.currentPiece=currentPiece;
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
  if(isSpectator&&renderer){renderer.markDead&&renderer.markDead(id);return;}
  if(renderer)renderer.opponentGameOver(id);
});

socket.on('opponent_spin',({id,spinType})=>{
  if(renderer)renderer.triggerOpponentSpin(id,spinType);
});

socket.on('opponent_line_clear',({id,count,spinType,isB2B,ren,allClear})=>{
  if(renderer)renderer.triggerOpponentLineClear(id,count,spinType,isB2B,ren,allClear);
});

socket.on('attack_sent',({fromId,toId,attack,clearRows})=>{
  if(!renderer)return;
  if(fromId===myId){
    // My attack going to opponent
    const launchY=renderer._getClearRowsCenterY(clearRows);
    renderer.onAttackProjectile(toId,attack,launchY);
  } else if(toId===myId){
    // Opponent/bot attack incoming
    // Big attacks (tetris/tspin triple/double/ren) → cyan + large
    // Small attacks → orange + small
    const d=renderer.opBoardData[fromId];
    if(d){
      const sx=d.origX+d.boardW/2;
      const sy=d.origY+d.boardH/2;
      const isBig=attack>=4;
      const color=isBig?0x00f5ff:0xff8500;
      const visualPower=isBig?attack+4:attack; // inflate size only for big
      renderer.spawnProjectile(sx,sy,renderer.mainBX-8,renderer.mainBY+BOARD_H*0.5,color,visualPower);
    }
  }
});

socket.on('game_end',({winner,winnerName,scores,forceEnded})=>{
  stopDAS();stopSoftDrop();
  if(gameState)gameState.alive=false;
  if(isSpectator){
    // 観戦者はゲーム終了後にwaitingルームへ戻る
    isSpectator=false;
    if(gameApp){try{gameApp.destroy(true);}catch(e){}gameApp=null;}
    gameState=null;renderer=null;
    setTimeout(()=>{
      // 試合終了後は通常参加者として部屋へ自動復帰
      socket.emit('rejoin_room',{roomId:roomId,name:myName});
    },2000);
    addChatSystem(forceEnded?'⚠ Game force-ended by host.':'🏁 Game ended. Returning to room...');
    return;
  }
  setTimeout(()=>showResult(winner,winnerName,scores),2000);
});

let _autoReturnTimer=null;

// ルームの非アクティブ警告
let _roomInactivityTimer=null;
let _roomInactivityWarningTimer=null;
let _inactivityExtendBtn=null;

function resetRoomInactivityTimer(){
  if(!roomId)return;
  if(!isHost)return; // ホストのみ
  // 待機室画面のみ動作
  if(document.getElementById('waiting').classList.contains('active')){
    _startInactivityTimer();
  }
}

function _startInactivityTimer(){
  if(_roomInactivityTimer)clearTimeout(_roomInactivityTimer);
  if(_roomInactivityWarningTimer)clearTimeout(_roomInactivityWarningTimer);
  _removeInactivityBtn();
  // 1分後に警告
  _roomInactivityTimer=setTimeout(()=>{
    _showInactivityWarning();
  },60000);
}

function _showInactivityWarning(){
  if(!roomId||!isHost)return;
  // 警告ボタン表示
  _removeInactivityBtn();
  const btn=document.createElement('div');
  btn.id='inactivity-warning-btn';
  btn.style.cssText='position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9000;background:rgba(255,0,110,0.92);border:2px solid #ff006e;border-radius:12px;padding:1rem 2rem;font-family:Orbitron,sans-serif;color:#fff;text-align:center;cursor:pointer;box-shadow:0 0 30px rgba(255,0,110,0.5);animation:pulse-warn 0.8s ease-in-out infinite alternate;';
  btn.innerHTML='<div style="font-size:0.9rem;letter-spacing:0.1em;margin-bottom:0.4rem;">⚠ ルームが非アクティブです</div><div style="font-size:0.75rem;opacity:0.8;margin-bottom:0.6rem;">10秒以内に押さないとルームが削除されます</div><button style="background:rgba(255,255,255,0.2);border:1px solid #fff;color:#fff;font-family:Orbitron;font-size:0.75rem;padding:0.4rem 1.2rem;border-radius:6px;cursor:pointer;letter-spacing:0.05em;">延長する (+1分)</button>';
  _inactivityExtendBtn=btn;
  document.body.appendChild(btn);
  btn.querySelector('button').addEventListener('click',_extendRoomTime);
  // 10秒のカウントダウン
  let remaining=10;
  const countEl=document.createElement('div');
  countEl.style.cssText='font-size:2rem;font-weight:900;margin-top:0.3rem;color:#ffbe0b;';
  countEl.textContent=remaining;
  btn.appendChild(countEl);
  _roomInactivityWarningTimer=setInterval(()=>{
    remaining--;
    if(countEl)countEl.textContent=remaining;
    if(remaining<=0){
      clearInterval(_roomInactivityWarningTimer);
      _deleteRoomDueToInactivity();
    }
  },1000);
  // スタイル追加
  if(!document.getElementById('inactivity-style')){
    const st=document.createElement('style');
    st.id='inactivity-style';
    st.textContent='@keyframes pulse-warn{from{box-shadow:0 0 20px rgba(255,0,110,0.4);}to{box-shadow:0 0 40px rgba(255,0,110,0.9);}}';
    document.head.appendChild(st);
  }
}

function _extendRoomTime(){
  _removeInactivityBtn();
  _startInactivityTimer();
}

function _removeInactivityBtn(){
  if(_inactivityExtendBtn){_inactivityExtendBtn.remove();_inactivityExtendBtn=null;}
  if(_roomInactivityWarningTimer){clearInterval(_roomInactivityWarningTimer);_roomInactivityWarningTimer=null;}
  const b=document.getElementById('inactivity-warning-btn');
  if(b)b.remove();
}

function _deleteRoomDueToInactivity(){
  _removeInactivityBtn();
  if(roomId){
    socket.emit('leave_room');
    addChatSystem('⚠ ルームが非アクティブのため削除されました。');
  }
  roomId=null;roomPlayers=[];
  if(myName)showGameLobby(null);
  else showScreen('lobby');
}



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
  el.appendChild(d);
  // 最大30件
  while(el.children.length>30)el.removeChild(el.firstChild);
  el.scrollTop=el.scrollHeight;
}
function addChatSystem(text){
  const el=document.getElementById('chat-messages');
  const d=document.createElement('div');d.className='chat-msg system';d.textContent=text;
  el.appendChild(d);
  while(el.children.length>30)el.removeChild(el.firstChild);
  el.scrollTop=el.scrollHeight;
}
function sendChat(){
  const i=document.getElementById('chat-input');const m=i.value.trim();if(!m)return;
  const name=myName||(document.getElementById('player-name').value.trim())||'Anonymous';
  socket.emit('chat_message',{message:m,name});i.value='';
}
socket.on('chat_message',addChatMessage);
function esc(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ---- Mobile Controls ----

function toggleMobileControls() {
  mobileControlsEnabled = !mobileControlsEnabled;
  const btn = document.getElementById('mobile-toggle-btn');
  if (mobileControlsEnabled) {
    btn.innerHTML = '📱 MOBILE<br>ON';
    btn.classList.add('on');
    setupMobileControls();
  } else {
    btn.innerHTML = '📱 MOBILE<br>OFF';
    btn.classList.remove('on');
    removeMobileControls();
  }
  document.cookie='tetrix_mobile='+(mobileControlsEnabled?'1':'0')+'; max-age=31536000; path=/';
  const inGame = document.getElementById('game').classList.contains('active');
  const inLobby = document.getElementById('game-lobby').classList.contains('active');
  showDpad(inGame);
  const dpadBtnWrap=document.getElementById('dpad-layout-btn-wrap');
  if(dpadBtnWrap)dpadBtnWrap.style.display=(mobileControlsEnabled&&inLobby)?'block':'none';
  if(!mobileControlsEnabled)closeDpadEditor();
}

// ---- Display Keyboard (D-Pad) ----
let _dpadDasTimers = {}; // key -> {das, arr}

function applyDpadLayout() {
  const parts = ['cross','shift','z','harddrop'];
  parts.forEach(part => {
    const el = document.getElementById('dpad-' + part);
    if (!el) { console.warn('[dpad] element not found: dpad-'+part); return; }
    const d = settings.dpad[part];
    if (!d) { console.warn('[dpad] no settings for part: '+part); return; }
    el.style.left    = d.x + '%';
    el.style.top     = d.y + '%';
    el.style.opacity = d.opacity / 100;
    if (part === 'cross') {
      el.style.setProperty('--dpad-scale', d.size / 160);
      el.style.width  = d.size + 'px';
      el.style.height = d.size + 'px';
    } else {
      el.style.setProperty('--dpad-scale', d.size / 80);
      el.style.width  = d.size + 'px';
      el.style.height = Math.round(d.size * 0.72) + 'px';
    }
    console.log('[dpad]', part, 'display='+el.style.display, 'w='+el.style.width, 'x='+d.x, 'y='+d.y);
  });
  // swapCenterDown: センターと下ボタンのラベル更新
  const swap = settings.dpad.swapCenterDown;
  const centerEl = document.getElementById('dpad-btn-center');
  const downEl   = document.getElementById('dpad-btn-down');
  if (centerEl) centerEl.innerHTML = swap
    ? '▼'
    : '▲<br><span style="font-size:0.35em;letter-spacing:.03em">HARD</span>';
  if (downEl) downEl.innerHTML = swap
    ? '▲<br><span style="font-size:0.35em;letter-spacing:.03em">HARD</span>'
    : '▼';
}

function showDpad(visible) {
  ['cross','shift','z','harddrop'].forEach(part => {
    const el = document.getElementById('dpad-' + part);
    if (!el) return;
    el.style.display = (mobileControlsEnabled && visible) ? 'block' : 'none';
  });
  if (mobileControlsEnabled && visible) applyDpadLayout();
}

// Called on pointer-down for DAS keys (left/right/down)
function _dpadStartDAS(key, action, repeatMs) {
  _dpadStopKey(key);
  action(); // immediate first fire
  _dpadDasTimers[key] = {};
  _dpadDasTimers[key].das = setTimeout(() => {
    _dpadDasTimers[key].arr = setInterval(() => {
      if (!gameState || !gameState.alive) { _dpadStopKey(key); return; }
      action();
    }, repeatMs);
  }, settings.dasDelay||133);
}

function _dpadStopKey(key) {
  const t = _dpadDasTimers[key];
  if (!t) return;
  if (t.das) clearTimeout(t.das);
  if (t.arr) clearInterval(t.arr);
  delete _dpadDasTimers[key];
}

function _dpadStopAll() {
  Object.keys(_dpadDasTimers).forEach(_dpadStopKey);
  stopSoftDrop();
}

let _dpadButtonsBound = false; // 2重登録防止フラグ

function setupDpadButtons() {
  applyDpadLayout();
  if (_dpadButtonsBound) return; // 既にバインド済みならスキップ
  _dpadButtonsBound = true;

  function bind(id, onDown, onUp) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      // ゲーム中のみ動作（エディター中・非ゲーム画面では何もしない）
      const inGame = document.getElementById('game').classList.contains('active');
      const inEditor = !!document.getElementById('dpad-editor-overlay');
      if (!inGame || inEditor) return;
      el.classList.add('dpad-active');
      if (gameState && gameState.alive) onDown();
    });
    const release = (e) => {
      e.preventDefault();
      el.classList.remove('dpad-active');
      if (onUp) onUp();
    };
    el.addEventListener('pointerup',     release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave',  release);
  }

  bind('dpad-btn-left',
    () => _dpadStartDAS('left',  () => gameState && gameState.move(-1), settings.arrInterval||20),
    () => { _dpadStopKey('left');  if(renderer) renderer._wallBumpActive=false; }
  );
  bind('dpad-btn-right',
    () => _dpadStartDAS('right', () => gameState && gameState.move(1),  settings.arrInterval||20),
    () => { _dpadStopKey('right'); if(renderer) renderer._wallBumpActive=false; }  );
  bind('dpad-btn-up',
    () => { if(gameState && gameState.alive) gameState.rotate(1); }, null
  );
  bind('dpad-btn-center',
    () => {
      if (!(gameState && gameState.alive)) return;
      if (settings.dpad.swapCenterDown) startSoftDrop();
      else gameState.hardDrop();
    },
    () => { if (settings.dpad.swapCenterDown) stopSoftDrop(); }
  );
  bind('dpad-btn-down',
    () => {
      if (settings.dpad.swapCenterDown) { if(gameState && gameState.alive) gameState.hardDrop(); }
      else startSoftDrop();
    },
    () => { if (!settings.dpad.swapCenterDown) stopSoftDrop(); }
  );
  bind('dpad-btn-harddrop',
    () => { if(gameState && gameState.alive) gameState.hardDrop(); }, null
  );
  bind('dpad-btn-shift',
    () => { if(gameState && gameState.alive) gameState.hold(); }, null
  );
  bind('dpad-btn-z',
    () => { if(gameState && gameState.alive) gameState.rotate(-1); }, null
  );
}

// ---- D-Pad Layout Editor ----
// openDpadEditor(): ロビーから呼ぶ。dpadを画面に表示してドラッグ・スライダーで設定
function openDpadEditor() {
  if (document.getElementById('dpad-editor-overlay')) return; // already open

  // dpadパーツを表示（ロビー上に浮かせる）
  ['cross','shift','z','harddrop'].forEach(part => {
    const el = document.getElementById('dpad-' + part);
    if (!el) return;
    el.style.display = 'block';
    el.style.zIndex  = '9100';
    el.style.cursor  = 'grab';
  });
  applyDpadLayout();
  applyDpadLayout();

  const overlay = document.createElement('div');
  overlay.id = 'dpad-editor-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;touch-action:none;background:rgba(0,0,0,0.45);';
  document.body.appendChild(overlay);

  const dpadSz  = settings.dpad.cross.size;
  const btnSz   = settings.dpad.shift.size;
  const opacity = settings.dpad.cross.opacity;

  const panel = document.createElement('div');
  panel.id = 'dpad-editor-panel';
  panel.style.cssText = [
    'position:fixed;top:0;left:0;right:0;z-index:9200;',
    'background:rgba(3,7,18,0.96);border-bottom:1px solid rgba(0,245,255,.3);',
    'padding:12px 16px 10px;font-family:Orbitron,sans-serif;',
    'display:flex;flex-direction:column;gap:8px;'
  ].join('');

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
      <div style="color:#00f5ff;font-size:.9rem;letter-spacing:.2em;">🎮 ボタン配置</div>
      <button id="dpad-editor-done" style="font-family:Orbitron,sans-serif;font-size:.7rem;letter-spacing:.12em;padding:.4rem 1.2rem;background:transparent;border:2px solid #00f5ff;color:#00f5ff;border-radius:5px;cursor:pointer;box-shadow:0 0 10px rgba(0,245,255,.3);">✓ 完了</button>
    </div>
    <div style="color:rgba(255,255,255,.45);font-size:.6rem;letter-spacing:.08em;margin-bottom:2px;">各パーツをドラッグして移動できます</div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <div style="flex:1;min-width:110px;">
        <label style="color:rgba(255,255,255,.55);font-size:.62rem;letter-spacing:.08em;display:block;margin-bottom:3px;">十字キーサイズ <span id="ed-cross-sz-val" style="color:#ffbe0b;">${dpadSz}px</span></label>
        <input type="range" id="ed-cross-sz" min="100" max="280" value="${dpadSz}" style="width:100%;accent-color:#00f5ff;">
      </div>
      <div style="flex:1;min-width:110px;">
        <label style="color:rgba(255,255,255,.55);font-size:.62rem;letter-spacing:.08em;display:block;margin-bottom:3px;">ボタンサイズ <span id="ed-btn-sz-val" style="color:#ffbe0b;">${btnSz}px</span></label>
        <input type="range" id="ed-btn-sz" min="50" max="280" value="${btnSz}" style="width:100%;accent-color:#00f5ff;">
      </div>
      <div style="flex:1;min-width:110px;">
        <label style="color:rgba(255,255,255,.55);font-size:.62rem;letter-spacing:.08em;display:block;margin-bottom:3px;">透明度 <span id="ed-opacity-val" style="color:#ffbe0b;">${opacity}%</span></label>
        <input type="range" id="ed-opacity" min="10" max="100" value="${opacity}" style="width:100%;accent-color:#00f5ff;">
      </div>
    </div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <label style="color:rgba(255,255,255,.6);font-size:.65rem;letter-spacing:.08em;display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="ed-swap-center-down" ${settings.dpad.swapCenterDown?'checked':''} style="width:16px;height:16px;accent-color:#ffbe0b;">
        <span>十字キー中央↔下を入れ替え<br><span style="color:rgba(255,255,255,.4);font-size:.58rem;">中央=ソフトドロップ / 下=ハードドロップ</span></span>
      </label>
    </div>
  `;
  document.body.appendChild(panel);

  // Sliders
  document.getElementById('ed-cross-sz').addEventListener('input', function() {
    const v = parseInt(this.value);
    document.getElementById('ed-cross-sz-val').textContent = v + 'px';
    settings.dpad.cross.size = v;
    applyDpadLayout(); saveSettings();
  });
  document.getElementById('ed-btn-sz').addEventListener('input', function() {
    const v = parseInt(this.value);
    document.getElementById('ed-btn-sz-val').textContent = v + 'px';
    settings.dpad.shift.size = v;
    settings.dpad.z.size = v;
    settings.dpad.harddrop.size = v;
    applyDpadLayout(); saveSettings();
  });
  document.getElementById('ed-opacity').addEventListener('input', function() {
    const v = parseInt(this.value);
    document.getElementById('ed-opacity-val').textContent = v + '%';
    settings.dpad.cross.opacity = v;
    settings.dpad.shift.opacity = v;
    settings.dpad.z.opacity = v;
    settings.dpad.harddrop.opacity = v;
    applyDpadLayout(); saveSettings();
  });
  document.getElementById('ed-swap-center-down').addEventListener('change', function() {
    settings.dpad.swapCenterDown = this.checked;
    applyDpadLayout(); saveSettings();
  });

  // Draggable parts — エディター開いている間だけドラッグ可。累積登録防止のため一度削除してから追加
  ['cross','shift','z','harddrop'].forEach(partName => {
    const el = document.getElementById('dpad-' + partName);
    if (!el) return;
    // 既存のドラッグハンドラを削除
    if (el._dpadDragHandler) {
      el.removeEventListener('pointerdown', el._dpadDragHandler);
    }
    const dragHandler = (e) => {
      // エディターが開いていない場合はドラッグ無効（試合中など）
      if (!document.getElementById('dpad-editor-overlay')) return;
      e.preventDefault(); e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      el.setPointerCapture(e.pointerId);
      el.style.outline = '2px dashed #ffbe0b';

      const onMove = (ev) => {
        const vw = window.innerWidth, vh = window.innerHeight;
        settings.dpad[partName].x = Math.max(0, Math.min(95, ((ev.clientX - offX) / vw) * 100));
        settings.dpad[partName].y = Math.max(0, Math.min(95, ((ev.clientY - offY) / vh) * 100));
        applyDpadLayout(); saveSettings();
      };
      const onUp = () => {
        el.style.outline = '';
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
    };
    el._dpadDragHandler = dragHandler;
    el.addEventListener('pointerdown', dragHandler);
  });

  document.getElementById('dpad-editor-done').addEventListener('click', closeDpadEditor);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDpadEditor(); });
}

function closeDpadEditor() {
  const ov = document.getElementById('dpad-editor-overlay');
  const pn = document.getElementById('dpad-editor-panel');
  if (ov) ov.remove();
  if (pn) pn.remove();
  // ゲーム画面以外ではdpadを非表示に戻す
  const inGame = document.getElementById('game').classList.contains('active');
  showDpad(inGame);
  ['cross','shift','z','harddrop'].forEach(part => {
    const el = document.getElementById('dpad-' + part);
    if (!el) return;
    el.style.zIndex = '';
    el.style.cursor = '';
  });
}

// ---- Mobile touch state ----
let _mobileTouchData = {};

// ── Mobile touch thresholds ───────────────────────────────────────
const M_SWIPE_DOWN  = 50;   // px total down → hard drop
const M_SWIPE_UP    = 35;   // px total up   → rotate
const M_TAP_MS      = 220;  // max ms for tap
const M_FLICK_PX    = 18;   // px total horizontal to count as a flick
const M_FLICK_MS    = 220;  // ms window: flick must finish within this time
const M_SWIPE_X     = 28;   // px per step for slow drag
const M_DAS_MS      = 150;  // ms before DAS kicks in during drag
const M_ARR_MS      = 45;   // ms per repeat during DAS drag

// Returns true when chat input has focus (game should not process touch/keys)
function _chatHasFocus() {
  const ci = document.getElementById('chat-input');
  return ci && ci === document.activeElement;
}

function setupMobileControls() {
  const gameEl = document.getElementById('game');
  gameEl.addEventListener('touchstart',  onMobileTouchStart,  { passive: false });
  gameEl.addEventListener('touchmove',   onMobileTouchMove,   { passive: false });
  gameEl.addEventListener('touchend',    onMobileTouchEnd,    { passive: false });
  gameEl.addEventListener('touchcancel', onMobileTouchCancel, { passive: false });

  // Soft drop button
  const sdBtn = document.getElementById('mobile-softdrop-btn');
  if(sdBtn){
    sdBtn.addEventListener('touchstart', onSoftDropStart, { passive: false });
    sdBtn.addEventListener('touchend',   onSoftDropEnd,   { passive: false });
    sdBtn.addEventListener('touchcancel',onSoftDropEnd,   { passive: false });
  }

  // Hold button
  const holdBtn = document.getElementById('mobile-hold-btn');
  if(holdBtn){
    holdBtn.addEventListener('touchstart', (e)=>{ e.preventDefault(); e.stopPropagation();
      holdBtn.classList.add('active-press');
      if(gameState&&gameState.alive) gameState.hold();
    }, { passive: false });
    holdBtn.addEventListener('touchend',   (e)=>{ e.preventDefault(); holdBtn.classList.remove('active-press'); }, { passive: false });
    holdBtn.addEventListener('touchcancel',(e)=>{ holdBtn.classList.remove('active-press'); }, { passive: false });
  }

  // Rotate left button
  const rotLBtn = document.getElementById('mobile-rotleft-btn');
  if(rotLBtn){
    rotLBtn.addEventListener('touchstart', (e)=>{ e.preventDefault(); e.stopPropagation();
      rotLBtn.classList.add('active-press');
      if(gameState&&gameState.alive) gameState.rotate(-1);
    }, { passive: false });
    rotLBtn.addEventListener('touchend',   (e)=>{ e.preventDefault(); rotLBtn.classList.remove('active-press'); }, { passive: false });
    rotLBtn.addEventListener('touchcancel',(e)=>{ rotLBtn.classList.remove('active-press'); }, { passive: false });
  }
}

function removeMobileControls() {
  const gameEl = document.getElementById('game');
  gameEl.removeEventListener('touchstart',  onMobileTouchStart);
  gameEl.removeEventListener('touchmove',   onMobileTouchMove);
  gameEl.removeEventListener('touchend',    onMobileTouchEnd);
  gameEl.removeEventListener('touchcancel', onMobileTouchCancel);
  Object.values(_mobileTouchData).forEach(d => _mobileClean(d));
  _mobileTouchData = {};
}

function _mobileClean(d) {
  if (!d) return;
  if (d.dasTimer) { clearTimeout(d.dasTimer);  d.dasTimer = null; }
  if (d.dasArr)   { clearInterval(d.dasArr);   d.dasArr   = null; }
}

// ---- Soft Drop Button ----
let _sdBtnTimer = null;
function onSoftDropStart(e) {
  e.preventDefault(); e.stopPropagation();
  if (!gameState || !gameState.alive) return;
  document.getElementById('mobile-softdrop-btn').classList.add('active-press');
  gameState.softDrop();
  _sdBtnTimer = setInterval(() => {
    if (!gameState || !gameState.alive) { clearInterval(_sdBtnTimer); _sdBtnTimer = null; return; }
    gameState.softDrop();
  }, 80);
}
function onSoftDropEnd(e) {
  e.preventDefault();
  document.getElementById('mobile-softdrop-btn').classList.remove('active-press');
  if (_sdBtnTimer) { clearInterval(_sdBtnTimer); _sdBtnTimer = null; }
}

// Returns whether a touch point is over the hold display area in the canvas
function _isTouchOverHold(clientX, clientY) {
  if (!renderer) return false;
  const canvas = document.querySelector('#pixi-container canvas');
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (clientX - rect.left) * scaleX;
  const cy = (clientY - rect.top)  * scaleY;
  const hx1 = renderer.mainBX - 95, hx2 = renderer.mainBX - 5;
  const hy1 = renderer.mainBY - 5,  hy2 = renderer.mainBY + 90;
  return cx >= hx1 && cx <= hx2 && cy >= hy1 && cy <= hy2;
}

function onMobileTouchStart(e) {
  e.preventDefault();
  if (!mobileControlsEnabled) return;
  // チャット入力中はゲーム操作を無視
  if (_chatHasFocus()) return;

  for (const t of e.changedTouches) {
    // アクションボタン上のタッチは除外
    const target = document.elementFromPoint(t.clientX, t.clientY);
    if (target && (target.closest('#mobile-softdrop-btn') ||
                   target.closest('#mobile-left-btns') ||
                   target.closest('#chat-input-row') ||
                   target.closest('#chat-panel'))) continue;

    _mobileTouchData[t.identifier] = {
      id:           t.identifier,
      startX:       t.clientX,
      startY:       t.clientY,
      startTime:    performance.now(),
      lastX:        t.clientX,
      lastTime:     performance.now(),
      velocityX:    0,          // px/ms — rolling velocity for flick detection
      swipeHandled: false,
      flickDone:    false,      // horizontal flick already fired this touch
      dasDir:       0,
      dasTimer:     null,
      dasArr:       null,
      swipeAccX:    0,
      dragDir:      0,          // direction of drag (set during move, used on touchend)
    };
  }
}

function onMobileTouchMove(e) {
  e.preventDefault();
  if (!mobileControlsEnabled) return;
  if (_chatHasFocus()) return;

  for (const t of e.changedTouches) {
    const d = _mobileTouchData[t.identifier];
    if (!d || d.swipeHandled) continue;

    const now       = performance.now();
    const totalDX   = t.clientX - d.startX;
    const totalDY   = t.clientY - d.startY;
    const absDX     = Math.abs(totalDX);
    const absDY     = Math.abs(totalDY);
    const dt        = Math.max(1, now - d.lastTime);

    // Rolling velocity (px/ms) — used for flick detection on touchend
    const incX = t.clientX - d.lastX;
    d.velocityX = incX / dt;   // last-frame velocity
    d.lastX     = t.clientX;
    d.lastTime  = now;

    // ── DOWN swipe → hard drop
    if (totalDY > M_SWIPE_DOWN && absDY > absDX * 1.2) {
      d.swipeHandled = true;
      _mobileClean(d);
      if (gameState && gameState.alive) gameState.hardDrop();
      continue;
    }

    // ── UP swipe → rotate right
    if (totalDY < -M_SWIPE_UP && absDY > absDX * 1.2) {
      d.swipeHandled = true;
      _mobileClean(d);
      if (gameState && gameState.alive) gameState.rotate(1);
      continue;
    }

    // ── Horizontal drag: record direction for flick detection on touchend only
    // (No continuous DAS movement during drag — 1 flick = 1 cell, triggered on touchend)
    if (absDX > 8 && absDX > absDY * 1.5) {
      d.dragDir = totalDX > 0 ? 1 : -1;
    }
  }
}

function onMobileTouchEnd(e) {
  e.preventDefault();
  if (!mobileControlsEnabled) return;
  if (_chatHasFocus()) {
    // タッチがチャット外で終わったらフォーカスを外す
    for (const t of e.changedTouches) {
      const target = document.elementFromPoint(t.clientX, t.clientY);
      if (!target || !target.closest('#chat-panel')) {
        document.getElementById('chat-input')?.blur();
      }
    }
    return;
  }

  for (const t of e.changedTouches) {
    const d = _mobileTouchData[t.identifier];
    if (!d) continue;
    _mobileClean(d);

    const now     = performance.now();
    const elapsed = now - d.startTime;
    const totalDX = t.clientX - d.startX;
    const totalDY = t.clientY - d.startY;
    const absDX   = Math.abs(totalDX);
    const absDY   = Math.abs(totalDY);

    // ── フリック判定: 素早く短く横に動かしたら1マス移動（指が離れた時に実行）
    // swipeHandledでない、かつ横方向優勢、かつ距離足りる（時間制限なし）
    if (!d.swipeHandled &&
        absDX >= M_FLICK_PX &&
        absDX > absDY * 0.8) {
      const dir = totalDX > 0 ? 1 : -1;
      if (gameState && gameState.alive) gameState.move(dir);
      delete _mobileTouchData[t.identifier];
      continue;
    }

    // ── タップ判定（小さな動き・短時間）
    const isQuickTap = elapsed < M_TAP_MS && absDX < 20 && absDY < 20 && !d.swipeHandled;
    if (isQuickTap && gameState && gameState.alive) {
      if (_isTouchOverHold(t.clientX, t.clientY)) {
        gameState.hold();
      } else {
        gameState.rotate(1);
      }
    }

    delete _mobileTouchData[t.identifier];
  }
}

function onMobileTouchCancel(e) {
  for (const t of e.changedTouches) {
    const d = _mobileTouchData[t.identifier];
    if (d) { _mobileClean(d); delete _mobileTouchData[t.identifier]; }
  }
}

// ===== ズーム全対策 =====
(function(){
  // ① ダブルタップ防止
  let lastTap = 0;
  document.addEventListener('touchstart', function(e){
    const now = Date.now();
    if (now - lastTap < 300) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  // ② ピンチズーム防止（2本指touchmove）
  document.addEventListener('touchmove', function(e){
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  // ③ Safari gestureイベント防止
  document.addEventListener('gesturestart',  function(e){ e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturechange', function(e){ e.preventDefault(); }, { passive: false });
  document.addEventListener('gestureend',    function(e){ e.preventDefault(); }, { passive: false });
})();

document.addEventListener('DOMContentLoaded',()=>{
  loadSettings();
  document.getElementById('ghost-opacity').value=settings.ghostOpacity;
  document.getElementById('ghost-val').textContent=settings.ghostOpacity+'%';
  document.getElementById('quality-select').value=settings.quality;
  document.getElementById('quality-val').textContent=settings.quality==='minimum'?'MINIMUM':settings.quality==='ultra'?'ULTRA':settings.quality.toUpperCase();
  document.getElementById('particles-select').value=settings.particles;
  document.getElementById('shake-select').value=settings.shake;
  document.getElementById('sfx-volume').value=settings.sfxVolume;
  document.getElementById('sfx-val').textContent=settings.sfxVolume+'%';
  document.getElementById('tilt-select').value=settings.tilt;
  // ソフトドロップ速度
  const sdi=document.getElementById('soft-drop-interval');
  const sdv=document.getElementById('soft-drop-val');
  if(sdi)sdi.value=settings.softDropInterval||50;
  if(sdv)sdv.textContent=(settings.softDropInterval||50)+'ms';
  // DAS / ARR
  const dasDel=document.getElementById('das-delay-input');
  const dasDelV=document.getElementById('das-delay-val');
  if(dasDel)dasDel.value=settings.dasDelay||133;
  if(dasDelV)dasDelV.textContent=(settings.dasDelay||133)+'ms';
  const arrInt=document.getElementById('arr-interval-input');
  const arrIntV=document.getElementById('arr-interval-val');
  if(arrInt)arrInt.value=settings.arrInterval||20;
  if(arrIntV)arrIntV.textContent=(settings.arrInterval||20)+'ms';
  const dcdDel=document.getElementById('dcd-delay-input');
  const dcdDelV=document.getElementById('dcd-delay-val');
  if(dcdDel)dcdDel.value=settings.dcdDelay||0;
  if(dcdDelV)dcdDelV.textContent=(settings.dcdDelay||0)+'ms';
  sfxVol=settings.sfxVolume/100;
  document.getElementById('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});
  document.getElementById('gl-join-id-input').addEventListener('keydown',e=>{if(e.key==='Enter')glJoinRoom();});
  document.getElementById('gl-room-id-input').addEventListener('keydown',e=>{if(e.key==='Enter')glCreateRoom();});

  const saved=getSavedName();
  const inp=document.getElementById('name-modal-input');
  if(saved)inp.value=saved;
  inp.focus();
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')submitNameModal();});

  // Restore mobile controls preference
  try{
    const mc=document.cookie.split(';').find(c=>c.trim().startsWith('tetrix_mobile='));
    if(mc&&mc.split('=')[1].trim()==='1'){
      mobileControlsEnabled=true;
      const btn=document.getElementById('mobile-toggle-btn');
      btn.innerHTML='📱 MOBILE<br>ON';btn.classList.add('on');
      setupMobileControls();
    }
  }catch(e){}
  // Apply saved dpad layout
  applyDpadLayout();
  // UIレイアウト設定の初期化
  const ul=settings.uiLayout||{};
  const bOffY=document.getElementById('board-offset-y');
  const bOffYv=document.getElementById('board-offset-y-val');
  const bSc=document.getElementById('board-scale');
  const bScv=document.getElementById('board-scale-val');
  const sOffY=document.getElementById('side-ui-offset-y');
  const sOffYv=document.getElementById('side-ui-offset-y-val');
  const sFsc=document.getElementById('side-ui-font-scale');
  const sFscv=document.getElementById('side-ui-font-scale-val');
  if(bOffY)bOffY.value=ul.boardOffsetY||0;
  if(bOffYv)bOffYv.textContent=(ul.boardOffsetY||0)+'px';
  if(bSc)bSc.value=ul.boardScale||100;
  if(bScv)bScv.textContent=(ul.boardScale||100)+'%';
  if(sOffY)sOffY.value=ul.sideUiOffsetY||0;
  if(sOffYv)sOffYv.textContent=(ul.sideUiOffsetY||0)+'px';
  if(sFsc)sFsc.value=ul.sideUiFontScale||100;
  if(sFscv)sFscv.textContent=(ul.sideUiFontScale||100)+'%';

  // ダブルタップ拡大・ピンチ拡大を完全ブロック
  let _lastTap = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - _lastTap < 300) e.preventDefault();
    _lastTap = now;
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart',  (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gestureend',    (e) => e.preventDefault(), { passive: false });
});
