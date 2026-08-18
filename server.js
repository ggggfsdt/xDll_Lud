const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let game = {
    players: [],
    pot: 0,
    state: 'idle',
    countdown: 3,
    countdownStart: 0,
    prestartTimer: 0,
    opening: null,
    openingTimer: 0,
    gameTime: 0,
    winnerId: null,
    arenaSize: 440,
    cornerRadius: 66,
    perimeterPoints: [],
};

function generatePerimeter(size, cornerRadius, numPoints = 200) {
    const half = size / 2;
    const r = Math.min(cornerRadius, half);
    const points = [];
    const sections = [
        { type: 'line', x1: -half + r, y1: -half, x2: half - r, y2: -half },
        { type: 'arc', cx: half - r, cy: -half + r, start: -Math.PI / 2, end: 0 },
        { type: 'line', x1: half, y1: -half + r, x2: half, y2: half - r },
        { type: 'arc', cx: half - r, cy: half - r, start: 0, end: Math.PI / 2 },
        { type: 'line', x1: half - r, y1: half, x2: -half + r, y2: half },
        { type: 'arc', cx: -half + r, cy: half - r, start: Math.PI / 2, end: Math.PI },
        { type: 'line', x1: -half, y1: half - r, x2: -half, y2: -half + r },
        { type: 'arc', cx: -half + r, cy: -half + r, start: Math.PI, end: 3 * Math.PI / 2 }
    ];
    let totalLen = 0;
    const segLengths = sections.map(seg => {
        if (seg.type === 'line') {
            const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
            return Math.sqrt(dx * dx + dy * dy);
        } else {
            return r * (seg.end - seg.start);
        }
    });
    totalLen = segLengths.reduce((a, b) => a + b, 0);
    const step = totalLen / numPoints;
    let accumulated = 0, segIdx = 0;
    for (let i = 0; i < numPoints; i++) {
        const target = i * step;
        while (accumulated + segLengths[segIdx] < target) {
            accumulated += segLengths[segIdx];
            segIdx = (segIdx + 1) % sections.length;
        }
        const localT = (target - accumulated) / segLengths[segIdx];
        const seg = sections[segIdx];
        let px, py;
        if (seg.type === 'line') {
            px = seg.x1 + localT * (seg.x2 - seg.x1);
            py = seg.y1 + localT * (seg.y2 - seg.y1);
        } else {
            const angle = seg.start + localT * (seg.end - seg.start);
            px = seg.cx + r * Math.cos(angle);
            py = seg.cy + r * Math.sin(angle);
        }
        points.push({ x: px + half, y: py + half });
    }
    return points;
}
game.perimeterPoints = generatePerimeter(game.arenaSize, game.cornerRadius, 200);

function getAlive() { return game.players.filter(p => p.alive); }

function speedForRadius(radius) {
    const minR = 14, maxR = 52;
    const norm = Math.min(1, Math.max(0, (radius - minR) / (maxR - minR)));
    return 6.0 - norm * 3.0;
}

function updatePhysics(dt) {
    if (game.state !== 'playing') return;
    const alive = getAlive();
    if (alive.length <= 1) {
        if (alive.length === 1) endGame(alive[0].id);
        else resetGame();
        return;
    }

    const pts = game.perimeterPoints;
    const totalPts = pts.length;
    const half = game.arenaSize / 2;

    game.openingTimer -= dt;
    if (game.openingTimer <= 0) {
        if (!game.opening) {
            const gapSize = Math.floor((0.08 + Math.random() * 0.1) * totalPts);
            const startIdx = Math.floor(Math.random() * totalPts);
            const endIdx = (startIdx + gapSize) % totalPts;
            game.opening = { startIdx, endIdx, flashCount: 0, flashTimer: 0, state: 'flashing', _total: totalPts };
            game.openingTimer = 3.5 + Math.random() * 2.5;
        } else {
            game.opening = null;
            game.openingTimer = 1.5 + Math.random() * 2.0;
        }
    }

    const opening = game.opening;
    if (opening && opening.state === 'flashing') {
        opening.flashTimer += dt;
        if (opening.flashTimer > 0.25) {
            opening.flashTimer = 0;
            opening.flashCount++;
            if (opening.flashCount >= 4) opening.state = 'open';
        }
    }

    function isInGap(idx) {
        if (!opening || opening.state !== 'open') return false;
        const start = opening.startIdx, end = opening.endIdx;
        if (start < end) return idx >= start && idx <= end;
        return idx >= start || idx <= end;
    }

    const subSteps = 4; // reduced from 6 for performance
    const subDt = dt / subSteps;

    for (let step = 0; step < subSteps; step++) {
        alive.forEach(p => {
            p.x += p.vx * subDt * 60;
            p.y += p.vy * subDt * 60;
            const radius = p.radius;
            for (let i = 0; i < totalPts; i++) {
                const j = (i + 1) % totalPts;
                if (opening && opening.state === 'open' && isInGap(i) && isInGap(j)) continue;
                const ax = pts[i].x, ay = pts[i].y;
                const bx = pts[j].x, by = pts[j].y;
                const dx = bx - ax, dy = by - ay;
                const lenSq = dx * dx + dy * dy;
                if (lenSq === 0) continue;
                let t = ((p.x - ax) * dx + (p.y - ay) * dy) / lenSq;
                t = Math.max(0, Math.min(1, t));
                const nearX = ax + t * dx, nearY = ay + t * dy;
                const distX = p.x - nearX, distY = p.y - nearY;
                const dist = Math.sqrt(distX * distX + distY * distY);
                if (dist < radius) {
                    const nx = distX / dist, ny = distY / dist;
                    const overlap = radius - dist;
                    p.x += nx * overlap;
                    p.y += ny * overlap;
                    const vn = p.vx * nx + p.vy * ny;
                    if (vn < 0) { p.vx -= 2 * vn * nx; p.vy -= 2 * vn * ny; }
                    break;
                }
            }
            if (opening && opening.state === 'open') {
                const cx = half, cy = half;
                const dx = p.x - cx, dy = p.y - cy;
                const distFromCenter = Math.sqrt(dx * dx + dy * dy);
                const escapeThreshold = half * 1.12 + radius;
                if (distFromCenter > escapeThreshold) {
                    let nearestGapIdx = -1, minDist = Infinity;
                    for (let i = 0; i < totalPts; i++) {
                        if (isInGap(i)) {
                            const d = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2;
                            if (d < minDist) { minDist = d; nearestGapIdx = i; }
                        }
                    }
                    if (nearestGapIdx >= 0) {
                        const angle = Math.atan2(dy, dx);
                        const gapAngle = Math.atan2(pts[nearestGapIdx].y - cy, pts[nearestGapIdx].x - cx);
                        let diff = Math.abs(angle - gapAngle);
                        diff = Math.min(diff, 2 * Math.PI - diff);
                        const vOut = p.vx * dx + p.vy * dy;
                        if (diff < 0.8 && vOut > 0) {
                            p.alive = false;
                            // broadcast immediately when someone dies
                            broadcastState();
                        }
                    }
                }
            }
        });

        // Circle collisions
        for (let i = 0; i < alive.length; i++) {
            for (let j = i + 1; j < alive.length; j++) {
                const a = alive[i], b = alive[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const rA = a.radius, rB = b.radius;
                const minDist = rA + rB;
                if (dist < minDist && dist > 0.001) {
                    const nx = dx / dist, ny = dy / dist;
                    const overlap = (minDist - dist) * 0.5;
                    a.x -= nx * overlap;
                    a.y -= ny * overlap;
                    b.x += nx * overlap;
                    b.y += ny * overlap;
                    const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
                    const dvn = dvx * nx + dvy * ny;
                    if (dvn > 0) {
                        const totalMass = a.mass + b.mass;
                        const impulse = 2 * dvn / (1 / a.mass + 1 / b.mass);
                        const aFactor = 1 - (a.mass / totalMass) * 0.6;
                        const bFactor = 1 - (b.mass / totalMass) * 0.6;
                        a.vx -= (impulse / a.mass) * aFactor * nx;
                        a.vy -= (impulse / a.mass) * aFactor * ny;
                        b.vx += (impulse / b.mass) * bFactor * nx;
                        b.vy += (impulse / b.mass) * bFactor * ny;
                    }
                }
            }
        }

        alive.forEach(p => {
            const maxSp = speedForRadius(p.radius);
            const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
            if (sp > maxSp) { p.vx = (p.vx / sp) * maxSp; p.vy = (p.vy / sp) * maxSp; }
            const minSp = 3.0;
            if (sp < minSp && sp > 0.01) { const ratio = minSp / sp; p.vx *= ratio; p.vy *= ratio; }
        });
    }
}

function startCountdown() {
    if (game.state !== 'idle') return;
    const alive = getAlive();
    if (alive.length < 2) return;
    game.state = 'countdown';
    game.countdown = 3.0;
    game.countdownStart = Date.now();
    broadcastState();
}

function startPrestart() {
    game.state = 'prestart';
    game.prestartTimer = 2.0;
    broadcastState();
}

function startGame() {
    game.state = 'playing';
    game.gameTime = 0;
    game.opening = null;
    game.winnerId = null;
    const alive = getAlive();
    const half = game.arenaSize / 2;
    alive.forEach((p, i) => {
        const angle = (i / alive.length) * Math.PI * 2 + Math.random() * 0.3;
        const baseSpeed = speedForRadius(p.radius);
        const speed = baseSpeed * (0.9 + Math.random() * 0.2);
        p.vx = Math.cos(angle) * speed;
        p.vy = Math.sin(angle) * speed;
        p.x = half + Math.cos(angle) * (game.arenaSize * 0.15 + Math.random() * 15);
        p.y = half + Math.sin(angle) * (game.arenaSize * 0.15 + Math.random() * 15);
        p.alive = true;
    });
    game.openingTimer = 3.5 + Math.random() * 2.5;
    broadcastState();
}

function endGame(winnerId) {
    if (game.state === 'finished') return;
    game.state = 'finished';
    game.winnerId = winnerId;
    const winner = game.players.find(p => p.id === winnerId);
    if (winner) {
        const totalPot = game.pot;
        const winnerBet = winner.bet;
        const losersBets = totalPot - winnerBet;
        const commission = Math.floor(losersBets * 0.02);
        const winnings = totalPot - commission;
        winner.balance += winnings;
        game.pot = 0;
    }
    broadcastState();
    setTimeout(resetGame, 3000);
}

function resetGame() {
    game.state = 'idle';
    game.players = [];
    game.pot = 0;
    game.opening = null;
    game.winnerId = null;
    broadcastState();
}

let broadcastCounter = 0;
function broadcastState() {
    // Throttle to 20 Hz (every 3rd frame if called at 60 Hz)
    broadcastCounter++;
    if (broadcastCounter % 3 !== 0 && game.state === 'playing') return;
    // But we always broadcast for state changes (countdown, finished, etc.)
    const payload = JSON.stringify({ type: 'state', game });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
}

wss.on('connection', (ws) => {
    ws.id = null;
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case 'join': {
                    const { name, pfp } = data;
                    const id = 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                    const player = {
                        id,
                        name: name || 'Player',
                        pfp: pfp || '',
                        bet: 0,
                        balance: 1000,
                        x: 0, y: 0,
                        vx: 0, vy: 0,
                        radius: 18,
                        mass: 18 * 18 * 1.2,
                        alive: true,
                    };
                    ws.id = id;
                    game.players.push(player);
                    ws.send(JSON.stringify({ type: 'joined', id }));
                    broadcastState();
                    break;
                }
                case 'bet': {
                    const { amount } = data;
                    const player = game.players.find(p => p.id === ws.id);
                    if (!player || game.state !== 'idle') return;
                    if (amount < 10 || amount > player.balance) return;
                    player.bet += amount;
                    player.balance -= amount;
                    game.pot += amount;
                    const totalBet = game.players.reduce((s, p) => s + p.bet, 0);
                    game.players.forEach(p => {
                        const ratio = p.bet / totalBet;
                        const r = 18 + ratio * 34;
                        p.radius = Math.min(Math.max(r, 14), 52);
                        p.mass = p.radius * p.radius * 1.2;
                    });
                    broadcastState();
                    if (getAlive().length >= 2 && game.state === 'idle') startCountdown();
                    break;
                }
                default: break;
            }
        } catch (e) { console.error(e); }
    });

    ws.on('close', () => {
        if (ws.id) {
            game.players = game.players.filter(p => p.id !== ws.id);
            broadcastState();
        }
    });
});

// Game loop at 60 Hz, but broadcast throttled
setInterval(() => {
    const dt = 1 / 60;
    if (game.state === 'countdown') {
        const elapsed = (Date.now() - game.countdownStart) / 1000;
        if (elapsed >= 3.0) startPrestart();
    } else if (game.state === 'prestart') {
        game.prestartTimer -= dt;
        if (game.prestartTimer <= 0) startGame();
    } else if (game.state === 'playing') {
        updatePhysics(dt);
        broadcastState(); // throttled internally
    }
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
