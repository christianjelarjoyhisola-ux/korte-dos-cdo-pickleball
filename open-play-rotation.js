(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OpenPlayRotation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VALID_FORMATS = new Set(['doubles', 'singles']);
  const VALID_STYLES = new Set([
    'balanced',
    'adaptive_competitive',
    'queue',
    'winners_losers',
    'skill_separated',
    'mixed_doubles',
    'skill_courts',
    'king_court',
    'club_wars',
    'tournament',
  ]);
  const DOUBLES_ONLY_STYLES = new Set([
    'adaptive_competitive',
    'skill_separated',
    'mixed_doubles',
    'skill_courts',
    'king_court',
    'club_wars',
    'tournament',
  ]);
  const SKILL_BAND_ORDER = ['beginner', 'intermediate', 'advanced', 'unrated'];

  function parseMode(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw.includes(':')) {
      const [formatValue, styleValue] = raw.split(':', 2);
      return {
        format: VALID_FORMATS.has(formatValue) ? formatValue : 'doubles',
        style: VALID_STYLES.has(styleValue) ? styleValue : 'balanced',
      };
    }
    if (raw === 'all_rotate') return { format: 'doubles', style: 'queue' };
    if (raw === 'adaptive_competitive_mixer') {
      return { format: 'doubles', style: 'adaptive_competitive' };
    }
    if (VALID_STYLES.has(raw)) return { format: 'doubles', style: raw };
    return { format: 'doubles', style: 'balanced' };
  }

  function encodeMode(format, style) {
    const safeFormat = VALID_FORMATS.has(format) ? format : 'doubles';
    const safeStyle = VALID_STYLES.has(style) ? style : 'balanced';
    return `${safeFormat}:${safeStyle}`;
  }

  function playersPerGame(format) {
    return format === 'singles' ? 2 : 4;
  }

  function pairKey(a, b) {
    return [String(a), String(b)].sort().join('|');
  }

  function normalizeSkill(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(6, numeric));
  }

  function normalizeGender(value) {
    const gender = String(value || '').trim().toLowerCase();
    return ['male', 'female', 'other'].includes(gender) ? gender : 'unspecified';
  }

  function normalizePlayer(player, index) {
    const lockedPartnerId = player.locked_partner_id ?? player.lockedPartnerId;
    return {
      ...player,
      id: String(player.id),
      seed_order: Number(player.seed_order ?? player.seedOrder ?? index),
      skill_level: normalizeSkill(player.skill_level ?? player.skillLevel),
      gender: normalizeGender(player.gender),
      group_name: String(player.group_name ?? player.groupName ?? '').trim(),
      locked_partner_id: lockedPartnerId == null || String(lockedPartnerId).trim() === ''
        ? ''
        : String(lockedPartnerId),
    };
  }

  function playerSkill(player) {
    return normalizeSkill(player?.skill_level ?? player?.skillLevel);
  }

  function playerStrength(player) {
    const candidates = [
      player?.competitive_rating,
      player?.competitiveRating,
      player?.rating_exact,
      player?.ratingExact,
      player?.rating,
      player?.performance_seed_rating,
      player?.performanceSeedRating,
    ];
    const stored = candidates.map(Number).find(value => Number.isFinite(value) && value > 0);
    if (stored != null) return stored;
    const skill = playerSkill(player) || 1;
    return 1000 + (skill - 1) * 100;
  }

  function playerStandingPoints(player) {
    const value = Number(
      player?.points_exact ??
      player?.pointsExact ??
      player?.points ??
      0
    );
    return Number.isFinite(value) ? value : 0;
  }

  function playerStandingRank(player) {
    const value = Number(player?.competitive_rank ?? player?.competitiveRank ?? player?.rank);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  function playerGender(player) {
    return normalizeGender(player?.gender);
  }

  function playerGroup(player) {
    return String(player?.group_name ?? player?.groupName ?? '').trim();
  }

  function playerLock(player) {
    const value = player?.locked_partner_id ?? player?.lockedPartnerId;
    return value == null || String(value).trim() === '' ? '' : String(value);
  }

  function skillBand(value) {
    const skill = normalizeSkill(value);
    if (!skill) return 'unrated';
    if (skill <= 2) return 'beginner';
    if (skill <= 4) return 'intermediate';
    return 'advanced';
  }

  function buildLockMap(players, style, format) {
    const locks = new Map();
    if (format !== 'doubles') return locks;
    const byId = new Map(players.map(player => [String(player.id), player]));
    const ordered = [...players].sort((a, b) =>
      a.seed_order - b.seed_order || String(a.id).localeCompare(String(b.id))
    );

    ordered.forEach(player => {
      const id = String(player.id);
      const targetId = playerLock(player);
      if (!targetId || targetId === id || locks.has(id) || locks.has(targetId)) return;
      const target = byId.get(targetId);
      if (!target) return;
      const targetRequest = playerLock(target);
      if (targetRequest && targetRequest !== id) return;
      if (style === 'mixed_doubles') {
        const genders = new Set([playerGender(player), playerGender(target)]);
        if (!genders.has('male') || !genders.has('female')) return;
      }
      if (style === 'club_wars' && (
        !playerGroup(player) ||
        playerGroup(player) !== playerGroup(target)
      )) return;
      locks.set(id, targetId);
      locks.set(targetId, id);
    });
    return locks;
  }

  function makeLockUnits(players, locks) {
    const byId = new Map(players.map(player => [String(player.id), player]));
    const seen = new Set();
    const units = [];
    players.forEach((player, index) => {
      const id = String(player.id);
      if (seen.has(id)) return;
      const partnerId = locks.get(id);
      const partner = partnerId ? byId.get(partnerId) : null;
      const members = partner && !seen.has(String(partner.id))
        ? [player, partner]
        : [player];
      members.forEach(member => seen.add(String(member.id)));
      const rated = members.map(playerSkill).filter(Boolean);
      units.push({
        players: members,
        firstIndex: Math.min(...members.map(member =>
          players.findIndex(candidate => String(candidate.id) === String(member.id))
        )),
        skill: rated.length ? rated.reduce((sum, value) => sum + value, 0) / rated.length : 0,
      });
    });
    return units.sort((a, b) => a.firstIndex - b.firstIndex);
  }

  function flattenUnits(units) {
    return units.flatMap(unit => unit.players);
  }

  function lexicographicallyEarlier(left, right) {
    if (!right) return true;
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (left[index] !== right[index]) return left[index] < right[index];
    }
    return left.length < right.length;
  }

  function pickQueueUnitIndexes(units, targetSize) {
    const picks = Array(targetSize + 1).fill(null);
    picks[0] = [];
    units.forEach((unit, unitIndex) => {
      const size = unit.players.length;
      for (let total = targetSize; total >= size; total -= 1) {
        if (!picks[total - size]) continue;
        const candidate = [...picks[total - size], unitIndex];
        if (lexicographicallyEarlier(candidate, picks[total])) picks[total] = candidate;
      }
    });
    return picks[targetSize];
  }

  function enumerateUnitPicks(units, targetSize, requiredIndex, visit, maxLookahead = 16) {
    const end = Math.min(units.length, requiredIndex + maxLookahead);
    const picked = [requiredIndex];
    let size = units[requiredIndex].players.length;

    const choose = start => {
      if (size === targetSize) {
        visit([...picked]);
        return;
      }
      if (size > targetSize) return;
      for (let index = start; index < end; index += 1) {
        const nextSize = size + units[index].players.length;
        if (nextSize > targetSize) continue;
        picked.push(index);
        size = nextSize;
        choose(index + 1);
        size -= units[index].players.length;
        picked.pop();
      }
    };
    choose(requiredIndex + 1);
  }

  function pickCompatibleUnitIndexes(units, targetSize, isCompatible, scoreGroup) {
    for (let anchor = 0; anchor < units.length; anchor += 1) {
      let best = null;
      let bestScore = Number.POSITIVE_INFINITY;
      enumerateUnitPicks(units, targetSize, anchor, indexes => {
        const selected = indexes.map(index => units[index]);
        if (!isCompatible(selected)) return;
        const score = scoreGroup(selected);
        if (score < bestScore || (
          score === bestScore &&
          lexicographicallyEarlier(indexes, best)
        )) {
          best = indexes;
          bestScore = score;
        }
      });
      if (best) return best;
    }
    return null;
  }

  function removePickedUnits(units, pickedIndexes) {
    const picked = new Set(pickedIndexes);
    return units.filter((_, index) => !picked.has(index));
  }

  function buildUnitGroups(players, groupSize, groupCount, locks, picker = pickQueueUnitIndexes) {
    let units = makeLockUnits(players, locks);
    const groups = [];
    while (groups.length < groupCount) {
      const pickedIndexes = picker(units, groupSize);
      if (!pickedIndexes) break;
      groups.push(flattenUnits(pickedIndexes.map(index => units[index])));
      units = removePickedUnits(units, pickedIndexes);
    }
    const playing = new Set(groups.flat().map(player => String(player.id)));
    return {
      groups,
      waiting: players.filter(player => !playing.has(String(player.id))),
    };
  }

  function buildHistory(rounds) {
    const partner = {};
    const opponent = {};
    const playCount = {};
    const resultCount = {};
    const winCount = {};
    const lastRound = {};
    const lastOutcome = {};
    const partnerTimeline = {};
    const resultEvents = [];
    let resultSequence = 0;

    const validPlayerIds = values => (Array.isArray(values) ? values : [])
      .filter(value => value != null && String(value).trim() !== '')
      .map(String);
    const processGame = (game, roundNo, roundIndex) => {
      const teamA = validPlayerIds(game.teamA);
      const teamB = validPlayerIds(game.teamB);
      if (teamA.length === 2) {
        const key = pairKey(teamA[0], teamA[1]);
        partner[key] = (partner[key] || 0) + 1;
        partnerTimeline[teamA[0]] = [...(partnerTimeline[teamA[0]] || []), teamA[1]].slice(-3);
        partnerTimeline[teamA[1]] = [...(partnerTimeline[teamA[1]] || []), teamA[0]].slice(-3);
      }
      if (teamB.length === 2) {
        const key = pairKey(teamB[0], teamB[1]);
        partner[key] = (partner[key] || 0) + 1;
        partnerTimeline[teamB[0]] = [...(partnerTimeline[teamB[0]] || []), teamB[1]].slice(-3);
        partnerTimeline[teamB[1]] = [...(partnerTimeline[teamB[1]] || []), teamB[0]].slice(-3);
      }
      teamA.forEach(a => teamB.forEach(b => {
        const key = pairKey(a, b);
        opponent[key] = (opponent[key] || 0) + 1;
      }));
      [...teamA, ...teamB].forEach(id => {
        playCount[id] = (playCount[id] || 0) + 1;
        lastRound[id] = roundNo;
      });
      if (game.winner === 'A' || game.winner === 'B') {
        [...teamA, ...teamB].forEach(id => { resultCount[id] = (resultCount[id] || 0) + 1; });
        const winners = game.winner === 'A' ? teamA : teamB;
        const losers = game.winner === 'A' ? teamB : teamA;
        winners.forEach(id => { winCount[id] = (winCount[id] || 0) + 1; });
        const resultTime = Date.parse(game.resultAt || game.result_at || '');
        resultEvents.push({
          winners,
          losers,
          roundIndex,
          sequence: resultSequence,
          time: Number.isFinite(resultTime) ? resultTime : null,
        });
        resultSequence += 1;
      }
    };

    (rounds || []).forEach((round, roundIndex) => {
      const roundNo = Number(round.round_no || round.roundNo || 0);
      (round.assignments || []).forEach(game => {
        (game.completedGames || []).forEach(done => processGame(done, roundNo, roundIndex));
        processGame(game, roundNo, roundIndex);
      });
    });

    resultEvents
      .sort((a, b) =>
        a.roundIndex - b.roundIndex ||
        (a.time != null && b.time != null ? a.time - b.time : a.sequence - b.sequence)
      )
      .forEach(event => {
        event.winners.forEach(id => { lastOutcome[id] = 'winner'; });
        event.losers.forEach(id => { lastOutcome[id] = 'loser'; });
      });

    return {
      partner,
      opponent,
      playCount,
      resultCount,
      winCount,
      lastRound,
      lastOutcome,
      recentPartners: partnerTimeline,
    };
  }

  function shuffle(items, random) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function splitHonorsLocks(teamA, teamB, locks) {
    if (!locks?.size) return true;
    const sideA = new Set(teamA.map(player => String(player.id)));
    const sideB = new Set(teamB.map(player => String(player.id)));
    for (const [id, partnerId] of locks.entries()) {
      if (
        (sideA.has(id) && !sideA.has(partnerId)) ||
        (sideB.has(id) && !sideB.has(partnerId))
      ) return false;
    }
    return true;
  }

  function isMixedTeam(team) {
    if (team.length !== 2) return false;
    const genders = new Set(team.map(playerGender));
    return genders.has('male') && genders.has('female');
  }

  function bestSplit(group, history, random, options = {}) {
    const jitter = typeof random === 'function' ? random : Math.random;
    if (group.length === 2) {
      const opponentRepeats = history.opponent[pairKey(group[0].id, group[1].id)] || 0;
      return {
        teamA: [group[0]],
        teamB: [group[1]],
        score: opponentRepeats * 25 + jitter(),
      };
    }

    const combinations = [
      [[0, 1], [2, 3]],
      [[0, 2], [1, 3]],
      [[0, 3], [1, 2]],
    ];
    let best = null;

    combinations.forEach(([teamAIndexes, teamBIndexes]) => {
      const teamA = teamAIndexes.map(index => group[index]);
      const teamB = teamBIndexes.map(index => group[index]);
      if (!splitHonorsLocks(teamA, teamB, options.locks)) return;
      if (options.requireMixed && (!isMixedTeam(teamA) || !isMixedTeam(teamB))) return;
      const partnerRepeats =
        (history.partner[pairKey(teamA[0].id, teamA[1].id)] || 0) +
        (history.partner[pairKey(teamB[0].id, teamB[1].id)] || 0);
      let opponentRepeats = 0;
      teamA.forEach(a => teamB.forEach(b => {
        opponentRepeats += history.opponent[pairKey(a.id, b.id)] || 0;
      }));
      const teamASkill = teamA.reduce((sum, player) => sum + playerSkill(player), 0);
      const teamBSkill = teamB.reduce((sum, player) => sum + playerSkill(player), 0);
      const skillPenalty = Math.abs(teamASkill - teamBSkill) * (options.skillWeight ?? 0);
      let score = partnerRepeats * 100 + opponentRepeats * 25 + skillPenalty + jitter();
      let matchQuality;

      if (options.adaptive) {
        const teamPairs = [
          [teamA[0], teamA[1]],
          [teamB[0], teamB[1]],
        ];
        const recentPartnerRepeats = teamPairs.reduce((count, [left, right]) => {
          const leftRecent = history.recentPartners?.[String(left.id)] || [];
          const rightRecent = history.recentPartners?.[String(right.id)] || [];
          return count + (
            leftRecent.includes(String(right.id)) || rightRecent.includes(String(left.id))
              ? 1
              : 0
          );
        }, 0);
        const strengthA = teamA.reduce((sum, player) => sum + playerStrength(player), 0);
        const strengthB = teamB.reduce((sum, player) => sum + playerStrength(player), 0);
        const strengthGap = Math.abs(strengthA - strengthB);
        const expectedA = 1 / (1 + Math.pow(10, (strengthB - strengthA) / 400));
        const groupStrengths = group.map(playerStrength);
        const groupSpread = Math.max(...groupStrengths) - Math.min(...groupStrengths);
        const nearTie = (left, right) => {
          const leftRank = playerStandingRank(left);
          const rightRank = playerStandingRank(right);
          if (leftRank != null && leftRank === rightRank) return true;
          const gamesReady = Number(left?.games || 0) >= 2 && Number(right?.games || 0) >= 2;
          return gamesReady && Math.abs(
            playerStandingPoints(left) - playerStandingPoints(right)
          ) <= 1;
        };
        const tiedPartnerPairs = teamPairs.reduce(
          (count, [left, right]) => count + (nearTie(left, right) ? 1 : 0),
          0
        );
        let challengeOpponentPairs = 0;
        teamA.forEach(left => teamB.forEach(right => {
          if (nearTie(left, right)) challengeOpponentPairs += 1;
        }));

        score =
          recentPartnerRepeats * 100000 +
          partnerRepeats * 4000 +
          tiedPartnerPairs * 2500 +
          strengthGap * strengthGap * .7 +
          opponentRepeats * 120 +
          groupSpread * .35 -
          challengeOpponentPairs * 160 +
          jitter() * .01;

        const expectedPercentA = Math.round(expectedA * 100);
        const balanceDistance = Math.abs(expectedA - .5);
        matchQuality = {
          expectedTeamA: expectedPercentA,
          expectedTeamB: 100 - expectedPercentA,
          balance: balanceDistance <= .05
            ? 'Excellent'
            : balanceDistance <= .1
              ? 'Good'
              : 'Wide',
          recentPartnerRepeats,
          partnerRepeats,
          opponentRepeats,
          challenge: challengeOpponentPairs > 0,
          gameCounts: group.map(player => Number(history.playCount?.[String(player.id)] || 0)),
        };
      }

      if (!best || score < best.score) best = { teamA, teamB, score, matchQuality };
    });

    return best;
  }

  function makeAssignments(groups, courtIds, courtNames, history, random, options = {}) {
    const assignments = [];
    for (let index = 0; index < groups.length; index += 1) {
      const split = bestSplit(groups[index], history, random, options);
      if (!split) return [];
      const courtId = courtIds[index];
      assignments.push({
        courtId,
        courtName: courtNames[String(courtId)] || `Court ${index + 1}`,
        teamA: split.teamA.map(player => String(player.id)),
        teamB: split.teamB.map(player => String(player.id)),
        _score: split.score,
        ...(split.matchQuality ? { matchQuality: split.matchQuality } : {}),
        ...(options.assignmentMeta?.[index] || {}),
      });
    }
    return assignments;
  }

  function groupsOf(players, size) {
    const groups = [];
    for (let i = 0; i < players.length; i += size) groups.push(players.slice(i, i + size));
    return groups;
  }

  function exactBalancedAssignments(players, groupSize, courtIds, courtNames, history, random, options = {}) {
    const searchOrder = shuffle(players, random);
    let bestAssignments = [];
    let bestScore = Number.POSITIVE_INFINITY;

    const visit = (remaining, groups) => {
      if (!remaining.length) {
        const candidate = makeAssignments(groups, courtIds, courtNames, history, () => 0, options);
        if (candidate.length !== groups.length) return;
        const score = candidate.reduce((sum, assignment) => sum + assignment._score, 0);
        if (score < bestScore) {
          bestScore = score;
          bestAssignments = candidate;
        }
        return;
      }

      const anchor = remaining[0];
      const rest = remaining.slice(1);
      const needed = groupSize - 1;
      const pickedIndexes = [];

      const choose = start => {
        if (pickedIndexes.length === needed) {
          const picked = new Set(pickedIndexes);
          const group = [anchor, ...pickedIndexes.map(index => rest[index])];
          const next = rest.filter((_, index) => !picked.has(index));
          visit(next, [...groups, group]);
          return;
        }
        const picksLeft = needed - pickedIndexes.length;
        for (let index = start; index <= rest.length - picksLeft; index += 1) {
          pickedIndexes.push(index);
          choose(index + 1);
          pickedIndexes.pop();
        }
      };

      choose(0);
    };

    visit(searchOrder, []);
    return bestAssignments;
  }

  function queueOrderedPlayers(active, lastQueue) {
    const byId = new Map(active.map(player => [String(player.id), player]));
    const seen = new Set();
    const ordered = [];
    (lastQueue || []).forEach(rawId => {
      const id = String(rawId);
      if (!seen.has(id) && byId.has(id)) {
        seen.add(id);
        ordered.push(byId.get(id));
      }
    });
    [...active]
      .sort((a, b) => a.seed_order - b.seed_order)
      .forEach(player => {
        const id = String(player.id);
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(player);
        }
      });
    return ordered;
  }

  function selectNextPlayers(queueIds, history, groupSize, style) {
    const queue = (queueIds || []).map(String);
    if (style !== 'winners_losers' || queue.length < groupSize) return queue.slice(0, groupSize);
    const pools = { winner: [], loser: [], new: [] };
    queue.forEach(id => {
      const outcome = history.lastOutcome[id];
      pools[outcome === 'winner' || outcome === 'loser' ? outcome : 'new'].push(id);
    });
    const frontOutcome = history.lastOutcome[queue[0]];
    const frontPool = pools[frontOutcome === 'winner' || frontOutcome === 'loser' ? frontOutcome : 'new'];
    const fifoGroup = queue.slice(0, groupSize);
    if (frontPool.length < groupSize) return fifoGroup;

    const outcomeGroup = frontPool.slice(0, groupSize);
    const playCount = history.playCount || {};
    const fairnessVector = ids => ids
      .map(id => Number(playCount[id]) || 0)
      .sort((a, b) => b - a);
    const fifoFairness = fairnessVector(fifoGroup);
    const outcomeFairness = fairnessVector(outcomeGroup);
    const fifoTotal = fifoFairness.reduce((sum, count) => sum + count, 0);
    const outcomeTotal = outcomeFairness.reduce((sum, count) => sum + count, 0);
    let outcomeIsNoWorse = outcomeTotal <= fifoTotal;
    for (let index = 0; index < outcomeFairness.length; index += 1) {
      if (outcomeFairness[index] === fifoFairness[index]) continue;
      outcomeIsNoWorse = outcomeIsNoWorse && outcomeFairness[index] < fifoFairness[index];
      break;
    }
    return outcomeIsNoWorse ? outcomeGroup : fifoGroup;
  }

  function winnerLoserGroups(queuePlayers, groupSize, courtCount, history) {
    let remaining = [...queuePlayers];
    const groups = [];
    while (groups.length < courtCount && remaining.length >= groupSize) {
      const selectedIds = selectNextPlayers(
        remaining.map(player => player.id),
        history,
        groupSize,
        'winners_losers'
      );
      const selected = new Set(selectedIds);
      groups.push(selectedIds.map(id => remaining.find(player => String(player.id) === String(id))));
      remaining = remaining.filter(player => !selected.has(String(player.id)));
    }
    return { groups, remaining };
  }

  function winnerLoserGroupsWithLocks(queuePlayers, groupSize, courtCount, history, locks) {
    let units = makeLockUnits(queuePlayers, locks);
    const groups = [];
    const outcomeOf = unit => {
      const outcomes = unit.players.map(player =>
        history.lastOutcome[String(player.id)] || 'new'
      );
      return outcomes.every(outcome => outcome === outcomes[0]) ? outcomes[0] : 'new';
    };

    while (groups.length < courtCount) {
      if (!pickQueueUnitIndexes(units, groupSize)) break;
      const frontOutcome = units.length ? outcomeOf(units[0]) : 'new';
      let pickedIndexes = pickCompatibleUnitIndexes(
        units,
        groupSize,
        selected => selected.every(unit => outcomeOf(unit) === frontOutcome),
        selected => selected.reduce((sum, unit) =>
          sum + unit.players.reduce((total, player) =>
            total + (history.playCount[String(player.id)] || 0), 0
          ), 0
        )
      );
      if (!pickedIndexes) pickedIndexes = pickQueueUnitIndexes(units, groupSize);
      if (!pickedIndexes) break;
      groups.push(flattenUnits(pickedIndexes.map(index => units[index])));
      units = removePickedUnits(units, pickedIndexes);
    }

    const playing = new Set(groups.flat().map(player => String(player.id)));
    return {
      groups,
      remaining: queuePlayers.filter(player => !playing.has(String(player.id))),
    };
  }

  function skillSeparatedGroups(queuePlayers, groupSize, courtCount, locks) {
    const picker = (units, size) => pickCompatibleUnitIndexes(
      units,
      size,
      selected => {
        const skills = selected.map(unit => unit.skill).filter(Boolean);
        return !skills.length || Math.max(...skills) - Math.min(...skills) <= 1;
      },
      selected => {
        const skills = selected.map(unit => unit.skill).filter(Boolean);
        if (!skills.length) return 0;
        return (Math.max(...skills) - Math.min(...skills)) * 100 +
          skills.reduce((sum, skill) => sum + Math.abs(
            skill - skills.reduce((total, value) => total + value, 0) / skills.length
          ), 0);
      }
    );
    return buildUnitGroups(queuePlayers, groupSize, courtCount, locks, picker);
  }

  function mixedDoublesGroups(queuePlayers, groupSize, courtCount, locks) {
    const picker = (units, size) => pickCompatibleUnitIndexes(
      units,
      size,
      selected => {
        const players = flattenUnits(selected);
        return players.filter(player => playerGender(player) === 'male').length === 2 &&
          players.filter(player => playerGender(player) === 'female').length === 2;
      },
      selected => {
        const skills = flattenUnits(selected).map(playerSkill);
        return Math.max(...skills) - Math.min(...skills);
      }
    );
    return buildUnitGroups(queuePlayers, groupSize, courtCount, locks, picker);
  }

  function skillCourtGroups(queuePlayers, groupSize, courtCount, locks) {
    const units = makeLockUnits(queuePlayers, locks);
    const buckets = Object.fromEntries(SKILL_BAND_ORDER.map(band => [band, []]));
    units.forEach(unit => {
      const band = skillBand(unit.skill);
      buckets[band].push(unit);
    });

    const bandGroups = {};
    SKILL_BAND_ORDER.forEach(band => {
      let remaining = buckets[band];
      bandGroups[band] = [];
      while (true) {
        const pickedIndexes = pickQueueUnitIndexes(remaining, groupSize);
        if (!pickedIndexes) break;
        bandGroups[band].push(flattenUnits(pickedIndexes.map(index => remaining[index])));
        remaining = removePickedUnits(remaining, pickedIndexes);
      }
    });

    const groups = [];
    const bands = [];
    let wave = 0;
    while (groups.length < courtCount) {
      let added = false;
      SKILL_BAND_ORDER.forEach(band => {
        if (groups.length >= courtCount || !bandGroups[band][wave]) return;
        groups.push(bandGroups[band][wave]);
        bands.push(band);
        added = true;
      });
      if (!added) break;
      wave += 1;
    }

    const playing = new Set(groups.flat().map(player => String(player.id)));
    return {
      groups,
      bands,
      waiting: queuePlayers.filter(player => !playing.has(String(player.id))),
    };
  }

  function kingCourtAssignments(queuePlayers, courtIds, courtNames, rounds, history, random, locks) {
    const last = rounds[rounds.length - 1];
    if (!last || !Array.isArray(last.assignments) || last.assignments.length !== courtIds.length) {
      return null;
    }
    const previous = courtIds.map(courtId =>
      last.assignments.find(game => String(game.courtId) === String(courtId))
    );
    if (previous.some(game => !game || !['A', 'B'].includes(game.winner))) return null;

    const byId = new Map(queuePlayers.map(player => [String(player.id), player]));
    const destinations = courtIds.map(() => []);
    previous.forEach((game, courtIndex) => {
      const winners = game.winner === 'A' ? game.teamA : game.teamB;
      const losers = game.winner === 'A' ? game.teamB : game.teamA;
      const winnerDestination = Math.max(0, courtIndex - 1);
      const loserDestination = Math.min(courtIds.length - 1, courtIndex + 1);
      (winners || []).forEach(id => {
        if (byId.has(String(id))) destinations[winnerDestination].push(byId.get(String(id)));
      });
      (losers || []).forEach(id => {
        if (byId.has(String(id))) destinations[loserDestination].push(byId.get(String(id)));
      });
    });
    if (destinations.some(group => group.length !== 4)) return null;

    const assignments = makeAssignments(
      destinations,
      courtIds,
      courtNames,
      history,
      random,
      {
        locks,
        assignmentMeta: courtIds.map((_, index) => ({ ladderRank: index + 1 })),
      }
    );
    if (assignments.length !== destinations.length) return null;
    const playing = new Set(destinations.flat().map(player => String(player.id)));
    return {
      assignments,
      waiting: queuePlayers.filter(player => !playing.has(String(player.id))),
    };
  }

  function clubWarAssignments(queuePlayers, courtIds, courtNames, locks) {
    const groupNames = [];
    queuePlayers.forEach(player => {
      const group = playerGroup(player);
      if (group && !groupNames.includes(group)) groupNames.push(group);
    });
    if (groupNames.length < 2) return { assignments: [], waiting: queuePlayers };
    const [groupAName, groupBName] = groupNames;
    let groupAUnits = makeLockUnits(
      queuePlayers.filter(player => playerGroup(player) === groupAName),
      locks
    );
    let groupBUnits = makeLockUnits(
      queuePlayers.filter(player => playerGroup(player) === groupBName),
      locks
    );
    const assignments = [];
    for (let index = 0; index < courtIds.length; index += 1) {
      const groupAIndexes = pickQueueUnitIndexes(groupAUnits, 2);
      const groupBIndexes = pickQueueUnitIndexes(groupBUnits, 2);
      if (!groupAIndexes || !groupBIndexes) break;
      const teamAPlayers = flattenUnits(groupAIndexes.map(unitIndex => groupAUnits[unitIndex]));
      const teamBPlayers = flattenUnits(groupBIndexes.map(unitIndex => groupBUnits[unitIndex]));
      const courtId = courtIds[index];
      assignments.push({
        courtId,
        courtName: courtNames[String(courtId)] || `Court ${index + 1}`,
        teamA: teamAPlayers.map(player => String(player.id)),
        teamB: teamBPlayers.map(player => String(player.id)),
        teamAName: groupAName,
        teamBName: groupBName,
      });
      groupAUnits = removePickedUnits(groupAUnits, groupAIndexes);
      groupBUnits = removePickedUnits(groupBUnits, groupBIndexes);
    }
    const playing = new Set(assignments.flatMap(game => [...game.teamA, ...game.teamB]));
    return {
      assignments,
      waiting: queuePlayers.filter(player => !playing.has(String(player.id))),
    };
  }

  function fixedTournamentTeams(players, locks) {
    const units = makeLockUnits(players, locks);
    const teams = [];
    const singles = [];
    units.forEach(unit => {
      if (unit.players.length === 2) {
        teams.push({ players: unit.players, firstIndex: unit.firstIndex });
      } else {
        singles.push(unit);
      }
    });
    for (let index = 0; index + 1 < singles.length; index += 2) {
      teams.push({
        players: [singles[index].players[0], singles[index + 1].players[0]],
        firstIndex: Math.min(singles[index].firstIndex, singles[index + 1].firstIndex),
      });
    }
    return teams.sort((a, b) =>
      a.firstIndex - b.firstIndex ||
      String(a.players[0].id).localeCompare(String(b.players[0].id))
    );
  }

  function roundRobinRounds(teams) {
    if (teams.length < 2) return [];
    const rotation = [...teams];
    if (rotation.length % 2) rotation.push(null);
    const rounds = [];
    for (let roundIndex = 0; roundIndex < rotation.length - 1; roundIndex += 1) {
      const fixtures = [];
      for (let index = 0; index < rotation.length / 2; index += 1) {
        const left = rotation[index];
        const right = rotation[rotation.length - 1 - index];
        if (left && right) fixtures.push([left, right]);
      }
      rounds.push(fixtures);
      rotation.splice(1, 0, rotation.pop());
    }
    return rounds;
  }

  function tournamentAssignments(players, queuePlayers, courtIds, courtNames, rounds, locks) {
    if (!courtIds.length) return { assignments: [], waiting: queuePlayers };
    const teams = fixedTournamentTeams(
      [...players].sort((a, b) =>
        a.seed_order - b.seed_order || String(a.id).localeCompare(String(b.id))
      ),
      locks
    );
    const scheduleRounds = roundRobinRounds(teams);
    const waves = [];
    scheduleRounds.forEach((fixtures, roundIndex) => {
      for (let offset = 0; offset < fixtures.length; offset += courtIds.length) {
        waves.push({
          tournamentRound: roundIndex + 1,
          fixtures: fixtures.slice(offset, offset + courtIds.length),
        });
      }
    });
    const wave = waves[rounds.length];
    if (!wave) return { assignments: [], waiting: queuePlayers };
    const assignments = wave.fixtures.map(([teamA, teamB], index) => {
      const courtId = courtIds[index];
      return {
        courtId,
        courtName: courtNames[String(courtId)] || `Court ${index + 1}`,
        teamA: teamA.players.map(player => String(player.id)),
        teamB: teamB.players.map(player => String(player.id)),
        tournamentRound: wave.tournamentRound,
        fixtureNumber: index + 1,
      };
    });
    const playing = new Set(assignments.flatMap(game => [...game.teamA, ...game.teamB]));
    return {
      assignments,
      waiting: queuePlayers.filter(player => !playing.has(String(player.id))),
    };
  }

  function generateAssignments(options) {
    const active = (options.active || []).map(normalizePlayer);
    const courtIds = (options.courtIds || []).map(String);
    const courtNames = options.courtNames || {};
    const rounds = options.rounds || [];
    const format = VALID_FORMATS.has(options.format) ? options.format : 'doubles';
    const requestedStyle = VALID_STYLES.has(options.style) ? options.style : 'balanced';
    const style = format === 'singles' && DOUBLES_ONLY_STYLES.has(requestedStyle)
      ? 'balanced'
      : requestedStyle;
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const history = buildHistory(rounds);
    const groupSize = playersPerGame(format);
    const courtCount = Math.min(courtIds.length, Math.floor(active.length / groupSize));
    const playSlots = courtCount * groupSize;
    const lastQueue = rounds.length
      ? (rounds[rounds.length - 1].queue_snapshot || []).map(String)
      : active.map(player => player.id);
    const queueOrder = queueOrderedPlayers(active, lastQueue);
    const locks = buildLockMap(active, style, format);

    if (!courtCount) {
      return {
        assignments: [],
        queueSnapshot: queueOrder.map(player => player.id),
        partnerHistory: history.partner,
        opponentHistory: history.opponent,
      };
    }

    const queueIndex = {};
    queueOrder.forEach((player, index) => { queueIndex[player.id] = index; });

    let rotationOrder = queueOrder;
    let waiting = [];
    let bestAssignments = [];
    if (style === 'tournament') {
      const selected = tournamentAssignments(
        active,
        queueOrder,
        courtIds,
        courtNames,
        rounds,
        locks
      );
      waiting = selected.waiting;
      bestAssignments = selected.assignments;
    } else if (style === 'club_wars') {
      const selected = clubWarAssignments(queueOrder, courtIds, courtNames, locks);
      waiting = selected.waiting;
      bestAssignments = selected.assignments;
    } else if (style === 'king_court') {
      const selected = kingCourtAssignments(
        queueOrder,
        courtIds,
        courtNames,
        rounds,
        history,
        random,
        locks
      );
      if (selected) {
        waiting = selected.waiting;
        bestAssignments = selected.assignments;
      } else {
        const seeded = buildUnitGroups(queueOrder, groupSize, courtCount, locks);
        waiting = seeded.waiting;
        bestAssignments = makeAssignments(
          seeded.groups,
          courtIds,
          courtNames,
          history,
          random,
          { locks }
        );
      }
    } else if (style === 'adaptive_competitive') {
      rotationOrder = [...active].sort((a, b) =>
        (history.playCount[a.id] || 0) - (history.playCount[b.id] || 0) ||
        (queueIndex[a.id] ?? 999999) - (queueIndex[b.id] ?? 999999) ||
        a.seed_order - b.seed_order
      );
      const mustPlay = rotationOrder.slice(0, playSlots);
      waiting = rotationOrder.slice(playSlots);
      const adaptiveOptions = { locks, adaptive: true };
      if (mustPlay.length <= 8 && !locks.size) {
        bestAssignments = exactBalancedAssignments(
          mustPlay,
          groupSize,
          courtIds,
          courtNames,
          history,
          random,
          adaptiveOptions
        );
      } else if (locks.size) {
        const selected = buildUnitGroups(mustPlay, groupSize, courtCount, locks);
        waiting = [...selected.waiting, ...waiting];
        bestAssignments = makeAssignments(
          selected.groups,
          courtIds,
          courtNames,
          history,
          random,
          adaptiveOptions
        );
      } else {
        let bestScore = Number.POSITIVE_INFINITY;
        const candidates = [];
        const samples = Math.max(360, Math.min(960, active.length * 48));
        for (let sample = 0; sample < samples; sample += 1) {
          const candidate = makeAssignments(
            groupsOf(shuffle(mustPlay, random), groupSize),
            courtIds,
            courtNames,
            history,
            random,
            adaptiveOptions
          );
          const score = candidate.reduce((sum, assignment) => sum + assignment._score, 0);
          if (score < bestScore) bestScore = score;
          candidates.push({ candidate, score });
        }
        const tolerance = Math.max(1, Math.abs(bestScore) * .03);
        const nearBest = candidates.filter(item => item.score <= bestScore + tolerance);
        const selectedIndex = Math.min(
          nearBest.length - 1,
          Math.floor(random() * Math.max(1, nearBest.length))
        );
        bestAssignments = nearBest[Math.max(0, selectedIndex)]?.candidate || [];
      }
    } else if (style === 'skill_separated') {
      const selected = skillSeparatedGroups(queueOrder, groupSize, courtCount, locks);
      waiting = selected.waiting;
      bestAssignments = makeAssignments(
        selected.groups,
        courtIds,
        courtNames,
        history,
        random,
        { locks, skillWeight: 30 }
      );
    } else if (style === 'mixed_doubles') {
      const selected = mixedDoublesGroups(queueOrder, groupSize, courtCount, locks);
      waiting = selected.waiting;
      bestAssignments = makeAssignments(
        selected.groups,
        courtIds,
        courtNames,
        history,
        random,
        { locks, requireMixed: true, skillWeight: 30 }
      );
    } else if (style === 'skill_courts') {
      const selected = skillCourtGroups(queueOrder, groupSize, courtCount, locks);
      waiting = selected.waiting;
      bestAssignments = makeAssignments(
        selected.groups,
        courtIds,
        courtNames,
        history,
        random,
        {
          locks,
          skillWeight: 30,
          assignmentMeta: selected.bands.map(band => ({ skillBand: band })),
        }
      );
    } else if (style === 'queue') {
      if (locks.size) {
        const selected = buildUnitGroups(queueOrder, groupSize, courtCount, locks);
        waiting = selected.waiting;
        bestAssignments = makeAssignments(
          selected.groups,
          courtIds,
          courtNames,
          history,
          random,
          { locks }
        );
      } else {
        const mustPlay = queueOrder.slice(0, playSlots);
        waiting = queueOrder.slice(playSlots);
        bestAssignments = makeAssignments(
          groupsOf(mustPlay, groupSize),
          courtIds,
          courtNames,
          history,
          random
        );
      }
    } else if (style === 'winners_losers') {
      const selected = locks.size
        ? winnerLoserGroupsWithLocks(queueOrder, groupSize, courtCount, history, locks)
        : winnerLoserGroups(queueOrder, groupSize, courtCount, history);
      waiting = selected.remaining;
      bestAssignments = makeAssignments(
        selected.groups,
        courtIds,
        courtNames,
        history,
        random,
        { locks }
      );
    } else {
      rotationOrder = [...active].sort((a, b) =>
        (history.playCount[a.id] || 0) - (history.playCount[b.id] || 0) ||
        (queueIndex[a.id] ?? 999999) - (queueIndex[b.id] ?? 999999) ||
        a.seed_order - b.seed_order
      );
      if (locks.size) {
        const selected = buildUnitGroups(rotationOrder, groupSize, courtCount, locks);
        waiting = selected.waiting;
        bestAssignments = makeAssignments(
          selected.groups,
          courtIds,
          courtNames,
          history,
          random,
          { locks }
        );
      } else {
        const mustPlay = rotationOrder.slice(0, playSlots);
        waiting = rotationOrder.slice(playSlots);
        if (mustPlay.length <= 8) {
          bestAssignments = exactBalancedAssignments(
            mustPlay,
            groupSize,
            courtIds,
            courtNames,
            history,
            random
          );
        } else {
          let bestScore = Number.POSITIVE_INFINITY;
          const samples = Math.max(120, Math.min(420, active.length * 24));
          for (let sample = 0; sample < samples; sample += 1) {
            const candidate = makeAssignments(
              groupsOf(shuffle(mustPlay, random), groupSize),
              courtIds,
              courtNames,
              history,
              random
            );
            const score = candidate.reduce((sum, assignment) => sum + assignment._score, 0);
            if (score < bestScore) {
              bestScore = score;
              bestAssignments = candidate;
            }
          }
        }
      }
    }

    const assignments = bestAssignments.map(({ _score, ...assignment }) => assignment);
    const playingIds = new Set(assignments.flatMap(game => [...game.teamA, ...game.teamB]));
    const queueSnapshot = [
      ...waiting.map(player => player.id),
      ...rotationOrder.filter(player => playingIds.has(player.id)).map(player => player.id),
    ];
    const nextHistory = buildHistory([
      ...rounds,
      { round_no: rounds.length + 1, assignments },
    ]);

    return {
      assignments,
      queueSnapshot,
      partnerHistory: nextHistory.partner,
      opponentHistory: nextHistory.opponent,
    };
  }

  function queueWaitLabel(index, courtCount, format) {
    const safeCourts = Math.max(1, Number(courtCount) || 1);
    const waveSize = safeCourts * playersPerGame(format);
    const rotation = Math.floor(Math.max(0, index) / waveSize) + 1;
    if (rotation === 1) return 'next rotation';
    return `about ${rotation} rotations`;
  }

  return {
    buildHistory,
    bestSplit,
    encodeMode,
    generateAssignments,
    pairKey,
    parseMode,
    playersPerGame,
    queueWaitLabel,
    selectNextPlayers,
  };
});
