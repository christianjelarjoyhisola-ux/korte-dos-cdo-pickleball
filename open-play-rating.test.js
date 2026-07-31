const test = require("node:test");
const assert = require("node:assert/strict");
const rating = require("./open-play-rating.js");

const players = [
  { id: "a", full_name: "A", skill_level: 3 },
  { id: "b", full_name: "B", skill_level: 3 },
  { id: "c", full_name: "C", skill_level: 5 },
  { id: "d", full_name: "D", skill_level: 5 },
];

test("seeds ratings from the manager's six skill levels", () => {
  assert.equal(rating.seedRating(1), 1000);
  assert.equal(rating.seedRating(3), 1200);
  assert.equal(rating.seedRating(6), 1500);
  assert.equal(rating.seedRating("invalid"), 1000);
});

test("an upset earns more performance points than an expected win", () => {
  const upset = rating.calculateStandings(players, [{
    resultAt: "2026-07-28T10:00:00.000Z",
    teamA: ["a", "b"],
    teamB: ["c", "d"],
    winner: "A",
  }]);
  const expected = rating.calculateStandings(players, [{
    resultAt: "2026-07-28T10:00:00.000Z",
    teamA: ["a", "b"],
    teamB: ["c", "d"],
    winner: "B",
  }]);

  assert.ok(upset.find(row => row.id === "a").points > 12);
  assert.ok(expected.find(row => row.id === "c").points < 12);
  assert.equal(
    upset.find(row => row.id === "a").points,
    -upset.find(row => row.id === "c").points
  );
});

test("a current court result sorts after its archived games when timestamps tie", () => {
  const ordered = rating.chronologicalMatches([
    {
      resultAt: "",
      roundNo: 1,
      courtIndex: 0,
      completedGameIndex: null,
      sequence: 1,
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "B",
    },
    {
      resultAt: "",
      roundNo: 1,
      courtIndex: 0,
      completedGameIndex: 0,
      sequence: 0,
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
  ]);

  assert.equal(ordered[0].winner, "A");
  assert.equal(ordered[1].winner, "B");
});

test("rating follows each player while teammates rotate", () => {
  const rotatingPlayers = [
    ...players,
    { id: "e", full_name: "E", skill_level: 3 },
    { id: "f", full_name: "F", skill_level: 3 },
  ];
  const rows = rating.calculateStandings(rotatingPlayers, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "e"],
      teamB: ["b", "f"],
      winner: "A",
    },
  ], { minGames: 1 });

  assert.equal(rows.find(row => row.id === "a").games, 2);
  assert.equal(rows.find(row => row.id === "a").wins, 2);
  assert.ok(rows.find(row => row.id === "a").points > rows.find(row => row.id === "b").points);
});

test("minimum games controls podium eligibility without using wins as rank", () => {
  const rows = rating.calculateStandings(players, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "c"],
      teamB: ["b", "d"],
      winner: "B",
    },
    {
      resultAt: "2026-07-28T10:20:00.000Z",
      teamA: ["a", "d"],
      teamB: ["b", "c"],
      winner: "A",
    },
  ]);

  assert.ok(rows.every(row => row.eligible));
  assert.equal(rating.podiumRows(rows).length, 3);
  assert.deepEqual(rows.map(row => row.rank), [1, 1, 3, 4]);
});

test("Korte DOS qualifies players after two completed games by default", () => {
  const rows = rating.calculateStandings(players, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "c"],
      teamB: ["b", "d"],
      winner: "B",
    },
  ]);

  assert.equal(rating.MIN_PODIUM_GAMES, 2);
  assert.ok(rows.every(row => row.eligible));
  assert.ok(rows.every(row => Number.isInteger(row.rank)));
});

test("replaying corrected immutable match history changes ratings deterministically", () => {
  const original = [{
    resultAt: "2026-07-28T10:00:00.000Z",
    teamA: ["a", "b"],
    teamB: ["c", "d"],
    winner: "A",
  }];
  const corrected = [{ ...original[0], winner: "B" }];
  const originalRows = rating.calculateStandings(players, original, { minGames: 1 });
  const correctedRows = rating.calculateStandings(players, corrected, { minGames: 1 });

  assert.ok(originalRows.find(row => row.id === "a").points > 0);
  assert.ok(correctedRows.find(row => row.id === "a").points < 0);
  assert.deepEqual(
    rating.calculateStandings(players, corrected, { minGames: 1 }),
    correctedRows
  );
});

test("a corrected early result replays every later expectation", () => {
  const replayPlayers = [
    { id: "a", full_name: "A", performance_seed_rating: 1000 },
    { id: "b", full_name: "B", performance_seed_rating: 1000 },
    { id: "c", full_name: "C", performance_seed_rating: 1300 },
    { id: "d", full_name: "D", performance_seed_rating: 1300 },
    { id: "e", full_name: "E", performance_seed_rating: 1100 },
    { id: "f", full_name: "F", performance_seed_rating: 1100 },
  ];
  const matches = [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "e"],
      teamB: ["c", "f"],
      winner: "A",
    },
  ];
  const before = rating.calculateStandings(replayPlayers, matches, { minGames: 1 });
  const after = rating.calculateStandings(
    replayPlayers,
    [{ ...matches[0], winner: "B" }, matches[1]],
    { minGames: 1 }
  );

  assert.equal(before.find(row => row.id === "a").points, 36);
  assert.equal(before.find(row => row.id === "e").points, 16);
  assert.equal(after.find(row => row.id === "a").points, 13);
  assert.equal(after.find(row => row.id === "e").points, 17);
});

test("invalid teams and unknown player IDs never create phantom standings", () => {
  const rows = rating.calculateStandings(players, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "a"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "missing"],
      teamB: ["c", "d"],
      winner: "B",
    },
  ], { minGames: 1 });

  assert.equal(rows.length, players.length);
  assert.ok(rows.every(row => row.games === 0 && row.points === 0));
});

test("exact performance ties share an official rank", () => {
  const tied = rating.calculateStandings(players, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
  ], { minGames: 1 });

  assert.equal(tied.find(row => row.id === "a").rank, tied.find(row => row.id === "b").rank);
  assert.equal(tied.find(row => row.id === "c").rank, tied.find(row => row.id === "d").rank);
});

test("performance remains the default and ranking modes normalize safely", () => {
  assert.equal(rating.normalizeRankingMode(), rating.RANKING_MODE_PERFORMANCE);
  assert.equal(
    rating.normalizeRankingMode("win_percentage"),
    rating.RANKING_MODE_WIN_PERCENTAGE
  );
  assert.equal(
    rating.normalizeRankingMode("competitive"),
    rating.RANKING_MODE_COMPETITIVE
  );
  assert.equal(rating.normalizeRankingMode("unknown"), rating.RANKING_MODE_PERFORMANCE);

  const rows = rating.calculateStandings(players, [{
    teamA: ["a", "b"],
    teamB: ["c", "d"],
    winner: "A",
  }], { minGames: 1 });
  assert.ok(rows.every(row => row.mode === rating.RANKING_MODE_PERFORMANCE));
  assert.ok(rows.find(row => row.id === "a").points > 0);
});

test("win percentage follows each individual while teammates rotate", () => {
  const rotatingPlayers = [
    ...players,
    { id: "e", full_name: "E", skill_level: 3 },
    { id: "f", full_name: "F", skill_level: 3 },
  ];
  const rows = rating.calculateStandings(rotatingPlayers, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "e"],
      teamB: ["b", "f"],
      winner: "B",
    },
  ], { minGames: 2, mode: "win_percentage" });

  const playerA = rows.find(row => row.id === "a");
  const playerB = rows.find(row => row.id === "b");
  assert.equal(playerA.games, 2);
  assert.equal(playerA.wins, 1);
  assert.equal(playerA.losses, 1);
  assert.equal(playerA.winPercentage, 50);
  assert.equal(playerA.points, 0);
  assert.equal(playerA.eligible, true);
  assert.equal(playerB.winPercentage, 100);
  assert.equal(playerB.rank, 1);
});

test("win percentage outranks raw win count and still requires minimum games", () => {
  const winPlayers = [
    { id: "a", full_name: "A", skill_level: 3 },
    { id: "b", full_name: "B", skill_level: 3 },
    { id: "c", full_name: "C", skill_level: 3 },
    { id: "d", full_name: "D", skill_level: 3 },
    { id: "e", full_name: "E", skill_level: 3 },
    { id: "f", full_name: "F", skill_level: 3 },
    { id: "g", full_name: "G", skill_level: 3 },
    { id: "h", full_name: "H", skill_level: 3 },
  ];
  const rows = rating.calculateStandings(winPlayers, [
    { teamA: ["a", "b"], teamB: ["c", "d"], winner: "A" },
    { teamA: ["e", "f"], teamB: ["g", "h"], winner: "A" },
    { teamA: ["e", "g"], teamB: ["f", "h"], winner: "A" },
    { teamA: ["e", "h"], teamB: ["f", "g"], winner: "B" },
  ], { minGames: 1, mode: "win_percentage" });

  const playerA = rows.find(row => row.id === "a");
  const playerE = rows.find(row => row.id === "e");
  assert.equal(playerA.wins, 1);
  assert.equal(playerE.wins, 2);
  assert.equal(playerA.winPercentage, 100);
  assert.equal(playerE.winPercentage, 66.7);
  assert.ok(playerA.rank < playerE.rank);

  const provisional = rating.calculateStandings(winPlayers, [
    { teamA: ["a", "b"], teamB: ["c", "d"], winner: "A" },
  ], { minGames: 3, mode: "win_percentage" });
  assert.ok(provisional.every(row => row.rank === null));
});

test("win-percentage ties favor more wins and equal zero-win rates share rank", () => {
  const tiePlayers = [
    { id: "a", full_name: "A", performance_seed_rating: 1200 },
    { id: "b", full_name: "B", performance_seed_rating: 1200 },
    { id: "c", full_name: "C", performance_seed_rating: 1200 },
    { id: "d", full_name: "D", performance_seed_rating: 1200 },
    { id: "e", full_name: "E", performance_seed_rating: 1200 },
    { id: "f", full_name: "F", performance_seed_rating: 1200 },
    { id: "g", full_name: "G", performance_seed_rating: 1200 },
    { id: "h", full_name: "H", performance_seed_rating: 1200 },
  ];
  const tiedSchedule = [
    { teamA: ["a", "b"], teamB: ["c", "d"], winner: "A" },
    { teamA: ["a", "b"], teamB: ["c", "d"], winner: "B" },
    { teamA: ["e", "f"], teamB: ["g", "h"], winner: "A" },
    { teamA: ["e", "f"], teamB: ["g", "h"], winner: "B" },
  ];
  const tiedRows = rating.calculateStandings(tiePlayers, tiedSchedule, {
    minGames: 2,
    mode: "win_percentage",
  });
  assert.equal(
    tiedRows.find(row => row.id === "a").rank,
    tiedRows.find(row => row.id === "e").rank
  );

  const largerSampleRows = rating.calculateStandings(tiePlayers, [
    ...tiedSchedule,
    { teamA: ["a", "c"], teamB: ["b", "d"], winner: "A" },
    { teamA: ["a", "c"], teamB: ["b", "d"], winner: "B" },
  ], { minGames: 2, mode: "win_percentage" });
  assert.equal(largerSampleRows.find(row => row.id === "a").winPercentage, 50);
  assert.equal(largerSampleRows.find(row => row.id === "e").winPercentage, 50);
  assert.ok(
    largerSampleRows.findIndex(row => row.id === "a") <
    largerSampleRows.findIndex(row => row.id === "e")
  );

  const zeroWinRows = rating.calculateStandings(tiePlayers, [
    { teamA: ["a", "b"], teamB: ["c", "d"], winner: "B" },
    { teamA: ["a", "e"], teamB: ["c", "f"], winner: "B" },
    { teamA: ["a", "g"], teamB: ["d", "h"], winner: "B" },
  ], { minGames: 1, mode: "win_percentage" });
  assert.equal(zeroWinRows.find(row => row.id === "a").winPercentage, 0);
  assert.equal(zeroWinRows.find(row => row.id === "b").winPercentage, 0);
  assert.equal(
    zeroWinRows.find(row => row.id === "a").rank,
    zeroWinRows.find(row => row.id === "b").rank
  );
});

test("podium includes every qualified player tied at the cutoff", () => {
  const podium = rating.podiumRows([
    { id: "a", eligible: true, rank: 1 },
    { id: "b", eligible: true, rank: 2 },
    { id: "c", eligible: true, rank: 3 },
    { id: "d", eligible: true, rank: 3 },
    { id: "e", eligible: true, rank: 5 },
    { id: "f", eligible: false, rank: null },
  ]);

  assert.deepEqual(podium.map(row => row.id), ["a", "b", "c", "d"]);
});

test("competitive ranking applies the complete evidence hierarchy in order", () => {
  const baseline = {
    pointsExact: 12.25,
    wins: 3,
    games: 4,
    headToHeadWins: 0,
    headToHeadGames: 0,
    averageOpponentRatingExact: 1225,
    bestUpsetExact: 80,
  };

  const cases = [
    {
      criterion: "performance_points",
      ahead: { ...baseline, pointsExact: 12.2500001 },
      behind: baseline,
    },
    {
      criterion: "win_percentage",
      ahead: { ...baseline, wins: 4, games: 5 },
      behind: baseline,
    },
    {
      criterion: "wins",
      ahead: { ...baseline, wins: 4, games: 8 },
      behind: { ...baseline, wins: 3, games: 6 },
    },
    {
      criterion: "head_to_head",
      ahead: { ...baseline, headToHeadWins: 2, headToHeadGames: 3 },
      behind: { ...baseline, headToHeadWins: 1, headToHeadGames: 3 },
    },
    {
      criterion: "opponent_strength",
      ahead: { ...baseline, averageOpponentRatingExact: 1225.000001 },
      behind: baseline,
    },
    {
      criterion: "quality_win",
      ahead: { ...baseline, bestUpsetExact: 80.000001 },
      behind: baseline,
    },
  ];

  cases.forEach(({ criterion, ahead, behind }) => {
    assert.equal(rating.competitiveCriterion(ahead, behind), criterion);
    assert.ok(rating.compareCompetitive(ahead, behind) < 0);
    assert.ok(rating.compareCompetitive(behind, ahead) > 0);
  });
  assert.equal(rating.competitiveCriterion(baseline, { ...baseline }), null);
  assert.equal(rating.compareCompetitive(baseline, { ...baseline }), 0);
});

test("competitive rating stays individual while teammates rotate", () => {
  const rotatingPlayers = [
    ...players,
    { id: "e", full_name: "E", skill_level: 3 },
    { id: "f", full_name: "F", skill_level: 3 },
  ];
  const rows = rating.calculateStandings(rotatingPlayers, [
    {
      resultAt: "2026-07-28T10:00:00.000Z",
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      winner: "A",
    },
    {
      resultAt: "2026-07-28T10:10:00.000Z",
      teamA: ["a", "e"],
      teamB: ["b", "f"],
      winner: "A",
    },
  ], { minGames: 1, mode: "competitive" });

  const playerA = rows.find(row => row.id === "a");
  const playerB = rows.find(row => row.id === "b");
  assert.equal(playerA.mode, rating.RANKING_MODE_COMPETITIVE);
  assert.equal(playerA.games, 2);
  assert.equal(playerA.wins, 2);
  assert.ok(playerA.pointsExact > playerB.pointsExact);
  assert.ok(playerA.rank < playerB.rank);
  assert.notEqual(playerA.pointsExact, playerA.points);
  assert.equal(playerA.rankReason, "Exact Performance Points");
});

test("competitive ranking resolves equal displayed points using unrounded points", () => {
  const precisionPlayers = [
    { id: "a", full_name: "A", performance_seed_rating: 1000 },
    { id: "b", full_name: "B", performance_seed_rating: 1100 },
    { id: "c", full_name: "C", performance_seed_rating: 1200 },
    { id: "d", full_name: "D", performance_seed_rating: 1300 },
    { id: "e", full_name: "E", performance_seed_rating: 1400 },
    { id: "f", full_name: "F", performance_seed_rating: 1500 },
  ];
  const rows = rating.calculateStandings(precisionPlayers, [
    {
      sequence: 0,
      teamA: ["a", "b"],
      teamB: ["f", "c"],
      winner: "B",
    },
    {
      sequence: 1,
      teamA: ["a", "d"],
      teamB: ["e", "f"],
      winner: "B",
    },
  ], { minGames: 1, mode: "competitive" });

  const playerC = rows.find(row => row.id === "c");
  const playerE = rows.find(row => row.id === "e");
  assert.equal(playerC.points, 3.6);
  assert.equal(playerE.points, 3.6);
  assert.ok(playerC.pointsExact > playerE.pointsExact);
  assert.ok(playerC.rank < playerE.rank);
  assert.equal(playerC.rankCriterion, "performance_points");
  assert.equal(playerC.requiresPodiumDecider, false);
  assert.equal(playerE.requiresPodiumDecider, false);
});

test("competitive ranking flags indistinguishable podium teammates for a decider", () => {
  const levelPlayers = players.map(player => ({
    ...player,
    performance_seed_rating: 1200,
  }));
  const rows = rating.calculateStandings(levelPlayers, [
    { sequence: 0, teamA: ["a", "b"], teamB: ["c", "d"], winner: "A" },
    { sequence: 1, teamA: ["a", "b"], teamB: ["c", "d"], winner: "B" },
    { sequence: 2, teamA: ["a", "b"], teamB: ["c", "d"], winner: "A" },
  ], { minGames: 3, mode: "competitive" });

  const playerA = rows.find(row => row.id === "a");
  const playerB = rows.find(row => row.id === "b");
  const playerC = rows.find(row => row.id === "c");
  const playerD = rows.find(row => row.id === "d");

  assert.equal(playerA.rank, 1);
  assert.equal(playerB.rank, 1);
  assert.equal(playerC.rank, 3);
  assert.equal(playerD.rank, 3);
  [playerA, playerB, playerC, playerD].forEach(row => {
    assert.equal(row.requiresPodiumDecider, true);
    assert.equal(row.rankCriterion, "podium_decider");
    assert.equal(row.tieBreakReason, "Podium decider required");
    assert.ok(row.podiumDeciderGroupId);
    assert.equal(row.podiumDeciderPlayerIds.length, 2);
  });
  assert.deepEqual(playerA.podiumDeciderPlayerIds, ["a", "b"]);
  assert.deepEqual(playerC.podiumDeciderPlayerIds, ["c", "d"]);
  assert.notEqual(playerA.podiumDeciderGroupId, playerC.podiumDeciderGroupId);
});
