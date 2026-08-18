// Inside startCountdown:
game.countdownEndTime = Date.now() + 3000;

// In broadcastState: add countdownRemaining
let countdownRemaining = 0;
if (game.state === 'countdown') {
    countdownRemaining = Math.max(0, (game.countdownEndTime - Date.now()) / 1000);
}
const payload = JSON.stringify({
    type: 'state',
    game: {
        ...game,
        perimeterPoints: game.perimeterPoints,
        countdownRemaining,
    }
});

// resetGame – keep players
function resetGame() {
    game.state = 'idle';
    game.players.forEach(p => {
        p.bet = 0;
        p.alive = true;
        p.x = 0; p.y = 0;
        p.vx = 0; p.vy = 0;
        p.radius = 18;
        p.mass = 18 * 18 * 1.2;
    });
    game.pot = 0;
    game.opening = null;
    game.winnerId = null;
    broadcastState();
}
