const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { 
    cors: { origin: "*" },
    pingInterval: 2000, 
    pingTimeout: 5000 
});
const path = require('path');

const PORT = 3000;
app.use(express.static(path.join(__dirname, 'public')));

const mazeIo = io.of('/maze');

// --- 游戏平衡性配置 ---
const CONFIG = {
    CHUNK_SIZE: 15,        // 区块尺寸 (必须奇数)
    CELL_SIZE: 40,         // 格子像素
    TICK_RATE: 100,        // 服务器逻辑帧 (10fps)
    MOVE_COOLDOWN: 80,     // 移动冷却
    
    SPAWN_RADIUS: 4,       // 出生点离中心的范围
    MAX_INVENTORY: 3,      // 背包容量
    ENERGY_DECAY: 0.4,     // 能量衰减速度 (调低了一点，更友好)
    
    // 道具定义
    ITEMS: {
        ENERGY: 0,    // ⚡ 能量 (直接吃)
        SPEED: 1,     // ⏩ 极速药水
        VISION: 2,    // 👁️ 夜视仪
        TELEPORT: 3   // 🌀 随机传送
    },

    GC_INTERVAL: 30000,
    CHUNK_LIFETIME: 60000
};

// --- 状态存储 ---
let chunks = new Map();
let players = {}; 

// --- 辅助：随机身份生成 ---
const PREFIX = ["Shadow", "Neon", "Cyber", "Void", "Hyper", "Solar", "Quantum"];
const SUFFIX = ["Walker", "Runner", "Ghost", "Core", "Hex", "Pulse", "Drifter"];

function generateIdentity() {
    const hue = Math.floor(Math.random() * 360);
    return {
        name: `${PREFIX[Math.floor(Math.random()*PREFIX.length)]} ${SUFFIX[Math.floor(Math.random()*SUFFIX.length)]}`,
        color: `hsl(${hue}, 75%, 60%)`,
        glow: `hsl(${hue}, 90%, 50%)`,
        core: '#fff'
    };
}

// --- 核心：地图生成 ---
function getChunk(cx, cy) {
    const key = `${cx},${cy}`;
    if (chunks.has(key)) {
        const wrapper = chunks.get(key);
        wrapper.lastAccessed = Date.now();
        return wrapper.data;
    }
    const chunkData = generateChunk(cx, cy);
    chunks.set(key, { data: chunkData, lastAccessed: Date.now() });
    return chunkData;
}

function generateChunk(cx, cy) {
    let grid = [];
    const size = CONFIG.CHUNK_SIZE;
    
    // 1. 初始化全墙壁
    for (let y = 0; y < size; y++) {
        let row = [];
        for (let x = 0; x < size; x++) {
            row.push({ x, y, walls: { top: 1, right: 1, bottom: 1, left: 1 }, walkable: false });
        }
        grid.push(row);
    }

    // 2. 必通出口 (中心十字) - 保证区块间连通
    const mid = Math.floor(size / 2);
    grid[0][mid].walls.top = 0;
    grid[size-1][mid].walls.bottom = 0;
    grid[mid][0].walls.left = 0;
    grid[mid][size-1].walls.right = 0;
    
    // 标记出口为可行走
    grid[0][mid].walkable = true;
    grid[size-1][mid].walkable = true;
    grid[mid][0].walkable = true;
    grid[mid][size-1].walkable = true;

    // 3. DFS 生成迷宫
    let stack = [{x: mid, y: mid}];
    let visited = new Set([`${mid},${mid}`]);
    grid[mid][mid].walkable = true;

    while(stack.length > 0) {
        let curr = stack[stack.length-1];
        let neighbors = [
            {dx:0, dy:-1, w:'top', opp:'bottom'}, {dx:1, dy:0, w:'right', opp:'left'},
            {dx:0, dy:1, w:'bottom', opp:'top'}, {dx:-1, dy:0, w:'left', opp:'right'}
        ].filter(d => {
            let nx = curr.x + d.dx, ny = curr.y + d.dy;
            return nx >= 0 && nx < size && ny >= 0 && ny < size && !visited.has(`${nx},${ny}`);
        });

        if(neighbors.length > 0) {
            let next = neighbors[Math.floor(Math.random() * neighbors.length)];
            let nx = curr.x + next.dx, ny = curr.y + next.dy;
            
            grid[curr.y][curr.x].walls[next.w] = 0;
            grid[ny][nx].walls[next.opp] = 0;
            
            // 标记为路
            grid[curr.y][curr.x].walkable = true;
            grid[ny][nx].walkable = true;

            visited.add(`${nx},${ny}`);
            stack.push({x: nx, y: ny});
        } else {
            stack.pop();
        }
    }

    // 4. 腐蚀 (随机打通，增加连通度)
    // 修复：打通墙壁时，必须同时把涉及的格子标记为 walkable
    for(let i=0; i < (size*size)*0.2; i++) {
        let rx = Math.floor(Math.random() * (size-2)) + 1;
        let ry = Math.floor(Math.random() * (size-2)) + 1;
        if(Math.random() > 0.5) {
            grid[ry][rx].walls.right = 0;
            grid[ry][rx+1].walls.left = 0;
            grid[ry][rx].walkable = true;
            grid[ry][rx+1].walkable = true;
        } else {
            grid[ry][rx].walls.bottom = 0;
            grid[ry+1][rx].walls.top = 0;
            grid[ry][rx].walkable = true;
            grid[ry+1][rx].walkable = true;
        }
    }

    // 5. 道具生成 (修复：只在 walkable=true 的地方生成)
    let validSpots = [];
    for(let y=0; y<size; y++) {
        for(let x=0; x<size; x++) {
            // 不要在中心生成
            if(cx===0 && cy===0 && Math.abs(x-mid)<2 && Math.abs(y-mid)<2) continue;
            if(grid[y][x].walkable) {
                validSpots.push({x,y});
            }
        }
    }

    let items = [];
    const count = 3 + Math.floor(Math.random() * 3);
    for(let i=0; i<count; i++) {
        if(validSpots.length === 0) break;
        // 随机取一个空位
        const idx = Math.floor(Math.random() * validSpots.length);
        const spot = validSpots.splice(idx, 1)[0]; // 取出并移除，防重叠

        const rand = Math.random();
        let type = CONFIG.ITEMS.ENERGY;
        if (rand > 0.75) type = CONFIG.ITEMS.SPEED;
        if (rand > 0.88) type = CONFIG.ITEMS.VISION;
        if (rand > 0.96) type = CONFIG.ITEMS.TELEPORT;

        items.push({ 
            id: Math.random().toString(36).substr(2), 
            x: spot.x, y: spot.y, 
            type: type 
        });
    }

    return { cx, cy, grid, items };
}

// --- 玩家逻辑 ---
mazeIo.on('connection', (socket) => {
    // 安全出生点：随机找一个 Chunk 的中心，因为中心必定是空的
    const scx = Math.floor((Math.random()-0.5) * CONFIG.SPAWN_RADIUS * 2);
    const scy = Math.floor((Math.random()-0.5) * CONFIG.SPAWN_RADIUS * 2);
    getChunk(scx, scy); // 触发生成

    const startX = scx * CONFIG.CHUNK_SIZE + Math.floor(CONFIG.CHUNK_SIZE/2);
    const startY = scy * CONFIG.CHUNK_SIZE + Math.floor(CONFIG.CHUNK_SIZE/2);

    players[socket.id] = {
        id: socket.id,
        x: startX,
        y: startY,
        skin: generateIdentity(),
        energy: 100,
        score: 0,
        isDead: false,
        inventory: [],
        buffs: { speed: 0, vision: 0 },
        lastAck: Date.now()
    };

    socket.emit('init', { selfId: socket.id, config: CONFIG });
    pushState(socket.id);

    // 移动
    socket.on('move', (d) => {
        let p = players[socket.id];
        if (!p || p.isDead) return;

        // 简单的频率限制
        const now = Date.now();
        // 如果有加速Buff，允许稍微快一点的频率(虽然逻辑上主要靠客户端插值)
        const minTime = p.buffs.speed > now ? 60 : CONFIG.MOVE_COOLDOWN - 20;
        if (now - p.lastAck < minTime) return;
        p.lastAck = now;

        const { dir, sprint } = d;
        let tx = p.x, ty = p.y;

        if (dir === 'up') ty--;
        else if (dir === 'down') ty++;
        else if (dir === 'left') tx--;
        else if (dir === 'right') tx++;
        else return;

        // 碰撞检查
        if (!isBlocked(p.x, p.y, dir)) {
            p.x = tx;
            p.y = ty;
            
            // 冲刺消耗
            if (sprint && p.energy > 5) p.energy -= 1.0;
            
            checkInteract(p, socket);
        }
    });

    // 使用道具
    socket.on('use', (index) => {
        let p = players[socket.id];
        if (!p || p.isDead) return;
        
        if (p.inventory[index] !== undefined) {
            const type = p.inventory[index];
            useItem(p, type, socket);
            p.inventory.splice(index, 1);
        }
    });

    socket.on('respawn', () => {
        let p = players[socket.id];
        if (p) {
            p.energy = 100;
            p.isDead = false;
            p.score = Math.floor(p.score * 0.5);
            p.inventory = [];
            p.buffs = { speed: 0, vision: 0 };
            // 原地复活
        }
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

function useItem(p, type, socket) {
    const now = Date.now();
    if(type === CONFIG.ITEMS.SPEED) {
        p.buffs.speed = now + 6000;
        socket.emit('fx', { t:'txt', msg:'SPEED UP!', x:p.x, y:p.y, c:'#0ff' });
    }
    else if(type === CONFIG.ITEMS.VISION) {
        p.buffs.vision = now + 12000;
        socket.emit('fx', { t:'txt', msg:'NIGHT VISION', x:p.x, y:p.y, c:'#0f0' });
    }
    else if(type === CONFIG.ITEMS.TELEPORT) {
        // 尝试随机传送
        for(let i=0; i<10; i++) {
            let dx = Math.floor(Math.random()*20)-10;
            let dy = Math.floor(Math.random()*20)-10;
            if(!isBlocked(p.x+dx, p.y+dy, 'up')) { // 简单检查
                p.x += dx; p.y += dy;
                socket.emit('fx', { t:'txt', msg:'WARP', x:p.x, y:p.y, c:'#f0f' });
                break;
            }
        }
    }
}

function checkInteract(p, socket) {
    const cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    const chunk = getChunk(cx, cy);

    // 局部坐标
    const lx = ((p.x % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const ly = ((p.y % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;

    const idx = chunk.items.findIndex(i => i.x === lx && i.y === ly);
    if (idx !== -1) {
        const item = chunk.items[idx];
        
        if (item.type === CONFIG.ITEMS.ENERGY) {
            p.energy = Math.min(100, p.energy + 20);
            p.score += 20;
            socket.emit('fx', { t:'txt', msg:'+20 POWER', x:p.x, y:p.y, c:'#ff0' });
            chunk.items.splice(idx, 1);
            mazeIo.emit('item_gone', { k: `${cx},${cy}`, id: item.id });
        } else {
            if (p.inventory.length < CONFIG.MAX_INVENTORY) {
                p.inventory.push(item.type);
                socket.emit('fx', { t:'txt', msg:'ITEM GET', x:p.x, y:p.y });
                chunk.items.splice(idx, 1);
                mazeIo.emit('item_gone', { k: `${cx},${cy}`, id: item.id });
            } else {
                socket.emit('fx', { t:'txt', msg:'BAG FULL', x:p.x, y:p.y, c:'#f00' });
            }
        }
    }
}

function isBlocked(gx, gy, dir) {
    const cx = Math.floor(gx / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(gy / CONFIG.CHUNK_SIZE);
    const chunk = getChunk(cx, cy);
    const lx = ((gx % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const ly = ((gy % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const cell = chunk.grid[ly][lx];
    
    // 物理墙壁检测
    if (dir === 'up' && cell.walls.top) return true;
    if (dir === 'down' && cell.walls.bottom) return true;
    if (dir === 'left' && cell.walls.left) return true;
    if (dir === 'right' && cell.walls.right) return true;
    return false;
}

function pushState(sid) {
    const p = players[sid];
    if (!p) return;
    const socket = mazeIo.sockets.get(sid);
    if (!socket) return;

    const cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    let chunksToSend = [];
    
    // 发送周围 3x3 Chunk (9个)
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            chunksToSend.push(getChunk(cx + dx, cy + dy));
        }
    }

    let visiblePlayers = {};
    for (let pid in players) {
        let op = players[pid];
        if (Math.abs(op.x - p.x) < 30 && Math.abs(op.y - p.y) < 30) {
            visiblePlayers[pid] = {
                id: op.id, x: op.x, y: op.y, 
                skin: op.skin, isDead: op.isDead, score: op.score
            };
        }
    }

    let lb = Object.values(players).sort((a,b)=>b.score-a.score).slice(0,5)
        .map(u => ({ name: u.skin.name, score: Math.floor(u.score), color: u.skin.color, isMe: u.id === sid }));

    socket.emit('state', {
        me: p, 
        chunks: chunksToSend,
        players: visiblePlayers,
        lb: lb
    });
}

setInterval(() => {
    const now = Date.now();
    for (let id in players) {
        let p = players[id];
        if (!p.isDead) {
            p.energy -= CONFIG.ENERGY_DECAY * 0.1;
            if (p.energy <= 0) { p.energy = 0; p.isDead = true; }
            else p.score += 0.1;
            
            if(p.buffs.speed < now) p.buffs.speed = 0;
            if(p.buffs.vision < now) p.buffs.vision = 0;
        }
        pushState(id);
    }
}, CONFIG.TICK_RATE);

setInterval(() => {
    const now = Date.now();
    for (let [k, v] of chunks) {
        if (now - v.lastAccessed > CONFIG.CHUNK_LIFETIME) chunks.delete(k);
    }
}, CONFIG.GC_INTERVAL);

server.listen(PORT, () => {
    console.log(`Server v2.0 (Solid Walls) on ${PORT}`);
});