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

// --- 核心配置 ---
const CONFIG = {
    CHUNK_SIZE: 15,
    CELL_SIZE: 40,
    TICK_RATE: 100,        // 10Hz 逻辑刷新
    MOVE_COOLDOWN: 80,     // 客户端发送频率限制
    
    // 平衡性参数
    SPAWN_RADIUS: 5,       // 出生半径(Chunk数)
    ENERGY_DECAY: 0.6,     // 能量衰减速度
    ITEM_ENERGY: 30,
    ITEM_SCORE: 50,
    
    // 系统参数
    GC_INTERVAL: 30000,    // 30秒清理一次内存
    CHUNK_LIFETIME: 60000  // 60秒无人访问则销毁
};

// --- 内存数据 ---
let chunks = new Map();
let players = {}; 

// --- 辅助工具：随机颜色/昵称生成器 ---
const ADJECTIVES = ["Neon", "Cyber", "Dark", "Hyper", "Void", "Solar", "Toxic"];
const NOUNS = ["Runner", "Ghost", "Orb", "Core", "Spark", "Glitch", "Echo"];

function generateIdentity() {
    const hue = Math.floor(Math.random() * 360);
    return {
        // 随机皮肤参数
        color: `hsl(${hue}, 80%, 60%)`,
        glow: `hsl(${hue}, 90%, 50%)`,
        coreColor: Math.random() > 0.5 ? '#fff' : `hsl(${(hue+180)%360}, 100%, 80%)`, // 互补色或白色核心
        name: `${ADJECTIVES[Math.floor(Math.random()*ADJECTIVES.length)]}-${Math.floor(Math.random()*999)}`
    };
}

// --- 地图系统 ---
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
            row.push({ x, y, walls: { top: 1, right: 1, bottom: 1, left: 1 } });
        }
        grid.push(row);
    }

    // 2. 强制打通中心十字 (保证连通性)
    const mid = Math.floor(size / 2);
    grid[0][mid].walls.top = 0;
    grid[size-1][mid].walls.bottom = 0;
    grid[mid][0].walls.left = 0;
    grid[mid][size-1].walls.right = 0;

    // 3. DFS 生成迷宫
    let stack = [{x: mid, y: mid}];
    let visited = new Set([`${mid},${mid}`]);

    while(stack.length > 0) {
        let curr = stack[stack.length-1];
        let neighbors = [
            {dx:0, dy:-1, w:'top', opp:'bottom'},
            {dx:1, dy:0, w:'right', opp:'left'},
            {dx:0, dy:1, w:'bottom', opp:'top'},
            {dx:-1, dy:0, w:'left', opp:'right'}
        ].filter(d => {
            let nx = curr.x + d.dx, ny = curr.y + d.dy;
            return nx >= 0 && nx < size && ny >= 0 && ny < size && !visited.has(`${nx},${ny}`);
        });

        if(neighbors.length > 0) {
            let nextDir = neighbors[Math.floor(Math.random() * neighbors.length)];
            let nx = curr.x + nextDir.dx, ny = curr.y + nextDir.dy;
            
            grid[curr.y][curr.x].walls[nextDir.w] = 0;
            grid[ny][nx].walls[nextDir.opp] = 0;
            
            visited.add(`${nx},${ny}`);
            stack.push({x: nx, y: ny});
        } else {
            stack.pop();
        }
    }

    // 4. 腐蚀算法 (随机打通 15% 的墙，减少死胡同)
    for(let i=0; i < (size*size)*0.15; i++) {
        let rx = Math.floor(Math.random() * (size-2)) + 1;
        let ry = Math.floor(Math.random() * (size-2)) + 1;
        if(Math.random() > 0.5) {
            grid[ry][rx].walls.right = 0;
            grid[ry][rx+1].walls.left = 0;
        } else {
            grid[ry][rx].walls.bottom = 0;
            grid[ry+1][rx].walls.top = 0;
        }
    }

    // 5. 物品生成
    let items = [];
    const itemCount = Math.floor(Math.random() * 3) + 2;
    for(let i=0; i<itemCount; i++) {
        let ix = Math.floor(Math.random()*size);
        let iy = Math.floor(Math.random()*size);
        // 简单防重叠
        if(!items.find(it => it.x === ix && it.y === iy)) {
            items.push({ id: Math.random().toString(36).substr(2), x: ix, y: iy });
        }
    }

    return { cx, cy, grid, items };
}

// --- 玩家逻辑 ---
mazeIo.on('connection', (socket) => {
    // 1. 随机出生点计算
    const spawnCx = Math.floor((Math.random() - 0.5) * 2 * CONFIG.SPAWN_RADIUS);
    const spawnCy = Math.floor((Math.random() - 0.5) * 2 * CONFIG.SPAWN_RADIUS);
    // 确保出生区块存在
    getChunk(spawnCx, spawnCy); 
    
    // 全局坐标
    const startX = spawnCx * CONFIG.CHUNK_SIZE + 7;
    const startY = spawnCy * CONFIG.CHUNK_SIZE + 7;

    const identity = generateIdentity();

    players[socket.id] = {
        id: socket.id,
        x: startX,
        y: startY,
        skin: identity, // 皮肤数据
        energy: 100,
        score: 0,
        isDead: false,
        lastAck: Date.now()
    };

    console.log(`Player join: ${identity.name} at [${spawnCx}, ${spawnCy}]`);

    socket.emit('init', { selfId: socket.id, config: CONFIG });
    pushState(socket.id);

    socket.on('move', (d) => {
        let p = players[socket.id];
        if (!p || p.isDead) return;

        // 防作弊：距离/速度检查 (简单的冷却检查)
        const now = Date.now();
        if (now - p.lastAck < CONFIG.MOVE_COOLDOWN - 20) return; // 允许少量误差
        p.lastAck = now;

        const { dir, sprint } = d;
        let tx = p.x, ty = p.y;

        if (dir === 'up') ty--;
        else if (dir === 'down') ty++;
        else if (dir === 'left') tx--;
        else if (dir === 'right') tx++;
        else return;

        // 碰撞检测
        if (!isBlocked(p.x, p.y, dir)) {
            p.x = tx;
            p.y = ty;
            // 冲刺消耗
            if(sprint && p.energy > 5) p.energy -= 1.5;
            checkItem(p);
        }
    });

    socket.on('respawn', () => {
        let p = players[socket.id];
        if (p) {
            p.energy = 100;
            p.isDead = false;
            p.score = Math.floor(p.score * 0.5);
            // 原地复活
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

function isBlocked(gx, gy, dir) {
    const cx = Math.floor(gx / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(gy / CONFIG.CHUNK_SIZE);
    const chunk = getChunk(cx, cy); // 安全获取

    // 转为局部坐标
    const lx = ((gx % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const ly = ((gy % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const cell = chunk.grid[ly][lx];

    if (dir === 'up' && cell.walls.top) return true;
    if (dir === 'down' && cell.walls.bottom) return true;
    if (dir === 'left' && cell.walls.left) return true;
    if (dir === 'right' && cell.walls.right) return true;
    return false;
}

function checkItem(p) {
    const cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    const chunk = getChunk(cx, cy); // 安全获取

    const lx = ((p.x % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const ly = ((p.y % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;

    const idx = chunk.items.findIndex(i => i.x === lx && i.y === ly);
    if (idx !== -1) {
        const item = chunk.items[idx];
        p.energy = Math.min(100, p.energy + CONFIG.ITEM_ENERGY);
        p.score += CONFIG.ITEM_SCORE;
        chunk.items.splice(idx, 1);
        mazeIo.emit('item_gone', { key: `${cx},${cy}`, id: item.id });
    }
}

// AOI 广播 (只发送视野内的数据)
function pushState(sid) {
    const p = players[sid];
    if (!p) return;
    const socket = mazeIo.sockets.get(sid);
    if (!socket) return;

    // 视野范围：周围 2 格 Chunk
    const cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    let visibleChunks = [];
    
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            visibleChunks.push(getChunk(cx + dx, cy + dy));
        }
    }

    // 玩家过滤
    let visiblePlayers = {};
    for (let pid in players) {
        let target = players[pid];
        // 简单距离判断 (50格以内)
        if (Math.abs(target.x - p.x) < 50 && Math.abs(target.y - p.y) < 50) {
            visiblePlayers[pid] = target;
        }
    }

    // 排行榜
    let lb = Object.values(players)
        .sort((a,b) => b.score - a.score)
        .slice(0, 5)
        .map(u => ({ name: u.skin.name, score: Math.floor(u.score), color: u.skin.color, isMe: u.id === sid }));

    socket.emit('state', {
        me: p,
        chunks: visibleChunks,
        players: visiblePlayers,
        lb: lb
    });
}

// Game Loop
setInterval(() => {
    for (let id in players) {
        let p = players[id];
        if (!p.isDead) {
            p.energy -= CONFIG.ENERGY_DECAY * 0.1;
            if (p.energy <= 0) { p.energy = 0; p.isDead = true; }
            else p.score += 0.2; // 存活分
        }
        pushState(id);
    }
}, CONFIG.TICK_RATE);

// GC Loop
setInterval(() => {
    const now = Date.now();
    for (let [k, v] of chunks) {
        if (now - v.lastAccessed > CONFIG.CHUNK_LIFETIME) chunks.delete(k);
    }
}, CONFIG.GC_INTERVAL);

server.listen(PORT, () => {
    console.log(`Pro Maze Server on ${PORT}`);
});