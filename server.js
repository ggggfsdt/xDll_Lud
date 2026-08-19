// ... (everything above is the same as before, but we add imports for addWinToHistory)

const {
  getUser,
  saveUser,
  addWinToHistory,
  getAllUsers,
  topPlayers,
  allUsersCount,
  createPromoCode,
  redeemPromoCode,
  getPromoCodes,
  deletePromoCode,
} = require('./store');

// ... inside endGame, after awarding the winner, add to history:

if (winner) {
  // ... (existing payout code)
  // Add win to winner's history
  await addWinToHistory(winner.id, winner.name, winner.pfp, winnings);
  // Also add to other players? We'll only add to the winner, or add a generic "lost" entry? Not needed.
  // But we can also add to all players as a "round ended" event? We'll just keep winner history.
}

// ... when sending the user object in the join ack, include winHistory:

ack?.({
  ok: true,
  user: {
    ...user,
    winHistory: user.winHistory || [],
  },
  arena: { size: ARENA_SIZE, cornerRadius: CORNER_RADIUS, perimeter: PERIMETER },
});

// The rest of the server is identical to the previous version, including the admin panel and promo endpoints.
