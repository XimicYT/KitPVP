const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// --- CONFIG (CLASSIC TIGHT MAP) ---
const FPS = 60;
const MAP_SIZE = 1600; // Much smaller for instant action
const OBSTACLE_COUNT = 30; // Dense obstacles
const ORB_COUNT = 50; // Lots of XP everywhere

const KITS = {
  assault: {
    name: "Assault",
    hp: 100,
    maxHp: 100,
    speed: 5,
    size: 22,
    reload: 10,
    dmg: 8,
    bulletSpeed: 14,
    range: 450,
    color: "#3498db",
    spread: 0.1,
  },
  sniper: {
    name: "Sniper",
    hp: 60,
    maxHp: 60,
    speed: 6,
    size: 20,
    reload: 50,
    dmg: 40,
    bulletSpeed: 28,
    range: 1000,
    color: "#e74c3c",
    spread: 0.01,
  },
  tank: {
    name: "Tank",
    hp: 200,
    maxHp: 200,
    speed: 3.5,
    size: 30,
    reload: 25,
    dmg: 18,
    bulletSpeed: 10,
    range: 350,
    color: "#27ae60",
    spread: 0.05,
  },
  shotgun: {
    name: "Shotgun",
    hp: 120,
    maxHp: 120,
    speed: 5,
    size: 24,
    reload: 40,
    dmg: 8,
    bulletSpeed: 12,
    range: 300,
    color: "#9b59b6",
    spread: 0.2,
    count: 5,
  },
};

let players = {};
let bullets = [];
let obstacles = [];
let orbs = [];
let bulletIdCounter = 0;

// --- UTILS ---
function checkRectCollision(circle, rect) {
  const testX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.w));
  const testY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.h));
  const distX = circle.x - testX;
  const distY = circle.y - testY;
  return distX * distX + distY * distY < circle.r * circle.r;
}

function checkRectOverlap(r1, r2, padding = 0) {
  return !(
    r2.x - padding > r1.x + r1.w ||
    r2.x + r2.w + padding < r1.x ||
    r2.y - padding > r1.y + r1.h ||
    r2.y + r2.h + padding < r1.y
  );
}

// --- GENERATION ---
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
    for (const obs of obstacles) {
      if (checkRectOverlap(newObs, obs, 40)) valid = false;
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
    for (const obs of obstacles) {
      if (checkRectCollision({ x, y, r: r + 5 }, obs)) valid = false;
    }
    if (valid) return { x, y, r }; // Removed view distance check for classic chaos
    attempts++;
  }
  return { x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE, r: 10 };
}

function scheduleOrbSpawn() {
  if (orbs.length < ORB_COUNT) {
    setTimeout(
      () => {
        const orb = getSafeOrbLocation();
        orb.id = Math.random().toString(36).substr(2, 9);
        orbs.push(orb);
      },
      Math.random() * 2000 + 500,
    );
  }
}
for (let i = 0; i < ORB_COUNT; i++)
  orbs.push({ ...getSafeOrbLocation(), id: i });

function getSafeSpawn(radius) {
  let attempts = 0;
  while (attempts < 50) {
    const x = Math.random() * MAP_SIZE;
    const y = Math.random() * MAP_SIZE;
    let safe = true;
    for (const obs of obstacles) {
      if (checkRectCollision({ x, y, r: radius + 20 }, obs)) safe = false;
    }
    if (safe) return { x, y };
    attempts++;
  }
  return { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
}

// --- SOCKETS ---
io.on("connection", (socket) => {
  socket.emit("mapData", { obstacles });

  socket.on("check_name", (name) => {
    let taken = false;
    for (let id in players) {
      if (players[id].name.toLowerCase() === name.toLowerCase()) taken = true;
    }
    socket.emit("name_checked", { taken: taken, name: name });
  });

  socket.on("join_game", (data) => {
    const kit = KITS[data.kit] || KITS.assault;
    const spawn = getSafeSpawn(kit.size);
    players[socket.id] = {
      id: socket.id,
      name: data.name,
      x: spawn.x,
      y: spawn.y,
      kit: data.kit,
      hp: kit.hp,
      maxHp: kit.maxHp,
      score: 0,
      angle: 0,
      cooldown: 0,
      stamina: 100,
      regenTimer: 0,
      invincible: 180,
      input: { w: false, a: false, s: false, d: false, shift: false },
    };
  });

  socket.on("shoot", () => {
    const p = players[socket.id];
    if (p && p.cooldown <= 0) {
      const stats = KITS[p.kit];
      const count = stats.count || 1;
      for (let i = 0; i < count; i++) {
        const spreadAngle = (Math.random() - 0.5) * stats.spread;
        const finalAngle = p.angle + spreadAngle;
        bullets.push({
          id: bulletIdCounter++,
          ownerId: p.id,
          x: p.x,
          y: p.y,
          vx: Math.cos(finalAngle) * stats.bulletSpeed,
          vy: Math.sin(finalAngle) * stats.bulletSpeed,
          range: stats.range,
          traveled: 0,
          dmg: stats.dmg,
        });
      }
      p.cooldown = stats.reload;
      p.regenTimer = 180;
    }
  });

  socket.on("movement", (input) => {
    if (players[socket.id]) {
      players[socket.id].input = input;
      players[socket.id].angle = input.angle;
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
  });
});

setInterval(() => {
  // Leaderboard
  const leaderboard = Object.values(players)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((p) => ({ name: p.name, score: p.score }));

  // Players
  for (const id in players) {
    const p = players[id];
    const stats = KITS[p.kit];

    if (p.invincible > 0) p.invincible--;
    if (p.hp < p.maxHp && p.regenTimer <= 0)
      p.hp = Math.min(p.maxHp, p.hp + 0.15);
    if (p.regenTimer > 0) p.regenTimer--;

    let speed = stats.speed;
    if (p.input.shift && p.stamina > 0) {
      speed *= 1.4;
      p.stamina = Math.max(0, p.stamina - 1.2);
      p.isSprinting = true;
    } else {
      p.stamina = Math.min(100, p.stamina + 0.6);
      p.isSprinting = false;
    }

    const moves = [
      { axis: "y", val: -speed, input: p.input.w },
      { axis: "y", val: speed, input: p.input.s },
      { axis: "x", val: -speed, input: p.input.a },
      { axis: "x", val: speed, input: p.input.d },
    ];

    for (const m of moves) {
      if (m.input) {
        const original = p[m.axis];
        p[m.axis] += m.val;
        let collided = false;
        for (const obs of obstacles) {
          if (checkRectCollision({ x: p.x, y: p.y, r: stats.size }, obs)) {
            collided = true;
            break;
          }
        }
        if (collided) p[m.axis] = original;
      }
    }

    p.x = Math.max(0, Math.min(MAP_SIZE, p.x));
    p.y = Math.max(0, Math.min(MAP_SIZE, p.y));
    if (p.cooldown > 0) p.cooldown--;

    // Orbs
    for (let i = orbs.length - 1; i >= 0; i--) {
      const orb = orbs[i];
      const dx = p.x - orb.x;
      const dy = p.y - orb.y;
      if (Math.sqrt(dx * dx + dy * dy) < stats.size + orb.r) {
        p.score += 5;
        p.hp = Math.min(p.maxHp, p.hp + 10);
        orbs.splice(i, 1);
        scheduleOrbSpawn();
      }
    }
  }

  // Bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.traveled += Math.sqrt(b.vx * b.vx + b.vy * b.vy);

    if (
      b.traveled > b.range ||
      b.x < 0 ||
      b.x > MAP_SIZE ||
      b.y < 0 ||
      b.y > MAP_SIZE
    ) {
      bullets.splice(i, 1);
      continue;
    }

    let hitWall = false;
    for (const obs of obstacles) {
      if (
        b.x > obs.x &&
        b.x < obs.x + obs.w &&
        b.y > obs.y &&
        b.y < obs.y + obs.h
      ) {
        bullets.splice(i, 1);
        hitWall = true;
        break;
      }
    }
    if (hitWall) continue;

    for (const id in players) {
      const p = players[id];
      if (b.ownerId !== p.id && p.invincible <= 0) {
        const dx = p.x - b.x;
        const dy = p.y - b.y;
        if (Math.sqrt(dx * dx + dy * dy) < KITS[p.kit].size) {
          p.hp -= b.dmg;
          p.regenTimer = 300;
          bullets.splice(i, 1);
          io.emit("hit", { x: b.x, y: b.y });

          if (p.hp <= 0) {
            const killer = players[b.ownerId];
            const killerName = killer ? killer.name : "Unknown";
            io.emit("kill_feed", { killer: killerName, victim: p.name });
            io.to(p.id).emit("you_died", { killer: killerName });
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

  io.emit("state", { players, bullets, orbs, leaderboard });
}, 1000 / FPS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
