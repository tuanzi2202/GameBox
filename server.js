const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });
const path = require('path');

const PORT = 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 🎮 迷宫频道：逻辑核心
// ==========================================
const mazeIo = io.of('/maze');

const GRID_SIZE = 20;
let gameState = {
    maze: [],
    players: {},
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 19, y: 19 },
    winner: null // 记录当前有没有人赢
};

// --- 专业算法：带起点终点的迷宫生成 ---
function generateMaze() {
    console.log("正在构建新赛季地图...");
    let grid = [];
    // 1. 初始化全墙
    for (let y = 0; y < GRID_SIZE; y++) {
        let row = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            row.push({ x, y, visited: false, walls: { top: true, right: true, bottom: true, left: true } });
        }
        grid.push(row);
    }

    // 2. DFS 生成
    function visit(cell) {
        cell.visited = true;
        const neighbors = [
            { x: cell.x, y: cell.y - 1, dir: 'top', opp: 'bottom' },
            { x: cell.x + 1, y: cell.y, dir: 'right', opp: 'left' },
            { x: cell.x, y: cell.y + 1, dir: 'bottom', opp: 'top' },
            { x: cell.x - 1, y: cell.y, dir: 'left', opp: 'right' }
        ].sort(() => Math.random() - 0.5);

        for (let n of neighbors) {
            if (n.x >= 0 && n.x < GRID_SIZE && n.y >= 0 && n.y < GRID_SIZE && !grid[n.y][n.x].visited) {
                cell.walls[n.dir] = false;
                grid[n.y][n.x].walls[n.opp] = false;
                visit(grid[n.y][n.x]);
            }
        }
    }
    
    // 3. 设定起点(左上)和终点(右下)
    let start = { x: 0, y: 0 };
    let end = { x: GRID_SIZE - 1, y: GRID_SIZE - 1 };
    
    visit(grid[start.y][start.x]);

    // 4. 打一些随机洞，防止太难
    for(let i=0; i<GRID_SIZE*3; i++) {
        let rx = Math.floor(Math.random()*(GRID_SIZE-1));
        let ry = Math.floor(Math.random()*(GRID_SIZE-1));
        if(Math.random()>0.5) grid[ry][rx].walls.right = grid[ry][rx+1].walls.left = false;
        else grid[ry][rx].walls.bottom = grid[ry+1][rx].walls.top = false;
    }

    // 更新全局状态
    gameState.maze = grid;
    gameState.startPoint = start;
    gameState.endPoint = end;
    gameState.winner = null;

    // 重置所有在线玩家位置到起点
    for (let id in gameState.players) {
        gameState.players[id].gridX = start.x;
        gameState.players[id].gridY = start.y;
    }

    return gameState;
}

// 启动生成
generateMaze();

// --- 核心逻辑处理 ---
mazeIo.on('connection', (socket) => {
    console.log(`[迷宫] 勇士 ${socket.id} 加入`);

    // 1. 玩家出生 (出生在起点)
    gameState.players[socket.id] = {
        id: socket.id,
        gridX: gameState.startPoint.x,
        gridY: gameState.startPoint.y,
        color: `hsl(${Math.random() * 360}, 100%, 50%)`,
        score: 0
    };

    // 2. 发送完整游戏状态 (地图、终点、玩家)
    socket.emit('init', {
        selfId: socket.id,
        gameState: gameState,
        gridSize: GRID_SIZE
    });
    socket.broadcast.emit('newPlayer', gameState.players[socket.id]);

    // 3. 【防作弊核心】监听移动指令 (只接收方向，不接收坐标)
    socket.on('playerMoveAction', (direction) => {
        let player = gameState.players[socket.id];
        if (!player || gameState.winner) return; // 赢了就冻结游戏

        let currentX = player.gridX;
        let currentY = player.gridY;
        let targetX = currentX;
        let targetY = currentY;

        // 计算目标位置
        if (direction === 'up') targetY -= 1;
        if (direction === 'down') targetY += 1;
        if (direction === 'left') targetX -= 1;
        if (direction === 'right') targetX += 1;

        // 3.1 边界检查
        if (targetX < 0 || targetX >= GRID_SIZE || targetY < 0 || targetY >= GRID_SIZE) return;

        // 3.2 墙壁碰撞检查 (服务端校验！)
        let cell = gameState.maze[currentY][currentX];
        let targetCell = gameState.maze[targetY][targetX];
        let blocked = false;

        if (direction === 'up') { if (targetCell.walls.bottom) blocked = true; } 
        else if (direction === 'down') { if (cell.walls.bottom) blocked = true; }
        else if (direction === 'left') { if (targetCell.walls.right) blocked = true; }
        else if (direction === 'right') { if (cell.walls.right) blocked = true; }

        if (!blocked) {
            // 允许移动
            player.gridX = targetX;
            player.gridY = targetY;

            // 广播新位置
            mazeIo.emit('playerMoved', { id: socket.id, gridX: targetX, gridY: targetY });

            // 3.3 胜利检测
            if (targetX === gameState.endPoint.x && targetY === gameState.endPoint.y) {
                console.log(`玩家 ${socket.id} 获胜！`);
                gameState.winner = socket.id;
                
                // 广播胜利消息
                mazeIo.emit('gameWon', { winnerId: socket.id });

                // 3秒后自动开始新的一局
                setTimeout(() => {
                    generateMaze();
                    mazeIo.emit('gameRestart', gameState);
                }, 3000);
            }
        }
    });

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        mazeIo.emit('playerDisconnected', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`\n👵 太奶的专业版游戏盒子已启动！端口: ${PORT}\n`);
});