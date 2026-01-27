const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// ALLOW CORS (So you can host on Netlify later if you want)
const io = new Server(server, {
    cors: {
        origin: "*",            // Allow connection from ANYWHERE (including file://)
        methods: ["GET", "POST"],
        credentials: false      // Must be false if origin is "*"
    }
});

app.use(express.static('public'));

// --- Game Configuration ---
const FPS = 60;
const MAP_SIZE = 2000;

const KITS = {
    assault: { name: "Assault", hp: 100, speed: 5, size: 20, reload: 15, dmg: 10, bulletSpeed: 12, range: 400 },
    sniper:  { name: "Sniper",  hp: 60,  speed: 6, size: 18, reload: 60, dmg: 45, bulletSpeed: 25, range: 800 },
    tank:    { name: "Tank",    hp: 200, speed: 3, size: 28, reload: 30, dmg: 20, bulletSpeed: 8,  range: 300 }
};

let players = {};
let bullets = [];
let bulletIdCounter = 0;

io.on('connection', (socket) => {
    // 1. Send total count to everyone when a new person connects
    io.emit('playerCount', io.engine.clientsCount);

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
            input: { w: false, a: false, s: false, d: false }
        };
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
        // 2. Update count when someone leaves
        io.emit('playerCount', io.engine.clientsCount);
    });
});

// Game Loop
setInterval(() => {
    // Player Logic
    for (const id in players) {
        const p = players[id];
        const stats = KITS[p.kit];

        if (p.input.w) p.y -= stats.speed;
        if (p.input.s) p.y += stats.speed;
        if (p.input.a) p.x -= stats.speed;
        if (p.input.d) p.x += stats.speed;

        p.x = Math.max(0, Math.min(MAP_SIZE, p.x));
        p.y = Math.max(0, Math.min(MAP_SIZE, p.y));

        if (p.cooldown > 0) p.cooldown--;
    }

    // Bullet Logic
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.traveled += Math.sqrt(b.vx*b.vx + b.vy*b.vy);

        if (b.traveled > b.range || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            bullets.splice(i, 1);
            continue;
        }

        for (const id in players) {
            const p = players[id];
            if (b.ownerId !== p.id) {
                const dx = p.x - b.x;
                const dy = p.y - b.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < KITS[p.kit].size) {
                    p.hp -= b.dmg;
                    bullets.splice(i, 1);
                    if (p.hp <= 0) {
                        const killer = players[b.ownerId];
                        if (killer) killer.score++;
                        p.hp = p.maxHp;
                        p.x = Math.random() * MAP_SIZE;
                        p.y = Math.random() * MAP_SIZE;
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