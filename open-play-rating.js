(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.PBOpenPlayRating = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "pr-performance-v1";
  const RANKING_MODE_PERFORMANCE = "performance";
  const RANKING_MODE_WIN_PERCENTAGE = "win_percentage";
  const RANKING_MODE_COMPETITIVE = "competitive";
  const K_FACTOR = 24;
  const RATING_SCALE = 400;
  const MIN_PODIUM_GAMES = 2;
  const DEFAULT_SKILL_LEVEL = 1;
  const BASE_RATING = 1000;
  const SKILL_STEP = 100;

  const asId = value => String(value ?? "");
  const roundOne = value => Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  const numeric = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  function normalizeRankingMode(value) {
    if (value === RANKING_MODE_WIN_PERCENTAGE) return RANKING_MODE_WIN_PERCENTAGE;
    if (value === RANKING_MODE_COMPETITIVE) return RANKING_MODE_COMPETITIVE;
    return RANKING_MODE_PERFORMANCE;
  }

  function winRatioKey(wins, games) {
    const safeWins = Math.max(0, Math.floor(numeric(wins)));
    const safeGames = Math.max(0, Math.floor(numeric(games)));
    if (!safeGames || !safeWins) return safeWins ? `${safeWins}/0` : "0/1";
    let left = safeWins;
    let right = safeGames;
    while (right) {
      const remainder = left % right;
      left = right;
      right = remainder;
    }
    return `${safeWins / left}/${safeGames / left}`;
  }

  function normalizeSkillLevel(value) {
    const level = Number(value);
    return Number.isInteger(level) && level >= 1 && level <= 6
      ? level
      : DEFAULT_SKILL_LEVEL;
  }

  function seedRating(skillLevel) {
    return BASE_RATING + (normalizeSkillLevel(skillLevel) - 1) * SKILL_STEP;
  }

  function expectedScore(teamRating, opponentRating) {
    return 1 / (1 + Math.pow(10, (numeric(opponentRating) - numeric(teamRating)) / RATING_SCALE));
  }

  function matchDelta(teamRating, opponentRating, won) {
    const raw = K_FACTOR * ((won ? 1 : 0) - expectedScore(teamRating, opponentRating));
    if (!raw) return 0;
    const magnitude = Math.min(K_FACTOR - 1, Math.max(1, Math.round(Math.abs(raw))));
    return raw > 0 ? magnitude : -magnitude;
  }

  function exactMatchDelta(teamRating, opponentRating, won) {
    return K_FACTOR * ((won ? 1 : 0) - expectedScore(teamRating, opponentRating));
  }

  function compareWinRates(left, right) {
    return (
      numeric(right?.wins) * Math.max(1, numeric(left?.games)) -
      numeric(left?.wins) * Math.max(1, numeric(right?.games))
    );
  }

  function compareHeadToHead(left, right) {
    const leftGames = Math.max(0, numeric(left?.headToHeadGames));
    const rightGames = Math.max(0, numeric(right?.headToHeadGames));
    const leftWins = Math.max(0, numeric(left?.headToHeadWins));
    const rightWins = Math.max(0, numeric(right?.headToHeadWins));
    if (!leftGames && !rightGames) return 0;
    if (!leftGames) return 1;
    if (!rightGames) return -1;
    return (
      rightWins * leftGames - leftWins * rightGames ||
      rightWins - leftWins
    );
  }

  function competitiveCriterion(left, right) {
    if (numeric(left?.pointsExact) !== numeric(right?.pointsExact)) {
      return "performance_points";
    }
    if (compareWinRates(left, right)) return "win_percentage";
    if (numeric(left?.wins) !== numeric(right?.wins)) return "wins";
    if (compareHeadToHead(left, right)) return "head_to_head";
    if (
      numeric(left?.averageOpponentRatingExact) !==
      numeric(right?.averageOpponentRatingExact)
    ) return "opponent_strength";
    if (numeric(left?.bestUpsetExact) !== numeric(right?.bestUpsetExact)) {
      return "quality_win";
    }
    return null;
  }

  function competitiveReason(criterion) {
    return ({
      performance_points: "Exact Performance Points",
      win_percentage: "Win percentage tiebreak",
      wins: "Wins tiebreak",
      head_to_head: "Head-to-head tiebreak",
      opponent_strength: "Opponent strength tiebreak",
      quality_win: "Best upset tiebreak",
      podium_decider: "Podium decider required",
    })[criterion] || "";
  }

  function compareCompetitive(left, right) {
    return (
      numeric(right?.pointsExact) - numeric(left?.pointsExact) ||
      compareWinRates(left, right) ||
      numeric(right?.wins) - numeric(left?.wins) ||
      compareHeadToHead(left, right) ||
      numeric(right?.averageOpponentRatingExact) -
        numeric(left?.averageOpponentRatingExact) ||
      numeric(right?.bestUpsetExact) - numeric(left?.bestUpsetExact)
    );
  }

  function sameCompetitiveEvidence(left, right) {
    return compareCompetitive(left, right) === 0;
  }

  function matchSortValue(match) {
    const parsed = Date.parse(match?.resultAt || "");
    return Number.isFinite(parsed) ? parsed : null;
  }

  function chronologicalMatches(matches) {
    return (Array.isArray(matches) ? matches : [])
      .filter(match => {
        if (
          !match ||
          !["A", "B"].includes(match.winner) ||
          !Array.isArray(match.teamA) ||
          !Array.isArray(match.teamB) ||
          match.teamA.length !== 2 ||
          match.teamB.length !== 2
        ) return false;
        const playerIds = [...match.teamA, ...match.teamB].map(asId);
        return playerIds.every(Boolean) && new Set(playerIds).size === 4;
      })
      .map((match, inputIndex) => ({ match, inputIndex, time: matchSortValue(match) }))
      .sort((left, right) => {
        if (left.time !== null && right.time !== null && left.time !== right.time) {
          return left.time - right.time;
        }
        if ((left.time === null) !== (right.time === null)) {
          return left.time === null ? 1 : -1;
        }
        return (
          numeric(left.match.roundNo) - numeric(right.match.roundNo) ||
          numeric(left.match.courtIndex) - numeric(right.match.courtIndex) ||
          (left.match.completedGameIndex == null
            ? Number.MAX_SAFE_INTEGER
            : numeric(left.match.completedGameIndex, Number.MAX_SAFE_INTEGER)) -
            (right.match.completedGameIndex == null
              ? Number.MAX_SAFE_INTEGER
              : numeric(right.match.completedGameIndex, Number.MAX_SAFE_INTEGER)) ||
          numeric(left.match.sequence, left.inputIndex) -
            numeric(right.match.sequence, right.inputIndex) ||
          String(left.match.matchId || "").localeCompare(String(right.match.matchId || "")) ||
          left.inputIndex - right.inputIndex
        );
      })
      .map(entry => entry.match);
  }

  function calculateStandings(players, matches, options = {}) {
    const minGames = Math.max(1, Math.floor(numeric(options.minGames, MIN_PODIUM_GAMES)));
    const mode = normalizeRankingMode(options.mode);
    const records = new Map();

    (Array.isArray(players) ? players : []).forEach((player, index) => {
      const id = asId(player?.id ?? player?.player_id ?? player?.name ?? index);
      if (!id || records.has(id)) return;
      const storedSeed = numeric(
        player?.performance_seed_rating ?? player?.rating_start ?? player?.ratingStart,
        NaN
      );
      const startingRating = Number.isFinite(storedSeed)
        ? storedSeed
        : seedRating(player?.skill_level ?? player?.skillLevel);
      records.set(id, {
        id,
        name: String(player?.full_name ?? player?.name ?? "Player"),
        seedOrder: numeric(player?.seed_order ?? player?.seedOrder, index),
        skillLevel: normalizeSkillLevel(player?.skill_level ?? player?.skillLevel),
        seedRating: startingRating,
        ratingExact: startingRating,
        pointsExact: 0,
        games: 0,
        wins: 0,
        opponentRatingTotal: 0,
        bestUpset: 0,
        headToHead: new Map(),
      });
    });

    const ensureRecord = idValue => {
      const id = asId(idValue);
      return id ? records.get(id) || null : null;
    };

    chronologicalMatches(matches).forEach(match => {
      const teamA = match.teamA.map(ensureRecord);
      const teamB = match.teamB.map(ensureRecord);
      if (teamA.some(record => !record) || teamB.some(record => !record)) return;

      const teamARating = (teamA[0].ratingExact + teamA[1].ratingExact) / 2;
      const teamBRating = (teamB[0].ratingExact + teamB[1].ratingExact) / 2;
      const aWon = match.winner === "A";
      const deltaA = mode === RANKING_MODE_COMPETITIVE
        ? exactMatchDelta(teamARating, teamBRating, aWon)
        : mode === RANKING_MODE_PERFORMANCE
          ? matchDelta(teamARating, teamBRating, aWon)
          : 0;
      const deltaB = mode === RANKING_MODE_COMPETITIVE
        ? -deltaA
        : roundOne(-deltaA);
      const tracksPerformance = mode !== RANKING_MODE_WIN_PERCENTAGE;
      const upsetA = tracksPerformance && aWon
        ? Math.max(0, teamBRating - teamARating)
        : 0;
      const upsetB = tracksPerformance && !aWon
        ? Math.max(0, teamARating - teamBRating)
        : 0;

      teamA.forEach(record => {
        record.games += 1;
        if (aWon) record.wins += 1;
        record.opponentRatingTotal += teamBRating;
        record.bestUpset = Math.max(record.bestUpset, upsetA);
        record.pointsExact += deltaA;
        record.ratingExact += deltaA;
        teamB.forEach(opponent => {
          const result = record.headToHead.get(opponent.id) || { games: 0, wins: 0 };
          result.games += 1;
          if (aWon) result.wins += 1;
          record.headToHead.set(opponent.id, result);
        });
      });

      teamB.forEach(record => {
        record.games += 1;
        if (!aWon) record.wins += 1;
        record.opponentRatingTotal += teamARating;
        record.bestUpset = Math.max(record.bestUpset, upsetB);
        record.pointsExact += deltaB;
        record.ratingExact += deltaB;
        teamA.forEach(opponent => {
          const result = record.headToHead.get(opponent.id) || { games: 0, wins: 0 };
          result.games += 1;
          if (!aWon) result.wins += 1;
          record.headToHead.set(opponent.id, result);
        });
      });
    });

    const scored = [...records.values()]
      .map(record => {
        const points = roundOne(record.pointsExact);
        const rating = roundOne(record.ratingExact);
        const winRate = record.games ? record.wins / record.games : 0;
        const winPercentage = roundOne(winRate * 100);
        const averageOpponentRatingExact = record.games
          ? record.opponentRatingTotal / record.games
          : 0;
        const averageOpponentRating = roundOne(averageOpponentRatingExact);
        const bestUpsetExact = record.bestUpset;
        const bestUpset = roundOne(record.bestUpset);
        return {
          id: record.id,
          name: record.name,
          seedOrder: record.seedOrder,
          skillLevel: record.skillLevel,
          seedRating: record.seedRating,
          rating,
          ratingExact: record.ratingExact,
          points,
          pointsExact: record.pointsExact,
          mode,
          games: record.games,
          wins: record.wins,
          losses: Math.max(0, record.games - record.wins),
          winRate,
          winPercentage,
          averageOpponentRating,
          averageOpponentRatingExact,
          bestUpset,
          bestUpsetExact,
          headToHeadGames: 0,
          headToHeadWins: 0,
          headToHeadLosses: 0,
          headToHeadPercentage: 0,
          eligible: record.games >= minGames,
          gamesNeeded: Math.max(0, minGames - record.games),
        };
      });

    if (mode === RANKING_MODE_COMPETITIVE) {
      const tiedGroups = new Map();
      scored.forEach(row => {
        const key = [
          row.eligible ? "qualified" : "provisional",
          row.pointsExact,
          winRatioKey(row.wins, row.games),
          row.wins,
        ].join("|");
        const group = tiedGroups.get(key) || [];
        group.push(row);
        tiedGroups.set(key, group);
      });
      tiedGroups.forEach(group => {
        if (group.length < 2) return;
        const peerIds = new Set(group.map(row => row.id));
        group.forEach(row => {
          const source = records.get(row.id);
          source?.headToHead?.forEach((result, opponentId) => {
            if (!peerIds.has(opponentId)) return;
            row.headToHeadGames += numeric(result?.games);
            row.headToHeadWins += numeric(result?.wins);
          });
          row.headToHeadLosses = Math.max(
            0,
            row.headToHeadGames - row.headToHeadWins
          );
          row.headToHeadPercentage = row.headToHeadGames
            ? roundOne((row.headToHeadWins / row.headToHeadGames) * 100)
            : 0;
        });
      });
    }

    const sorted = scored.sort((left, right) => {
        const eligibility = Number(right.eligible) - Number(left.eligible);
        if (eligibility) return eligibility;
        if (mode === RANKING_MODE_COMPETITIVE) {
          return (
            compareCompetitive(left, right) ||
            left.seedOrder - right.seedOrder ||
            left.id.localeCompare(right.id)
          );
        }
        if (mode === RANKING_MODE_WIN_PERCENTAGE) {
          return (
            compareWinRates(left, right) ||
            right.wins - left.wins ||
            left.seedOrder - right.seedOrder ||
            left.id.localeCompare(right.id)
          );
        }
        return (
          right.points - left.points ||
          right.averageOpponentRating - left.averageOpponentRating ||
          right.bestUpset - left.bestUpset ||
          left.seedOrder - right.seedOrder ||
          left.id.localeCompare(right.id)
        );
      });
    let qualifiedPosition = 0;
    let previousPerformanceKey = "";
    let previousCompetitiveRecord = null;
    let previousRank = null;
    const ranked = sorted.map((record, index) => {
      const rank = (() => {
        if (!record.eligible) return null;
        qualifiedPosition += 1;
        if (mode === RANKING_MODE_COMPETITIVE) {
          if (
            !previousCompetitiveRecord ||
            !sameCompetitiveEvidence(record, previousCompetitiveRecord)
          ) {
            previousRank = qualifiedPosition;
          }
          previousCompetitiveRecord = record;
          return previousRank;
        }
        const performanceKey = mode === RANKING_MODE_WIN_PERCENTAGE
          ? [
              winRatioKey(record.wins, record.games),
              record.wins,
            ].join("|")
          : [
              record.points,
              record.averageOpponentRating,
              record.bestUpset,
            ].join("|");
        if (performanceKey !== previousPerformanceKey) {
          previousRank = qualifiedPosition;
          previousPerformanceKey = performanceKey;
        }
        return previousRank;
      })();
      return {
        ...record,
        position: index + 1,
        rank,
      };
    });

    if (mode !== RANKING_MODE_COMPETITIVE) return ranked;

    const eligibleRows = ranked.filter(record => record.eligible);
    const identicalGroups = new Map();
    eligibleRows.forEach(record => {
      const group = identicalGroups.get(record.rank) || [];
      group.push(record);
      identicalGroups.set(record.rank, group);
    });

    return ranked.map(record => {
      if (!record.eligible) {
        return {
          ...record,
          rankCriterion: null,
          rankReason: "",
          tieBreakReason: null,
          requiresPodiumDecider: false,
          podiumDeciderGroupId: null,
          podiumDeciderPlayerIds: [],
        };
      }

      const identicalGroup = identicalGroups.get(record.rank) || [record];
      const isIdenticalTie = identicalGroup.length > 1;
      const requiresPodiumDecider = isIdenticalTie && Number(record.rank) <= 3;
      const deciderGroupId = requiresPodiumDecider
        ? `podium-decider-rank-${record.rank}`
        : null;

      if (isIdenticalTie) {
        const criterion = requiresPodiumDecider
          ? "podium_decider"
          : "identical_record";
        return {
          ...record,
          rankCriterion: criterion,
          rankReason: requiresPodiumDecider
            ? competitiveReason(criterion)
            : "Identical competitive record",
          tieBreakReason: requiresPodiumDecider
            ? competitiveReason(criterion)
            : null,
          requiresPodiumDecider,
          podiumDeciderGroupId: deciderGroupId,
          podiumDeciderPlayerIds: requiresPodiumDecider
            ? identicalGroup.map(player => player.id)
            : [],
        };
      }

      const eligibleIndex = eligibleRows.findIndex(player => player.id === record.id);
      const previous = eligibleRows[eligibleIndex - 1] || null;
      const next = eligibleRows[eligibleIndex + 1] || null;
      const samePointsPeer = previous?.pointsExact === record.pointsExact
        ? previous
        : next?.pointsExact === record.pointsExact
          ? next
          : null;
      const criterion = samePointsPeer
        ? competitiveCriterion(record, samePointsPeer)
        : "performance_points";
      const reason = competitiveReason(criterion);

      return {
        ...record,
        rankCriterion: criterion,
        rankReason: reason,
        tieBreakReason: criterion && criterion !== "performance_points"
          ? reason
          : null,
        requiresPodiumDecider: false,
        podiumDeciderGroupId: null,
        podiumDeciderPlayerIds: [],
      };
    });
  }

  function podiumRows(rows, limit = 3) {
    return (Array.isArray(rows) ? rows : [])
      .filter(row => row?.eligible && Number(row.rank) <= Math.max(0, Number(limit) || 0));
  }

  return Object.freeze({
    VERSION,
    RANKING_MODE_PERFORMANCE,
    RANKING_MODE_WIN_PERCENTAGE,
    RANKING_MODE_COMPETITIVE,
    K_FACTOR,
    RATING_SCALE,
    MIN_PODIUM_GAMES,
    BASE_RATING,
    SKILL_STEP,
    normalizeSkillLevel,
    normalizeRankingMode,
    winRatioKey,
    seedRating,
    expectedScore,
    matchDelta,
    exactMatchDelta,
    compareWinRates,
    compareHeadToHead,
    competitiveCriterion,
    compareCompetitive,
    chronologicalMatches,
    calculateStandings,
    podiumRows,
  });
});
