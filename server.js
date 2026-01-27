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

// --- Game Configuration ---
const FPS = 60;
const MAP_SIZE = 2000;

const KITS = {
    assault: { name: "Assault", hp: 100, speed: 5, size: 20, reload: 15, dmg: 10, bulletSpeed: 12, range: 400, color: '#3498db' },
    sniper:  { name: "Sniper",  hp: 60,  speed: 6, size: 18, reload: 60, dmg: 45, bulletSpeed: 25, range: 800, color: '#e74c3c' },
    tank:    { name: "Tank",    hp: 200, speed: 3, size: 28, reload: 30, dmg: 20, bulletSpeed: 8,  range: 300, color: '#27ae60' }
};

let players = {};
let bullets = [];
let bulletIdCounter = 0;

io.on('connection', (socket) => {
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
            // SPRINT MECHANIC:
            stamina: 100, 
            isSprinting: false,
            input: { w: false, a: false, s: false, d: false, shift: false }
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
        io.emit('playerCount', io.engine.clientsCount);
    });
});

setInterval(() => {
    for (const id in players) {
        const p = players[id];
        const stats = KITS[p.kit];
        
        // Sprint Logic
        let currentSpeed = stats.speed;
        if (p.input.shift && p.stamina > 0) {
            currentSpeed *= 1.5; // 50% speed boost
            p.stamina = Math.max(0, p.stamina - 2);
            p.isSprinting = true;
        } else {
            p.stamina = Math.min(100, p.stamina + 1);
            p.isSprinting = false;
        }

        // Movement
        if (p.input.w) p.y -= currentSpeed;
        if (p.input.s) p.y += currentSpeed;
        if (p.input.a) p.x -= currentSpeed;
        if (p.input.d) p.x += currentSpeed;

        p.x = Math.max(0, Math.min(MAP_SIZE, p.x));
        p.y = Math.max(0, Math.min(MAP_SIZE, p.y));

        if (p.cooldown > 0) p.cooldown--;
    }

    // Bullet Logic (Same as before)
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