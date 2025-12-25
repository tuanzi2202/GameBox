const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" }, pingInterval: 2000, pingTimeout: 5000 });
const path = require('path');

const PORT = 3000;
app.use(express.static(path.join(__dirname, 'public')));

const mazeIo = io.of('/maze');

// --- 专业游戏配置 ---
const CONFIG = {
    CHUNK_SIZE: 15,        // 区块尺寸
    CELL_SIZE: 40,         // 格子判定尺寸
    TICK_RATE: 100,        // 逻辑帧率 (ms)
    
    // 游戏性参数
    BASE_SPEED: 1,         // 基础移动距离(格)
    SPRINT_MULT: 2,        // 冲刺倍率
    ENERGY_DECAY: 0.8,     // 正常衰减
    SPRINT_COST: 4,        // 冲刺额外消耗
    ITEM_ENERGY: 25,
    ITEM_SCORE: 50,
    
    // 系统参数
    VIEW_DIST: 2,          // 视野半径 (Chunk数量)
    GC_INTERVAL: 30000,    // GC 频率
    CHUNK_LIFETIME: 60000  // 区块存活时间
};

// --- 内存数据库 ---
// 结构: Key -> { data: ChunkData, lastAccessed: timestamp }
let chunks = new Map();
let players = {}; 

// --- 核心：地图生成与管理 ---
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
    
    // 1. 基础网格
    for (let y = 0; y < size; y++) {
        let row = [];
        for (let x = 0; x < size; x++) {
            row.push({ x, y, walls: { top: 1, right: 1, bottom: 1, left: 1 } });
        }
        grid.push(row);
    }

    // 2. 必通出口 (中心十字)
    const mid = Math.floor(size / 2);
    grid[0][mid].walls.top = 0;
    grid[size-1][mid].walls.bottom = 0;
    grid[mid][0].walls.left = 0;
    grid[mid][size-1].walls.right = 0;

    // 3. DFS 迷宫生成
    let visited = new Set();
    function visit(x, y) {
        visited.add(`${x},${y}`);
        let dirs = [
            { dx: 0, dy: -1, w: 'top', opp: 'bottom' },
            { dx: 1, dy: 0, w: 'right', opp: 'left' },
            { dx: 0, dy: 1, w: 'bottom', opp: 'top' },
            { dx: -1, dy: 0, w: 'left', opp: 'right' }
        ].sort(() => Math.random() - 0.5);

        for (let d of dirs) {
            let nx = x + d.dx, ny = y + d.dy;
            if (nx >= 0 && nx < size && ny >= 0 && ny < size && !visited.has(`${nx},${ny}`)) {
                grid[y][x].walls[d.w] = 0;
                grid[ny][nx].walls[d.opp] = 0;
                visit(nx, ny);
            }
        }
    }
    visit(mid, mid);

    // 4. 地图腐蚀 (Erosion): 随机打通 10% 的墙壁，制造环路和广场，防止死路太令人沮丧
    for(let y=1; y<size-1; y++) {
        for(let x=1; x<size-1; x++) {
            if(Math.random() < 0.1) {
                grid[y][x].walls.right = 0;
                grid[y][x+1].walls.left = 0;
            }
            if(Math.random() < 0.1) {
                grid[y][x].walls.bottom = 0;
                grid[y+1][x].walls.top = 0;
            }
        }
    }

    // 5. 物品生成
    let items = [];
    // 离原点越远，物品越多/越好 (简单的风险奖励机制)
    const dist = Math.abs(cx) + Math.abs(cy);
    const count = 2 + Math.floor(Math.random() * 3) + (dist > 5 ? 2 : 0);
    
    for (let i = 0; i < count; i++) {
        let rx = Math.floor(Math.random() * size);
        let ry = Math.floor(Math.random() * size);
        // 避开中心出生点
        if (cx === 0 && cy === 0 && Math.abs(rx-mid) < 2 && Math.abs(ry-mid) < 2) continue;
        
        items.push({ 
            id: Math.random().toString(36).substr(2, 9), 
            x: rx, y: ry,
            val: CONFIG.ITEM_ENERGY + (dist * 2) // 远处能量更多
        });
    }

    return { cx, cy, grid, items };
}

// --- 游戏逻辑 ---
mazeIo.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);
    
    players[socket.id] = {
        id: socket.id,
        x: Math.floor(CONFIG.CHUNK_SIZE / 2), // 全局格子坐标
        y: Math.floor(CONFIG.CHUNK_SIZE / 2),
        color: `hsl(${Math.floor(Math.random() * 360)}, 85%, 60%)`,
        energy: 100,
        score: 0,
        isDead: false,
        lastAck: Date.now()
    };

    // 发送初始化包
    socket.emit('init', { selfId: socket.id, config: CONFIG });
    
    // 立即推送一次周围环境
    pushStateTo(socket.id);

    // 处理移动请求 (带防作弊和物理校验)
    socket.on('move', (data) => {
        let p = players[socket.id];
        if (!p || p.isDead) return;

        const { dir, sprint } = data;
        const speed = sprint && p.energy > 5 ? CONFIG.SPRINT_MULT : 1;
        
        // 1. 计算目标位
        let tx = p.x, ty = p.y;
        if (dir === 'up') ty -= 1;
        else if (dir === 'down') ty += 1;
        else if (dir === 'left') tx -= 1;
        else if (dir === 'right') tx += 1;
        else return;

        // 2. 碰撞检测
        const cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
        const cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
        const chunk = getChunk(cx, cy); // 确保当前区块已加载
        
        // 获取当前格子的墙壁信息
        const lx = ((p.x % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
        const ly = ((p.y % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
        const cell = chunk.grid[ly][lx];

        let blocked = false;
        if (dir === 'up' && cell.walls.top) blocked = true;
        if (dir === 'down' && cell.walls.bottom) blocked = true;
        if (dir === 'left' && cell.walls.left) blocked = true;
        if (dir === 'right' && cell.walls.right) blocked = true;

        if (!blocked) {
            p.x = tx;
            p.y = ty;
            
            // 冲刺扣除额外能量
            if(sprint && p.energy > 5) {
                p.energy -= 2; 
            }
            
            checkPickup(p);
        }
    });

    socket.on('respawn', () => {
        let p = players[socket.id];
        if (p) {
            p.energy = 100;
            p.isDead = false;
            p.score = Math.floor(p.score * 0.7); // 死亡惩罚
            // 稍微移动一下防止卡死
            p.x += Math.floor(Math.random()*3) - 1;
            p.y += Math.floor(Math.random()*3) - 1;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        console.log(`[DISCONNECT] ${socket.id}`);
    });
});

function checkPickup(p) {
    const cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    const chunk = getChunk(cx, cy); // 安全获取

    const lx = ((p.x % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const ly = ((p.y % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;

    const idx = chunk.items.findIndex(i => i.x === lx && i.y === ly);
    if (idx !== -1) {
        const item = chunk.items[idx];
        p.energy = Math.min(100, p.energy + item.val);
        p.score += item.val * 2;
        chunk.items.splice(idx, 1);
        // 广播移除事件给附近的玩家
        mazeIo.emit('item_gone', { key: `${cx},${cy}`, id: item.id });
    }
}

// --- AOI 广播系统 ---
// 只发送玩家视野内的数据
function pushStateTo(sid) {
    const p = players[sid];
    if (!p) return;
    const socket = mazeIo.sockets.get(sid);
    if (!socket) return;

    // 1. 准备区块数据
    const cx = Math.floor(p.x / CONFIG.CHUNK_SIZE);
    const cy = Math.floor(p.y / CONFIG.CHUNK_SIZE);
    const chunksToSend = [];
    
    for (let dy = -CONFIG.VIEW_DIST; dy <= CONFIG.VIEW_DIST; dy++) {
        for (let dx = -CONFIG.VIEW_DIST; dx <= CONFIG.VIEW_DIST; dx++) {
            chunksToSend.push(getChunk(cx + dx, cy + dy));
        }
    }

    // 2. 筛选可见玩家 (AOI)
    // 假设视野半径约等于 ChunkSize * ViewDist
    const viewRange = CONFIG.CHUNK_SIZE * (CONFIG.VIEW_DIST + 1);
    const visiblePlayers = {};
    for (let oid in players) {
        let op = players[oid];
        if (Math.abs(op.x - p.x) <= viewRange && Math.abs(op.y - p.y) <= viewRange) {
            visiblePlayers[oid] = {
                id: op.id, x: op.x, y: op.y, 
                color: op.color, isDead: op.isDead, score: op.score
            };
        }
    }

    // 3. 排行榜 (全局 Top 5)
    const lb = Object.values(players)
        .sort((a,b) => b.score - a.score)
        .slice(0, 5)
        .map(u => ({ score: Math.floor(u.score), color: u.color, isMe: u.id === sid }));

    socket.emit('state', {
        me: p,
        players: visiblePlayers,
        chunks: chunksToSend,
        lb: lb
    });
}

// --- 主循环 ---
setInterval(() => {
    // 1. 游戏逻辑 Tick
    for (let id in players) {
        let p = players[id];
        if (!p.isDead) {
            p.energy -= CONFIG.ENERGY_DECAY * (CONFIG.TICK_RATE / 1000);
            if (p.energy <= 0) {
                p.energy = 0;
                p.isDead = true;
            } else {
                p.score += 0.1; // 存活奖励
            }
        }
        // 2. 针对每个玩家进行 AOI 推送
        pushStateTo(id);
    }
}, CONFIG.TICK_RATE);

// --- GC 循环 ---
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (let [key, val] of chunks) {
        if (now - val.lastAccessed > CONFIG.CHUNK_LIFETIME) {
            chunks.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[GC] Cleaned ${cleaned} chunks`);
}, CONFIG.GC_INTERVAL);

server.listen(PORT, () => {
    console.log(`Professional Maze Server running on port ${PORT}`);
});