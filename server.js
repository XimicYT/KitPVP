const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: false
    }
});

app.use(express.static('public'));

// --- Game Config ---
const FPS = 60;
const MAP_SIZE = 2000;
const OBSTACLE_COUNT = 20;

const KITS = {
    assault: { name: "Assault", hp: 100, speed: 5, size: 20, reload: 15, dmg: 10, bulletSpeed: 12, range: 400, color: '#3498db' },
    sniper:  { name: "Sniper",  hp: 60,  speed: 6, size: 18, reload: 60, dmg: 45, bulletSpeed: 25, range: 800, color: '#e74c3c' },
    tank:    { name: "Tank",    hp: 200, speed: 3, size: 28, reload: 30, dmg: 20, bulletSpeed: 8,  range: 300, color: '#27ae60' }
};

let players = {};
let bullets = [];
let obstacles = [];
let bulletIdCounter = 0;

// Generate Obstacles (Walls)
for (let i = 0; i < OBSTACLE_COUNT; i++) {
    obstacles.push({
        x: Math.random() * (MAP_SIZE - 100),
        y: Math.random() * (MAP_SIZE - 100),
        w: 50 + Math.random() * 100,
        h: 50 + Math.random() * 100
    });
}

// Helper: Circle-Rectangle Collision
function checkRectCollision(circle, rect) {
    const distX = Math.abs(circle.x - rect.x - rect.w / 2);
    const distY = Math.abs(circle.y - rect.y - rect.h / 2);

    if (distX > (rect.w / 2 + circle.r)) return false;
    if (distY > (rect.h / 2 + circle.r)) return false;

    if (distX <= (rect.w / 2)) return true; 
    if (distY <= (rect.h / 2)) return true;

    const dx = distX - rect.w / 2;
    const dy = distY - rect.h / 2;
    return (dx * dx + dy * dy <= (circle.r * circle.r));
}

io.on('connection', (socket) => {
    // Send initial map data
    socket.emit('mapData', obstacles);

    socket.on('join_game', (kitName) => {
        const kit = KITS[kitName] || KITS.assault;
        players[socket.id] = {
            id: socket.id,
            x: Math.random() * MAP_SIZE,
            y: Math.random() * MAP_SIZE,
            kit: kitName,
            hp: kit.hp,
            maxHp: kit.hp,
            score: 0,
            angle: 0,
            cooldown: 0,
            stamina: 100,
            input: { w: false, a: false, s: false, d: false, shift: false }
        };
        // Accurate Count Update
        io.emit('playerCount', Object.keys(players).length);
    });

    socket.on('movement', (input) => {
        if (players[socket.id]) {
            players[socket.id].input = input;
            players[socket.id].angle = input.angle;
        }
    });

    socket.on('shoot', () => {
        const p = players[socket.id];
        if (p && p.cooldown <= 0) {
            const stats = KITS[p.kit];
            bullets.push({
                id: bulletIdCounter++,
                ownerId: p.id,
                x: p.x,
                y: p.y,
                vx: Math.cos(p.angle) * stats.bulletSpeed,
                vy: Math.sin(p.angle) * stats.bulletSpeed,
                range: stats.range,
                traveled: 0,
                dmg: stats.dmg
            });
            p.cooldown = stats.reload;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        // Accurate Count Update
        io.emit('playerCount', Object.keys(players).length);
    });
});

setInterval(() => {
    // 1. Update Players
    for (const id in players) {
        const p = players[id];
        const stats = KITS[p.kit];
        
        // Sprint
        let speed = stats.speed;
        if (p.input.shift && p.stamina > 0) {
            speed *= 1.5;
            p.stamina = Math.max(0, p.stamina - 2);
            p.isSprinting = true;
        } else {
            p.stamina = Math.min(100, p.stamina + 1);
            p.isSprinting = false;
        }

        // Calculate potential new position
        let newX = p.x;
        let newY = p.y;

        if (p.input.w) newY -= speed;
        if (p.input.s) newY += speed;
        if (p.input.a) newX -= speed;
        if (p.input.d) newX += speed;

        // Wall Collision Check (Simple Slide Logic)
        let collidedX = false;
        let collidedY = false;
        
        const pSize = stats.size;

        for (const obs of obstacles) {
            if (checkRectCollision({x: newX, y: p.y, r: pSize}, obs)) collidedX = true;
            if (checkRectCollision({x: p.x, y: newY, r: pSize}, obs)) collidedY = true;
        }

        // Update if no collision
        if (!collidedX) p.x = newX;
        if (!collidedY) p.y = newY;

        // Map Boundaries
        p.x = Math.max(0, Math.min(MAP_SIZE, p.x));
        p.y = Math.max(0, Math.min(MAP_SIZE, p.y));

        if (p.cooldown > 0) p.cooldown--;
    }

    // 2. Update Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.traveled += Math.sqrt(b.vx*b.vx + b.vy*b.vy);

        // Remove if out of range/bounds
        if (b.traveled > b.range || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            bullets.splice(i, 1);
            continue;
        }

        // Wall Collision
        let hitWall = false;
        for (const obs of obstacles) {
            if (b.x > obs.x && b.x < obs.x + obs.w && b.y > obs.y && b.y < obs.y + obs.h) {
                bullets.splice(i, 1);
                hitWall = true;
                break;
            }
        }
        if (hitWall) continue;

        // Player Collision
        for (const id in players) {
            const p = players[id];
            if (b.ownerId !== p.id) {
                const dx = p.x - b.x;
                const dy = p.y - b.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < KITS[p.kit].size) {
                    p.hp -= b.dmg;
                    bullets.splice(i, 1);
                    
                    // Notify clients of hit (for particles)
                    io.emit('hit', { x: b.x, y: b.y });

                    if (p.hp <= 0) {
                        const killer = players[b.ownerId];
                        if (killer) killer.score++;
                        p.hp = p.maxHp;
                        p.x = Math.random() * MAP_SIZE;
                        p.y = Math.random() * MAP_SIZE;
                        p.stamina = 100;
                    }
                    break;
                }
            }
        }
    }

    io.emit('state', { players, bullets });
}, 1000 / FPS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));