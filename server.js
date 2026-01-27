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
const OBSTACLE_COUNT = 25; // More obstacles now that they don't overlap

const KITS = {
    assault: { name: "Assault", hp: 100, speed: 5, size: 20, reload: 15, dmg: 10, bulletSpeed: 12, range: 450, color: '#3498db' },
    sniper:  { name: "Sniper",  hp: 60,  speed: 6, size: 18, reload: 60, dmg: 45, bulletSpeed: 25, range: 900, color: '#e74c3c' },
    tank:    { name: "Tank",    hp: 200, speed: 3, size: 28, reload: 30, dmg: 20, bulletSpeed: 8,  range: 300, color: '#27ae60' }
};

let players = {};
let bullets = [];
let obstacles = [];
let bulletIdCounter = 0;

// --- Helper: Collision Detection ---
function checkRectCollision(circle, rect) {
    // Expand rect slightly for player collision to prevent clipping
    const testX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.w));
    const testY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.h));

    const distX = circle.x - testX;
    const distY = circle.y - testY;
    
    return (distX * distX + distY * distY) < (circle.r * circle.r);
}

function checkRectOverlap(r1, r2, padding = 0) {
    return !(r2.x - padding > r1.x + r1.w || 
             r2.x + r2.w + padding < r1.x || 
             r2.y - padding > r1.y + r1.h || 
             r2.y + r2.h + padding < r1.y);
}

// --- Generate Smart Obstacles ---
function generateObstacles() {
    obstacles = [];
    let attempts = 0;
    while (obstacles.length < OBSTACLE_COUNT && attempts < 1000) {
        const w = 60 + Math.random() * 100;
        const h = 60 + Math.random() * 100;
        const x = Math.random() * (MAP_SIZE - w);
        const y = Math.random() * (MAP_SIZE - h);
        
        const newObs = { x, y, w, h };
        let valid = true;

        // Check if overlaps with existing obstacles (with 50px buffer)
        for (const obs of obstacles) {
            if (checkRectOverlap(newObs, obs, 50)) {
                valid = false;
                break;
            }
        }

        if (valid) obstacles.push(newObs);
        attempts++;
    }
}
generateObstacles();

// --- Find Safe Spawn Point ---
function getSafeSpawn(radius) {
    let attempts = 0;
    while (attempts < 100) {
        const x = Math.random() * MAP_SIZE;
        const y = Math.random() * MAP_SIZE;
        let safe = true;

        for (const obs of obstacles) {
            if (checkRectCollision({x, y, r: radius + 20}, obs)) { // +20 buffer
                safe = false;
                break;
            }
        }
        if (safe) return { x, y };
        attempts++;
    }
    return { x: MAP_SIZE/2, y: MAP_SIZE/2 }; // Fallback to center
}

io.on('connection', (socket) => {
    socket.emit('mapData', obstacles);

    // Latency Check (Ping)
    socket.on('latency_ping', (timestamp) => {
        socket.emit('latency_pong', timestamp);
    });

    socket.on('join_game', (kitName) => {
        const kit = KITS[kitName] || KITS.assault;
        const spawn = getSafeSpawn(kit.size);
        
        players[socket.id] = {
            id: socket.id,
            x: spawn.x,
            y: spawn.y,
            kit: kitName,
            hp: kit.hp,
            maxHp: kit.hp,
            score: 0,
            angle: 0,
            cooldown: 0,
            stamina: 100,
            regenTimer: 0,
            input: { w: false, a: false, s: false, d: false, shift: false }
        };
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
            p.regenTimer = 180; // Stop regen for 3 seconds (60 ticks * 3)
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerCount', Object.keys(players).length);
    });
});

setInterval(() => {
    // 1. Update Players
    for (const id in players) {
        const p = players[id];
        const stats = KITS[p.kit];
        
        // Regen Logic (Passive Healing)
        if (p.hp < p.maxHp) {
            if (p.regenTimer > 0) p.regenTimer--;
            else p.hp = Math.min(p.maxHp, p.hp + 0.1);
        }

        // Sprint
        let speed = stats.speed;
        if (p.input.shift && p.stamina > 0) {
            speed *= 1.4;
            p.stamina = Math.max(0, p.stamina - 1.5);
            p.isSprinting = true;
        } else {
            p.stamina = Math.min(100, p.stamina + 0.8);
            p.isSprinting = false;
        }

        // Movement with Independent Axis (Wall Sliding)
        // We calculate X and Y separately. If X is blocked, we still allow Y movement.
        const moves = [
            { axis: 'y', val: -speed, input: p.input.w },
            { axis: 'y', val: speed,  input: p.input.s },
            { axis: 'x', val: -speed, input: p.input.a },
            { axis: 'x', val: speed,  input: p.input.d }
        ];

        for (const m of moves) {
            if (m.input) {
                const originalPos = p[m.axis];
                p[m.axis] += m.val;

                // Check collision at new spot
                let collided = false;
                for (const obs of obstacles) {
                    if (checkRectCollision({x: p.x, y: p.y, r: stats.size}, obs)) {
                        collided = true;
                        break;
                    }
                }

                // If collided, revert ONLY this axis
                if (collided) {
                    p[m.axis] = originalPos;
                }
            }
        }

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

        if (b.traveled > b.range || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            bullets.splice(i, 1);
            continue;
        }

        // Obstacle Collision
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
                    p.regenTimer = 300; // Reset regen timer on hit (5s)
                    bullets.splice(i, 1);
                    
                    io.emit('hit', { x: b.x, y: b.y });

                    if (p.hp <= 0) {
                        const killer = players[b.ownerId];
                        if (killer) killer.score++;
                        
                        // Respawn safely
                        const spawn = getSafeSpawn(KITS[p.kit].size);
                        p.hp = p.maxHp;
                        p.x = spawn.x;
                        p.y = spawn.y;
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