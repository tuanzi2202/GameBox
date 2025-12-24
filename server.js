const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });
const path = require('path');

const PORT = 3000;
app.use(express.static(path.join(__dirname, 'public')));

const mazeIo = io.of('/maze');

// --- 游戏配置 ---
const CONFIG = {
    CHUNK_SIZE: 15,
    CELL_SIZE: 40,
    MOVE_COOLDOWN: 80,
    ENERGY_DECAY: 0.8,
    ITEM_ENERGY: 30,
    ITEM_SCORE: 100,
    GC_INTERVAL: 15000,
    CHUNK_LIFETIME: 60000,
    VIEW_DIST: 2
};

let chunks = new Map();
let players = {};

// --- 区块生成 ---
function getChunk(cx, cy) {
    const key = `${cx},${cy}`;
    if (chunks.has(key)) {
        const wrapper = chunks.get(key);
        wrapper.lastAccessed = Date.now();
        // 关键点：这里返回的是 wrapper.data
        return wrapper.data;
    }
    const chunkData = generateChunk(cx, cy);
    chunks.set(key, { data: chunkData, lastAccessed: Date.now() });
    return chunkData;
}

function generateChunk(cx, cy) {
    let grid = [];
    const size = CONFIG.CHUNK_SIZE;
    // 初始化
    for (let y = 0; y < size; y++) {
        let row = [];
        for (let x = 0; x < size; x++) {
            row.push({ x, y, visited: false, walls: { top: 1, right: 1, bottom: 1, left: 1 } });
        }
        grid.push(row);
    }

    // 必通中心
    const mid = Math.floor(size / 2);
    grid[0][mid].walls.top = 0;
    grid[size - 1][mid].walls.bottom = 0;
    grid[mid][0].walls.left = 0;
    grid[mid][size - 1].walls.right = 0;

    // DFS 生成
    let stack = [grid[mid][mid]];
    grid[mid][mid].visited = true;

    while (stack.length > 0) {
        let curr = stack[stack.length - 1];
        let neighbors = [
            { x: curr.x, y: curr.y - 1, dir: 'top', opp: 'bottom' },
            { x: curr.x + 1, y: curr.y, dir: 'right', opp: 'left' },
            { x: curr.x, y: curr.y + 1, dir: 'bottom', opp: 'top' },
            { x: curr.x - 1, y: curr.y, dir: 'left', opp: 'right' }
        ].filter(n => n.x >= 0 && n.x < size && n.y >= 0 && n.y < size && !grid[n.y][n.x].visited);

        if (neighbors.length > 0) {
            let next = neighbors[Math.floor(Math.random() * neighbors.length)];
            curr.walls[next.dir] = 0;
            grid[next.y][next.x].walls[next.opp] = 0;
            grid[next.y][next.x].visited = true;
            stack.push(grid[next.y][next.x]);
        } else {
            stack.pop();
        }
    }

    // 物品生成
    let items = [];
    const itemCount = Math.floor(Math.random() * 3) + 2;
    for (let i = 0; i < itemCount; i++) {
        let rx = Math.floor(Math.random() * size);
        let ry = Math.floor(Math.random() * size);
        if (rx !== mid || ry !== mid) {
            items.push({ id: Math.random().toString(36).substr(2, 9), x: rx, y: ry });
        }
    }

    return { cx, cy, grid, items };
}

// --- Socket ---
mazeIo.on('connection', (socket) => {
    console.log('Player join:', socket.id);

    // 初始位置
    players[socket.id] = {
        id: socket.id,
        x: Math.floor(CONFIG.CHUNK_SIZE / 2),
        y: Math.floor(CONFIG.CHUNK_SIZE / 2),
        color: `hsl(${Math.random() * 360}, 80%, 60%)`,
        energy: 100,
        score: 0,
        isDead: false,
        lastMove: 0
    };

    socket.emit('init', { selfId: socket.id, config: CONFIG });
    sendStateToPlayer(socket.id); // 立即发送第一帧

    socket.on('move', (dir) => {
        let p = players[socket.id];
        if (!p || p.isDead) return;
        if (Date.now() - p.lastMove < CONFIG.MOVE_COOLDOWN) return;

        let targetX = p.x;
        let targetY = p.y;
        if (dir === 'up') targetY--;
        if (dir === 'down') targetY++;
        if (dir === 'left') targetX--;
        if (dir === 'right') targetX++;

        // 碰撞检测
        let cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
        let cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
        
        // 这里的 getChunk 会返回 data，不仅为了检测，也保证了区块生成
        let chunk = getChunk(cx, cy); 
        
        let lx = ((p.x % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
        let ly = ((p.y % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
        
        let cell = chunk.grid[ly][lx];
        let blocked = false;
        if (dir === 'up' && cell.walls.top) blocked = true;
        if (dir === 'down' && cell.walls.bottom) blocked = true;
        if (dir === 'left' && cell.walls.left) blocked = true;
        if (dir === 'right' && cell.walls.right) blocked = true;

        if (!blocked) {
            p.x = targetX;
            p.y = targetY;
            p.lastMove = Date.now();
            checkItemPickup(p);
        }
    });

    socket.on('respawn', () => {
        let p = players[socket.id];
        if (p) {
            p.energy = 100;
            p.isDead = false;
            p.score = Math.floor(p.score / 2);
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// --- 修复后的函数 ---
function checkItemPickup(p) {
    let cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    let cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    let lx = ((p.x % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    let ly = ((p.y % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;

    // 修改点：使用 getChunk 而不是 chunks.get
    // getChunk 内部会自动解包并返回 .data (包含 .items)，同时刷新活跃时间
    let chunk = getChunk(cx, cy); 
    
    if (chunk && chunk.items) {
        let idx = chunk.items.findIndex(i => i.x === lx && i.y === ly);
        if (idx !== -1) {
            p.energy = Math.min(100, p.energy + CONFIG.ITEM_ENERGY);
            p.score += CONFIG.ITEM_SCORE;
            let item = chunk.items.splice(idx, 1)[0];
            mazeIo.emit('item_removed', { key: `${cx},${cy}`, id: item.id });
        }
    }
}

function sendStateToPlayer(sid) {
    let p = players[sid];
    if (!p) return;

    let cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    let cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    let chunksToSend = [];

    // 发送 5x5 范围
    for (let dy = -CONFIG.VIEW_DIST; dy <= CONFIG.VIEW_DIST; dy++) {
        for (let dx = -CONFIG.VIEW_DIST; dx <= CONFIG.VIEW_DIST; dx++) {
            chunksToSend.push(getChunk(cx + dx, cy + dy));
        }
    }

    let lb = Object.values(players).sort((a, b) => b.score - a.score).slice(0, 5)
        .map(x => ({ color: x.color, score: x.score, isMe: x.id === sid }));

    const socket = mazeIo.sockets.get(sid);
    if(socket) {
        socket.emit('gamestate', {
            me: p,
            players: players,
            chunks: chunksToSend,
            leaderboard: lb
        });
    }
}

// 循环
setInterval(() => {
    for (let id in players) {
        let p = players[id];
        if (!p.isDead) {
            p.energy -= CONFIG.ENERGY_DECAY * 0.1;
            if (p.energy <= 0) { p.energy = 0; p.isDead = true; }
            else p.score += 0.2;
        }
        sendStateToPlayer(id);
    }
}, 100);

setInterval(() => {
    const now = Date.now();
    for (let [k, v] of chunks) {
        if (now - v.lastAccessed > CONFIG.CHUNK_LIFETIME) chunks.delete(k);
    }
}, CONFIG.GC_INTERVAL);

server.listen(PORT, () => {
    console.log(`Maze Server on ${PORT}`);
});