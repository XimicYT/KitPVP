const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// --- CONFIG ---
const FPS = 60;
const MAP_SIZE = 1600; 
const OBSTACLE_COUNT = 12; 
const ORB_COUNT = 30; // Increased orb count slightly so mimics blend in better

const KITS = {
    assault: { name: "Assault", hp: 100, maxHp: 100, speed: 5, size: 22, reload: 10, dmg: 8,  bulletSpeed: 14, range: 450, spread: 0.1 },
    sniper:  { name: "Sniper",  hp: 60,  maxHp: 60,  speed: 6, size: 20, reload: 50, dmg: 40, bulletSpeed: 28, range: 1000, spread: 0.01 },
    tank:    { name: "Tank",    hp: 200, maxHp: 200, speed: 3.5,size: 30, reload: 25, dmg: 18, bulletSpeed: 10, range: 350,  spread: 0.05 },
    shotgun: { name: "Shotgun", hp: 120, maxHp: 120, speed: 5, size: 24, reload: 40, dmg: 8,  bulletSpeed: 12, range: 300,  spread: 0.2, count: 5 },
    bouncy:  { name: "Bouncy Boi", hp: 150, maxHp: 150, speed: 0.8, size: 25, reload: 9999, dmg: 0, bulletSpeed: 0, range: 0, spread: 0 },
    gravity: { name: "Gravity Guy", hp: 250, maxHp: 250, speed: 3.0, size: 35, reload: 9999, dmg: 2, bulletSpeed: 0, range: 450, spread: 0 },
    // MIMIC CLASS
    mimic:   { name: "Mimic", hp: 100, maxHp: 100, speed: 5.5, size: 12, reload: 60, dmg: 70, bulletSpeed: 0, range: 0, spread: 0 } 
    // Size 12 matches Orb size roughly
};

let players = {};
let bullets = [];
let obstacles = [];
let orbs = [];
let bulletIdCounter = 0;

// --- PHYSICS UTILS ---
function checkRectCollision(circle, rect) {
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

function isColliding(p, r) {
    if (p.x < 0 || p.x > MAP_SIZE || p.y < 0 || p.y > MAP_SIZE) return true;
    for (const obs of obstacles) {
        if (checkRectCollision({x: p.x, y: p.y, r: r}, obs)) return true;
    }
    return false;
}

// --- GENERATION ---
function generateObstacles() {
    obstacles = [];
    let attempts = 0;
    while (obstacles.length < OBSTACLE_COUNT && attempts < 1000) {
        const w = 100 + Math.random() * 150;
        const h = 100 + Math.random() * 150;
        const x = Math.random() * (MAP_SIZE - w);
        const y = Math.random() * (MAP_SIZE - h);
        const newObs = { x, y, w, h };
        
        let valid = true;
        for (const obs of obstacles) {
            if (checkRectOverlap(newObs, obs, 100)) valid = false;
        }
        if (valid) obstacles.push(newObs);
        attempts++;
    }
}
generateObstacles();

function getSafeOrbLocation() {
    let attempts = 0;
    while (attempts < 50) {
        const x = Math.random() * MAP_SIZE;
        const y = Math.random() * MAP_SIZE;
        const r = 8 + Math.random() * 4;
        let valid = true;
        if (x < 50 || x > MAP_SIZE - 50 || y < 50 || y > MAP_SIZE - 50) valid = false;
        if (valid) {
            for (const obs of obstacles) {
                if (checkRectCollision({x, y, r: r + 30}, obs)) valid = false;
            }
        }
        if (valid) return { x, y, r };
        attempts++;
    }
    return { x: MAP_SIZE/2, y: MAP_SIZE/2, r: 10 };
}

function scheduleOrbSpawn() {
    if (orbs.length < ORB_COUNT) {
        setTimeout(() => {
            const orb = getSafeOrbLocation();
            orb.id = Math.random().toString(36).substr(2, 9);
            orbs.push(orb);
        }, Math.random() * 2000 + 500);
    }
}
for(let i=0; i<ORB_COUNT; i++) orbs.push({ ...getSafeOrbLocation(), id: i });

function getSafeSpawn(radius) {
    let attempts = 0;
    while (attempts < 50) {
        const x = Math.random() * MAP_SIZE;
        const y = Math.random() * MAP_SIZE;
        let valid = true;
        if (isColliding({x, y}, radius + 50)) valid = false;
        if (valid) {
            for (const id in players) {
                const p = players[id];
                if (p.kit === 'gravity') {
                    const dx = p.x - x;
                    const dy = p.y - y;
                    if (Math.sqrt(dx*dx + dy*dy) < KITS.gravity.range + 100) {
                        valid = false;
                        break;
                    }
                }
            }
        }
        if (valid) return { x, y };
        attempts++;
    }
    return { x: MAP_SIZE/2, y: MAP_SIZE/2 };
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.emit('mapData', { obstacles });
    socket.on('latency', (cb) => cb());

    socket.on('check_name', (name) => {
        let taken = false;
        for(let id in players) {
            if(players[id].name.toLowerCase() === name.toLowerCase()) taken = true;
        }
        socket.emit('name_checked', { taken: taken, name: name });
    });

    socket.on('join_game', (data) => {
        const kitKey = data.kit || 'assault';
        const kit = KITS[kitKey] || KITS.assault;
        const spawn = getSafeSpawn(kit.size);
        
        players[socket.id] = {
            id: socket.id,
            name: data.name,
            x: spawn.x, y: spawn.y,
            vx: 0, vy: 0,
            kit: kitKey,
            hp: kit.hp, maxHp: kit.maxHp,
            score: 0,
            angle: 0,
            cooldown: 0,
            stamina: 100,
            regenTimer: 0,
            invincibleUntil: Date.now() + 2500, 
            input: { w: false, a: false, s: false, d: false, shift: false }
        };
    });

    socket.on('shoot', () => {
        const p = players[socket.id];
        // MIMICS CANNOT SHOOT (They are living mines)
        if (p && p.kit !== 'bouncy' && p.kit !== 'mimic' && p.cooldown <= 0) {
            const stats = KITS[p.kit];
            const count = stats.count || 1;
            for(let i=0; i<count; i++) {
                const spreadAngle = (Math.random() - 0.5) * stats.spread;
                const finalAngle = p.angle + spreadAngle;
                bullets.push({
                    id: bulletIdCounter++,
                    ownerId: p.id,
                    x: p.x, y: p.y,
                    vx: Math.cos(finalAngle) * stats.bulletSpeed,
                    vy: Math.sin(finalAngle) * stats.bulletSpeed,
                    range: stats.range,
                    traveled: 0,
                    dmg: stats.dmg
                });
            }
            p.cooldown = stats.reload;
            p.regenTimer = 180; 
            p.invincibleUntil = 0; 
        }
    });

    socket.on('movement', (input) => {
        if (players[socket.id]) {
            players[socket.id].input = input;
            players[socket.id].angle = input.angle;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

setInterval(() => {
    const leaderboard = Object.values(players)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(p => ({ name: p.name, score: p.score }));

    const now = Date.now();

    // 1. GRAVITY LOGIC
    for (const id in players) {
        const p = players[id];
        if (p.kit === 'gravity') {
            const range = KITS.gravity.range;
            for (const targetId in players) {
                if (id === targetId) continue;
                const target = players[targetId];
                if (target.isInvincible) continue;

                const dx = p.x - target.x;
                const dy = p.y - target.y;
                const dist = Math.sqrt(dx*dx + dy*dy);

                if (dist < range) {
                    const pullFactor = 1 - (dist / range);
                    let force = 0.5 + (pullFactor * 7.5);
                    if (target.kit === 'gravity') force *= 2.0;

                    const angle = Math.atan2(dy, dx);
                    if (target.kit === 'bouncy') {
                        target.vx += Math.cos(angle) * (force * 0.2);
                        target.vy += Math.sin(angle) * (force * 0.2);
                    } else {
                        target.x += Math.cos(angle) * force;
                        target.y += Math.sin(angle) * force;
                    }

                    const hitDist = KITS.gravity.size + KITS[target.kit].size;
                    if (dist < hitDist) {
                        let damage = KITS.gravity.dmg;
                        if (target.kit === 'gravity') {
                            damage = 5; p.hp -= 2; p.regenTimer = 300;
                        }
                        target.hp -= damage;
                        target.regenTimer = 300;
                        if (target.hp <= 0) {
                            io.emit('kill_feed', { killer: p.name, victim: target.name });
                            io.to(target.id).emit('you_died', { killer: p.name });
                            p.score += (target.kit === 'gravity' ? 200 : 100);
                            p.hp = Math.min(p.maxHp, p.hp + 50);
                            delete players[targetId];
                        }
                    }
                }
            }
            for (const b of bullets) {
                if (b.ownerId === p.id) continue;
                const dx = p.x - b.x;
                const dy = p.y - b.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < range) {
                    const pullFactor = 1 - (dist / range);
                    const angle = Math.atan2(dy, dx);
                    const strength = 0.5 + (pullFactor * 1.5); 
                    b.vx += Math.cos(angle) * strength;
                    b.vy += Math.sin(angle) * strength;
                }
            }
        }
    }

    // 2. MOVEMENT & COLLISION
    for (const id in players) {
        const p = players[id];
        if(!p) continue; 
        const stats = KITS[p.kit];
        
        p.isInvincible = now < p.invincibleUntil;

        if (p.hp < p.maxHp && p.regenTimer <= 0) p.hp = Math.min(p.maxHp, p.hp + 0.15);
        if (p.regenTimer > 0) p.regenTimer--;
        
        if (p.hp <= 0 && p.kit === 'gravity') {
             io.emit('kill_feed', { killer: "The Singularity", victim: p.name });
             io.to(p.id).emit('you_died', { killer: "The Singularity" });
             delete players[id];
             continue;
        }

        // --- MIMIC EXPLOSION LOGIC ---
        if (p.kit === 'mimic' && p.cooldown <= 0) {
            for (const targetId in players) {
                if (id === targetId) continue;
                const target = players[targetId];
                if (target.isInvincible) continue;

                const dx = target.x - p.x;
                const dy = target.y - p.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                
                // Trigger distance: slightly larger than touching
                if (dist < (stats.size + KITS[target.kit].size + 5)) {
                    // EXPLODE
                    p.cooldown = stats.reload; // ~1 sec cooldown
                    
                    // Damage Target
                    target.hp -= stats.dmg;
                    target.regenTimer = 300;
                    
                    // Knockback Target
                    const angle = Math.atan2(dy, dx);
                    // Add impulse velocity
                    if (!target.vx) target.vx = 0; 
                    if (!target.vy) target.vy = 0;
                    target.vx += Math.cos(angle) * 15; 
                    target.vy += Math.sin(angle) * 15;

                    // Self Damage (Mimic takes some damage)
                    p.hp -= 15;
                    p.regenTimer = 300;

                    // Visual Hit
                    io.emit('hit', { x: p.x, y: p.y }); 

                    // Kill Check
                    if (target.hp <= 0) {
                        io.emit('kill_feed', { killer: p.name, victim: target.name });
                        io.to(target.id).emit('you_died', { killer: p.name });
                        p.score += 200; // Big points for trap kill
                        p.hp = Math.min(p.maxHp, p.hp + 50);
                        delete players[targetId];
                    }

                    // Self Death Check
                    if (p.hp <= 0) {
                        io.emit('kill_feed', { killer: "Self Destruction", victim: p.name });
                        io.to(p.id).emit('you_died', { killer: "Self Destruction" });
                        delete players[id];
                        continue; 
                    }
                }
            }
        }

        // Movement Logic
        if (p.kit === 'bouncy') {
            const accel = stats.speed;
            if (p.input.w) p.vy -= accel;
            if (p.input.s) p.vy += accel;
            if (p.input.a) p.vx -= accel;
            if (p.input.d) p.vx += accel;

            const maxSpeed = 22;
            const currentSpeed = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
            if (currentSpeed > maxSpeed) {
                const ratio = maxSpeed / currentSpeed;
                p.vx *= ratio;
                p.vy *= ratio;
            }
            p.vx *= 0.985; p.vy *= 0.985;

            p.x += p.vx;
            if (isColliding(p, stats.size)) { p.x -= p.vx; p.vx = -p.vx * 0.9; }
            p.y += p.vy;
            if (isColliding(p, stats.size)) { p.y -= p.vy; p.vy = -p.vy * 0.9; }

            // Bouncy Ramming
            const speedMag = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
            if (speedMag > 10) {
                for (const targetId in players) {
                    if (id === targetId) continue;
                    const target = players[targetId];
                    if (target.isInvincible) continue;
                    const dx = target.x - p.x;
                    const dy = target.y - p.y;
                    if (Math.sqrt(dx*dx + dy*dy) < stats.size + KITS[target.kit].size) {
                        const dmg = Math.floor(speedMag * 2.5);
                        target.hp -= dmg;
                        target.regenTimer = 300;
                        io.emit('hit', { x: target.x, y: target.y });
                        p.vx = -p.vx * 0.5; p.vy = -p.vy * 0.5; 
                        
                        if (target.hp <= 0) {
                            io.emit('kill_feed', { killer: p.name, victim: target.name });
                            io.to(target.id).emit('you_died', { killer: p.name });
                            p.score += 150;
                            p.hp = Math.min(p.maxHp, p.hp + 50);
                            delete players[targetId];
                        }
                    }
                }
            }

        } else {
            let speed = stats.speed;
            if (p.input.shift && p.stamina > 0) {
                speed *= 1.4;
                p.stamina = Math.max(0, p.stamina - 1.2);
            } else {
                p.stamina = Math.min(100, p.stamina + 0.6);
            }
            
            // Apply Knockback Decay (for Mimic explosion recoil)
            if (p.vx) { p.x += p.vx; p.vx *= 0.9; if(Math.abs(p.vx)<0.1) p.vx=0; }
            if (p.vy) { p.y += p.vy; p.vy *= 0.9; if(Math.abs(p.vy)<0.1) p.vy=0; }

            let dx = 0, dy = 0;
            if (p.input.w) dy -= speed;
            if (p.input.s) dy += speed;
            if (p.input.a) dx -= speed;
            if (p.input.d) dx += speed;

            if (dx !== 0 && dy !== 0) { const factor = 1 / Math.sqrt(2); dx *= factor; dy *= factor; }

            if (dx !== 0) { p.x += dx; if (isColliding(p, stats.size)) p.x -= dx; }
            if (dy !== 0) { p.y += dy; if (isColliding(p, stats.size)) p.y -= dy; }
        }
        
        if (p.cooldown > 0) p.cooldown--;

        // Orb Collision (Mimics can eat orbs too!)
        for (let i = orbs.length - 1; i >= 0; i--) {
            const orb = orbs[i];
            const dx = p.x - orb.x;
            const dy = p.y - orb.y;
            if (Math.sqrt(dx*dx + dy*dy) < stats.size + orb.r) {
                p.score += 5;
                p.hp = Math.min(p.maxHp, p.hp + 10);
                orbs.splice(i, 1);
                scheduleOrbSpawn();
            }
        }
    }

    // 3. BULLET LOOP
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.traveled += Math.sqrt(b.vx*b.vx + b.vy*b.vy);

        if (b.traveled > b.range || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            bullets.splice(i, 1); continue;
        }

        let hitWall = false;
        for (const obs of obstacles) {
            if (b.x > obs.x && b.x < obs.x + obs.w && b.y > obs.y && b.y < obs.y + obs.h) {
                bullets.splice(i, 1); hitWall = true; break;
            }
        }
        if (hitWall) continue;

        for (const id in players) {
            const p = players[id];
            if (b.ownerId !== p.id && !p.isInvincible) {
                const dx = p.x - b.x;
                const dy = p.y - b.y;
                if (Math.sqrt(dx*dx + dy*dy) < KITS[p.kit].size) {
                    p.hp -= b.dmg;
                    p.regenTimer = 300;
                    bullets.splice(i, 1);
                    io.emit('hit', { x: b.x, y: b.y });

                    if (p.hp <= 0) {
                        const killer = players[b.ownerId];
                        const killerName = killer ? killer.name : "Unknown";
                        io.emit('kill_feed', { killer: killerName, victim: p.name });
                        io.to(p.id).emit('you_died', { killer: killerName });
                        if (killer) {
                            killer.score += 100;
                            killer.hp = Math.min(killer.maxHp, killer.hp + 30);
                        }
                        delete players[id];
                    }
                    break;
                }
            }
        }
    }

    io.emit('state', { players, bullets, orbs, leaderboard });
}, 1000 / FPS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
