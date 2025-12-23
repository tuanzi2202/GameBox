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
// 🔥 升级：地图扩大到 30x30，配合手机端摄像机模式
const GRID_SIZE = 30; 
const MOVE_COOLDOWN = 80; // 手感优化：稍微加快一点节奏

let gameState = {
    maze: [],
    players: {},
    startPoint: { x: 0, y: 0 },
    endPoint: { x: GRID_SIZE-1, y: GRID_SIZE-1 },
    winner: null 
};

function generateMaze() {
    console.log("正在构建新赛季巨型地图...");
    let grid = [];
    for (let y = 0; y < GRID_SIZE; y++) {
        let row = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            row.push({ x, y, visited: false, walls: { top: true, right: true, bottom: true, left: true } });
        }
        grid.push(row);
    }

    // DFS 生成主路径
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
    
    let start = { x: 1, y: 1 }; //稍微往里一点
    visit(grid[start.y][start.x]);

    // 🔥 玩法优化：打更多的洞，让地图更像“开阔迷宫”而不是死胡同迷宫
    // 增加追逐和绕路的可能性
    for(let i=0; i<GRID_SIZE*10; i++) {
        let rx = Math.floor(Math.random()*(GRID_SIZE-1));
        let ry = Math.floor(Math.random()*(GRID_SIZE-1));
        if(Math.random()>0.5) grid[ry][rx].walls.right = grid[ry][rx+1].walls.left = false;
        else grid[ry][rx].walls.bottom = grid[ry+1][rx].walls.top = false;
    }

    gameState.maze = grid;
    gameState.startPoint = start;
    gameState.endPoint = { x: GRID_SIZE - 2, y: GRID_SIZE - 2 };
    gameState.winner = null;

    // 重置所有玩家
    for (let id in gameState.players) {
        let p = gameState.players[id];
        p.gridX = start.x;
        p.gridY = start.y;
        p.lastMoveTime = 0;
    }

    return gameState;
}

generateMaze();

mazeIo.on('connection', (socket) => {
    // 随机分配一个鲜艳的颜色
    const hue = Math.floor(Math.random() * 360);
    gameState.players[socket.id] = {
        id: socket.id,
        gridX: gameState.startPoint.x,
        gridY: gameState.startPoint.y,
        color: `hsl(${hue}, 80%, 60%)`, // 这种颜色在黑底上更好看
        lastMoveTime: 0
    };

    socket.emit('init', {
        selfId: socket.id,
        gameState: gameState,
        gridSize: GRID_SIZE
    });
    socket.broadcast.emit('newPlayer', gameState.players[socket.id]);

    socket.on('playerMoveAction', (direction) => {
        let player = gameState.players[socket.id];
        if (!player || gameState.winner) return;

        const now = Date.now();
        if (now - player.lastMoveTime < MOVE_COOLDOWN) return; 

        let currentX = player.gridX;
        let currentY = player.gridY;
        let targetX = currentX;
        let targetY = currentY;

        if (direction === 'up') targetY -= 1;
        if (direction === 'down') targetY += 1;
        if (direction === 'left') targetX -= 1;
        if (direction === 'right') targetX += 1;

        if (targetX < 0 || targetX >= GRID_SIZE || targetY < 0 || targetY >= GRID_SIZE) return;

        let cell = gameState.maze[currentY][currentX];
        let blocked = false;

        if (direction === 'up') { if (cell.walls.top) blocked = true; }
        else if (direction === 'down') { if (cell.walls.bottom) blocked = true; }
        else if (direction === 'left') { if (cell.walls.left) blocked = true; }
        else if (direction === 'right') { if (cell.walls.right) blocked = true; }

        if (!blocked) {
            player.gridX = targetX;
            player.gridY = targetY;
            player.lastMoveTime = now;

            mazeIo.emit('playerMoved', { id: socket.id, gridX: targetX, gridY: targetY });

            if (targetX === gameState.endPoint.x && targetY === gameState.endPoint.y) {
                gameState.winner = socket.id;
                mazeIo.emit('gameWon', { winnerId: socket.id });
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
    console.log(`\n🚀 游戏升级版已启动: http://localhost:${PORT}\n`);
});