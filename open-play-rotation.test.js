const test = require('node:test');
const assert = require('node:assert/strict');
const Rotation = require('./open-play-rotation.js');

test('parses legacy and current rotation modes', () => {
  assert.deepEqual(Rotation.parseMode('smart_random_mixer'), { format: 'doubles', style: 'balanced' });
  assert.deepEqual(Rotation.parseMode('adaptive_competitive_mixer'), { format: 'doubles', style: 'adaptive_competitive' });
  assert.deepEqual(Rotation.parseMode('all_rotate'), { format: 'doubles', style: 'queue' });
  assert.deepEqual(Rotation.parseMode('singles:winners_losers'), { format: 'singles', style: 'winners_losers' });
  [
    'skill_separated',
    'mixed_doubles',
    'skill_courts',
    'king_court',
    'club_wars',
    'tournament',
  ].forEach(style => {
    assert.deepEqual(Rotation.parseMode(style), { format: 'doubles', style });
  });
  assert.equal(Rotation.encodeMode('singles', 'queue'), 'singles:queue');
  assert.equal(Rotation.encodeMode('doubles', 'mixed_doubles'), 'doubles:mixed_doubles');
});

test('adaptive competitive rotation gives the court to players with fewer games first', () => {
  const active = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    .map((id, seed_order) => ({ id, seed_order, skill_level: 3 }));
  const result = Rotation.generateAssignments({
    active,
    courtIds: ['court-1'],
    rounds: [
      {
        round_no: 1,
        assignments: [
          { teamA: ['A', 'B'], teamB: ['C', 'D'], winner: 'A' },
          { teamA: ['E', 'F'], teamB: ['G', 'H'], winner: 'A' },
        ],
      },
      {
        round_no: 2,
        assignments: [
          { teamA: ['A', 'C'], teamB: ['B', 'D'], winner: 'A' },
        ],
        queue_snapshot: ['E', 'F', 'G', 'H', 'A', 'B', 'C', 'D'],
      },
    ],
    format: 'doubles',
    style: 'adaptive_competitive',
    random: () => 0,
  });
  const playing = new Set([...result.assignments[0].teamA, ...result.assignments[0].teamB]);
  assert.deepEqual(playing, new Set(['E', 'F', 'G', 'H']));
});

test('adaptive competitive rotation blocks recent partner repeats when another split exists', () => {
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C', 'D'].map((id, seed_order) => ({
      id,
      seed_order,
      skill_level: 3,
    })),
    courtIds: ['court-1'],
    rounds: [{
      round_no: 1,
      assignments: [{ teamA: ['A', 'B'], teamB: ['C', 'D'], winner: 'A' }],
      queue_snapshot: ['A', 'B', 'C', 'D'],
    }],
    format: 'doubles',
    style: 'adaptive_competitive',
    random: () => 0,
  });
  const partnerPairs = [result.assignments[0].teamA, result.assignments[0].teamB]
    .map(team => Rotation.pairKey(team[0], team[1]));
  assert.ok(!partnerPairs.includes('A|B'));
  assert.ok(!partnerPairs.includes('C|D'));
  assert.equal(result.assignments[0].matchQuality.recentPartnerRepeats, 0);
});

test('adaptive competitive rotation never makes strong-strong face weak-weak when balanced teams exist', () => {
  const players = [
    { id: 'S1', skill_level: 6 },
    { id: 'S2', skill_level: 6 },
    { id: 'W1', skill_level: 1 },
    { id: 'W2', skill_level: 1 },
  ].map((player, seed_order) => ({ ...player, seed_order }));
  const skills = Object.fromEntries(players.map(player => [player.id, player.skill_level]));
  const result = Rotation.generateAssignments({
    active: players,
    courtIds: ['court-1'],
    rounds: [],
    format: 'doubles',
    style: 'adaptive_competitive',
    random: () => 0,
  });
  const game = result.assignments[0];
  const teamATotal = game.teamA.reduce((sum, id) => sum + skills[id], 0);
  const teamBTotal = game.teamB.reduce((sum, id) => sum + skills[id], 0);
  assert.equal(teamATotal, 7);
  assert.equal(teamBTotal, 7);
  assert.equal(game.matchQuality.expectedTeamA, 50);
  assert.equal(game.matchQuality.expectedTeamB, 50);
});

test('adaptive competitive rotation relaxes partner cooldown before allowing an unfair match', () => {
  const players = [
    { id: 'S1', skill_level: 6 },
    { id: 'S2', skill_level: 6 },
    { id: 'W1', skill_level: 1 },
    { id: 'W2', skill_level: 1 },
  ].map((player, seed_order) => ({ ...player, seed_order }));
  const skills = Object.fromEntries(players.map(player => [player.id, player.skill_level]));
  const result = Rotation.generateAssignments({
    active: players,
    courtIds: ['court-1'],
    rounds: [
      {
        round_no: 1,
        assignments: [{ teamA: ['S1', 'W1'], teamB: ['S2', 'W2'], winner: 'A' }],
      },
      {
        round_no: 2,
        assignments: [{ teamA: ['S1', 'W2'], teamB: ['S2', 'W1'], winner: 'A' }],
        queue_snapshot: ['S1', 'S2', 'W1', 'W2'],
      },
    ],
    format: 'doubles',
    style: 'adaptive_competitive',
    random: () => 0,
  });
  const game = result.assignments[0];
  const teamATotal = game.teamA.reduce((sum, id) => sum + skills[id], 0);
  const teamBTotal = game.teamB.reduce((sum, id) => sum + skills[id], 0);
  assert.equal(teamATotal, 7);
  assert.equal(teamBTotal, 7);
  assert.equal(game.matchQuality.balance, 'Excellent');
  assert.ok(game.matchQuality.recentPartnerRepeats > 0);
});

test('adaptive competitive rotation builds strong-vs-strong and weak-vs-weak courts when possible', () => {
  const players = [
    ...['S1', 'S2', 'S3', 'S4'].map(id => ({ id, skill_level: 6 })),
    ...['W1', 'W2', 'W3', 'W4'].map(id => ({ id, skill_level: 1 })),
  ].map((player, seed_order) => ({ ...player, seed_order }));
  const skills = Object.fromEntries(players.map(player => [player.id, player.skill_level]));
  const result = Rotation.generateAssignments({
    active: players,
    courtIds: ['one', 'two'],
    rounds: [],
    format: 'doubles',
    style: 'adaptive_competitive',
    random: () => 0,
  });
  assert.equal(result.assignments.length, 2);
  result.assignments.forEach(game => {
    const courtSkills = new Set([...game.teamA, ...game.teamB].map(id => skills[id]));
    assert.equal(courtSkills.size, 1);
  });
});

test('adaptive competitive rotation places tied players on opposite teams for a challenge', () => {
  const players = [
    { id: 'A', competitive_rank: 4, points_exact: 1, games: 3 },
    { id: 'B', competitive_rank: 4, points_exact: 1, games: 3 },
    { id: 'C', competitive_rank: 5, points_exact: 12, games: 3 },
    { id: 'D', competitive_rank: 6, points_exact: -10, games: 3 },
  ].map((player, seed_order) => ({
    ...player,
    seed_order,
    rating_exact: 1200,
    skill_level: 3,
  }));
  const result = Rotation.generateAssignments({
    active: players,
    courtIds: ['court-1'],
    rounds: [],
    format: 'doubles',
    style: 'adaptive_competitive',
    random: () => 0,
  });
  const game = result.assignments[0];
  const aSide = game.teamA.includes('A') ? 'A' : 'B';
  const bSide = game.teamA.includes('B') ? 'A' : 'B';
  assert.notEqual(aSide, bSide);
  assert.equal(game.matchQuality.challenge, true);
});

test('queue style keeps the first eligible players on court', () => {
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C', 'D', 'E'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['court-1'],
    courtNames: { 'court-1': 'Court 1' },
    rounds: [],
    format: 'doubles',
    style: 'queue',
    random: () => 0,
  });
  const playing = new Set([...result.assignments[0].teamA, ...result.assignments[0].teamB]);
  assert.deepEqual(playing, new Set(['A', 'B', 'C', 'D']));
  assert.equal(result.queueSnapshot[0], 'E');
});

test('singles fills each court with two players', () => {
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C', 'D', 'E'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['one', 'two'],
    courtNames: { one: 'One', two: 'Two' },
    rounds: [],
    format: 'singles',
    style: 'queue',
    random: () => 0,
  });
  assert.equal(result.assignments.length, 2);
  result.assignments.forEach(game => {
    assert.equal(game.teamA.length, 1);
    assert.equal(game.teamB.length, 1);
  });
  assert.equal(result.queueSnapshot[0], 'E');
});

test('balanced rotation selects players with fewer appearances first', () => {
  const priorRound = {
    round_no: 1,
    assignments: [{
      teamA: ['A', 'B'],
      teamB: ['C', 'D'],
      winner: 'A',
    }],
    queue_snapshot: ['E', 'F', 'A', 'B', 'C', 'D'],
  };
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C', 'D', 'E', 'F'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['court-1'],
    rounds: [priorRound],
    format: 'doubles',
    style: 'balanced',
    random: () => 0,
  });
  const playing = new Set([...result.assignments[0].teamA, ...result.assignments[0].teamB]);
  assert.ok(playing.has('E'));
  assert.ok(playing.has('F'));
});

test('fair queue is strict FIFO and late arrivals join the back', () => {
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C', 'D', 'E', 'F'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['court-1'],
    rounds: [{ round_no: 1, assignments: [], queue_snapshot: ['F', 'A', 'B', 'C', 'D'] }],
    format: 'doubles',
    style: 'queue',
    random: () => 0,
  });
  const playing = new Set([...result.assignments[0].teamA, ...result.assignments[0].teamB]);
  assert.deepEqual(playing, new Set(['F', 'A', 'B', 'C']));
  assert.equal(result.queueSnapshot[0], 'D');
  assert.equal(result.queueSnapshot[1], 'E');
});

test('doubles avoids repeating both prior partner pairs when another split exists', () => {
  const priorRound = {
    round_no: 1,
    assignments: [{ teamA: ['A', 'B'], teamB: ['C', 'D'] }],
    queue_snapshot: ['A', 'B', 'C', 'D'],
  };
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C', 'D'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['court-1'],
    rounds: [priorRound],
    format: 'doubles',
    style: 'queue',
    random: () => 0,
  });
  const partnerPairs = [result.assignments[0].teamA, result.assignments[0].teamB]
    .map(team => Rotation.pairKey(team[0], team[1]));
  assert.ok(!partnerPairs.includes('A|B'));
  assert.ok(!partnerPairs.includes('C|D'));
});

test('in-progress appearances do not count as completed results', () => {
  const history = Rotation.buildHistory([{
    round_no: 1,
    assignments: [{
      completedGames: [{ teamA: ['A', 'B'], teamB: ['C', 'D'], winner: 'A' }],
      teamA: ['A', 'C'],
      teamB: ['B', 'D'],
    }],
  }]);
  assert.equal(history.playCount.A, 2);
  assert.equal(history.resultCount.A, 1);
  assert.equal(history.winCount.A, 1);
  assert.equal(history.lastOutcome.A, 'winner');
  assert.equal(history.lastOutcome.C, 'loser');
});

test('history ignores null and empty player slots', () => {
  const history = Rotation.buildHistory([{
    round_no: 1,
    assignments: [{
      teamA: ['A', null, ''],
      teamB: ['B', undefined],
      winner: 'A',
    }],
  }]);

  assert.deepEqual(history.playCount, { A: 1, B: 1 });
  assert.deepEqual(history.resultCount, { A: 1, B: 1 });
  assert.equal(history.opponent['A|B'], 1);
  assert.equal(Object.hasOwn(history.playCount, 'null'), false);
  assert.equal(Object.hasOwn(history.playCount, 'undefined'), false);
  assert.equal(Object.hasOwn(history.playCount, ''), false);
});

test('winners and losers form separate next games when each pool is full', () => {
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['one', 'two'],
    rounds: [{
      round_no: 1,
      assignments: [
        { teamA: ['A', 'B'], teamB: ['C', 'D'], winner: 'A' },
        { teamA: ['E', 'F'], teamB: ['G', 'H'], winner: 'A' },
      ],
      queue_snapshot: ['A', 'C', 'E', 'G', 'B', 'D', 'F', 'H'],
    }],
    format: 'doubles',
    style: 'winners_losers',
    random: () => 0,
  });
  const outcomes = Rotation.buildHistory([{
    round_no: 1,
    assignments: [
      { teamA: ['A', 'B'], teamB: ['C', 'D'], winner: 'A' },
      { teamA: ['E', 'F'], teamB: ['G', 'H'], winner: 'A' },
    ],
  }]).lastOutcome;
  result.assignments.forEach(game => {
    const groupOutcomes = new Set([...game.teamA, ...game.teamB].map(id => outcomes[id]));
    assert.equal(groupOutcomes.size, 1);
  });
});

test('continuous winners and losers refill selects one recent-outcome pool', () => {
  const history = Rotation.buildHistory([{
    round_no: 1,
    assignments: [
      { teamA: ['W1', 'W2'], teamB: ['L1', 'L2'], winner: 'A' },
      { teamA: ['W3', 'W4'], teamB: ['L3', 'L4'], winner: 'A' },
    ],
  }]);
  const selected = Rotation.selectNextPlayers(
    ['W1', 'L1', 'W2', 'L2', 'W3', 'L3', 'W4', 'L4'],
    history,
    4,
    'winners_losers'
  );
  assert.deepEqual(selected, ['W1', 'W2', 'W3', 'W4']);
});

test('latest completed result controls the winners and losers pool', () => {
  const history = Rotation.buildHistory([
    { round_no: 1, assignments: [{ teamA: ['A'], teamB: ['B'], winner: 'A' }] },
    { round_no: 2, assignments: [{ teamA: ['A'], teamB: ['C'], winner: 'A' }] },
    { round_no: 3, assignments: [{ teamA: ['A'], teamB: ['D'], winner: 'B' }] },
  ]);
  assert.equal(history.winCount.A, 2);
  assert.equal(history.resultCount.A, 3);
  assert.equal(history.lastOutcome.A, 'loser');
});

test('cross-court result timestamps determine the latest outcome', () => {
  const history = Rotation.buildHistory([{
    round_no: 1,
    assignments: [
      {
        completedGames: [{
          teamA: ['A', 'B'],
          teamB: ['C', 'D'],
          winner: 'B',
          resultAt: '2026-07-24T10:10:00.000Z',
        }],
        teamA: ['E', 'F'],
        teamB: ['G', 'H'],
      },
      {
        completedGames: [{
          teamA: ['A', 'C'],
          teamB: ['B', 'D'],
          winner: 'A',
          resultAt: '2026-07-24T10:00:00.000Z',
        }],
        teamA: ['I', 'J'],
        teamB: ['K', 'L'],
      },
    ],
  }]);
  assert.equal(history.lastOutcome.A, 'loser');
});

test('winners and losers lookahead never skips an unmatched front player', () => {
  const history = {
    lastOutcome: {
      A: 'loser',
      B: 'winner',
      C: 'winner',
      D: 'winner',
      E: 'winner',
    },
  };
  assert.deepEqual(
    Rotation.selectNextPlayers(['A', 'B', 'C', 'D', 'E'], history, 4, 'winners_losers'),
    ['A', 'B', 'C', 'D']
  );
});

test('winners and losers lookahead keeps court time bounded over many results', () => {
  const active = Array.from({ length: 6 }, (_, seed_order) => ({
    id: `P${seed_order}`,
    seed_order,
  }));
  const rounds = [];

  for (let roundNo = 1; roundNo <= 60; roundNo += 1) {
    const result = Rotation.generateAssignments({
      active,
      courtIds: ['one'],
      rounds,
      format: 'doubles',
      style: 'winners_losers',
      random: () => 0,
    });
    rounds.push({
      round_no: roundNo,
      assignments: result.assignments.map(game => ({
        ...game,
        winner: 'A',
        resultAt: new Date(Date.UTC(2026, 0, 1, 0, 0, roundNo)).toISOString(),
      })),
      queue_snapshot: result.queueSnapshot,
    });
  }

  const history = Rotation.buildHistory(rounds);
  const appearances = active.map(player => history.playCount[player.id] || 0);
  assert.ok(Math.max(...appearances) - Math.min(...appearances) <= 1, appearances.join(','));
});

test('singles avoids an immediate repeat opponent when another pairing exists', () => {
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['one'],
    rounds: [{
      round_no: 1,
      assignments: [{ teamA: ['A'], teamB: ['B'], winner: 'A' }],
      queue_snapshot: ['A', 'B', 'C'],
    }],
    format: 'singles',
    style: 'balanced',
    random: () => 0,
  });
  const matchup = new Set([...result.assignments[0].teamA, ...result.assignments[0].teamB]);
  assert.ok(matchup.has('C'));
});

test('balanced rotation exhaustively finds the best eight-player repeat score', () => {
  const rounds = [
    {
      round_no: 1,
      assignments: [
        { teamA: ['B', 'H'], teamB: ['A', 'E'], winner: 'B' },
        { teamA: ['G', 'F'], teamB: ['C', 'D'], winner: 'B' },
      ],
      queue_snapshot: ['B', 'H', 'A', 'E', 'G', 'F', 'C', 'D'],
    },
    {
      round_no: 2,
      assignments: [
        { teamA: ['H', 'B'], teamB: ['A', 'D'], winner: 'B' },
        { teamA: ['E', 'C'], teamB: ['G', 'F'], winner: 'B' },
      ],
      queue_snapshot: ['H', 'B', 'A', 'D', 'E', 'C', 'G', 'F'],
    },
    {
      round_no: 3,
      assignments: [
        { teamA: ['F', 'C'], teamB: ['B', 'H'], winner: 'B' },
        { teamA: ['G', 'D'], teamB: ['E', 'A'], winner: 'B' },
      ],
      queue_snapshot: ['F', 'C', 'B', 'H', 'G', 'D', 'E', 'A'],
    },
  ];
  const history = Rotation.buildHistory(rounds);
  let seed = 2;
  const random = () => (
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / (2 ** 32)
  );
  const result = Rotation.generateAssignments({
    active: 'ABCDEFGH'.split('').map((id, seed_order) => ({ id, seed_order })),
    courtIds: ['one', 'two'],
    rounds,
    format: 'doubles',
    style: 'balanced',
    random,
  });
  const repeatPenalty = game => {
    const partnerRepeats =
      (history.partner[Rotation.pairKey(game.teamA[0], game.teamA[1])] || 0) +
      (history.partner[Rotation.pairKey(game.teamB[0], game.teamB[1])] || 0);
    const opponentRepeats = game.teamA.reduce((total, playerA) =>
      total + game.teamB.reduce((sum, playerB) =>
        sum + (history.opponent[Rotation.pairKey(playerA, playerB)] || 0), 0
      ), 0);
    return partnerRepeats * 100 + opponentRepeats * 25;
  };
  const score = result.assignments.reduce((sum, game) => sum + repeatPenalty(game), 0);

  assert.equal(score, 50);
});

test('balanced rotation keeps the sampled fallback for larger cohorts', () => {
  let seed = 11;
  const random = () => (
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / (2 ** 32)
  );
  const result = Rotation.generateAssignments({
    active: Array.from({ length: 12 }, (_, seed_order) => ({
      id: `P${seed_order}`,
      seed_order,
    })),
    courtIds: ['one', 'two', 'three'],
    rounds: [],
    format: 'doubles',
    style: 'balanced',
    random,
  });
  const playing = result.assignments.flatMap(game => [...game.teamA, ...game.teamB]);

  assert.equal(result.assignments.length, 3);
  assert.equal(new Set(playing).size, 12);
});

test('no-court result preserves the prior queue and appends late arrivals', () => {
  const result = Rotation.generateAssignments({
    active: ['A', 'B', 'C'].map((id, seed_order) => ({ id, seed_order })),
    courtIds: [],
    rounds: [{ round_no: 1, assignments: [], queue_snapshot: ['C', 'A'] }],
    format: 'singles',
    style: 'queue',
  });
  assert.deepEqual(result.queueSnapshot, ['C', 'A', 'B']);
});

test('queue wait labels scale with courts and format', () => {
  assert.equal(Rotation.queueWaitLabel(0, 2, 'doubles'), 'next rotation');
  assert.equal(Rotation.queueWaitLabel(7, 2, 'doubles'), 'next rotation');
  assert.equal(Rotation.queueWaitLabel(8, 2, 'doubles'), 'about 2 rotations');
  assert.equal(Rotation.queueWaitLabel(4, 2, 'singles'), 'about 2 rotations');
});

test('skill-separated mode builds courts from compatible skill levels', () => {
  const active = [
    ['L1', 1],
    ['H1', 5],
    ['L2', 1],
    ['H2', 5],
    ['L3', 2],
    ['H3', 6],
    ['L4', 2],
    ['H4', 6],
  ].map(([id, skill_level], seed_order) => ({ id, skill_level, seed_order }));
  const skills = Object.fromEntries(active.map(player => [player.id, player.skill_level]));
  const result = Rotation.generateAssignments({
    active,
    courtIds: ['one', 'two'],
    rounds: [],
    format: 'doubles',
    style: 'skill_separated',
    random: () => 0,
  });

  assert.equal(result.assignments.length, 2);
  result.assignments.forEach(game => {
    const gameSkills = [...game.teamA, ...game.teamB].map(id => skills[id]);
    assert.ok(Math.max(...gameSkills) - Math.min(...gameSkills) <= 1);
  });
});

test('mixed-doubles mode makes male-female teams and leaves ineligible players waiting', () => {
  const active = [
    { id: 'U', gender: 'other' },
    { id: 'M1', gender: 'male', lockedPartnerId: 'F1' },
    { id: 'F1', gender: 'female', locked_partner_id: 'M1' },
    { id: 'M2', gender: 'male' },
    { id: 'F2', gender: 'female' },
  ].map((player, seed_order) => ({ ...player, seed_order }));
  const genders = Object.fromEntries(active.map(player => [player.id, player.gender]));
  const result = Rotation.generateAssignments({
    active,
    courtIds: ['one'],
    rounds: [],
    format: 'doubles',
    style: 'mixed_doubles',
    random: () => 0,
  });

  assert.equal(result.assignments.length, 1);
  assert.equal(result.queueSnapshot[0], 'U');
  [result.assignments[0].teamA, result.assignments[0].teamB].forEach(team => {
    assert.deepEqual(new Set(team.map(id => genders[id])), new Set(['male', 'female']));
  });
  assert.ok(
    [result.assignments[0].teamA, result.assignments[0].teamB]
      .some(team => team.includes('M1') && team.includes('F1'))
  );
});

test('skill-courts mode labels and fills distinct rating bands', () => {
  const active = [
    ['L1', 1],
    ['H1', 5],
    ['L2', 1],
    ['H2', 5],
    ['L3', 2],
    ['H3', 6],
    ['L4', 2],
    ['H4', 6],
  ].map(([id, skillLevel], seed_order) => ({ id, skillLevel, seed_order }));
  const skills = Object.fromEntries(active.map(player => [player.id, player.skillLevel]));
  const result = Rotation.generateAssignments({
    active,
    courtIds: ['one', 'two'],
    rounds: [],
    format: 'doubles',
    style: 'skill_courts',
    random: () => 0,
  });

  assert.deepEqual(result.assignments.map(game => game.skillBand), ['beginner', 'advanced']);
  result.assignments.forEach(game => {
    const expectedBand = game.skillBand;
    [...game.teamA, ...game.teamB].forEach(id => {
      assert.equal(skills[id] <= 2 ? 'beginner' : 'advanced', expectedBand);
    });
  });
});

test('king-court mode promotes winners and relegates losers by court order', () => {
  const active = 'ABCDEFGH'.split('').map((id, seed_order) => ({ id, seed_order }));
  const result = Rotation.generateAssignments({
    active,
    courtIds: ['top', 'bottom'],
    rounds: [{
      round_no: 1,
      assignments: [
        { courtId: 'top', teamA: ['A', 'B'], teamB: ['C', 'D'], winner: 'A' },
        { courtId: 'bottom', teamA: ['E', 'F'], teamB: ['G', 'H'], winner: 'B' },
      ],
      queue_snapshot: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    }],
    format: 'doubles',
    style: 'king_court',
    random: () => 0,
  });

  assert.equal(result.assignments.length, 2);
  assert.equal(result.assignments[0].ladderRank, 1);
  assert.equal(result.assignments[1].ladderRank, 2);
  assert.deepEqual(
    new Set([...result.assignments[0].teamA, ...result.assignments[0].teamB]),
    new Set(['A', 'B', 'G', 'H'])
  );
  assert.deepEqual(
    new Set([...result.assignments[1].teamA, ...result.assignments[1].teamB]),
    new Set(['C', 'D', 'E', 'F'])
  );
});

test('club-wars mode places one named club on each side', () => {
  const active = [
    ['R1', 'Red'],
    ['B1', 'Blue'],
    ['R2', 'Red'],
    ['B2', 'Blue'],
    ['R3', 'Red'],
    ['B3', 'Blue'],
    ['R4', 'Red'],
    ['B4', 'Blue'],
  ].map(([id, groupName], seed_order) => ({ id, groupName, seed_order }));
  const groups = Object.fromEntries(active.map(player => [player.id, player.groupName]));
  const result = Rotation.generateAssignments({
    active,
    courtIds: ['one', 'two'],
    rounds: [],
    format: 'doubles',
    style: 'club_wars',
    random: () => 0,
  });

  assert.equal(result.assignments.length, 2);
  result.assignments.forEach(game => {
    assert.equal(game.teamAName, 'Red');
    assert.equal(game.teamBName, 'Blue');
    assert.ok(game.teamA.every(id => groups[id] === 'Red'));
    assert.ok(game.teamB.every(id => groups[id] === 'Blue'));
  });
});

test('tournament mode keeps locked teams and emits a deterministic round robin', () => {
  const active = [
    { id: 'A', locked_partner_id: 'B' },
    { id: 'B', lockedPartnerId: 'A' },
    { id: 'C', locked_partner_id: 'D' },
    { id: 'D', lockedPartnerId: 'C' },
    { id: 'E', locked_partner_id: 'F' },
    { id: 'F', lockedPartnerId: 'E' },
    { id: 'G', locked_partner_id: 'H' },
    { id: 'H', lockedPartnerId: 'G' },
  ].map((player, seed_order) => ({ ...player, seed_order }));
  const lockedTeams = new Set(['A|B', 'C|D', 'E|F', 'G|H']);
  const seenFixtures = new Set();
  const rounds = [];

  for (let roundNo = 1; roundNo <= 3; roundNo += 1) {
    const result = Rotation.generateAssignments({
      active,
      courtIds: ['one', 'two'],
      rounds,
      format: 'doubles',
      style: 'tournament',
      random: () => 0,
    });
    assert.equal(result.assignments.length, 2);
    result.assignments.forEach(game => {
      const teamA = Rotation.pairKey(game.teamA[0], game.teamA[1]);
      const teamB = Rotation.pairKey(game.teamB[0], game.teamB[1]);
      assert.ok(lockedTeams.has(teamA));
      assert.ok(lockedTeams.has(teamB));
      const fixture = [teamA, teamB].sort().join(' vs ');
      assert.equal(seenFixtures.has(fixture), false);
      seenFixtures.add(fixture);
    });
    rounds.push({
      round_no: roundNo,
      assignments: result.assignments,
      queue_snapshot: result.queueSnapshot,
    });
  }

  assert.equal(seenFixtures.size, 6);
});

test('partner locks keep a separated queue pair together on the same team', () => {
  const active = [
    { id: 'A', lockedPartnerId: 'B' },
    { id: 'C' },
    { id: 'D' },
    { id: 'E' },
    { id: 'F' },
    { id: 'B', locked_partner_id: 'A' },
  ].map((player, seed_order) => ({ ...player, seed_order }));
  const result = Rotation.generateAssignments({
    active,
    courtIds: ['one'],
    rounds: [],
    format: 'doubles',
    style: 'queue',
    random: () => 0,
  });

  assert.equal(result.assignments.length, 1);
  assert.ok(
    [result.assignments[0].teamA, result.assignments[0].teamB]
      .some(team => team.includes('A') && team.includes('B'))
  );
});
