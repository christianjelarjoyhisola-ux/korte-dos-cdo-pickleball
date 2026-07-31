(() => {
  "use strict";

  const state = {
    courts: [],
    sessions: [],
    session: null,
    players: [],
    rounds: [],
    view: "setup",
    initialized: false,
    loading: false,
    displayMode: false,
    displayModeRevision: 0,
    prefill: null,
    replacement: null,
    replacementTrigger: null,
    lineupSelection: null,
    lineupTrigger: null,
    winnerCorrection: null,
    winnerCorrectionTrigger: null,
    playerEditor: null,
    playerEditorTrigger: null,
    shareToken: null,
    shareSessionId: null,
    shareTrigger: null,
    toastTimer: null,
    clockTimer: null,
  };

  const SHARE_TOKEN_STORE = "korte_dos_play_manager_share_tokens_v1";
  const DEFAULT_SKILL_LEVEL = 1;
  const PERFORMANCE = window.PBOpenPlayRating;
  const ROTATION = window.OpenPlayRotation;
  const ADAPTIVE_COMPETITIVE_MODE = "adaptive_competitive_mixer";
  const RANKING_MODE_PERFORMANCE = PERFORMANCE?.RANKING_MODE_PERFORMANCE || "performance";
  const RANKING_MODE_WIN_PERCENTAGE = PERFORMANCE?.RANKING_MODE_WIN_PERCENTAGE || "win_percentage";
  const RANKING_MODE_COMPETITIVE = PERFORMANCE?.RANKING_MODE_COMPETITIVE || "competitive";
  const SKILL_LEVELS = [
    { value: 1, label: "Beginner" },
    { value: 2, label: "Advanced Beginner" },
    { value: 3, label: "Intermediate" },
    { value: 4, label: "Advanced Intermediate" },
    { value: 5, label: "Advanced" },
    { value: 6, label: "Expert" },
  ];
  const root = () => document.getElementById("playManagerRoot");
  const asId = value => String(value ?? "");
  const unique = values => [...new Set(values.map(asId).filter(Boolean))];
  const createMatchId = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function formatSessionPoints(value, suffix = "") {
    const points = Number(value || 0);
    const absolute = Math.abs(points).toFixed(1).replace(/\.0$/, "");
    const signed = points > 0 ? `+${absolute}` : points < 0 ? `−${absolute}` : "0";
    return suffix ? `${signed} ${suffix}` : signed;
  }

  function performanceTone(value) {
    const points = Number(value || 0);
    return points > 0 ? "is-positive" : points < 0 ? "is-negative" : "is-neutral";
  }

  function normalizeRankingMode(value) {
    return PERFORMANCE?.normalizeRankingMode
      ? PERFORMANCE.normalizeRankingMode(value)
      : (value === RANKING_MODE_COMPETITIVE
          ? RANKING_MODE_COMPETITIVE
          : value === RANKING_MODE_WIN_PERCENTAGE
          ? RANKING_MODE_WIN_PERCENTAGE
          : RANKING_MODE_PERFORMANCE);
  }

  function sessionRankingMode(session = state.session) {
    return normalizeRankingMode(session?.ranking_mode ?? session?.rankingMode);
  }

  function isWinPercentageMode(mode = sessionRankingMode()) {
    return normalizeRankingMode(mode) === RANKING_MODE_WIN_PERCENTAGE;
  }

  function isCompetitiveMode(mode = sessionRankingMode()) {
    return normalizeRankingMode(mode) === RANKING_MODE_COMPETITIVE;
  }

  function isAdaptiveCompetitiveRotation(session = state.session) {
    return String(session?.mode || "") === ADAPTIVE_COMPETITIVE_MODE;
  }

  function formatWinPercentage(value) {
    const percentage = Number(value || 0);
    return `${percentage.toFixed(1).replace(/\.0$/, "")}%`;
  }

  function formatCompetitivePoints(row, suffix = "") {
    const points = Number(row?.pointsExact ?? row?.points ?? 0);
    const absolute = Math.abs(points).toFixed(2).replace(/\.?0+$/, "");
    const signed = points > 0 ? `+${absolute}` : points < 0 ? `−${absolute}` : "0";
    return suffix ? `${signed} ${suffix}` : signed;
  }

  function standingDisplay(row) {
    if (isCompetitiveMode(row?.mode)) {
      const wins = Number(row?.wins || 0);
      const losses = Number(row?.losses ?? Math.max(0, Number(row?.games || 0) - wins));
      return {
        score: formatCompetitivePoints(row),
        compactScore: formatCompetitivePoints(row, "pts"),
        aria: `${formatCompetitivePoints(row, "exact Performance Points")}, ${formatWinPercentage(row?.winPercentage)} win percentage`,
        label: "PTS",
        meta: `${formatWinPercentage(row?.winPercentage)} · ${wins}W-${losses}L`,
        detail: `Opponent strength ${Math.round(Number(row?.averageOpponentRating || 0))}`,
        tone: performanceTone(row?.pointsExact ?? row?.points),
      };
    }
    if (isWinPercentageMode(row?.mode)) {
      const wins = Number(row?.wins || 0);
      const losses = Number(row?.losses ?? Math.max(0, Number(row?.games || 0) - wins));
      const percentage = formatWinPercentage(row?.winPercentage);
      return {
        score: percentage,
        compactScore: percentage,
        aria: `${percentage} win percentage`,
        label: "WIN %",
        meta: `${wins}W-${losses}L`,
        tone: Number(row?.games || 0) === 0
          ? "is-neutral"
          : Number(row?.winPercentage || 0) >= 50
            ? "is-positive"
            : "is-negative",
      };
    }
    return {
      score: formatSessionPoints(row?.points),
      compactScore: formatSessionPoints(row?.points, "pts"),
      aria: formatSessionPoints(row?.points, "Session Points"),
      label: "PTS",
      meta: `PR ${Math.round(Number(row?.rating || 0))}`,
      tone: performanceTone(row?.points),
    };
  }

  function requiresPodiumDecider(row) {
    return Boolean(row?.requiresPodiumDecider);
  }

  function standingRankLabel(row) {
    if (!row?.eligible) return "P";
    if (requiresPodiumDecider(row)) return "TBD";
    if (row?.sharedRank) return `T${row.rank}`;
    return row?.rank || "—";
  }

  function standingRankDescription(row) {
    if (!row?.eligible) return "Provisional";
    if (requiresPodiumDecider(row)) return "Podium decider required";
    if (row?.sharedRank) return `Tied at rank ${row.rank}`;
    return `Rank ${row?.rank}`;
  }

  function standingRankingReason(row) {
    if (requiresPodiumDecider(row)) {
      return "Identical competitive results · decider required";
    }
    return String(row?.tieBreakReason || row?.rankReason || "").trim();
  }

  function podiumDeciderNotice(rows) {
    const deciderRows = (Array.isArray(rows) ? rows : []).filter(requiresPodiumDecider);
    if (!deciderRows.length) return "";
    const groups = new Map();
    deciderRows.forEach(row => {
      const groupId = String(row?.podiumDeciderGroupId || `rank-${row?.rank || "podium"}`);
      const group = groups.get(groupId) || [];
      group.push(String(row?.name || "Player"));
      groups.set(groupId, group);
    });
    const groupCopy = [...groups.values()]
      .map(names => `${names.join(", ")} have identical competitive results`)
      .join("; ");
    return `
      <div class="pm2-decider-notice" role="status">
        <strong>Podium Decider Required</strong>
        <span>${escapeHtml(groupCopy)}. Record one separating result; official podium places stay TBD until then.</span>
      </div>
    `;
  }

  function rankingCopy(mode = sessionRankingMode()) {
    if (isCompetitiveMode(mode)) {
      return {
        name: "Competitive Ranking",
        badge: "Recommended",
        eyebrow: "Elo + record + head-to-head + strength",
        standings: "Competitive Standings",
        podium: "Competitive Podium",
        summary: "Competitive Ranking",
        liveDescription: "Rank every player by exact Elo Performance Points, then win percentage, wins, head-to-head, opponent strength, and best upset.",
        completedDescription: "Elo performance leads. Win percentage, wins, head-to-head, opponent strength, and best upset resolve close podium places.",
      };
    }
    if (isWinPercentageMode(mode)) {
      return {
        name: "Win Percentage",
        badge: "Simple scoring",
        eyebrow: "Ranked by win percentage",
        standings: "Win Percentage Standings",
        podium: "Win Percentage Podium",
        summary: "Win Percentage",
        liveDescription: "Record each winner, rotate teammates fairly, and follow every player's individual win percentage.",
        completedDescription: "Ranked by wins divided by games. Every win counts equally.",
      };
    }
    return {
      name: "Performance Rating",
      badge: "Recommended",
      eyebrow: "Ranked by Session Points",
      standings: "Performance Standings",
      podium: "Performance Podium",
      summary: "Performance Points",
      liveDescription: "Record each winner, rotate teammates fairly, and follow each player's opponent-adjusted Session Points.",
      completedDescription: "Ranked by Session Points. Opponent strength matters; wins and win rate do not determine rank.",
    };
  }

  function readShareTokens() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SHARE_TOKEN_STORE) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function storedShareToken(sessionId = state.session?.id) {
    const token = readShareTokens()[asId(sessionId)];
    return /^[0-9a-f]{64}$/.test(String(token || "")) ? token : "";
  }

  function rememberShareToken(token, sessionId = state.session?.id) {
    const id = asId(sessionId);
    if (!id) return;
    try {
      const tokens = readShareTokens();
      if (token) tokens[id] = token;
      else delete tokens[id];
      localStorage.setItem(SHARE_TOKEN_STORE, JSON.stringify(tokens));
    } catch (_) {}
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function localDateValue(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function formatDate(value) {
    if (!value) return "Today";
    const [year, month, day] = String(value).split("-").map(Number);
    if (!year || !month || !day) return value;
    return new Date(year, month - 1, day).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function playerName(id) {
    return playerRecord(id)?.full_name || "Player";
  }

  function playerRecord(id) {
    return state.players.find(player => asId(player.id) === asId(id)) || null;
  }

  function normalizeSkillLevel(value, fallback = DEFAULT_SKILL_LEVEL) {
    const level = Number(value);
    return Number.isInteger(level) && level >= 1 && level <= 6 ? level : fallback;
  }

  function skillInfo(value) {
    const level = normalizeSkillLevel(value);
    return SKILL_LEVELS.find(item => item.value === level) || SKILL_LEVELS[DEFAULT_SKILL_LEVEL - 1];
  }

  function playerSkillLevel(playerOrId) {
    const player = typeof playerOrId === "object" && playerOrId
      ? playerOrId
      : playerRecord(playerOrId);
    return normalizeSkillLevel(player?.skill_level ?? player?.skillLevel);
  }

  function skillLabel(value) {
    const info = skillInfo(value);
    return `${info.value} star${info.value === 1 ? "" : "s"} · ${info.label}`;
  }

  function skillStars(value) {
    return "★".repeat(normalizeSkillLevel(value));
  }

  function teamSkillTotal(playerIds) {
    return (playerIds || []).reduce((sum, id) => sum + playerSkillLevel(id), 0);
  }

  function activePlayers() {
    return state.players.filter(player => (player.status || "active") === "active" && player.full_name);
  }

  function lastRound() {
    return state.rounds[state.rounds.length - 1] || null;
  }

  function liveAssignments(round = lastRound()) {
    return Array.isArray(round?.assignments) ? round.assignments : [];
  }

  function readyMatchIds(game) {
    const readyMatch = game?.readyMatch;
    if (!readyMatch || typeof readyMatch !== "object") return [];
    return unique([...(readyMatch.teamA || []), ...(readyMatch.teamB || [])]);
  }

  function readyMatchQueueOrder(game) {
    const playerIds = readyMatchIds(game);
    const storedOrder = unique(game?.readyMatch?.queueOrder || []);
    const playerSet = new Set(playerIds);
    return storedOrder.length === playerIds.length
      && storedOrder.every(id => playerSet.has(id))
      ? storedOrder
      : playerIds;
  }

  function hasReadyMatch(game) {
    return readyMatchIds(game).length === 4
      && (game?.readyMatch?.teamA || []).length === 2
      && (game?.readyMatch?.teamB || []).length === 2;
  }

  function isLiveGame(game) {
    return Boolean(game && !game.winner);
  }

  function occupiedGameIds(game) {
    if (!game) return [];
    return isLiveGame(game)
      ? unique([...(game.teamA || []), ...(game.teamB || [])])
      : readyMatchIds(game);
  }

  function roundQueue(round = lastRound()) {
    if (!round) return [];
    const activeIds = new Set(activePlayers().map(player => asId(player.id)));
    const assigned = new Set(
      liveAssignments(round)
        .flatMap(occupiedGameIds)
        .map(asId)
    );
    const stored = (round.queue_snapshot || [])
      .map(asId)
      .filter(id => activeIds.has(id) && !assigned.has(id));
    const missing = [...activeIds].filter(id => !assigned.has(id) && !stored.includes(id));
    return unique([...stored, ...missing]);
  }

  async function syncQueueWaitTimes(queue = roundQueue()) {
    if (
      !state.session?.id ||
      state.session.status !== "active" ||
      typeof DB.syncOpenPlayGameQueueWaitTimes !== "function"
    ) return;
    const players = await DB.syncOpenPlayGameQueueWaitTimes(
      state.session.id,
      queue.map(asId)
    );
    if (Array.isArray(players) && players.length) {
      state.players = players;
    }
  }

  function pairKey(a, b) {
    return [asId(a), asId(b)].sort().join("|");
  }

  function buildHistory(rounds = state.rounds) {
    const history = {
      partner: {},
      opponent: {},
      playCount: {},
      winCount: {},
      lastRound: {},
    };

    const processGame = (game, roundNo) => {
      const teamA = (game.teamA || []).map(asId);
      const teamB = (game.teamB || []).map(asId);
      if (teamA.length === 2) {
        const key = pairKey(teamA[0], teamA[1]);
        history.partner[key] = (history.partner[key] || 0) + 1;
      }
      if (teamB.length === 2) {
        const key = pairKey(teamB[0], teamB[1]);
        history.partner[key] = (history.partner[key] || 0) + 1;
      }
      teamA.forEach(a => teamB.forEach(b => {
        const key = pairKey(a, b);
        history.opponent[key] = (history.opponent[key] || 0) + 1;
      }));
      [...teamA, ...teamB].forEach(id => {
        history.playCount[id] = (history.playCount[id] || 0) + 1;
        history.lastRound[id] = roundNo;
      });
      if (game.winner === "A") {
        teamA.forEach(id => { history.winCount[id] = (history.winCount[id] || 0) + 1; });
      }
      if (game.winner === "B") {
        teamB.forEach(id => { history.winCount[id] = (history.winCount[id] || 0) + 1; });
      }
    };

    rounds.forEach(round => {
      const roundNo = Number(round.round_no || 0);
      liveAssignments(round).forEach(game => {
        (game.completedGames || []).forEach(done => processGame(done, roundNo));
        processGame(game, roundNo);
      });
    });
    return history;
  }

  function completedMatches(rounds = state.rounds) {
    const matches = [];
    let sequence = 0;

    rounds.forEach((round, roundIndex) => {
      const roundNo = Number(round.round_no || roundIndex + 1);
      liveAssignments(round).forEach((game, courtIndex) => {
        const completedGames = Array.isArray(game.completedGames) ? game.completedGames : [];
        const results = completedGames.map((result, completedGameIndex) => ({
          result,
          completedGameIndex,
        }));
        if (["A", "B"].includes(game.winner)) {
          results.push({ result: game, completedGameIndex: null });
        }

        results.forEach(({ result, completedGameIndex }) => {
          if (!["A", "B"].includes(result.winner)) return;
          const parsedTime = Date.parse(result.resultAt || "");
          matches.push({
            matchId: asId(result.matchId || ""),
            roundId: asId(round.id),
            roundNo,
            courtIndex,
            completedGameIndex,
            courtName: result.courtName || game.courtName || `Court ${courtIndex + 1}`,
            teamA: (result.teamA || []).map(asId),
            teamB: (result.teamB || []).map(asId),
            winner: result.winner,
            corrected: Array.isArray(result.winnerCorrections) && result.winnerCorrections.length > 0,
            resultAt: result.resultAt || "",
            sortTime: Number.isFinite(parsedTime) ? parsedTime : 0,
            sequence: sequence++,
          });
        });
      });
    });

    return matches.sort((a, b) => {
      if (a.sortTime && b.sortTime && a.sortTime !== b.sortTime) {
        return b.sortTime - a.sortTime;
      }
      if (a.sortTime !== b.sortTime) return a.sortTime ? -1 : 1;
      return b.roundNo - a.roundNo || b.sequence - a.sequence;
    });
  }

  function averageGameDuration() {
    const minimumReportableSeconds = 2 * 60;
    const maximumReportableSeconds = 2 * 60 * 60;
    const durations = [];
    state.rounds.forEach(round => {
      liveAssignments(round).forEach(game => {
        const results = [
          ...(Array.isArray(game.completedGames) ? game.completedGames : []),
          ...(["A", "B"].includes(game.winner) ? [game] : []),
        ];
        results.forEach(result => {
          const startedAt = Date.parse(result.startedAt || "");
          const resultAt = Date.parse(result.resultAt || "");
          if (Number.isFinite(startedAt) && Number.isFinite(resultAt) && resultAt >= startedAt) {
            const durationSeconds = Math.floor((resultAt - startedAt) / 1000);
            if (
              durationSeconds >= minimumReportableSeconds &&
              durationSeconds <= maximumReportableSeconds
            ) {
              durations.push(durationSeconds);
            }
          }
        });
      });
    });
    if (!durations.length) return "—";
    const seconds = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function bestSplit(group, history, randomizeTies = true) {
    const splits = [
      [[0, 1], [2, 3]],
      [[0, 2], [1, 3]],
      [[0, 3], [1, 2]],
    ];
    let best = null;
    splits.forEach(([left, right]) => {
      const teamA = left.map(index => group[index]);
      const teamB = right.map(index => group[index]);
      const partnerRepeats =
        (history.partner[pairKey(teamA[0].id, teamA[1].id)] || 0) +
        (history.partner[pairKey(teamB[0].id, teamB[1].id)] || 0);
      let opponentRepeats = 0;
      teamA.forEach(a => teamB.forEach(b => {
        opponentRepeats += history.opponent[pairKey(a.id, b.id)] || 0;
      }));
      const teamASkill = teamA.reduce((sum, player) => sum + playerSkillLevel(player.id), 0);
      const teamBSkill = teamB.reduce((sum, player) => sum + playerSkillLevel(player.id), 0);
      const skillGap = Math.abs(teamASkill - teamBSkill);
      const score = partnerRepeats * 100
        + opponentRepeats * 20
        + skillGap * 8
        + (randomizeTies ? Math.random() : 0);
      if (!best || score < best.score) best = { teamA, teamB, score };
    });
    return best;
  }

  function shuffled(values) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [result[index], result[swap]] = [result[swap], result[index]];
    }
    return result;
  }

  function selectedCourtRows(ids) {
    const wanted = new Set(ids.map(asId));
    return state.courts.filter(court => wanted.has(asId(court.id)));
  }

  function sessionCourtIds() {
    const ids = (state.session?.court_ids || []).map(asId);
    if (ids.length) return ids;
    return state.courts.slice(0, Math.min(2, state.courts.length)).map(court => asId(court.id));
  }

  function adaptiveRotationPlayers(playerIds = activePlayers().map(player => asId(player.id))) {
    const wanted = new Set((playerIds || []).map(asId));
    const standingsById = new Map(
      standingsRows(completedMatches()).map(row => [asId(row.id), row])
    );
    return activePlayers()
      .filter(player => wanted.has(asId(player.id)))
      .map((player, index) => {
        const standing = standingsById.get(asId(player.id));
        return {
          ...player,
          id: asId(player.id),
          seed_order: Number(player.seed_order ?? index),
          skill_level: playerSkillLevel(player),
          rating_exact: Number(
            standing?.ratingExact ??
            standing?.rating ??
            player.performance_seed_rating ??
            PERFORMANCE?.seedRating?.(playerSkillLevel(player)) ??
            1000
          ),
          points_exact: Number(standing?.pointsExact ?? standing?.points ?? 0),
          competitive_rank: standing?.eligible ? Number(standing.rank || 0) || null : null,
          games: Number(standing?.games || 0),
        };
      });
  }

  function adaptiveRotationAssignments(playerIds, courtIds) {
    if (!ROTATION?.generateAssignments) {
      throw new Error("The Adaptive Competitive rotation engine did not load.");
    }
    const selectedCourtIds = (courtIds || []).map(asId);
    const courtNames = Object.fromEntries(selectedCourtIds.map((courtId, index) => {
      const court = state.courts.find(item => asId(item.id) === courtId);
      return [courtId, court?.name || `Court ${index + 1}`];
    }));
    return ROTATION.generateAssignments({
      active: adaptiveRotationPlayers(playerIds),
      courtIds: selectedCourtIds,
      courtNames,
      rounds: state.rounds,
      format: "doubles",
      style: "adaptive_competitive",
      random: Math.random,
    });
  }

  function generateAssignments() {
    if (isAdaptiveCompetitiveRotation()) {
      const generated = adaptiveRotationAssignments(
        activePlayers().map(player => asId(player.id)),
        sessionCourtIds()
      );
      const startedAt = new Date().toISOString();
      return {
        assignments: generated.assignments.map(game => ({
          ...game,
          startedAt,
          matchId: createMatchId(),
        })),
        queueSnapshot: generated.queueSnapshot,
        history: buildHistory(),
      };
    }

    const players = activePlayers().map((player, index) => ({
      id: asId(player.id),
      seedOrder: Number(player.seed_order ?? index),
    }));
    const courtIds = sessionCourtIds();
    const history = buildHistory();
    const previousQueue = roundQueue();
    const queuePosition = {};
    previousQueue.forEach((id, index) => { queuePosition[asId(id)] = index; });
    const courtCount = Math.min(courtIds.length, Math.floor(players.length / 4));
    const playingSlots = courtCount * 4;
    const ordered = [...players].sort((a, b) =>
      (history.playCount[a.id] || 0) - (history.playCount[b.id] || 0) ||
      (queuePosition[a.id] ?? 99999) - (queuePosition[b.id] ?? 99999) ||
      a.seedOrder - b.seedOrder
    );
    const mustPlay = ordered.slice(0, playingSlots);
    const waiting = ordered.slice(playingSlots);
    let best = null;
    const samples = Math.max(60, Math.min(220, players.length * 16));

    for (let sample = 0; sample < samples; sample += 1) {
      const candidatePlayers = state.session?.mode === "all_rotate" ? [...mustPlay] : shuffled(mustPlay);
      const assignments = [];
      let score = 0;
      for (let courtIndex = 0; courtIndex < courtCount; courtIndex += 1) {
        const group = candidatePlayers.slice(courtIndex * 4, courtIndex * 4 + 4);
        const split = bestSplit(group, history);
        score += split.score;
        const courtId = courtIds[courtIndex];
        const court = state.courts.find(item => asId(item.id) === asId(courtId));
        assignments.push({
          courtId,
          courtName: court?.name || `Court ${courtIndex + 1}`,
          teamA: split.teamA.map(player => player.id),
          teamB: split.teamB.map(player => player.id),
          startedAt: new Date().toISOString(),
          matchId: createMatchId(),
        });
      }
      if (!best || score < best.score) best = { assignments, score };
      if (state.session?.mode === "all_rotate") break;
    }

    const playingIds = new Set((best?.assignments || []).flatMap(game => [...game.teamA, ...game.teamB]).map(asId));
    return {
      assignments: best?.assignments || [],
      queueSnapshot: [
        ...waiting.map(player => player.id),
        ...ordered.filter(player => playingIds.has(player.id)).map(player => player.id),
      ],
      history,
    };
  }

  function completedCount() {
    return state.rounds.reduce((total, round) => total + liveAssignments(round).reduce(
      (count, game) => count + (game.completedGames || []).length + (game.winner ? 1 : 0),
      0
    ), 0);
  }

  function headerNumbers() {
    const round = lastRound();
    const assignments = liveAssignments(round);
    const playing = assignments
      .filter(isLiveGame)
      .flatMap(game => [...(game.teamA || []), ...(game.teamB || [])]);
    return {
      courts: assignments.length || sessionCourtIds().length,
      players: activePlayers().length,
      queue: roundQueue(round).length,
      playing: unique(playing).length,
      finished: completedCount(),
    };
  }

  function sessionTitle(session = state.session) {
    if (!session) return "New Open Play";
    const courts = (session.court_names || selectedCourtRows(session.court_ids || []).map(court => court.name)).join(", ");
    return [formatDate(session.date), session.time_label, courts].filter(Boolean).join(" · ");
  }

  function sessionOptionLabel(session) {
    const status = String(session.status || "draft").toUpperCase();
    return `${formatDate(session.date)} · ${session.time_label || "Open Play"} · ${status}`;
  }

  function loadingMarkup(message = "Loading Play Manager…") {
    return `<div class="pm2"><div class="pm2-loading"><div><div class="pm2-loading-ball"></div>${escapeHtml(message)}</div></div></div>`;
  }

  function notify(message, isError = false) {
    const toast = root()?.querySelector(".pm2-toast");
    if (!toast) {
      if (typeof window.toast === "function") window.toast(message, isError ? "err" : "ok");
      return;
    }
    clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.classList.toggle("is-error", isError);
    toast.classList.add("is-on");
    state.toastTimer = setTimeout(() => toast.classList.remove("is-on"), 2800);
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }

  function playWinnerReveal(courtIndex, winner) {
    const card = root()?.querySelector(`[data-pm-court-index="${courtIndex}"]`);
    const winningTeam = card?.querySelector(`[data-pm-team="${winner}"]`);
    if (!card || !winningTeam) return Promise.resolve();

    const losingTeam = card.querySelector(`[data-pm-team="${winner === "A" ? "B" : "A"}"]`);
    card.querySelectorAll('[data-pm-action="winner"]').forEach(button => {
      button.disabled = true;
    });
    card.classList.add("is-revealing-winner");
    winningTeam.classList.add("is-winner-reveal");
    losingTeam?.classList.add("is-loser-reveal");

    return new Promise(resolve => {
      setTimeout(resolve, prefersReducedMotion() ? 120 : 1050);
    });
  }

  function scrollContextKey() {
    return [
      asId(state.session?.id) || "none",
      state.view || "setup",
      state.displayMode ? "display" : "page",
      state.displayModeRevision,
    ].join("|");
  }

  function pageScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function captureRenderScroll(element) {
    const shell = element?.querySelector(".pm2[data-pm-scroll-context]");
    if (!shell) return null;
    const mainScroller = shell.classList.contains("pm2-display") ? shell : pageScroller();
    const panels = {};
    shell.querySelectorAll("[data-pm-scroll-key]").forEach(scroller => {
      const key = scroller.dataset.pmScrollKey;
      if (key) panels[key] = scroller.scrollTop;
    });
    return {
      context: shell.dataset.pmScrollContext || "",
      mainTop: mainScroller?.scrollTop || 0,
      panels,
    };
  }

  function restoreScrollTop(scroller, value) {
    if (!scroller) return;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const requested = Number.isFinite(Number(value)) ? Number(value) : 0;
    scroller.scrollTop = Math.min(Math.max(0, requested), maxTop);
  }

  function restoreRenderScroll(element, context, snapshot) {
    if (!snapshot || snapshot.context !== context) return;
    const shell = element?.querySelector(".pm2[data-pm-scroll-context]");
    if (!shell || shell.dataset.pmScrollContext !== context) return;
    const mainScroller = shell.classList.contains("pm2-display") ? shell : pageScroller();
    restoreScrollTop(mainScroller, snapshot.mainTop);
    shell.querySelectorAll("[data-pm-scroll-key]").forEach(scroller => {
      const key = scroller.dataset.pmScrollKey;
      if (key && Object.prototype.hasOwnProperty.call(snapshot.panels, key)) {
        restoreScrollTop(scroller, snapshot.panels[key]);
      }
    });
  }

  async function withBusy(task) {
    if (state.loading) return;
    state.loading = true;
    root()?.setAttribute("aria-busy", "true");
    try {
      await task();
    } catch (error) {
      console.error("Play Manager:", error);
      const sessionChanged = error?.code === "55000"
        || /PLAY_MANAGER_SESSION_(?:NOT_ACTIVE|TERMINAL)/i.test(String(error?.message || ""));
      const roundChanged = error?.code === "40001"
        || /PLAY_MANAGER_ROUND_CONFLICT/i.test(String(error?.message || ""));
      if ((sessionChanged || roundChanged) && state.session) {
        try {
          await refreshState(state.view);
          renderShell();
        } catch (refreshError) {
          console.warn("Play Manager could not refresh the changed session:", refreshError);
        }
        notify(
          sessionChanged
            ? "This session was ended or paused on another screen. The latest status is now loaded."
            : "Another screen changed this round first. The latest round is now loaded.",
          true
        );
        return;
      }
      notify(error?.message || "Play Manager could not complete that action.", true);
    } finally {
      state.loading = false;
      root()?.setAttribute("aria-busy", "false");
    }
  }

  async function loadSession(id, preferredView) {
    const session = state.sessions.find(item => asId(item.id) === asId(id));
    if (!session) return false;
    if (asId(state.session?.id) !== asId(session.id)) {
      state.shareToken = null;
      state.shareSessionId = null;
    }
    const [players, rounds] = await Promise.all([
      DB.getOpenPlayGamePlayers(session.id),
      DB.getOpenPlayGameRounds(session.id),
    ]);
    state.session = session;
    state.players = players || [];
    state.rounds = rounds || [];
    if (state.session.status === "active" && state.rounds.length) {
      try {
        await syncQueueWaitTimes(roundQueue());
      } catch (error) {
        console.warn("Play Manager could not initialize queue wait times:", error);
      }
    }
    state.view = preferredView || (state.rounds.length ? "live" : "setup");
    return true;
  }

  async function refreshState(preferredView) {
    if (!state.session) return;
    state.sessions = await DB.getOpenPlayGameSessions();
    await loadSession(state.session.id, preferredView || state.view);
  }

  function bindRoot(element) {
    if (element.dataset.pmBound === "true") return;
    element.dataset.pmBound = "true";
    element.addEventListener("click", handleClick);
    element.addEventListener("change", handleChange);
    element.addEventListener("input", handleInput);
    element.addEventListener("submit", handleSubmit);
  }

  async function render() {
    const element = root();
    if (!element) return;
    bindRoot(element);
    const scrollSnapshot = captureRenderScroll(element);
    element.innerHTML = loadingMarkup();
    await withBusy(async () => {
      const [courts, sessions] = await Promise.all([
        DB.getCourts(),
        DB.getOpenPlayGameSessions(),
      ]);
      state.courts = courts || [];
      state.sessions = sessions || [];

      const params = new URLSearchParams(location.search);
      const requested = state.prefill?.sessionId || params.get("pm") || params.get("gm");
      const remembered = state.session?.id;
      const activeToday = state.sessions.find(session =>
        session.date === localDateValue() &&
        ["active", "paused"].includes(session.status)
      );
      const candidate = requested || remembered || activeToday?.id || state.sessions[0]?.id;
      if (candidate && await loadSession(candidate)) {
        if (state.prefill) state.view = "setup";
      } else {
        state.session = null;
        state.players = [];
        state.rounds = [];
        state.view = "setup";
      }
      state.initialized = true;
      renderShell(scrollSnapshot);
      startClock();
    });
  }

  function skillSelectorMarkup(selectedLevel = DEFAULT_SKILL_LEVEL) {
    const selected = Number(selectedLevel);
    const selectedInfo = SKILL_LEVELS.find(item => item.value === selected);
    return `
      <fieldset class="pm2-skill-field" aria-describedby="pm2SkillText pm2SkillHelp">
        <legend>Player skill</legend>
        <div class="pm2-skill-row">
          <span class="pm2-skill-caption" id="pm2SkillCaption">Skill:</span>
          <div class="pm2-skill-stars" aria-label="Choose a skill level from one to six stars">
            ${SKILL_LEVELS.map(item => `
              <label class="pm2-skill-star ${selected >= item.value ? "is-filled" : ""} ${selected === item.value ? "is-selected" : ""}">
                <input
                  type="radio"
                  name="skillLevel"
                  value="${item.value}"
                  aria-label="${item.value} star${item.value === 1 ? "" : "s"}, ${escapeHtml(item.label)}"
                  ${selected === item.value ? "checked" : ""}
                >
                <span aria-hidden="true">★</span>
              </label>
            `).join("")}
          </div>
          <strong class="pm2-skill-text" id="pm2SkillText">${selectedInfo ? escapeHtml(selectedInfo.label) : "Set skill"}</strong>
        </div>
        <small id="pm2SkillHelp">New players start at 1-star Beginner.</small>
      </fieldset>
    `;
  }

  function renderShell(inheritedScrollSnapshot) {
    const element = root();
    if (!element) return;
    const scrollSnapshot = inheritedScrollSnapshot === undefined
      ? captureRenderScroll(element)
      : inheritedScrollSnapshot;
    const scrollContext = scrollContextKey();
    const numbers = headerNumbers();
    const live = state.view === "live" && !!lastRound();
    const completed = String(state.session?.status || "") === "completed";
    element.innerHTML = `
      <section
        class="pm2 ${state.displayMode ? "pm2-display" : ""}"
        data-pm-scroll-context="${escapeHtml(scrollContext)}"
        aria-label="Korte DOS Play Manager"
      >
        <header class="pm2-header">
          <div class="pm2-brand">
            <img class="pm2-brand-mark" src="korte-dos-logo.png" alt="">
            <div class="pm2-brand-copy">
              <span class="pm2-brand-kicker">Open Play</span>
              <h2>Korte DOS Play Manager</h2>
            </div>
          </div>
          <div class="pm2-header-stats" aria-label="${completed ? "Completed session totals" : "Live session totals"}">
            <div class="pm2-header-stat"><b>${numbers.courts}</b><span>Courts</span></div>
            <div class="pm2-header-stat"><b>${numbers.players}</b><span>Players</span></div>
            <div class="pm2-header-stat"><b>${completed ? numbers.finished : numbers.queue}</b><span>${completed ? "Results" : "Queue"}</span></div>
          </div>
          <div class="pm2-header-actions">
            <button class="pm2-btn pm2-btn-dark" type="button" data-pm-action="new-session" title="Create a new session">＋ <span>New</span></button>
            ${live ? `<button class="pm2-icon-btn pm2-btn-dark" type="button" data-pm-action="display" aria-label="${state.displayMode ? "Exit venue display" : "Open venue display"}">${state.displayMode ? "↙" : "⛶"}</button>` : ""}
          </div>
        </header>
        <div class="pm2-workspace">
          ${state.view === "live" && lastRound() ? renderLive() : renderSetup()}
        </div>
        <dialog class="pm2-dialog" id="pm2AddDialog" aria-labelledby="pm2AddTitle" aria-describedby="pm2PlayerEditorIntro pm2PlayerEditorSummary">
          <form method="dialog" data-pm-form="add-player">
            <div class="pm2-dialog-head">
              <div class="pm2-dialog-heading">
                <span class="pm2-dialog-kicker" id="pm2PlayerEditorKicker">Player queue</span>
                <h3 id="pm2AddTitle">Add a player</h3>
              </div>
              <button class="pm2-icon-btn pm2-btn-light pm2-dialog-close" type="button" data-pm-action="close-dialog" aria-label="Close">×</button>
            </div>
            <div class="pm2-dialog-body">
              <p class="pm2-dialog-intro" id="pm2PlayerEditorIntro">Add a walk-in to the end of the waiting list.</p>
              <section class="pm2-player-editor-summary" id="pm2PlayerEditorSummary" hidden aria-label="Player session summary">
                <div class="pm2-player-editor-stats">
                  <span id="pm2PlayerEditorGames">0G played</span>
                  <span id="pm2PlayerEditorPerformance">No results yet</span>
                </div>
                <p id="pm2PlayerEditorCheckIn">Checked-in time unavailable</p>
              </section>
              <label class="pm2-field">
                <span class="pm2-label" id="pm2PlayerNameLabel">Player name</span>
                <input class="pm2-input" id="pm2WalkInName" name="playerName" autocomplete="off" required maxlength="90" placeholder="Enter full name">
              </label>
              ${skillSelectorMarkup()}
              <div class="pm2-player-editor-note" id="pm2PlayerEditorNote" hidden>
                Skill changes apply to future team balancing.
              </div>
              <div class="pm2-dialog-actions">
                <button class="pm2-btn pm2-btn-light" type="button" data-pm-action="close-dialog">Cancel</button>
                <button class="pm2-btn pm2-btn-primary" id="pm2PlayerEditorSubmit" type="submit">Add to queue</button>
              </div>
            </div>
          </form>
        </dialog>
        <dialog class="pm2-dialog" id="pm2ReplaceDialog" aria-labelledby="pm2ReplaceTitle">
          <form method="dialog" data-pm-form="replace-player">
            <div class="pm2-dialog-head">
              <div class="pm2-dialog-heading">
                <span class="pm2-dialog-kicker">Live court</span>
                <h3 id="pm2ReplaceTitle">Replace player</h3>
              </div>
              <button class="pm2-icon-btn pm2-btn-light pm2-dialog-close" type="button" data-pm-action="close-dialog" aria-label="Close">×</button>
            </div>
            <div class="pm2-dialog-body">
              <div class="pm2-replace-summary">
                <div class="pm2-replace-person">
                  <span>Current player</span>
                  <strong id="pm2OutgoingPlayer">—</strong>
                </div>
                <small id="pm2OutgoingSlot">Choose a replacement for this court slot.</small>
              </div>
              <fieldset class="pm2-replace-source">
                <legend><span class="pm2-replace-step">1</span><span>Choose replacement</span></legend>
                <div class="pm2-replace-source-switch">
                  <label class="pm2-replace-source-option">
                    <input
                      type="radio"
                      name="replacementSource"
                      value="queue"
                      aria-controls="pm2ReplacementQueuePanel"
                      checked
                    >
                    <span>From queue</span>
                  </label>
                  <label class="pm2-replace-source-option">
                    <input
                      type="radio"
                      name="replacementSource"
                      value="walkin"
                      aria-controls="pm2ReplacementWalkInPanel"
                    >
                    <span>New walk-in</span>
                  </label>
                </div>
                <div
                  class="pm2-replace-source-panel"
                  id="pm2ReplacementQueuePanel"
                  data-pm-replacement-panel="queue"
                >
                  <label class="pm2-field">
                    <span class="pm2-replace-field-head">
                      <span class="pm2-label">Waiting player</span>
                      <span class="pm2-replace-next-badge" id="pm2ReplacementNextBadge" hidden>Next in queue</span>
                    </span>
                    <select
                      class="pm2-select"
                      id="pm2ReplacementPlayer"
                      name="replacementId"
                      aria-describedby="pm2ReplacementMeta"
                      disabled
                    ></select>
                    <small class="pm2-replacement-meta" id="pm2ReplacementMeta">Choose a waiting player.</small>
                  </label>
                </div>
                <div
                  class="pm2-replace-source-panel"
                  id="pm2ReplacementWalkInPanel"
                  data-pm-replacement-panel="walkin"
                  hidden
                >
                  <label class="pm2-field">
                    <span class="pm2-label">Walk-in name</span>
                    <input class="pm2-input" id="pm2ReplacementName" name="replacementName" autocomplete="off" maxlength="90" placeholder="Enter a new player" disabled>
                    <small class="pm2-replacement-meta">Use this for someone who is not currently in the queue.</small>
                  </label>
                </div>
              </fieldset>
              <fieldset class="pm2-choice-field">
                <legend><span class="pm2-replace-step">2</span><span>After the replacement</span></legend>
                <label class="pm2-choice">
                  <input type="radio" name="outgoingAction" value="queue" checked>
                  <span><strong>Return to queue</strong><small>Keep them checked in for a later game.</small></span>
                </label>
                <label class="pm2-choice">
                  <input type="radio" name="outgoingAction" value="removed">
                  <span><strong>Mark as left</strong><small>Remove them from the active roster.</small></span>
                </label>
              </fieldset>
              <div class="pm2-replace-plan is-pending" id="pm2ReplacementPlan">
                <span>Review before confirming</span>
                <strong id="pm2ReplacementPlanTitle">Choose a replacement player</strong>
                <small id="pm2ReplacementPlanDetail">The current court assignment will stay unchanged until you confirm.</small>
              </div>
            </div>
            <div class="pm2-dialog-actions pm2-replace-actions">
              <button class="pm2-btn pm2-btn-light" type="button" data-pm-action="close-dialog">Cancel</button>
              <button
                class="pm2-btn pm2-btn-primary"
                id="pm2ReplacementSubmit"
                type="submit"
                aria-describedby="pm2ReplacementPlanTitle pm2ReplacementPlanDetail"
                disabled
              >Confirm replacement</button>
            </div>
          </form>
        </dialog>
        <dialog class="pm2-dialog pm2-lineup-dialog" id="pm2ChooseDialog" aria-labelledby="pm2ChooseTitle" aria-describedby="pm2ChooseDescription">
          <form method="dialog" data-pm-form="choose-players">
            <div class="pm2-dialog-head">
              <div class="pm2-dialog-heading">
                <span class="pm2-dialog-kicker is-teal">Ready court</span>
                <h3 id="pm2ChooseTitle">Choose players</h3>
              </div>
              <button class="pm2-icon-btn pm2-btn-light pm2-dialog-close" type="button" data-pm-action="close-dialog" aria-label="Close">&times;</button>
            </div>
            <div class="pm2-dialog-body">
              <p class="pm2-dialog-intro" id="pm2ChooseDescription">Assign four different waiting players. They remain reserved until the match starts.</p>
              <div class="pm2-lineup-context">
                <span id="pm2LineupCourt">Court</span>
                <strong>Next matchup</strong>
                <small id="pm2LineupAvailable">Choose two players for each team.</small>
              </div>
              <div class="pm2-lineup-grid">
                <fieldset class="pm2-lineup-team is-team-a">
                  <legend>Team 1</legend>
                  <label>
                    <span>Player 1</span>
                    <select class="pm2-select" id="pm2LineupA1" name="teamA0" data-pm-lineup-slot required></select>
                  </label>
                  <label>
                    <span>Player 2</span>
                    <select class="pm2-select" id="pm2LineupA2" name="teamA1" data-pm-lineup-slot required></select>
                  </label>
                </fieldset>
                <div class="pm2-lineup-vs" aria-hidden="true">VS</div>
                <fieldset class="pm2-lineup-team is-team-b">
                  <legend>Team 2</legend>
                  <label>
                    <span>Player 1</span>
                    <select class="pm2-select" id="pm2LineupB1" name="teamB0" data-pm-lineup-slot required></select>
                  </label>
                  <label>
                    <span>Player 2</span>
                    <select class="pm2-select" id="pm2LineupB2" name="teamB1" data-pm-lineup-slot required></select>
                  </label>
                </fieldset>
              </div>
              <div class="pm2-lineup-status" id="pm2LineupStatus" role="status" aria-live="polite">Choose four different players.</div>
              <div class="pm2-dialog-actions">
                <button class="pm2-btn pm2-btn-light" type="button" data-pm-action="close-dialog">Cancel</button>
                <button class="pm2-btn pm2-btn-primary" id="pm2LineupSubmit" type="submit" disabled>Save lineup</button>
              </div>
            </div>
          </form>
        </dialog>
        <dialog
          class="pm2-dialog pm2-winner-dialog"
          id="pm2WinnerDialog"
          aria-labelledby="pm2WinnerDialogTitle"
          aria-describedby="pm2WinnerDialogDescription"
        >
          <form method="dialog" data-pm-form="correct-winner">
            <div class="pm2-dialog-head">
              <div class="pm2-dialog-heading">
                <span class="pm2-dialog-kicker">Match correction</span>
                <h3 id="pm2WinnerDialogTitle">Change winner</h3>
              </div>
              <button class="pm2-icon-btn pm2-btn-light pm2-dialog-close" type="button" data-pm-action="close-dialog" aria-label="Close">×</button>
            </div>
            <div class="pm2-dialog-body">
              <div class="pm2-winner-confirm">
                <span id="pm2WinnerMatchLabel">Match result</span>
                <strong id="pm2WinnerTeamLabel">Choose the corrected winner</strong>
                <p id="pm2WinnerDialogDescription">Standings will update. Court rotations and the player queue will stay unchanged.</p>
              </div>
              <div class="pm2-dialog-actions">
                <button class="pm2-btn pm2-btn-light" type="button" data-pm-action="close-dialog">Cancel</button>
                <button class="pm2-btn pm2-btn-primary" type="submit">Change winner</button>
              </div>
            </div>
          </form>
        </dialog>
        <dialog
          class="pm2-dialog pm2-share-dialog"
          id="pm2ShareDialog"
          aria-labelledby="pm2ShareTitle"
          aria-describedby="pm2ShareDescription"
        >
          <div class="pm2-dialog-head">
            <div class="pm2-dialog-heading">
              <span class="pm2-dialog-kicker is-teal">Player view</span>
              <h3 id="pm2ShareTitle">Share live board</h3>
            </div>
            <button class="pm2-icon-btn pm2-btn-light pm2-dialog-close" type="button" data-pm-action="close-dialog" aria-label="Close">×</button>
          </div>
          <div class="pm2-dialog-body pm2-share-body">
            <p class="pm2-share-description" id="pm2ShareDescription">
              Anyone with this private link can follow live courts, the player queue, and standings. The board is view-only.
            </p>
            <div class="pm2-share-layout">
              <div class="pm2-share-qr-shell" id="pm2ShareQrShell">
                <canvas id="pm2ShareQr" width="216" height="216" hidden aria-label="QR code for the player live board"></canvas>
                <div class="pm2-share-loading" id="pm2ShareLoading">Creating secure link…</div>
              </div>
              <div class="pm2-share-controls">
                <label class="pm2-field">
                  <span class="pm2-label">Player live-board link</span>
                  <input class="pm2-input pm2-share-url" id="pm2ShareUrl" type="url" readonly value="" aria-describedby="pm2ShareStatus">
                </label>
                <div class="pm2-share-status" id="pm2ShareStatus" role="status" aria-live="polite">Preparing the share link.</div>
                <div class="pm2-share-local" id="pm2ShareLocal" hidden>
                  Local preview links work only in this browser. Use the connected database before sharing with players on other phones.
                </div>
                <div class="pm2-share-actions">
                  <button class="pm2-btn pm2-btn-primary" id="pm2CopyLiveLink" type="button" data-pm-action="copy-live-link" disabled>Copy Link</button>
                  <button class="pm2-btn pm2-btn-dark pm2-share-native" id="pm2NativeShare" type="button" data-pm-action="native-share-live" ${typeof navigator.share === "function" ? "" : "hidden"} disabled>Share…</button>
                  <a class="pm2-btn pm2-btn-light is-disabled" id="pm2OpenLiveView" href="#" target="_blank" rel="noopener noreferrer" aria-disabled="true">Open Player View</a>
                </div>
                <div class="pm2-share-manage">
                  <button class="pm2-mini-action" id="pm2RotateLiveLink" type="button" data-pm-action="rotate-live-link" disabled>Generate New Link</button>
                  <button class="pm2-mini-action is-danger" id="pm2DisableLiveLink" type="button" data-pm-action="disable-live-link" disabled>Disable Link</button>
                </div>
              </div>
            </div>
          </div>
        </dialog>
        <div class="pm2-toast" role="status" aria-live="polite"></div>
      </section>
    `;
    const shareDialog = element.querySelector("#pm2ShareDialog");
    shareDialog?.addEventListener("close", () => {
      const trigger = state.shareTrigger;
      state.shareTrigger = null;
      trigger?.focus?.();
    });
    const playerEditorDialog = element.querySelector("#pm2AddDialog");
    playerEditorDialog?.addEventListener("close", () => {
      const trigger = state.playerEditorTrigger;
      state.playerEditor = null;
      state.playerEditorTrigger = null;
      if (trigger?.isConnected) trigger.focus?.();
    });
    const replacementDialog = element.querySelector("#pm2ReplaceDialog");
    replacementDialog?.addEventListener("close", () => {
      const trigger = state.replacementTrigger;
      state.replacement = null;
      state.replacementTrigger = null;
      if (trigger?.isConnected) trigger.focus?.();
    });
    const chooseDialog = element.querySelector("#pm2ChooseDialog");
    chooseDialog?.addEventListener("close", () => {
      const trigger = state.lineupTrigger;
      state.lineupSelection = null;
      state.lineupTrigger = null;
      if (trigger?.isConnected) trigger.focus?.();
    });
    const winnerDialog = element.querySelector("#pm2WinnerDialog");
    winnerDialog?.addEventListener("close", () => {
      const trigger = state.winnerCorrectionTrigger;
      state.winnerCorrection = null;
      state.winnerCorrectionTrigger = null;
      trigger?.focus?.();
    });
    updateSetupSummary();
    updateTimers();
    restoreRenderScroll(element, scrollContext, scrollSnapshot);
  }

  function rankingExplainerMarkup(mode) {
    if (isCompetitiveMode(mode)) {
      return `
        <div class="pm2-rating-explainer-head">
          <div>
            <span class="pm2-rating-kicker">Official podium &middot; Individual</span>
            <h3 id="pm2RatingTitle">Competitive Ranking</h3>
            <p>Your teammate can change every game. The ranking follows your own results, direct matchups, and the strength of the competition you faced.</p>
          </div>
          <span class="pm2-rating-badge">Recommended</span>
        </div>
        <div class="pm2-rating-principles">
          <div>
            <span aria-hidden="true">01</span>
            <strong>Performance first</strong>
            <p>Exact, unrounded Performance Points determine the initial order.</p>
          </div>
          <div>
            <span aria-hidden="true">02</span>
            <strong>Clear tiebreaks</strong>
            <p>Win percentage, more wins, head-to-head, opponent strength, then best upset are checked in order.</p>
          </div>
          <div>
            <span aria-hidden="true">03</span>
            <strong>No artificial winner</strong>
            <p>If every competitive result is identical, the podium shows Decider Required instead of inventing a winner.</p>
          </div>
        </div>
        <div class="pm2-ranking-ladder" aria-label="Competitive ranking order">
          <span><b>1</b> Exact Elo points</span>
          <i aria-hidden="true">&rarr;</i>
          <span><b>2</b> Win %</span>
          <i aria-hidden="true">&rarr;</i>
          <span><b>3</b> Wins</span>
          <i aria-hidden="true">&rarr;</i>
          <span><b>4</b> Head-to-head</span>
          <i aria-hidden="true">&rarr;</i>
          <span><b>5</b> Opponent strength</span>
          <i aria-hidden="true">&rarr;</i>
          <span><b>6</b> Best upset</span>
        </div>
        <div class="pm2-rating-rule">
          <strong>Complete at least 3 games to qualify.</strong>
          <span>Use varied partners and opponents. Exact podium ties require one separating result.</span>
        </div>
      `;
    }
    if (isWinPercentageMode(mode)) {
      return `
        <div class="pm2-rating-explainer-head">
          <div>
            <span class="pm2-rating-kicker">Podium scoring &middot; Individual</span>
            <h3 id="pm2RatingTitle">Individual Win Percentage</h3>
            <p>Your teammate can change every game. Your win-loss record always belongs to you.</p>
          </div>
          <span class="pm2-rating-badge is-simple">Simple &amp; familiar</span>
        </div>
        <div class="pm2-rating-principles">
          <div>
            <span aria-hidden="true">01</span>
            <strong>Wins divided by games</strong>
            <p>A 3-1 record is 75%. Both winning teammates receive one personal win.</p>
          </div>
          <div>
            <span aria-hidden="true">02</span>
            <strong>Every win is equal</strong>
            <p>Opponent strength and margin do not change the value of a result.</p>
          </div>
          <div>
            <span aria-hidden="true">03</span>
            <strong>Easy to explain</strong>
            <p>The highest qualified win percentage leads the podium.</p>
          </div>
        </div>
        <div class="pm2-rating-rule">
          <strong>Complete at least 3 games to qualify.</strong>
          <span>If percentages tie, more wins ranks first. Equal percentages with equal wins share a rank.</span>
        </div>
      `;
    }
    return `
      <div class="pm2-rating-explainer-head">
        <div>
          <span class="pm2-rating-kicker">Podium scoring &middot; Individual</span>
          <h3 id="pm2RatingTitle">Individual Performance Rating</h3>
          <p>Your teammate can change every game. Your rating always belongs to you.</p>
        </div>
        <span class="pm2-rating-badge">${window.PB_USE_LOCAL_DATA ? "Opponent adjusted" : "Recommended"}</span>
      </div>
      <div class="pm2-rating-principles">
        <div>
          <span aria-hidden="true">01</span>
          <strong>Personal score</strong>
          <p>Every result updates each player&rsquo;s own Session Points.</p>
        </div>
        <div>
          <span aria-hidden="true">02</span>
          <strong>Strength adjusted</strong>
          <p>Beating a stronger team earns more. An expected win earns less.</p>
        </div>
        <div>
          <span aria-hidden="true">03</span>
          <strong>Fairest podium</strong>
          <p>Session Points reward the quality of results, not just the quantity of wins.</p>
        </div>
      </div>
      <div class="pm2-rating-rule">
        <strong>Everyone starts at 0 Session Points.</strong>
        <span>Ratings adapt after every result. Complete at least 3 rated games to qualify.</span>
      </div>
    `;
  }

  function renderSetup() {
    const selectedIds = state.prefill?.courtIds?.length
      ? state.prefill.courtIds.map(asId)
      : sessionCourtIds();
    const selectedSet = new Set(selectedIds);
    const date = state.prefill?.date || state.session?.date || localDateValue();
    const timeLabel = state.session?.time_label || "6PM–10PM";
    const mode = state.prefill?.mode || state.session?.mode || ADAPTIVE_COMPETITIVE_MODE;
    const rankingMode = state.session
      ? sessionRankingMode(state.session)
      : RANKING_MODE_COMPETITIVE;
    const scoring = rankingCopy(rankingMode);
    const names = state.players.map(player => player.full_name).filter(Boolean);
    const isRestart = !!state.rounds.length;
    const sessionOptions = state.sessions.map(session => `
      <option value="${escapeHtml(session.id)}" ${asId(session.id) === asId(state.session?.id) ? "selected" : ""}>
        ${escapeHtml(sessionOptionLabel(session))}
      </option>
    `).join("");
    const courtOptions = state.courts.map(court => `
      <label class="pm2-court-option">
        <input type="checkbox" name="courtIds" value="${escapeHtml(court.id)}" ${selectedSet.has(asId(court.id)) ? "checked" : ""}>
        <span>${escapeHtml(court.name || "Court")}</span>
      </label>
    `).join("");

    return `
      <div class="pm2-view-head">
        <div>
          <span class="pm2-eyebrow">Session setup</span>
          <h1>Build today’s open play.</h1>
          <p>Choose the courts, load the roster, and launch a balanced rotation. Results and queue changes save to the existing Korte DOS game-manager records.</p>
        </div>
        ${state.session ? `<button class="pm2-btn pm2-btn-light" type="button" data-pm-action="continue-live" ${state.rounds.length ? "" : "disabled"}>Continue Live</button>` : ""}
      </div>
      <div class="pm2-setup-grid">
        <form class="pm2-panel" data-pm-form="setup">
          <div class="pm2-panel-head">
            <h3>Open Play Details</h3>
            <span>4 players per court</span>
          </div>
          <div class="pm2-panel-body pm2-form-grid">
            <label class="pm2-field pm2-field-wide">
              <span class="pm2-label">Open an existing session</span>
              <select class="pm2-select" id="pm2SessionSelect">
                <option value="">Create a new session</option>
                ${sessionOptions}
              </select>
            </label>
            <label class="pm2-field">
              <span class="pm2-label">Date</span>
              <input class="pm2-input" type="date" id="pm2Date" name="date" required value="${escapeHtml(date)}">
            </label>
            <label class="pm2-field">
              <span class="pm2-label">Time label</span>
              <input class="pm2-input" type="text" id="pm2Time" name="timeLabel" maxlength="60" value="${escapeHtml(timeLabel)}" placeholder="6PM–10PM">
            </label>
            <div class="pm2-field pm2-field-wide">
              <span class="pm2-label">Courts in play</span>
              <div class="pm2-court-options">
                ${courtOptions || `<div class="pm2-alert">Add at least one court in Court Management first.</div>`}
              </div>
            </div>
            <fieldset class="pm2-field pm2-field-wide pm2-mode-field">
              <legend class="pm2-label">Rotation style</legend>
              <div class="pm2-mode-options">
                <label class="pm2-mode-option is-featured">
                  <input type="radio" name="mode" value="${ADAPTIVE_COMPETITIVE_MODE}" ${mode === ADAPTIVE_COMPETITIVE_MODE ? "checked" : ""}>
                  <span><strong>Adaptive Competitive Mixer <em>Recommended</em></strong><small>Equalizes games first, blocks recent partner repeats, builds closely balanced teams, and schedules tied players as opponents.</small></span>
                </label>
                <label class="pm2-mode-option">
                  <input type="radio" name="mode" value="smart_random_mixer" ${mode === "smart_random_mixer" ? "checked" : ""}>
                  <span><strong>Fair Random</strong><small>Prioritizes fewer games, then queue order. Randomizes matchups and reduces repeat partners.</small></span>
                </label>
                <label class="pm2-mode-option">
                  <input type="radio" name="mode" value="all_rotate" ${mode === "all_rotate" ? "checked" : ""}>
                  <span><strong>Queue order</strong><small>Keeps the roster moving in a predictable sequence.</small></span>
                </label>
              </div>
            </fieldset>
            <fieldset class="pm2-field pm2-field-wide pm2-ranking-field">
              <legend class="pm2-label">Choose how the podium is ranked</legend>
              <div class="pm2-ranking-options">
                <label class="pm2-ranking-option">
                  <input type="radio" name="rankingMode" value="${RANKING_MODE_COMPETITIVE}" ${rankingMode === RANKING_MODE_COMPETITIVE ? "checked" : ""}>
                  <span class="pm2-ranking-option-copy">
                    <span class="pm2-ranking-option-title">
                      <strong>Competitive Ranking</strong>
                      <em>Recommended</em>
                    </span>
                    <small>Exact Elo performance first, then Win %, wins, head-to-head, opponent strength, and best upset.</small>
                    <b>Best for a decisive official podium</b>
                  </span>
                </label>
                <label class="pm2-ranking-option">
                  <input type="radio" name="rankingMode" value="${RANKING_MODE_PERFORMANCE}" ${rankingMode === RANKING_MODE_PERFORMANCE ? "checked" : ""}>
                  <span class="pm2-ranking-option-copy">
                    <span class="pm2-ranking-option-title">
                      <strong>Performance Rating (Elo)</strong>
                    </span>
                    <small>Opponent-adjusted Session Points. Strong upsets earn more; expected wins earn less.</small>
                    <b>Best for the fairest competitive podium</b>
                  </span>
                </label>
                <label class="pm2-ranking-option">
                  <input type="radio" name="rankingMode" value="${RANKING_MODE_WIN_PERCENTAGE}" ${rankingMode === RANKING_MODE_WIN_PERCENTAGE ? "checked" : ""}>
                  <span class="pm2-ranking-option-copy">
                    <span class="pm2-ranking-option-title">
                      <strong>Win Percentage</strong>
                    </span>
                    <small>Wins divided by games played. Every win has the same value, regardless of opponent.</small>
                    <b>Best when players want the simplest rule</b>
                  </span>
                </label>
              </div>
              ${isRestart ? `<p class="pm2-ranking-lock-note">Changing the ranking starts a revised session. Existing rounds and results stay preserved.</p>` : `<p class="pm2-ranking-lock-note">Choose before starting play. The scoring method is locked once the first round begins.</p>`}
            </fieldset>
            <section
              class="pm2-rating-explainer pm2-field-wide"
              id="pm2RatingExplainer"
              data-ranking-mode="${rankingMode}"
              aria-labelledby="pm2RatingTitle"
            >${rankingExplainerMarkup(rankingMode)}</section>
            <label class="pm2-field pm2-field-wide">
              <span class="pm2-label">Checked-in players · one name per line</span>
              <textarea class="pm2-textarea" id="pm2Names" name="names" placeholder="Alex Santos&#10;Bea Reyes&#10;Carlo Mendoza&#10;Dana Cruz">${escapeHtml(names.join("\n"))}</textarea>
            </label>
            <div class="pm2-form-actions">
              <div class="pm2-form-actions-left">
                <button class="pm2-btn pm2-btn-light" type="button" data-pm-action="import-paid">Import Paid</button>
                <button class="pm2-btn pm2-btn-light" type="button" data-pm-action="sample-roster">Use Demo Roster</button>
              </div>
              <div class="pm2-form-actions-right">
                ${state.session ? `<button class="pm2-btn pm2-btn-light" type="button" data-pm-action="new-session">Clear</button>` : ""}
                <button class="pm2-btn pm2-btn-primary" type="submit" aria-describedby="pm2RatingExplainer">${isRestart ? "Start Revised Session" : "Start Live Play"} →</button>
              </div>
            </div>
          </div>
        </form>
        <aside class="pm2-panel pm2-summary-card">
          <div class="pm2-summary-hero">
            <span>Ready check</span>
            <h3>Session Preview</h3>
          </div>
          <div class="pm2-summary-list">
            <div class="pm2-summary-row"><span>Date</span><b id="pm2SummaryDate">${escapeHtml(formatDate(date))}</b></div>
            <div class="pm2-summary-row"><span>Courts</span><b id="pm2SummaryCourts">${selectedIds.length}</b></div>
            <div class="pm2-summary-row"><span>Players</span><b id="pm2SummaryPlayers">${names.length}</b></div>
            <div class="pm2-summary-row"><span>Matches now</span><b id="pm2SummaryMatches">${Math.min(selectedIds.length, Math.floor(names.length / 4))}</b></div>
            <div class="pm2-summary-row"><span>Podium</span><b id="pm2SummaryRanking">${scoring.summary}</b></div>
          </div>
          <div class="pm2-ready-note is-warn" id="pm2ReadyNote">Choose at least one court and enter four players.</div>
        </aside>
      </div>
    `;
  }

  function courtPlayerRow(id, courtIndex, team, slotIndex, locked) {
    const name = playerName(id);
    const actionLabel = `Replace or remove ${name}`;
    const skillLevel = playerSkillLevel(id);
    const skillSummary = skillLabel(skillLevel);
    return `
      <div class="pm2-player">
        <button
          class="pm2-player-identity"
          type="button"
          data-pm-action="edit-player-skill"
          data-player-id="${escapeHtml(id)}"
          aria-label="Open ${escapeHtml(name)} player profile, ${escapeHtml(skillSummary)}"
          title="Open ${escapeHtml(name)} profile"
          ${locked ? "disabled" : ""}
        >
          <span class="pm2-player-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span
            class="pm2-player-skill"
            aria-hidden="true"
          >
            <span class="pm2-player-skill-icon" aria-hidden="true">★</span>
            <b aria-hidden="true">${skillLevel}</b>
          </span>
        </button>
        <button
          class="pm2-player-replace"
          type="button"
          data-pm-action="replace-player"
          data-court-index="${courtIndex}"
          data-team="${team}"
          data-slot-index="${slotIndex}"
          data-outgoing-id="${escapeHtml(id)}"
          aria-label="${escapeHtml(actionLabel)}"
          aria-haspopup="dialog"
          aria-controls="pm2ReplaceDialog"
          title="${locked ? `${escapeHtml(name)} can no longer be changed` : escapeHtml(actionLabel)}"
          ${locked ? "disabled" : ""}
        >×</button>
      </div>
    `;
  }

  function matchQualityMarkup(quality, compact = false) {
    if (!quality || typeof quality !== "object") return "";
    const expectedA = Math.max(0, Math.min(100, Number(quality.expectedTeamA) || 50));
    const expectedB = Math.max(0, Math.min(100, Number(quality.expectedTeamB) || (100 - expectedA)));
    const gameCounts = (quality.gameCounts || []).map(Number).filter(Number.isFinite);
    const gamesBalanced = !gameCounts.length || Math.max(...gameCounts) - Math.min(...gameCounts) <= 1;
    const partnerLabel = Number(quality.recentPartnerRepeats || 0) === 0
      ? "New partners"
      : "Best available partners";
    return `
      <div class="pm2-match-quality ${compact ? "is-compact" : ""}" aria-label="Adaptive match quality">
        <span class="is-balance">${expectedA}%&ndash;${expectedB}% balance</span>
        <span>${escapeHtml(partnerLabel)}</span>
        ${gamesBalanced ? "<span>Games balanced</span>" : ""}
        ${quality.challenge ? '<span class="is-challenge">Ranking challenge</span>' : ""}
      </div>
    `;
  }

  function readyCourtCard(game, index, sessionStatus) {
    const complete = hasReadyMatch(game);
    const active = sessionStatus === "active";
    const gameNo = (game.completedGames || []).length + 2;
    return `
      <article class="pm2-court-card pm2-ready-card is-ready" data-pm-court-index="${index}">
        <div class="pm2-court-bar pm2-ready-bar">
          <strong class="pm2-court-name">${escapeHtml(game.courtName || `Court ${index + 1}`)}</strong>
          <div class="pm2-court-state">
            <span class="pm2-live-pill is-ready">READY</span>
            <span class="pm2-timer">Game ${gameNo}</span>
          </div>
        </div>
        <div
          class="pm2-ready-court"
          aria-label="${complete ? "Next match is ready" : "Choose four players for the next match"}"
        >
          ${matchQualityMarkup(game.readyMatch?.matchQuality, true)}
          <div class="pm2-ready-actions">
            <button
              class="pm2-ready-start"
              type="button"
              data-pm-action="start-match"
              data-court-index="${index}"
              ${active && complete ? "" : "disabled"}
            >Start match</button>
            <button
              class="pm2-ready-choose"
              type="button"
              data-pm-action="choose-players"
              data-court-index="${index}"
              aria-haspopup="dialog"
              aria-controls="pm2ChooseDialog"
              ${active ? "" : "disabled"}
            >${complete ? "Change players" : "Choose players"}</button>
          </div>
        </div>
      </article>
    `;
  }

  function courtCard(game, index) {
    const winner = game.winner || "";
    const sessionStatus = String(state.session?.status || "active");
    const sessionActive = sessionStatus === "active";
    if (winner && ["active", "paused"].includes(sessionStatus)) {
      return readyCourtCard(game, index, sessionStatus);
    }
    const replacementLocked = !!winner || !sessionActive;
    const courtStatus = winner
      ? { label: "FINAL", className: "is-done", detail: "" }
      : sessionStatus === "paused"
        ? { label: "PAUSED", className: "is-paused", detail: "Paused" }
        : sessionActive
          ? { label: "LIVE", className: "", detail: "" }
          : { label: "ENDED", className: "is-ended", detail: "Session ended" };
    const cardStateClass = winner
      ? "is-final"
      : sessionStatus === "paused"
        ? "is-paused"
        : sessionActive
          ? "is-live"
          : "is-ended";
    const pastGames = (game.completedGames || []).length;
    const teamASkill = teamSkillTotal(game.teamA);
    const teamBSkill = teamSkillTotal(game.teamB);
    return `
      <article class="pm2-court-card ${cardStateClass}" data-pm-court-index="${index}">
        <div class="pm2-court-bar">
          <strong class="pm2-court-name">${escapeHtml(game.courtName || `Court ${index + 1}`)}</strong>
          <div class="pm2-court-state">
            <span class="pm2-live-pill ${courtStatus.className}">${courtStatus.label}</span>
            ${winner
              ? `<span class="pm2-timer">Game ${pastGames + 1}</span>`
              : sessionActive
                ? `<span class="pm2-timer" data-pm-start="${escapeHtml(game.startedAt || "")}">00:00</span>`
                : `<span class="pm2-timer">${courtStatus.detail}</span>`
            }
          </div>
        </div>
        <div class="pm2-match">
          <div class="pm2-team pm2-team-a ${winner === "A" ? "is-winner" : ""}" data-pm-team="A">
            <div class="pm2-team-title">
              <span class="pm2-team-heading">
                <span>Team 1</span>
                <span class="pm2-team-skill-total" aria-label="Team 1 combined skill ${teamASkill}">★ ${teamASkill}</span>
              </span>
              <b class="pm2-team-win-badge">WIN</b>
            </div>
            <span class="pm2-winner-sparks" aria-hidden="true"></span>
            <div class="pm2-roster">
              ${(game.teamA || []).map((id, slotIndex) => courtPlayerRow(id, index, "A", slotIndex, replacementLocked)).join("")}
            </div>
          </div>
          <div class="pm2-vs">VS</div>
          <div class="pm2-team pm2-team-b ${winner === "B" ? "is-winner" : ""}" data-pm-team="B">
            <div class="pm2-team-title">
              <span class="pm2-team-heading">
                <span>Team 2</span>
                <span class="pm2-team-skill-total" aria-label="Team 2 combined skill ${teamBSkill}">★ ${teamBSkill}</span>
              </span>
              <b class="pm2-team-win-badge">WIN</b>
            </div>
            <span class="pm2-winner-sparks" aria-hidden="true"></span>
            <div class="pm2-roster">
              ${(game.teamB || []).map((id, slotIndex) => courtPlayerRow(id, index, "B", slotIndex, replacementLocked)).join("")}
            </div>
          </div>
        </div>
        ${matchQualityMarkup(game.matchQuality)}
        <div class="pm2-result-actions">
          ${winner ? `
            <div class="pm2-result-note">${winner === "A" ? "Team 1" : "Team 2"} won${pastGames ? ` · ${pastGames + 1} games completed here` : ""}</div>
          ` : sessionActive ? `
            <button class="pm2-result-btn team-a" type="button" data-pm-action="winner" data-court-index="${index}" data-side="A">Team 1 Wins</button>
            <button class="pm2-result-btn team-b" type="button" data-pm-action="winner" data-court-index="${index}" data-side="B">Team 2 Wins</button>
          ` : `
            <div class="pm2-result-note">${sessionStatus === "paused" ? "Results are locked while the session is paused." : "No result was recorded before this session ended."}</div>
          `}
        </div>
      </article>
    `;
  }

  function dispatchSplit(playerIds, history = buildHistory()) {
    const ids = unique(playerIds || []);
    if (ids.length !== 4) {
      return {
        teamA: ids.slice(0, 2),
        teamB: ids.slice(2, 4),
      };
    }
    const split = bestSplit(ids.map(id => ({ id })), history, false);
    return {
      teamA: split.teamA.map(player => asId(player.id)),
      teamB: split.teamB.map(player => asId(player.id)),
    };
  }

  function nextDispatchSlots(assignments, queue) {
    const history = buildHistory();
    const slotCount = Math.max(assignments.length, sessionCourtIds().length);
    const ready = assignments
      .map((game, courtIndex) => ({ game, courtIndex }))
      .filter(item => hasReadyMatch(item.game))
      .sort((left, right) => {
        const leftTime = Date.parse(left.game.readyMatch?.reservedAt || "");
        const rightTime = Date.parse(right.game.readyMatch?.reservedAt || "");
        const leftOrder = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.courtIndex - right.courtIndex;
      })
      .map(({ game, courtIndex }) => ({
        kind: "ready",
        courtIndex,
        courtName: game.courtName || `Court ${courtIndex + 1}`,
        playerIds: readyMatchQueueOrder(game),
        teamA: (game.readyMatch?.teamA || []).map(asId),
        teamB: (game.readyMatch?.teamB || []).map(asId),
        reservedAt: game.readyMatch?.reservedAt || game.resultAt || "",
        matchQuality: game.readyMatch?.matchQuality || null,
      }));

    const previewCount = Math.max(0, slotCount - ready.length);
    let previews;
    if (isAdaptiveCompetitiveRotation() && previewCount && queue.length >= 4) {
      const previewCourtIds = Array.from(
        { length: Math.min(previewCount, Math.floor(queue.length / 4)) },
        (_, index) => `preview-${index + 1}`
      );
      const generated = adaptiveRotationAssignments(queue, previewCourtIds);
      previews = generated.assignments.map(match => ({
        kind: "preview",
        courtIndex: null,
        courtName: "",
        playerIds: [...match.teamA, ...match.teamB].map(asId),
        teamA: match.teamA.map(asId),
        teamB: match.teamB.map(asId),
        reservedAt: "",
        matchQuality: match.matchQuality || null,
      }));
      while (previews.length < previewCount) {
        const used = new Set(previews.flatMap(slot => slot.playerIds));
        const playerIds = queue.filter(id => !used.has(asId(id))).slice(0, 4).map(asId);
        const teams = dispatchSplit(playerIds, history);
        previews.push({
          kind: playerIds.length === 4 ? "preview" : "waiting",
          courtIndex: null,
          courtName: "",
          playerIds,
          teamA: teams.teamA,
          teamB: teams.teamB,
          reservedAt: "",
          matchQuality: null,
        });
      }
    } else {
      previews = Array.from({ length: previewCount }, (_, index) => {
        const playerIds = queue.slice(index * 4, index * 4 + 4).map(asId);
        const teams = dispatchSplit(playerIds, history);
        return {
          kind: playerIds.length === 4 ? "preview" : "waiting",
          courtIndex: null,
          courtName: "",
          playerIds,
          teamA: teams.teamA,
          teamB: teams.teamB,
          reservedAt: "",
          matchQuality: null,
        };
      });
    }

    return [...ready, ...previews].map((slot, index) => ({
      ...slot,
      order: index + 1,
    }));
  }

  function dispatchPlayerMarkup(id) {
    if (!id) {
      return `<span class="pm2-dispatch-player is-empty" aria-hidden="true">Open slot</span>`;
    }
    const name = playerName(id);
    const level = playerSkillLevel(id);
    return `
      <button
        class="pm2-dispatch-player"
        type="button"
        data-pm-action="edit-player-skill"
        data-player-id="${escapeHtml(id)}"
        aria-label="Open ${escapeHtml(name)} player profile"
      >
        <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <b aria-label="${level} star skill">★${level}</b>
      </button>
    `;
  }

  function dispatchTeamMarkup(label, playerIds) {
    const ids = (playerIds || []).map(asId);
    const total = ids.reduce((sum, id) => sum + playerSkillLevel(id), 0);
    return `
      <section class="pm2-dispatch-team" aria-label="${escapeHtml(label)}">
        <div class="pm2-dispatch-team-head">
          <span>${escapeHtml(label)}</span>
          <b aria-label="${escapeHtml(label)} combined skill ${total}">★ ${total || "—"}</b>
        </div>
        <div class="pm2-dispatch-team-players">
          ${[ids[0], ids[1]].map(dispatchPlayerMarkup).join("")}
        </div>
      </section>
    `;
  }

  function dispatchTime(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "";
  }

  function dispatchCardMarkup(slot, sessionStatus) {
    const ready = slot.kind === "ready";
    const complete = slot.playerIds.length === 4;
    const missing = Math.max(0, 4 - slot.playerIds.length);
    const statusLabel = ready ? "READY" : complete ? "AUTO" : "WAITING";
    const eyebrow = ready ? "Open court" : complete ? `Next group ${slot.order}` : `Queue group ${slot.order}`;
    const title = ready ? slot.courtName : complete ? "Any open court" : `Need ${missing} more`;
    const detail = ready
      ? `Reserved at ${dispatchTime(slot.reservedAt) || "now"}`
      : complete
        ? "Auto-assigns to the first court that opens"
        : `${slot.playerIds.length} of 4 players available`;
    return `
      <article class="pm2-dispatch-card is-${slot.kind}" data-pm-dispatch-order="${slot.order}">
        <header class="pm2-dispatch-card-head">
          <span class="pm2-dispatch-order" aria-hidden="true">${slot.order}</span>
          <div class="pm2-dispatch-card-title">
            <span>${escapeHtml(eyebrow)}</span>
            <strong>${escapeHtml(title)}</strong>
          </div>
          <span class="pm2-dispatch-status">${statusLabel}</span>
        </header>
        <div class="pm2-dispatch-matchup">
          ${dispatchTeamMarkup("Team 1", slot.teamA)}
          ${dispatchTeamMarkup("Team 2", slot.teamB)}
        </div>
        ${matchQualityMarkup(slot.matchQuality, true)}
        <footer class="pm2-dispatch-footer">
          <span class="pm2-dispatch-detail">${escapeHtml(detail)}</span>
          ${ready ? `
            <div class="pm2-dispatch-actions">
              <button
                class="pm2-btn pm2-btn-light pm2-dispatch-change"
                type="button"
                data-pm-action="choose-players"
                data-court-index="${slot.courtIndex}"
                aria-haspopup="dialog"
                aria-controls="pm2ChooseDialog"
                ${sessionStatus === "active" ? "" : "disabled"}
              >Change</button>
              <button
                class="pm2-btn pm2-btn-primary pm2-dispatch-start"
                type="button"
                data-pm-action="start-match"
                data-court-index="${slot.courtIndex}"
                title="Start match on ${escapeHtml(slot.courtName)}"
                ${sessionStatus === "active" ? "" : "disabled"}
              >Start on ${escapeHtml(slot.courtName)}</button>
            </div>
          ` : ""}
        </footer>
      </article>
    `;
  }

  function nextDispatchMarkup(slots, sessionStatus) {
    return `
      <div class="pm2-dispatch-grid" aria-label="${slots.length} upcoming court slots">
        ${slots.map(slot => dispatchCardMarkup(slot, sessionStatus)).join("")}
      </div>
    `;
  }

  function queueMarkup(queue) {
    if (!queue.length) {
      return `<div class="pm2-empty" style="min-height:90px;padding:12px;color:#9ca3af">Everyone is on court.</div>`;
    }
    const performanceById = Object.fromEntries(
      standingsRows(completedMatches()).map(row => [asId(row.id), row])
    );
    const scrollAttributes = queue.length > 10
      ? `tabindex="0" aria-label="Player queue, ${queue.length} players. Scroll for more."`
      : `aria-label="Player queue, ${queue.length} players."`;
    return `<div class="pm2-queue-list pm2-scroll-region" data-pm-scroll-key="queue" role="list" ${scrollAttributes}>${queue.map((id, index) => {
      const player = playerRecord(id);
      const playerId = asId(id);
      const performance = performanceById[playerId];
      const games = performance?.games || 0;
      const display = standingDisplay(performance);
      const waitStartedAt = player?.queue_entered_at || "";
      const isLast = index === queue.length - 1;
      const name = playerName(id);
      const skillLevel = playerSkillLevel(player);
      const skillSummary = skillLabel(skillLevel);
      return `
        <div class="pm2-queue-row" role="listitem">
          <span class="pm2-queue-no" aria-hidden="true">${index + 1}</span>
          <button
            class="pm2-queue-player pm2-queue-profile-button"
            type="button"
            data-pm-action="edit-player-skill"
            data-player-id="${escapeHtml(id)}"
            aria-label="Open ${escapeHtml(name)} player profile"
            title="Open ${escapeHtml(name)} profile"
            ${state.session?.status === "active" ? "" : "disabled"}
          >
            <span class="pm2-queue-name-row">
              <strong class="pm2-queue-name">${escapeHtml(name)}</strong>
              <span class="pm2-queue-wait" aria-label="Waiting time">
                <span aria-hidden="true">&#9203;</span>
                <span data-pm-wait-start="${escapeHtml(waitStartedAt)}">${waitStartedAt ? "0:00" : "&mdash;"}</span>
              </span>
            </span>
            <span class="pm2-queue-meta">
              <span>${games} ${games === 1 ? "game" : "games"}</span>
              <span aria-hidden="true">·</span>
              <span class="${display.tone}">${display.compactScore}</span>
            </span>
          </button>
          ${state.session?.status === "active"
            ? `<div class="pm2-queue-actions">
                <button
                  class="pm2-queue-skill"
                  type="button"
                  data-pm-action="edit-player-skill"
                  data-player-id="${escapeHtml(id)}"
                  aria-label="Open ${escapeHtml(name)} player profile, ${escapeHtml(skillSummary)}"
                  title="${escapeHtml(skillSummary)}"
                >
                  <span aria-hidden="true">&#9733;</span>
                  <b>${skillLevel}</b>
                </button>
                <button class="pm2-queue-skip" type="button" data-pm-action="skip-player" data-player-id="${escapeHtml(id)}" aria-label="${isLast ? `${escapeHtml(name)} is already last in the queue` : `Move ${escapeHtml(name)} to the back of the queue`}" ${isLast ? "disabled" : ""}>${isLast ? "Last" : "Skip"}</button>
              </div>`
            : ""}
        </div>
      `;
    }).join("")}</div>`;
  }

  function standingsRows(matches) {
    if (!PERFORMANCE?.calculateStandings) {
      throw new Error("The Open Play ranking engine did not load.");
    }
    const activeIds = new Set(activePlayers().map(player => asId(player.id)));
    const rows = PERFORMANCE
      .calculateStandings(state.players, matches, {
        minGames: PERFORMANCE.MIN_PODIUM_GAMES,
        mode: sessionRankingMode(),
      })
      .filter(row => activeIds.has(asId(row.id)) || row.games > 0);
    const eligibleRankCounts = new Map();
    rows.forEach(row => {
      if (!row.eligible || !row.rank) return;
      const rankKey = String(row.rank);
      eligibleRankCounts.set(rankKey, (eligibleRankCounts.get(rankKey) || 0) + 1);
    });
    return rows.map(row => ({
      ...row,
      sharedRank: Boolean(
        row.eligible &&
        row.rank &&
        eligibleRankCounts.get(String(row.rank)) > 1
      ),
    }));
  }

  function standingsMarkup(rows) {
    if (!rows.length) {
      return `<div class="pm2-empty" style="min-height:90px;padding:12px">Standings appear after play begins.</div>`;
    }
    const scrollAttributes = rows.length > 4
      ? `tabindex="0" aria-label="Player standings, ${rows.length} players. Scroll for more."`
      : `aria-label="Player standings, ${rows.length} players."`;
    return `${podiumDeciderNotice(rows)}<div class="pm2-standings-list pm2-scroll-region" data-pm-scroll-key="standings" role="list" ${scrollAttributes}>${rows.map(row => {
      const display = standingDisplay(row);
      const reason = standingRankingReason(row);
      const decider = requiresPodiumDecider(row);
      return `
        <div class="pm2-standing-row ${row.eligible ? "is-qualified" : "is-provisional"} ${decider ? "is-decider" : ""}" role="listitem">
          <span class="pm2-standing-no" aria-label="${escapeHtml(standingRankDescription(row))}">${standingRankLabel(row)}</span>
          <span class="pm2-standing-name">
            <strong>${escapeHtml(row.name)}</strong>
            <small>${decider ? "Decider required" : row.eligible ? "Qualified" : `${row.games} of ${PERFORMANCE.MIN_PODIUM_GAMES} games`}${reason ? ` &middot; ${escapeHtml(reason)}` : ""}</small>
          </span>
          <span class="pm2-standing-score ${display.tone}">
            <strong aria-label="${display.aria}">${display.score}</strong>
            <small>${display.label} &middot; ${display.meta}</small>
          </span>
        </div>
      `;
    }).join("")}</div>`;
  }

  function playerInitials(name) {
    return String(name || "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part.charAt(0))
      .join("")
      .toUpperCase() || "PR";
  }

  function finalPodiumMarkup(rows) {
    const places = ["Champion", "Runner-up", "Third place"];
    const leaders = PERFORMANCE.podiumRows(rows);
    if (!leaders.length) {
      return `<div class="pm2-empty pm2-final-empty">No player completed the required ${PERFORMANCE.MIN_PODIUM_GAMES} games. The provisional standings are preserved below.</div>`;
    }
    return `
      <div class="pm2-final-podium" role="list" aria-label="Podium players">
        ${leaders.map((row, index) => {
          const rank = Number(row.rank || index + 1);
          const display = standingDisplay(row);
          const decider = requiresPodiumDecider(row);
          const reason = standingRankingReason(row);
          return `
            <article class="pm2-podium-card is-rank-${Math.min(rank, 3)} ${decider ? "is-decider" : ""}" role="listitem">
              <div class="pm2-podium-rank" aria-label="${escapeHtml(standingRankDescription(row))}">${standingRankLabel(row)}</div>
              <div class="pm2-podium-avatar" aria-hidden="true">${escapeHtml(playerInitials(row.name))}</div>
              <span class="pm2-podium-place">${decider ? "Podium decider" : places[Math.min(rank, 3) - 1]}</span>
              <h3 title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</h3>
              <div class="pm2-podium-record ${display.tone}">
                <strong aria-label="${display.aria}">${display.score}</strong>
                <span>${display.label.toLowerCase()}</span>
              </div>
              <div class="pm2-podium-meta">
                <span>${row.games} ${row.games === 1 ? "game" : "games"}</span>
                <span>${display.meta}</span>
              </div>
              ${reason ? `<p class="pm2-podium-reason">${escapeHtml(reason)}</p>` : ""}
            </article>
          `;
        }).join("")}
      </div>
    `;
  }

  function finalLeaderboardMarkup(rows) {
    const podiumIds = new Set(PERFORMANCE.podiumRows(rows).map(row => asId(row.id)));
    const remaining = rows.filter(row => !podiumIds.has(asId(row.id)));
    if (!remaining.length) {
      return `<div class="pm2-empty pm2-final-empty">The podium contains the full leaderboard.</div>`;
    }
    const hasSharedRanks = remaining.some(row => row.sharedRank);
    return `
      ${hasSharedRanks ? `<p class="pm2-rank-legend"><strong>T</strong> means players share the same competitive rank.</p>` : ""}
      <div
        class="pm2-final-list pm2-scroll-region"
        data-pm-scroll-key="final-standings"
        role="list"
        tabindex="0"
        aria-label="Full individual standings"
      >
        ${remaining.map(row => {
          const display = standingDisplay(row);
          const decider = requiresPodiumDecider(row);
          const reason = standingRankingReason(row);
          return `
            <div class="pm2-final-row ${row.eligible ? "is-qualified" : "is-provisional"} ${decider ? "is-decider" : ""}" role="listitem">
              <span class="pm2-final-rank" aria-label="${escapeHtml(standingRankDescription(row))}">${standingRankLabel(row)}</span>
              <span class="pm2-final-avatar" aria-hidden="true">${escapeHtml(playerInitials(row.name))}</span>
              <span class="pm2-final-player">
                <strong title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</strong>
                <small>${decider ? "Decider required" : row.eligible ? "Qualified" : "Provisional"} &middot; ${row.games} ${row.games === 1 ? "game" : "games"}${reason ? ` &middot; ${escapeHtml(reason)}` : ""}</small>
              </span>
              <span class="pm2-final-score ${display.tone}">
                <strong>${display.compactScore}</strong>
                <small>${display.meta}</small>
              </span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function completedSessionMarkup(matches, standings) {
    const qualifiedCount = standings.filter(row => row.eligible).length;
    const scoring = rankingCopy();
    const rankingTitle = standings.length > PERFORMANCE.podiumRows(standings).length
      ? "Complete rankings"
      : "Everyone qualified for the podium";
    return `
      <div class="pm2-final-view">
        <section class="pm2-final-hero" aria-labelledby="pm2FinalTitle">
          <div class="pm2-final-hero-copy">
            <span class="pm2-final-kicker">Session complete</span>
            <h1 id="pm2FinalTitle">Session leaders</h1>
            <p>${escapeHtml(sessionTitle())}</p>
          </div>
          <div class="pm2-final-actions">
            <button class="pm2-btn pm2-btn-share" type="button" data-pm-action="share-live">Share Final Results</button>
            <button class="pm2-btn pm2-btn-primary pm2-btn-download" type="button" data-pm-action="download-result">Download branded result</button>
            <button class="pm2-btn pm2-btn-dark" type="button" data-pm-action="export">Export CSV</button>
            <button class="pm2-btn pm2-btn-dark" type="button" data-pm-action="new-session">Start new session</button>
          </div>
          <div class="pm2-final-stats" aria-label="Completed session summary">
            <div><strong>${matches.length}</strong><span>Matches played</span></div>
            <div><strong>${qualifiedCount}</strong><span>Podium qualified</span></div>
            <div><strong>${averageGameDuration()}</strong><span>Average game</span></div>
          </div>
        </section>

        <section class="pm2-final-podium-stage" aria-labelledby="pm2PodiumTitle">
          <div class="pm2-final-section-head">
            <div>
              <span>Individual scoring &middot; ${scoring.badge}</span>
              <h2 id="pm2PodiumTitle">${scoring.podium}</h2>
            </div>
            <p>${scoring.completedDescription}</p>
          </div>
          ${podiumDeciderNotice(standings)}
          ${finalPodiumMarkup(standings)}
        </section>

        <div class="pm2-final-grid">
          <section class="pm2-panel pm2-final-rankings" id="pm2FinalRankings">
            <div class="pm2-panel-head">
              <div class="pm2-final-panel-title">
                <span>Full leaderboard</span>
                <h3>${rankingTitle}</h3>
              </div>
              <button class="pm2-mini-action" type="button" data-pm-action="export">Export CSV</button>
            </div>
            <div class="pm2-panel-body">${finalLeaderboardMarkup(standings)}</div>
          </section>

          <section class="pm2-panel pm2-final-match-log" id="pm2MatchLog">
            <div class="pm2-panel-head">
              <div class="pm2-final-panel-title">
                <span>Results archive</span>
                <h3>Match log</h3>
              </div>
              <span>${matches.length} completed</span>
            </div>
            <div class="pm2-panel-body">${matchLogMarkup(matches)}</div>
          </section>
        </div>
      </div>
    `;
  }

  function matchTimeMarkup(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const label = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(label)}</time>`;
  }

  function matchTeamName(ids) {
    return (ids || []).map(playerName).join(" & ") || "Team";
  }

  function canCorrectMatchWinner() {
    const status = String(state.session?.status || "");
    const role = window.Auth?.getSession?.()?.role || "";
    if (["active", "paused"].includes(status)) {
      return ["owner", "court_owner", "staff"].includes(role);
    }
    return status === "completed" && role === "owner";
  }

  function makeWinnerButton(match, team, teamName) {
    if (!canCorrectMatchWinner() || match.winner === team) return "";
    const teamLabel = team === "A" ? "Team 1" : "Team 2";
    return `
      <button
        class="pm2-match-make-winner"
        type="button"
        data-pm-action="correct-winner"
        data-round-id="${escapeHtml(match.roundId)}"
        data-court-index="${match.courtIndex}"
        data-completed-game-index="${match.completedGameIndex ?? ""}"
        data-current-winner="${escapeHtml(match.winner)}"
        data-new-winner="${team}"
        aria-label="Make ${teamLabel}, ${escapeHtml(teamName)}, the winner"
      >Make winner</button>
    `;
  }

  function matchLogMarkup(matches) {
    if (!matches.length) {
      return `<div class="pm2-empty pm2-match-log-empty">Completed matches will appear here.</div>`;
    }
    const scrollAttributes = matches.length > 4
      ? `tabindex="0" aria-label="Match log, ${matches.length} completed matches. Scroll for more."`
      : `aria-label="Match log, ${matches.length} completed matches."`;
    return `<div class="pm2-match-log-list pm2-scroll-region" data-pm-scroll-key="match-log" role="list" ${scrollAttributes}>${matches.map(match => {
      const teamAName = matchTeamName(match.teamA);
      const teamBName = matchTeamName(match.teamB);
      return `
        <article class="pm2-match-log-card" role="listitem">
          <div class="pm2-match-log-meta">
            <span class="pm2-match-round">R${match.roundNo}</span>
            <strong title="${escapeHtml(match.courtName)}">${escapeHtml(match.courtName)}</strong>
            ${match.corrected ? `<span class="pm2-match-corrected">Corrected</span>` : ""}
            ${matchTimeMarkup(match.resultAt)}
          </div>
          <div class="pm2-match-log-team is-team-a ${match.winner === "A" ? "is-winner" : ""}">
            <span>T1</span>
            <strong title="${escapeHtml(teamAName)}">${escapeHtml(teamAName)}</strong>
            ${match.winner === "A" ? "<b>WIN</b>" : makeWinnerButton(match, "A", teamAName)}
          </div>
          <div class="pm2-match-log-team is-team-b ${match.winner === "B" ? "is-winner" : ""}">
            <span>T2</span>
            <strong title="${escapeHtml(teamBName)}">${escapeHtml(teamBName)}</strong>
            ${match.winner === "B" ? "<b>WIN</b>" : makeWinnerButton(match, "B", teamBName)}
          </div>
        </article>
      `;
    }).join("")}</div>`;
  }

  function openWinnerCorrectionDialog(button) {
    if (!canCorrectMatchWinner()) {
      notify("You do not have permission to correct this result.", true);
      return;
    }
    const completedGameIndex = button.dataset.completedGameIndex === ""
      ? null
      : Number(button.dataset.completedGameIndex);
    const match = completedMatches().find(item =>
      item.roundId === asId(button.dataset.roundId) &&
      item.courtIndex === Number(button.dataset.courtIndex) &&
      item.completedGameIndex === completedGameIndex
    );
    if (!match) {
      notify("That match result is no longer available.", true);
      return;
    }
    const newWinner = button.dataset.newWinner === "B" ? "B" : "A";
    const targetPlayers = newWinner === "A" ? match.teamA : match.teamB;
    state.winnerCorrection = {
      roundId: match.roundId,
      courtIndex: match.courtIndex,
      completedGameIndex: match.completedGameIndex,
      expectedWinner: match.winner,
      newWinner,
      courtName: match.courtName,
      roundNo: match.roundNo,
      teamName: matchTeamName(targetPlayers),
      teamLabel: newWinner === "A" ? "Team 1" : "Team 2",
    };
    state.winnerCorrectionTrigger = button;
    const dialog = root()?.querySelector("#pm2WinnerDialog");
    const matchLabel = dialog?.querySelector("#pm2WinnerMatchLabel");
    const teamLabel = dialog?.querySelector("#pm2WinnerTeamLabel");
    if (matchLabel) {
      matchLabel.textContent = `Round ${match.roundNo} · ${match.courtName}`;
    }
    if (teamLabel) {
      teamLabel.textContent = `Make ${state.winnerCorrection.teamLabel} — ${state.winnerCorrection.teamName} the winner?`;
    }
    dialog?.showModal();
  }

  async function correctMatchWinner() {
    const correction = state.winnerCorrection;
    if (!correction) return;
    const roundIndex = state.rounds.findIndex(round => asId(round.id) === correction.roundId);
    const round = state.rounds[roundIndex];
    if (!round) throw new Error("That match result is no longer available.");
    if (typeof DB.correctOpenPlayGameMatchWinner !== "function") {
      throw new Error("Apply the latest Play Manager database migration before correcting match winners.");
    }

    let saved;
    try {
      saved = await DB.correctOpenPlayGameMatchWinner(
        round.id,
        { assignments: liveAssignments(round) },
        correction
      );
    } catch (error) {
      const message = String(error?.message || "");
      if (error?.code === "40001" || message.includes("PLAY_MANAGER_ROUND_CONFLICT") || message.includes("PLAY_MANAGER_WINNER_CORRECTION_CHANGED")) {
        await refreshState("live");
        state.winnerCorrection = null;
        state.winnerCorrectionTrigger = null;
        renderShell();
        throw new Error("This match changed on another screen. The latest result is now loaded.");
      }
      if (message.includes("OWNER_REQUIRED")) {
        throw new Error("Only the system owner can correct a completed session.");
      }
      if (message.includes("FORBIDDEN")) {
        throw new Error("You do not have permission to correct this result.");
      }
      throw error;
    }

    if (!saved?.id) throw new Error("The corrected winner could not be saved.");
    state.rounds[roundIndex] = saved;
    root()?.querySelector("#pm2WinnerDialog")?.close();
    renderShell();
    notify(`${correction.teamLabel} is now the winner. ${rankingCopy().name} standings updated.`);
  }

  function renderLive() {
    const round = lastRound();
    const assignments = liveAssignments(round);
    const queue = roundQueue(round);
    const dispatchSlots = nextDispatchSlots(assignments, queue);
    const matches = completedMatches();
    const standings = standingsRows(matches);
    const scoring = rankingCopy();
    const sessionStatus = String(state.session?.status || "active");
    if (sessionStatus === "completed") {
      return completedSessionMarkup(matches, standings);
    }
    const canShare = ["active", "paused"].includes(sessionStatus);
    const liveCourtCount = assignments.filter(isLiveGame).length;
    const readyCourtCount = assignments.filter(game => !!game.winner).length;
    const readyDispatchCount = dispatchSlots.filter(slot => slot.kind === "ready").length;
    const fullPreviewCount = dispatchSlots.filter(slot => slot.kind === "preview").length;
    const eyebrow = sessionStatus === "completed"
      ? "Session complete"
      : sessionStatus === "paused"
        ? "Session paused"
        : "Live open play";
    return `
      <div class="pm2-view-head">
        <div>
          <span class="pm2-eyebrow">${eyebrow}</span>
          <h1>${escapeHtml(sessionTitle())}</h1>
          <p>${scoring.liveDescription}</p>
        </div>
        <div class="pm2-session-meta">Round ${Number(round?.round_no || state.rounds.length)} · <span data-pm-clock>--:--</span></div>
      </div>
      <nav class="pm2-live-jump" aria-label="Jump to live section">
        <button type="button" data-pm-action="scroll" data-target="pm2Courts" aria-label="Courts, ${assignments.length}">
          <span>Courts</span><b aria-hidden="true">${assignments.length}</b>
        </button>
        <button type="button" data-pm-action="scroll" data-target="pm2Queue" aria-label="Queue, ${queue.length}">
          <span>Queue</span><b aria-hidden="true">${queue.length}</b>
        </button>
        <button type="button" data-pm-action="scroll" data-target="pm2Next" aria-label="Up Next, ${dispatchSlots.length}">
          <span>Up Next</span><b aria-hidden="true">${dispatchSlots.length}</b>
        </button>
        <button type="button" data-pm-action="scroll" data-target="pm2MatchLog" aria-label="Matches, ${matches.length}">
          <span>Matches</span><b aria-hidden="true">${matches.length}</b>
        </button>
      </nav>
      <div class="pm2-live-dashboard">
        <div class="pm2-round-strip">
          <div class="pm2-round-copy">
            <strong>Round ${Number(round?.round_no || state.rounds.length)}</strong>
            <span>${liveCourtCount} live · ${readyCourtCount} ready · ${headerNumbers().finished} result${headerNumbers().finished === 1 ? "" : "s"}</span>
          </div>
          <div class="pm2-round-actions">
            <button class="pm2-btn pm2-btn-share" type="button" data-pm-action="share-live" ${canShare ? "" : "disabled"}>${canShare ? "Share Live" : "Sharing Ended"}</button>
            <button class="pm2-btn pm2-btn-dark" type="button" data-pm-action="copy-text-update">Copy Text Update</button>
            <button class="pm2-btn pm2-btn-dark pm2-session-edit" type="button" data-pm-action="edit-setup">Edit Setup</button>
            <button
              class="pm2-btn pm2-session-end"
              type="button"
              data-pm-action="end-session"
              ${["active", "paused"].includes(sessionStatus) ? "" : "disabled"}
            >End Session</button>
          </div>
        </div>

        <section class="pm2-dashboard-section pm2-live-courts-section" aria-labelledby="pm2LiveCourtsTitle">
          <header class="pm2-section-heading">
            <div class="pm2-section-heading-copy">
              <span class="pm2-section-kicker">Live play</span>
              <h2 id="pm2LiveCourtsTitle">Live Courts</h2>
            </div>
            <div class="pm2-live-court-tools">
              <span class="pm2-section-status">${assignments.length} court${assignments.length === 1 ? "" : "s"} · ${liveCourtCount} live · ${readyCourtCount} ready</span>
              <div class="pm2-live-court-actions" aria-label="Live court actions">
                <button class="pm2-compact-action" type="button" data-pm-action="edit-setup">Setup</button>
                <button class="pm2-compact-action is-share" type="button" data-pm-action="share-live" ${canShare ? "" : "disabled"}>${canShare ? "Share" : "Ended"}</button>
              </div>
            </div>
          </header>
          <div class="pm2-courts" id="pm2Courts" aria-label="Live courts">
            ${assignments.map(courtCard).join("") || `<div class="pm2-panel pm2-empty">No court assignments yet.</div>`}
          </div>
        </section>

        <section class="pm2-dashboard-section pm2-matchmaking-section" aria-labelledby="pm2MatchmakingTitle">
          <header class="pm2-section-heading">
            <div class="pm2-section-heading-copy">
              <span class="pm2-section-kicker">Rotation workflow</span>
              <h2 id="pm2MatchmakingTitle">Matchmaking</h2>
            </div>
            <span class="pm2-section-status">${readyDispatchCount} ready · ${fullPreviewCount} queued · ${queue.length} waiting</span>
          </header>
          <div class="pm2-matchmaking-layout">
            <section class="pm2-panel pm2-queue-panel" id="pm2Queue">
              <div class="pm2-panel-head pm2-queue-head">
                <div class="pm2-queue-title">
                  <h3>Player Queue</h3>
                  <span>${queue.length} waiting</span>
                </div>
                <span class="pm2-queue-average">
                  <span>Avg. game</span>
                  <strong>${averageGameDuration()}</strong>
                </span>
                ${sessionStatus === "active"
                  ? `<button class="pm2-queue-add" type="button" data-pm-action="add-player"><span aria-hidden="true">+</span> Add player</button>`
                  : ""}
              </div>
              <div class="pm2-panel-body">${queueMarkup(queue)}</div>
            </section>
            <section class="pm2-panel pm2-next-panel pm2-dispatch-panel" id="pm2Next">
              <div class="pm2-panel-head pm2-dispatch-panel-head">
                <div>
                  <span class="pm2-dispatch-kicker">Court dispatch</span>
                  <h3>Up Next</h3>
                </div>
                <span>${readyDispatchCount} ready · ${fullPreviewCount} queued · ${dispatchSlots.length} slots</span>
              </div>
              <div class="pm2-panel-body">${nextDispatchMarkup(dispatchSlots, sessionStatus)}</div>
            </section>
          </div>
        </section>

        <section class="pm2-dashboard-section pm2-session-activity-section" aria-labelledby="pm2ActivityTitle">
          <header class="pm2-section-heading">
            <div class="pm2-section-heading-copy">
              <span class="pm2-section-kicker">Results and progress</span>
              <h2 id="pm2ActivityTitle">Session Activity</h2>
            </div>
            <span class="pm2-section-status">${matches.length} completed · ${standings.filter(row => row.eligible).length} qualified</span>
          </header>
          <div class="pm2-activity-layout">
            <section class="pm2-panel pm2-match-log-panel" id="pm2MatchLog">
              <div class="pm2-panel-head"><h3>Match Log</h3><span>${matches.length} completed</span></div>
              <div class="pm2-panel-body">${matchLogMarkup(matches)}</div>
            </section>
            <section class="pm2-panel pm2-standings-panel" id="pm2Standings">
              <div class="pm2-panel-head">
                <div class="pm2-final-panel-title">
                  <span>${scoring.eyebrow}</span>
                  <h3>${scoring.standings}</h3>
                </div>
                <div class="pm2-panel-head-actions">
                  <span>${standings.length > 4 ? `4 visible / ${standings.length} total` : `${standings.length} players`}</span>
                  <button class="pm2-mini-action" type="button" data-pm-action="export">Export CSV</button>
                </div>
              </div>
              <div class="pm2-panel-body">${standingsMarkup(standings)}</div>
            </section>
          </div>
        </section>
      </div>
    `;
  }

  function readSetup() {
    const element = root();
    const names = (element?.querySelector("#pm2Names")?.value || "")
      .split(/\r?\n|,/)
      .map(name => name.trim())
      .filter(Boolean);
    const courtIds = [...(element?.querySelectorAll('input[name="courtIds"]:checked') || [])].map(input => asId(input.value));
    return {
      date: element?.querySelector("#pm2Date")?.value || localDateValue(),
      timeLabel: element?.querySelector("#pm2Time")?.value.trim() || "Open Play",
      mode: element?.querySelector('input[name="mode"]:checked')?.value || ADAPTIVE_COMPETITIVE_MODE,
      rankingMode: normalizeRankingMode(
        element?.querySelector('input[name="rankingMode"]:checked')?.value
      ),
      courtIds,
      names,
    };
  }

  function updateSetupSummary() {
    const element = root();
    if (!element?.querySelector('[data-pm-form="setup"]')) return;
    const setup = readSetup();
    const games = Math.min(setup.courtIds.length, Math.floor(setup.names.length / 4));
    const date = element.querySelector("#pm2SummaryDate");
    const courts = element.querySelector("#pm2SummaryCourts");
    const players = element.querySelector("#pm2SummaryPlayers");
    const matches = element.querySelector("#pm2SummaryMatches");
    const ranking = element.querySelector("#pm2SummaryRanking");
    const explainer = element.querySelector("#pm2RatingExplainer");
    const note = element.querySelector("#pm2ReadyNote");
    if (date) date.textContent = formatDate(setup.date);
    if (courts) courts.textContent = setup.courtIds.length;
    if (players) players.textContent = setup.names.length;
    if (matches) matches.textContent = games;
    if (ranking) ranking.textContent = rankingCopy(setup.rankingMode).summary;
    if (explainer && explainer.dataset.rankingMode !== setup.rankingMode) {
      explainer.dataset.rankingMode = setup.rankingMode;
      explainer.innerHTML = rankingExplainerMarkup(setup.rankingMode);
    }
    if (note) {
      const ready = setup.courtIds.length > 0 && setup.names.length >= 4;
      note.classList.toggle("is-warn", !ready);
      note.textContent = ready
        ? `${games} court game${games === 1 ? "" : "s"} will start with ${setup.names.length - games * 4} player${setup.names.length - games * 4 === 1 ? "" : "s"} waiting.`
        : "Choose at least one court and enter four players.";
    }
  }

  async function startSession() {
    const setup = readSetup();
    if (!setup.courtIds.length) throw new Error("Choose at least one court.");
    if (setup.names.length < 4) throw new Error("Enter at least four checked-in players.");
    const duplicate = setup.names.find((name, index) =>
      setup.names.findIndex(other => other.toLowerCase() === name.toLowerCase()) !== index
    );
    if (duplicate) throw new Error(`Remove or rename the duplicate player “${duplicate}”.`);
    const courtRows = selectedCourtRows(setup.courtIds);
    const previousSession = state.session;
    const preservesPreviousResults = !!(
      previousSession
      && (
        state.rounds.length
        || ["completed", "cancelled"].includes(String(previousSession.status || ""))
      )
    );
    const sessionInput = {
      date: setup.date,
      timeLabel: setup.timeLabel,
      courtIds: setup.courtIds,
      courtNames: courtRows.map(court => court.name),
      mode: setup.mode,
      rankingMode: setup.rankingMode,
      status: "draft",
      currentRound: 0,
    };

    if (preservesPreviousResults) {
      const approved = window.confirm("Start a revised session? Existing rounds and results will remain in history.");
      if (!approved) return;
      state.session = await DB.createOpenPlayGameSession(sessionInput);
    } else if (previousSession) {
      state.session = await DB.updateOpenPlayGameSession(previousSession.id, sessionInput);
    } else {
      state.session = await DB.createOpenPlayGameSession(sessionInput);
    }

    if (asId(previousSession?.id) !== asId(state.session?.id)) {
      state.shareToken = null;
      state.shareSessionId = null;
    }
    state.players = await DB.replaceOpenPlayGamePlayers(
      state.session.id,
      setup.names.map(name => ({
        fullName: name,
        status: "active",
        skillLevel: DEFAULT_SKILL_LEVEL,
      }))
    );
    state.rounds = [];
    state.sessions = await DB.getOpenPlayGameSessions();
    await createNextRound();
    if (preservesPreviousResults) {
      const archived = await DB.updateOpenPlayGameSession(previousSession.id, { status: "completed" }).catch(error => {
        console.warn("Play Manager could not archive the previous session:", error);
        return null;
      });
      if (archived) {
        await DB.setOpenPlayGamePublicShare(previousSession.id, false).catch(error => {
          console.warn("Play Manager could not disable the previous player link:", error);
        });
        rememberShareToken("", previousSession.id);
      }
    }
    state.view = "live";
    state.prefill = null;
    renderShell();
    notify("Live play started.");
  }

  async function createNextRound() {
    if (!state.session) throw new Error("Create a session first.");
    if (activePlayers().length < 4) throw new Error("At least four active players are required.");
    if (!sessionCourtIds().length) throw new Error("Choose at least one court.");
    const generated = generateAssignments();
    if (!generated.assignments.length) throw new Error("There are not enough players for a match.");
    const roundNo = Number(lastRound()?.round_no || 0) + 1;
    const newRound = await DB.addOpenPlayGameRound({
      sessionId: state.session.id,
      roundNo,
      assignments: generated.assignments,
      queueSnapshot: generated.queueSnapshot,
      partnerHistory: generated.history.partner,
      opponentHistory: generated.history.opponent,
    });
    state.rounds.push(newRound);
    state.session = {
      ...state.session,
      status: "active",
      current_round: roundNo,
      updated_at: new Date().toISOString(),
    };
    await syncQueueWaitTimes(roundQueue(newRound));
  }

  async function updateRoundSafely(round, updates) {
    try {
      if (typeof DB.updateOpenPlayGameRoundIfCurrent === "function") {
        return await DB.updateOpenPlayGameRoundIfCurrent(
          round.id,
          {
            assignments: liveAssignments(round),
            queueSnapshot: round.queue_snapshot || [],
          },
          updates
        );
      }
      return await DB.updateOpenPlayGameRound(round.id, updates);
    } catch (error) {
      const conflict = error?.code === "40001" || String(error?.message || "").includes("PLAY_MANAGER_ROUND_CONFLICT");
      if (!conflict) throw error;
      await refreshState("live");
      renderShell();
      throw new Error("The court board changed on another device. Latest state loaded—record the action again.");
    }
  }

  async function replaceRoundPlayerSafely(round, replacement) {
    try {
      if (typeof DB.replaceOpenPlayGameCourtPlayer !== "function") {
        throw new Error("Apply the latest Play Manager database migration before replacing live players.");
      }
      return await DB.replaceOpenPlayGameCourtPlayer(
        round.id,
        {
          assignments: liveAssignments(round),
          queueSnapshot: round.queue_snapshot || [],
        },
        replacement
      );
    } catch (error) {
      const conflict = error?.code === "40001" || String(error?.message || "").includes("PLAY_MANAGER_ROUND_CONFLICT");
      if (!conflict) throw error;
      await refreshState("live");
      state.replacement = null;
      state.replacementTrigger = null;
      renderShell();
      throw new Error("The court board changed on another device. Latest state loaded—choose the replacement again.");
    }
  }

  function queueWaitLabel(value) {
    const start = Date.parse(value || "");
    if (!Number.isFinite(start)) return "—";
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    if (seconds >= 3600) {
      return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;
    }
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function updateSkillPicker(dialog, levelValue) {
    const selected = Number(levelValue);
    dialog?.querySelectorAll(".pm2-skill-star").forEach(label => {
      const value = Number(label.querySelector('input[name="skillLevel"]')?.value);
      label.classList.toggle("is-filled", selected >= value);
      label.classList.toggle("is-selected", selected === value);
    });
    const text = dialog?.querySelector("#pm2SkillText");
    const info = SKILL_LEVELS.find(item => item.value === selected);
    if (text) text.textContent = info?.label || "Set skill";
  }

  function playerEditorStats(player) {
    const id = asId(player?.id);
    const performance = standingsRows(completedMatches()).find(row => asId(row.id) === id);
    const games = performance?.games || 0;
    const display = standingDisplay(performance);
    const checkedAt = Date.parse(player?.created_at || state.session?.created_at || "");
    const hasCheckIn = Number.isFinite(checkedAt);
    const checkedTime = hasCheckIn
      ? new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "";
    const totalMinutes = hasCheckIn
      ? Math.max(0, Math.floor((Date.now() - checkedAt) / 60000))
      : 0;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const duration = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    return {
      gamesText: `${games}G played`,
      performanceText: isCompetitiveMode()
        ? `${display.score} exact Performance Points · ${display.meta}${standingRankingReason(performance) ? ` · ${standingRankingReason(performance)}` : ""}`
        : isWinPercentageMode()
          ? `${display.score} win percentage · ${display.meta}`
          : `${display.score} Session Points`,
      checkInText: hasCheckIn
        ? `Checked-in at ${checkedTime} · ${duration} in session`
        : "Checked-in time unavailable",
    };
  }

  function openPlayerDialog(mode, trigger, playerId = "") {
    const dialog = root()?.querySelector("#pm2AddDialog");
    if (!dialog) return;
    const editing = mode === "edit";
    const player = editing ? playerRecord(playerId) : null;
    if (editing && !player) {
      notify("That player is no longer in the roster.", true);
      return;
    }

    state.playerEditor = {
      mode: editing ? "edit" : "add",
      playerId: editing ? asId(player.id) : "",
    };
    state.playerEditorTrigger = trigger || null;

    const kicker = dialog.querySelector("#pm2PlayerEditorKicker");
    const title = dialog.querySelector("#pm2AddTitle");
    const intro = dialog.querySelector("#pm2PlayerEditorIntro");
    const summary = dialog.querySelector("#pm2PlayerEditorSummary");
    const games = dialog.querySelector("#pm2PlayerEditorGames");
    const performance = dialog.querySelector("#pm2PlayerEditorPerformance");
    const checkIn = dialog.querySelector("#pm2PlayerEditorCheckIn");
    const nameLabel = dialog.querySelector("#pm2PlayerNameLabel");
    const nameInput = dialog.querySelector("#pm2WalkInName");
    const skillCaption = dialog.querySelector("#pm2SkillCaption");
    const skillHelp = dialog.querySelector("#pm2SkillHelp");
    const note = dialog.querySelector("#pm2PlayerEditorNote");
    const submit = dialog.querySelector("#pm2PlayerEditorSubmit");
    if (kicker) kicker.textContent = editing ? "Player profile" : "Player queue";
    if (title) title.textContent = editing ? player.full_name || "Player" : "Add a player";
    if (intro) {
      intro.textContent = "Add a walk-in to the end of the waiting list.";
      intro.hidden = editing;
    }
    if (summary) summary.hidden = !editing;
    if (editing) {
      const stats = playerEditorStats(player);
      if (games) games.textContent = stats.gamesText;
      if (performance) performance.textContent = stats.performanceText;
      if (checkIn) checkIn.textContent = stats.checkInText;
    }
    if (nameLabel) nameLabel.textContent = editing ? "Name" : "Player name";
    if (nameInput) {
      nameInput.value = editing ? player.full_name || "" : "";
      nameInput.readOnly = false;
      nameInput.classList.remove("is-readonly");
    }
    if (skillCaption) skillCaption.textContent = editing ? "Skill level:" : "Skill:";
    if (skillHelp) {
      skillHelp.textContent = editing
        ? "Used for future team balancing."
        : "New players start at 1-star Beginner.";
    }
    if (note) {
      note.hidden = !editing;
      note.textContent = isCompetitiveMode()
        ? "Competitive Ranking uses completed results only. Skill changes apply to future balancing; starting strength can change only before this player's first rated result."
        : isWinPercentageMode()
          ? "Skill changes apply only to future team balancing. Win percentage is calculated only from completed results."
          : "Skill changes apply to future team balancing. Starting PR strength can change only before this player's first rated result.";
    }
    if (submit) submit.textContent = editing ? "Save changes" : "Add to queue";

    const selectedLevel = editing ? playerSkillLevel(player) : DEFAULT_SKILL_LEVEL;
    const selectedInput = dialog.querySelector(`input[name="skillLevel"][value="${selectedLevel}"]`);
    dialog.querySelectorAll('input[name="skillLevel"]').forEach(input => {
      input.checked = input === selectedInput;
    });
    updateSkillPicker(dialog, selectedLevel);
    dialog.showModal();
    setTimeout(() => {
      nameInput?.focus();
    }, 0);
  }

  async function savePlayerDetails(playerId, playerNameValue, skillLevel) {
    if (state.session?.status !== "active") {
      throw new Error("Player details can only be edited while the session is active.");
    }
    const player = playerRecord(playerId);
    if (!player) throw new Error("That player is no longer in the roster.");
    const cleanName = String(playerNameValue || "").trim();
    if (!cleanName) throw new Error("Enter the player’s name.");
    const duplicate = state.players.some(item =>
      asId(item.id) !== asId(player.id) &&
      String(item.full_name || "").trim().toLocaleLowerCase() === cleanName.toLocaleLowerCase()
    );
    if (duplicate) throw new Error("That player name is already in the roster.");
    const level = normalizeSkillLevel(skillLevel);
    const saved = await DB.updateOpenPlayGamePlayer(player.id, {
      fullName: cleanName,
      skillLevel: level,
    });
    state.players = state.players.map(item =>
      asId(item.id) === asId(player.id)
        ? (saved || { ...item, full_name: cleanName, skill_level: level })
        : item
    );
    renderShell();
    notify(`${cleanName} was updated to ${skillLabel(level)}.`);
  }

  function activeReplacementSource(dialog) {
    return dialog?.querySelector('input[name="replacementSource"]:checked')?.value === "walkin"
      ? "walkin"
      : "queue";
  }

  function syncReplacementSource(dialog) {
    if (!dialog) return "queue";
    const source = activeReplacementSource(dialog);
    const queueSource = dialog.querySelector('input[name="replacementSource"][value="queue"]');
    const select = dialog.querySelector("#pm2ReplacementPlayer");
    const nameInput = dialog.querySelector("#pm2ReplacementName");

    dialog.querySelectorAll("[data-pm-replacement-panel]").forEach(panel => {
      panel.hidden = panel.dataset.pmReplacementPanel !== source;
    });
    if (select) select.disabled = source !== "queue" || !!queueSource?.disabled;
    if (nameInput) nameInput.disabled = source !== "walkin";
    return source;
  }

  function updateReplacementPreview() {
    const dialog = root()?.querySelector("#pm2ReplaceDialog");
    const replacement = state.replacement;
    if (!dialog || !replacement) return;
    const source = syncReplacementSource(dialog);
    const select = dialog.querySelector("#pm2ReplacementPlayer");
    const nameInput = dialog.querySelector("#pm2ReplacementName");
    const badge = dialog.querySelector("#pm2ReplacementNextBadge");
    const meta = dialog.querySelector("#pm2ReplacementMeta");
    const plan = dialog.querySelector("#pm2ReplacementPlan");
    const planTitle = dialog.querySelector("#pm2ReplacementPlanTitle");
    const planDetail = dialog.querySelector("#pm2ReplacementPlanDetail");
    const submit = dialog.querySelector("#pm2ReplacementSubmit");
    const typedName = source === "walkin" ? String(nameInput?.value || "").trim() : "";
    const selectedId = source === "queue" ? asId(select?.value) : "";
    const queue = roundQueue();
    const queueIndex = selectedId
      ? queue.findIndex(id => asId(id) === selectedId)
      : -1;
    const incomingName = typedName || (queueIndex >= 0 ? playerName(selectedId) : "");
    const outgoingName = playerName(replacement.outgoingId);
    const markOutgoingRemoved = dialog.querySelector('input[name="outgoingAction"]:checked')?.value === "removed";

    if (badge) badge.hidden = source !== "queue" || queueIndex !== 0;
    if (meta) {
      if (queueIndex >= 0) {
        const waitStartedAt = playerRecord(selectedId)?.queue_entered_at || "";
        meta.innerHTML = `Queue position #${queueIndex + 1} · Waiting <span data-pm-wait-start="${escapeHtml(waitStartedAt)}">${queueWaitLabel(waitStartedAt)}</span>`;
      } else if (select?.disabled) {
        meta.textContent = "No players are currently waiting.";
      } else {
        meta.textContent = "Choose a waiting player.";
      }
    }
    if (plan) plan.classList.toggle("is-pending", !incomingName);
    if (planTitle) {
      planTitle.textContent = incomingName
        ? `${incomingName} replaces ${outgoingName}`
        : "Choose a replacement player";
    }
    if (planDetail) {
      planDetail.textContent = incomingName
        ? (markOutgoingRemoved
            ? `${outgoingName} will be marked as left.`
            : `${outgoingName} returns to the back of the queue.`)
        : "The current court assignment will stay unchanged until you confirm.";
    }
    if (submit) submit.disabled = !incomingName;
  }

  function openReplacementDialog(button) {
    const round = lastRound();
    const courtIndex = Number(button.dataset.courtIndex);
    const team = button.dataset.team === "B" ? "B" : "A";
    const slotIndex = Number(button.dataset.slotIndex);
    const outgoingId = asId(button.dataset.outgoingId);
    const game = liveAssignments(round)[courtIndex];
    const teamKey = team === "A" ? "teamA" : "teamB";
    if (state.session?.status !== "active") {
      notify("Resume this session before replacing a live player.", true);
      return;
    }
    if (
      !round ||
      !game ||
      game.winner ||
      asId(game[teamKey]?.[slotIndex]) !== outgoingId
    ) {
      notify("That court slot has already changed. Refreshing the live board.", true);
      refreshState("live").then(renderShell).catch(() => {});
      return;
    }

    state.replacement = { courtIndex, team, slotIndex, outgoingId };
    state.replacementTrigger = button;
    const dialog = root()?.querySelector("#pm2ReplaceDialog");
    const select = dialog?.querySelector("#pm2ReplacementPlayer");
    const nameInput = dialog?.querySelector("#pm2ReplacementName");
    const queueSource = dialog?.querySelector('input[name="replacementSource"][value="queue"]');
    const walkInSource = dialog?.querySelector('input[name="replacementSource"][value="walkin"]');
    const queue = roundQueue(round);
    const outgoingName = playerName(outgoingId);
    const teamLabel = team === "A" ? "Team 1" : "Team 2";

    if (dialog?.querySelector("#pm2ReplaceTitle")) {
      dialog.querySelector("#pm2ReplaceTitle").textContent = `Replace ${outgoingName}`;
    }
    if (dialog?.querySelector("#pm2OutgoingPlayer")) {
      dialog.querySelector("#pm2OutgoingPlayer").textContent = outgoingName;
    }
    if (dialog?.querySelector("#pm2OutgoingSlot")) {
      dialog.querySelector("#pm2OutgoingSlot").textContent = `${game.courtName || `Court ${courtIndex + 1}`} · ${teamLabel}`;
    }
    if (select) {
      select.innerHTML = queue.length
        ? `<option value="">Choose a waiting player</option>${queue.map((id, index) => `<option value="${escapeHtml(id)}">#${index + 1} · ${escapeHtml(playerName(id))}${index === 0 ? " — Next in queue" : ""}</option>`).join("")}`
        : `<option value="">No players are currently waiting</option>`;
      select.value = queue.length ? asId(queue[0]) : "";
    }
    if (nameInput) nameInput.value = "";
    if (queueSource) {
      queueSource.disabled = !queue.length;
      queueSource.checked = !!queue.length;
    }
    if (walkInSource) walkInSource.checked = !queue.length;
    const queueAction = dialog?.querySelector('input[name="outgoingAction"][value="queue"]');
    if (queueAction) queueAction.checked = true;
    syncReplacementSource(dialog);
    updateReplacementPreview();
    dialog?.showModal();
    setTimeout(() => (queue.length ? select : nameInput)?.focus(), 0);
  }

  async function replaceCourtPlayer(form) {
    const replacement = state.replacement;
    const round = lastRound();
    if (!replacement || !round) throw new Error("Choose a live court player to replace.");
    if (state.session?.status !== "active") {
      throw new Error("Resume this session before replacing a live player.");
    }

    const game = liveAssignments(round)[replacement.courtIndex];
    const teamKey = replacement.team === "A" ? "teamA" : "teamB";
    if (
      !game ||
      game.winner ||
      asId(game[teamKey]?.[replacement.slotIndex]) !== replacement.outgoingId
    ) {
      await refreshState("live");
      state.replacement = null;
      state.replacementTrigger = null;
      renderShell();
      throw new Error("That court slot already changed. Latest state loaded.");
    }

    const data = new FormData(form);
    const replacementSource = data.get("replacementSource") === "walkin" ? "walkin" : "queue";
    const newName = replacementSource === "walkin"
      ? String(data.get("replacementName") || "").trim()
      : "";
    const incomingId = replacementSource === "queue"
      ? asId(data.get("replacementId"))
      : "";
    const incomingName = newName || (incomingId ? playerName(incomingId) : "");

    if (replacementSource === "walkin") {
      if (!newName) throw new Error("Enter a walk-in name.");
      if (state.players.some(player => String(player.full_name || "").toLowerCase() === newName.toLowerCase())) {
        throw new Error("That player is already in the session.");
      }
    } else {
      const waitingIds = new Set(roundQueue(round));
      if (!incomingId || !waitingIds.has(incomingId)) {
        throw new Error("Choose a waiting player or enter a new walk-in name.");
      }
    }

    if (incomingId === replacement.outgoingId) throw new Error("Choose a different player.");
    const markOutgoingRemoved = data.get("outgoingAction") === "removed";
    const outgoingName = playerName(replacement.outgoingId);
    const result = await replaceRoundPlayerSafely(
      round,
      {
        courtIndex: replacement.courtIndex,
        team: replacement.team,
        slotIndex: replacement.slotIndex,
        outgoingPlayerId: replacement.outgoingId,
        incomingPlayerId: incomingId || null,
        incomingPlayerName: newName || null,
        markOutgoingRemoved,
      }
    );
    const savedRound = result?.round || result;
    const addedPlayer = result?.incoming_player || result?.incomingPlayer || null;
    if (!savedRound?.id) throw new Error("The replacement could not be saved.");
    if (addedPlayer && !state.players.some(player => asId(player.id) === asId(addedPlayer.id))) {
      state.players.push(addedPlayer);
    }
    state.rounds[state.rounds.length - 1] = savedRound;
    if (markOutgoingRemoved) {
      state.players = state.players.map(player =>
        asId(player.id) === replacement.outgoingId ? { ...player, status: "removed" } : player
      );
    }
    state.replacement = null;
    state.replacementTrigger = null;
    renderShell();
    let queueSyncNote = "";
    try {
      await syncQueueWaitTimes(roundQueue(savedRound));
      renderShell();
    } catch (error) {
      console.warn("Play Manager could not refresh queue wait times after replacement:", error);
      queueSyncNote = " Queue wait times will refresh automatically.";
    }
    notify(`${outgoingName} was replaced by ${incomingName}. ${markOutgoingRemoved ? "Outgoing player marked as left." : "Outgoing player moved to the queue."}${queueSyncNote}`);
  }

  function reserveOpenCourtLineups(assignments, queue, history, reservedAt = new Date().toISOString()) {
    const nextAssignments = assignments.map(game => ({ ...game }));
    let queueSnapshot = unique(queue || []);
    const newlyReady = [];
    const openCourts = nextAssignments
      .map((game, courtIndex) => ({ game, courtIndex }))
      .filter(item => item.game?.winner && !hasReadyMatch(item.game))
      .sort((left, right) => {
        const leftTime = Date.parse(left.game.resultAt || "");
        const rightTime = Date.parse(right.game.resultAt || "");
        const leftOrder = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.courtIndex - right.courtIndex;
      });

    if (
      isAdaptiveCompetitiveRotation() &&
      openCourts.length &&
      queueSnapshot.length >= 4
    ) {
      const availableCourtCount = Math.min(openCourts.length, Math.floor(queueSnapshot.length / 4));
      const availableCourts = openCourts.slice(0, availableCourtCount);
      const generated = adaptiveRotationAssignments(
        queueSnapshot,
        availableCourts.map(({ game, courtIndex }) => asId(game.courtId || `court-${courtIndex + 1}`))
      );
      const selectedIds = new Set();
      generated.assignments.forEach((match, matchIndex) => {
        const target = availableCourts[matchIndex];
        if (!target) return;
        const nextIds = [...match.teamA, ...match.teamB].map(asId);
        nextIds.forEach(id => selectedIds.add(id));
        nextAssignments[target.courtIndex] = {
          ...target.game,
          readyMatch: {
            matchId: createMatchId(),
            teamA: match.teamA.map(asId),
            teamB: match.teamB.map(asId),
            queueOrder: queueSnapshot.filter(id => nextIds.includes(asId(id))),
            reservedAt: target.game.resultAt || reservedAt,
            matchQuality: match.matchQuality || null,
          },
        };
        newlyReady.push({
          courtIndex: target.courtIndex,
          courtName: target.game.courtName || `Court ${target.courtIndex + 1}`,
          playerIds: nextIds,
        });
      });
      queueSnapshot = queueSnapshot.filter(id => !selectedIds.has(asId(id)));
      return { assignments: nextAssignments, queueSnapshot, newlyReady };
    }

    openCourts.forEach(({ game, courtIndex }) => {
      if (queueSnapshot.length < 4) return;
      const nextIds = queueSnapshot.slice(0, 4);
      const split = bestSplit(nextIds.map(id => ({ id })), history, false);
      nextAssignments[courtIndex] = {
        ...game,
        readyMatch: {
          matchId: createMatchId(),
          teamA: split.teamA.map(player => asId(player.id)),
          teamB: split.teamB.map(player => asId(player.id)),
          queueOrder: nextIds,
          reservedAt: game.resultAt || reservedAt,
        },
      };
      queueSnapshot = queueSnapshot.slice(4);
      newlyReady.push({
        courtIndex,
        courtName: game.courtName || `Court ${courtIndex + 1}`,
        playerIds: nextIds,
      });
    });

    return { assignments: nextAssignments, queueSnapshot, newlyReady };
  }

  function lineupPool(round, courtIndex) {
    const game = liveAssignments(round)[courtIndex];
    if (!game?.winner) return [];
    const activeIds = new Set(activePlayers().map(player => asId(player.id)));
    const occupiedElsewhere = new Set(
      liveAssignments(round).flatMap((assignment, index) =>
        index === courtIndex ? [] : occupiedGameIds(assignment)
      ).map(asId)
    );
    return unique([...readyMatchQueueOrder(game), ...roundQueue(round)])
      .filter(id => activeIds.has(id) && !occupiedElsewhere.has(id));
  }

  function lineupSelectOptions(ids, selectedId) {
    return [
      `<option value="">Choose player</option>`,
      ...ids.map((id, index) => `
        <option value="${escapeHtml(id)}" ${asId(id) === asId(selectedId) ? "selected" : ""}>
          ${index + 1}. ${escapeHtml(playerName(id))}
        </option>
      `),
    ].join("");
  }

  function updateChoosePlayersDialog() {
    const dialog = root()?.querySelector("#pm2ChooseDialog");
    const selection = state.lineupSelection;
    if (!dialog || !selection) return;
    const selects = [...dialog.querySelectorAll("[data-pm-lineup-slot]")];
    const values = selects.map(select => asId(select.value)).filter(Boolean);
    const uniqueValues = unique(values);
    const duplicate = values.length !== uniqueValues.length;
    const allowed = new Set(selection.playerIds.map(asId));
    const valid = values.length === 4
      && !duplicate
      && values.every(id => allowed.has(id));

    selects.forEach(select => {
      [...select.options].forEach(option => {
        if (!option.value) return;
        option.disabled = values.includes(asId(option.value)) && asId(select.value) !== asId(option.value);
      });
    });

    const status = dialog.querySelector("#pm2LineupStatus");
    const submit = dialog.querySelector("#pm2LineupSubmit");
    if (submit) submit.disabled = !valid;
    if (status) {
      status.classList.toggle("is-valid", valid);
      status.classList.toggle("is-error", duplicate);
      status.textContent = valid
        ? "Lineup complete. These four players will stay reserved for this court."
        : duplicate
          ? "Each player can only occupy one lineup slot."
          : `${Math.max(0, 4 - values.length)} player${4 - values.length === 1 ? "" : "s"} still needed.`;
    }
  }

  function openChoosePlayersDialog(button) {
    const round = lastRound();
    const courtIndex = Number(button.dataset.courtIndex);
    const game = liveAssignments(round)[courtIndex];
    if (state.session?.status !== "active") {
      notify("Resume this session before changing a ready lineup.", true);
      return;
    }
    if (!round || !game?.winner) {
      notify("That court is no longer waiting for a new match.", true);
      return;
    }

    const playerIds = lineupPool(round, courtIndex);
    const current = [
      ...(game.readyMatch?.teamA || []),
      ...(game.readyMatch?.teamB || []),
    ].map(asId);
    state.lineupSelection = { courtIndex, playerIds };
    state.lineupTrigger = button;

    const dialog = root()?.querySelector("#pm2ChooseDialog");
    if (!dialog) return;
    const title = dialog.querySelector("#pm2ChooseTitle");
    const court = dialog.querySelector("#pm2LineupCourt");
    const available = dialog.querySelector("#pm2LineupAvailable");
    if (title) title.textContent = `Choose players · ${game.courtName || `Court ${courtIndex + 1}`}`;
    if (court) court.textContent = game.courtName || `Court ${courtIndex + 1}`;
    if (available) {
      available.textContent = `${playerIds.length} eligible player${playerIds.length === 1 ? "" : "s"} · four will be reserved`;
    }

    const selects = [...dialog.querySelectorAll("[data-pm-lineup-slot]")];
    selects.forEach((select, index) => {
      select.innerHTML = lineupSelectOptions(playerIds, current[index] || "");
      select.value = current[index] || "";
    });
    updateChoosePlayersDialog();
    dialog.showModal();
    setTimeout(() => selects[0]?.focus(), 0);
  }

  async function saveReadyLineup(form) {
    const selection = state.lineupSelection;
    const round = lastRound();
    if (!selection || !round) throw new Error("Choose a ready court first.");
    if (state.session?.status !== "active") {
      throw new Error("Resume this session before changing a ready lineup.");
    }
    const game = liveAssignments(round)[selection.courtIndex];
    if (!game?.winner) throw new Error("That court is no longer ready.");

    const data = new FormData(form);
    const teamA = [asId(data.get("teamA0")), asId(data.get("teamA1"))];
    const teamB = [asId(data.get("teamB0")), asId(data.get("teamB1"))];
    const selectedIds = [...teamA, ...teamB].filter(Boolean);
    const allowed = new Set(lineupPool(round, selection.courtIndex));
    if (selectedIds.length !== 4 || unique(selectedIds).length !== 4) {
      throw new Error("Choose four different players.");
    }
    if (selectedIds.some(id => !allowed.has(id))) {
      throw new Error("One of those players is no longer available. Choose the lineup again.");
    }

    const poolOrder = unique([...readyMatchQueueOrder(game), ...roundQueue(round)]);
    const selectedSet = new Set(selectedIds);
    const selectedQueueOrder = poolOrder.filter(id => selectedSet.has(id));
    const queueSnapshot = poolOrder.filter(id => !selectedSet.has(id));
    const assignments = liveAssignments(round).map((assignment, index) =>
      index === selection.courtIndex
        ? {
            ...assignment,
            readyMatch: {
              matchId: assignment.readyMatch?.matchId || createMatchId(),
              teamA,
              teamB,
              queueOrder: selectedQueueOrder,
              reservedAt: assignment.readyMatch?.reservedAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        : assignment
    );
    const saved = await updateRoundSafely(round, { assignments, queueSnapshot });
    state.rounds[state.rounds.length - 1] = saved || {
      ...round,
      assignments,
      queue_snapshot: queueSnapshot,
    };
    await syncQueueWaitTimes(roundQueue(state.rounds[state.rounds.length - 1]));
    root()?.querySelector("#pm2ChooseDialog")?.close();
    renderShell();
    notify(`${game.courtName || `Court ${selection.courtIndex + 1}`} lineup saved and ready.`);
  }

  async function startReadyMatch(courtIndex) {
    if (state.session?.status !== "active") {
      throw new Error("Resume this session before starting a match.");
    }
    const round = lastRound();
    const game = liveAssignments(round)[courtIndex];
    if (!round || !game?.winner || !hasReadyMatch(game)) {
      throw new Error("Choose four players before starting this match.");
    }
    const selectedIds = readyMatchIds(game);
    const activeIds = new Set(activePlayers().map(player => asId(player.id)));
    const occupiedElsewhere = new Set(
      liveAssignments(round).flatMap((assignment, index) =>
        index === courtIndex ? [] : occupiedGameIds(assignment)
      ).map(asId)
    );
    if (
      selectedIds.length !== 4
      || selectedIds.some(id => !activeIds.has(id) || occupiedElsewhere.has(id))
    ) {
      throw new Error("One of the reserved players is no longer available. Choose the lineup again.");
    }

    const {
      completedGames = [],
      readyMatch,
      ...finishedResult
    } = game;
    const startedAt = new Date().toISOString();
    const nextGame = {
      courtId: game.courtId,
      courtName: game.courtName,
      teamA: (readyMatch.teamA || []).map(asId),
      teamB: (readyMatch.teamB || []).map(asId),
      startedAt,
      matchId: readyMatch.matchId || createMatchId(),
      ...(readyMatch.matchQuality ? { matchQuality: readyMatch.matchQuality } : {}),
      completedGames: [...completedGames, finishedResult],
    };
    const assignments = liveAssignments(round).map((assignment, index) =>
      index === courtIndex ? nextGame : assignment
    );
    const queueSnapshot = round.queue_snapshot || roundQueue(round);
    const saved = await updateRoundSafely(round, { assignments, queueSnapshot });
    state.rounds[state.rounds.length - 1] = saved || {
      ...round,
      assignments,
      queue_snapshot: queueSnapshot,
    };
    await syncQueueWaitTimes(roundQueue(state.rounds[state.rounds.length - 1]));
    renderShell();
    notify(`${game.courtName || `Court ${courtIndex + 1}`} match started.`);
  }

  async function recordWinner(index, winner) {
    if (state.session?.status !== "active") {
      throw new Error("Results can only be recorded while the session is active.");
    }
    const round = lastRound();
    const current = liveAssignments(round)[index];
    if (!round || !current || current.winner) return;
    const resultAt = new Date().toISOString();
    const completed = { ...current, winner, resultAt };
    const waitingBefore = roundQueue(round);
    const activeIds = new Set(activePlayers().map(player => asId(player.id)));
    const finishedIds = [...(current.teamA || []), ...(current.teamB || [])]
      .map(asId)
      .filter(id => activeIds.has(id));
    const nextPool = unique([...waitingBefore, ...finishedIds]);
    const completedAssignments = liveAssignments(round).map((game, gameIndex) =>
      gameIndex === index ? completed : game
    );
    const historyWithResult = buildHistory([
      ...state.rounds.slice(0, -1),
      {
        ...round,
        assignments: completedAssignments,
      },
    ]);
    const allocation = reserveOpenCourtLineups(
      completedAssignments,
      nextPool,
      historyWithResult,
      resultAt
    );
    const assignments = allocation.assignments;
    const queueSnapshot = allocation.queueSnapshot;
    const saved = await updateRoundSafely(round, {
      assignments,
      queueSnapshot,
    });
    await playWinnerReveal(index, winner);
    state.rounds[state.rounds.length - 1] = saved || {
      ...round,
      assignments,
      queue_snapshot: queueSnapshot,
    };
    await syncQueueWaitTimes(roundQueue(state.rounds[state.rounds.length - 1]));
    renderShell();
    const readyNames = allocation.newlyReady.map(item => item.courtName);
    notify(readyNames.length
      ? `${winner === "A" ? "Team 1" : "Team 2"} won. ${readyNames.join(", ")} ${readyNames.length === 1 ? "is" : "are"} ready for the next match.`
      : `${winner === "A" ? "Team 1" : "Team 2"} won. Waiting for four available players.`
    );
  }

  async function skipPlayer(id) {
    if (state.session?.status !== "active") {
      throw new Error("The queue can only be changed while the session is active.");
    }
    const round = lastRound();
    if (!round) return;
    const queue = roundQueue(round);
    const next = [...queue.filter(item => asId(item) !== asId(id)), asId(id)];
    const saved = await updateRoundSafely(round, {
      assignments: liveAssignments(round),
      queueSnapshot: next,
    });
    state.rounds[state.rounds.length - 1] = saved || { ...round, queue_snapshot: next };
    await syncQueueWaitTimes(roundQueue(state.rounds[state.rounds.length - 1]));
    renderShell();
    notify(`${playerName(id)} moved to the back of the queue.`);
  }

  async function importPaidPlayers() {
    const setup = readSetup();
    const registrations = await DB.getOpenPlayRegistrations();
    const courtSet = new Set(setup.courtIds.map(asId));
    const names = registrations
      .filter(registration =>
        registration.date === setup.date &&
        registration.payment_status === "paid" &&
        (!courtSet.size || courtSet.has(asId(registration.court_id)))
      )
      .map(registration => String(registration.full_name || "").trim())
      .filter(Boolean);
    if (!names.length) throw new Error("No paid Open Play registrations match this date and court selection.");
    const box = root()?.querySelector("#pm2Names");
    if (box) box.value = unique(names).join("\n");
    updateSetupSummary();
    notify(`${unique(names).length} paid players imported.`);
  }

  async function addWalkIn(name, skillLevel = DEFAULT_SKILL_LEVEL) {
    if (state.session?.status !== "active") {
      throw new Error("Walk-in players can only be added while the session is active.");
    }
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Enter the walk-in player’s name.");
    if (state.players.some(player => player.full_name?.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error("That player is already in the roster.");
    }
    if (!state.session) throw new Error("Open a session first.");

    const newPlayer = await DB.addOpenPlayGamePlayer(state.session.id, {
      fullName: cleanName,
      status: "active",
      seedOrder: state.players.length,
      skillLevel: normalizeSkillLevel(skillLevel),
    });
    state.players.push(newPlayer);
    const round = lastRound();
    let newlyReady = [];
    if (round) {
      const queueWithWalkIn = unique([...roundQueue(round), asId(newPlayer.id)]);
      const allocation = reserveOpenCourtLineups(
        liveAssignments(round),
        queueWithWalkIn,
        buildHistory()
      );
      const assignments = allocation.assignments;
      const queueSnapshot = allocation.queueSnapshot;
      newlyReady = allocation.newlyReady;
      const saved = await updateRoundSafely(round, {
        assignments,
        queueSnapshot,
      });
      state.rounds[state.rounds.length - 1] = saved || {
        ...round,
        assignments,
        queue_snapshot: queueSnapshot,
      };
    }
    await syncQueueWaitTimes(roundQueue());
    renderShell();
    notify(newlyReady.length
      ? `${cleanName} was added. ${newlyReady.map(item => item.courtName).join(", ")} ${newlyReady.length === 1 ? "is" : "are"} now ready.`
      : `${cleanName} was added to the queue.`
    );
  }

  async function endSession() {
    if (!state.session || !["active", "paused"].includes(String(state.session.status || ""))) return;
    const unresolvedPodium = isCompetitiveMode()
      ? standingsRows(completedMatches()).filter(requiresPodiumDecider)
      : [];
    if (unresolvedPodium.length) {
      const names = unresolvedPodium.map(row => row.name).join(", ");
      throw new Error(
        `Podium decider required before ending. ${names} have identical competitive results—record one separating match first.`
      );
    }
    const approved = window.confirm(
      "End this session? No more matches can be started. The player link will show final results for up to 24 hours."
    );
    if (!approved) return;
    const sessionId = state.session.id;
    state.session = await DB.updateOpenPlayGameSession(sessionId, {
      status: "completed",
    }) || { ...state.session, status: "completed" };
    state.sessions = await DB.getOpenPlayGameSessions();
    renderShell();
    notify(`Session ended. Final ${rankingCopy().name} results remain shareable for up to 24 hours.`);
  }

  function playerLiveUrl(token = state.shareToken) {
    if (!token) return "";
    const url = new URL("player-live.html", location.href);
    url.search = "";
    if (window.PB_USE_LOCAL_DATA) url.searchParams.set("localData", "1");
    url.hash = token;
    return url.toString();
  }

  function shareDialogParts() {
    const element = root();
    return {
      dialog: element?.querySelector("#pm2ShareDialog"),
      title: element?.querySelector("#pm2ShareTitle"),
      description: element?.querySelector("#pm2ShareDescription"),
      canvas: element?.querySelector("#pm2ShareQr"),
      loading: element?.querySelector("#pm2ShareLoading"),
      input: element?.querySelector("#pm2ShareUrl"),
      status: element?.querySelector("#pm2ShareStatus"),
      localNote: element?.querySelector("#pm2ShareLocal"),
      copyButton: element?.querySelector("#pm2CopyLiveLink"),
      nativeButton: element?.querySelector("#pm2NativeShare"),
      openLink: element?.querySelector("#pm2OpenLiveView"),
      rotateButton: element?.querySelector("#pm2RotateLiveLink"),
      disableButton: element?.querySelector("#pm2DisableLiveLink"),
    };
  }

  function setShareControls(enabled) {
    const parts = shareDialogParts();
    [parts.copyButton, parts.nativeButton, parts.rotateButton, parts.disableButton]
      .filter(Boolean)
      .forEach(control => { control.disabled = !enabled; });
    if (parts.openLink) {
      parts.openLink.classList.toggle("is-disabled", !enabled);
      parts.openLink.setAttribute("aria-disabled", enabled ? "false" : "true");
      if (!enabled) parts.openLink.href = "#";
    }
  }

  function setShareStatus(message, isError = false) {
    const status = shareDialogParts().status;
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  async function copyToClipboard(value) {
    const text = String(value || "");
    if (!text) throw new Error("There is nothing to copy yet.");
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("Copy was blocked by the browser.");
  }

  async function ensureLiveShareToken(forceNew = false) {
    if (!state.session) throw new Error("Open a live session before sharing.");
    const stateToken = asId(state.shareSessionId) === asId(state.session.id)
      ? state.shareToken
      : "";
    let token = forceNew ? "" : (stateToken || storedShareToken());

    if (token) {
      const existingBoard = await DB.getPublicOpenPlayGameLiveBoard(token);
      if (existingBoard) {
        state.shareToken = token;
        state.shareSessionId = state.session.id;
        rememberShareToken(token);
        return { token, verified: true };
      }
    }

    if (forceNew) {
      if (typeof DB.rotateOpenPlayGamePublicShare !== "function") {
        throw new Error("Live-link rotation needs the latest database migration.");
      }
      token = await DB.rotateOpenPlayGamePublicShare(state.session.id);
    } else {
      token = await DB.setOpenPlayGamePublicShare(state.session.id, true);
    }
    if (!/^[0-9a-f]{64}$/.test(String(token || ""))) {
      throw new Error("The secure live link could not be created.");
    }

    state.shareToken = token;
    state.shareSessionId = state.session.id;
    rememberShareToken(token);
    const newBoard = await DB.getPublicOpenPlayGameLiveBoard(token);
    if (!newBoard) throw new Error("The new player link could not be verified.");
    return { token, verified: true };
  }

  async function drawShareQr(url) {
    const { canvas, loading } = shareDialogParts();
    if (!canvas || !loading) return;
    if (!window.PaddleRageQRCode?.toCanvas) {
      throw new Error("The QR generator did not load. The text link is still ready.");
    }
    await window.PaddleRageQRCode.toCanvas(canvas, url, {
      errorCorrectionLevel: "M",
      width: 216,
      margin: 4,
      color: {
        dark: "#111a2a",
        light: "#ffffff",
      },
    });
    loading.hidden = true;
    canvas.hidden = false;
  }

  async function prepareShareLink(forceNew = false) {
    const parts = shareDialogParts();
    if (!parts.dialog) return false;
    setShareControls(false);
    if (parts.canvas) parts.canvas.hidden = true;
    if (parts.loading) {
      parts.loading.hidden = false;
      parts.loading.textContent = forceNew ? "Generating a new private link…" : "Creating secure link…";
    }
    if (parts.input) parts.input.value = "";
    setShareStatus("Preparing the share link.");

    try {
      const { token } = await ensureLiveShareToken(forceNew);
      const url = playerLiveUrl(token);
      if (parts.input) parts.input.value = url;
      if (parts.openLink) parts.openLink.href = url;
      setShareControls(true);

      try {
        await drawShareQr(url);
        setShareStatus(
          state.session?.status === "completed"
            ? `Ready. Final ${rankingCopy().name} results remain available for up to 24 hours.`
            : "Ready. The player board refreshes automatically while this session is live."
        );
      } catch (qrError) {
        if (parts.loading) {
          parts.loading.hidden = false;
          parts.loading.textContent = "QR unavailable";
        }
        setShareStatus(qrError.message, true);
      }
      parts.copyButton?.focus();
      return true;
    } catch (error) {
      console.error("Play Manager live share:", error);
      if (parts.loading) {
        parts.loading.hidden = false;
        parts.loading.textContent = "Link unavailable";
      }
      setShareStatus(
        error?.message?.includes("function") || error?.code === "PGRST202"
          ? "Live sharing needs the latest database migration before it can be used."
          : (error?.message || "The live link could not be created."),
        true
      );
      return false;
    }
  }

  async function openShareDialog(trigger) {
    if (!state.session || !lastRound()) {
      notify("Start live play before sharing the player board.", true);
      return;
    }
    if (!["active", "paused", "completed"].includes(String(state.session.status || ""))) {
      notify("Sharing is unavailable for this session.", true);
      return;
    }
    state.shareTrigger = trigger || null;
    const parts = shareDialogParts();
    const completed = state.session.status === "completed";
    if (parts.title) parts.title.textContent = completed ? "Share final results" : "Share live board";
    if (parts.description) {
      parts.description.textContent = completed
        ? `Anyone with this private link can view the final ${rankingCopy().name} standings. The board is view-only and expires automatically.`
        : "Anyone with this private link can follow live courts, the player queue, and standings. The board is view-only.";
    }
    if (parts.localNote) parts.localNote.hidden = !window.PB_USE_LOCAL_DATA;
    if (!parts.dialog?.open) parts.dialog?.showModal();
    await prepareShareLink(false);
  }

  async function copyLiveLink() {
    const url = shareDialogParts().input?.value || "";
    await copyToClipboard(url);
    setShareStatus("Player link copied. Send it in your group chat.");
    notify("Live player link copied.");
  }

  async function nativeShareLive() {
    const url = shareDialogParts().input?.value || "";
    if (!url) return;
    if (typeof navigator.share !== "function") {
      await copyLiveLink();
      return;
    }
    try {
      await navigator.share({
        title: "Korte DOS Live Board",
        text: `Follow live courts and the queue for ${sessionTitle()}.`,
        url,
      });
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
  }

  async function rotateLiveLink() {
    if (!window.confirm("Generate a new live link? The old player link and QR code will stop working.")) return;
    if (await prepareShareLink(true)) {
      notify("A new live player link is ready.");
    }
  }

  async function disableLiveLink() {
    if (!state.session) return;
    if (!window.confirm("Disable this live link? Players using it will immediately lose access.")) return;
    await DB.setOpenPlayGamePublicShare(state.session.id, false);
    rememberShareToken("");
    state.shareToken = null;
    state.shareSessionId = null;
    shareDialogParts().dialog?.close();
    notify("Live player link disabled.");
  }

  async function copyTextUpdate() {
    const round = lastRound();
    if (!round) return;
    const lines = [
      `Korte DOS Open Play · ${sessionTitle()}`,
      `Round ${round.round_no || state.rounds.length}`,
      ...liveAssignments(round).map(game =>
        game.winner
          ? `${game.courtName}: ${game.winner === "A" ? "Team 1" : "Team 2"} won · waiting to start the next match`
          : `${game.courtName}: ${game.teamA.map(playerName).join(" & ")} vs ${game.teamB.map(playerName).join(" & ")}`
      ),
      `Queue: ${roundQueue(round).map(playerName).join(", ") || "No one waiting"}`,
    ];
    try {
      await copyToClipboard(lines.join("\n"));
      notify("Text update copied.");
    } catch (error) {
      notify(error?.message || "Copy was blocked by the browser.", true);
    }
  }

  function resultCanvasRoundRect(context, x, y, width, height, radius) {
    const corner = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + corner, y);
    context.lineTo(x + width - corner, y);
    context.quadraticCurveTo(x + width, y, x + width, y + corner);
    context.lineTo(x + width, y + height - corner);
    context.quadraticCurveTo(x + width, y + height, x + width - corner, y + height);
    context.lineTo(x + corner, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - corner);
    context.lineTo(x, y + corner);
    context.quadraticCurveTo(x, y, x + corner, y);
    context.closePath();
  }

  function resultCanvasFitText(context, value, maxWidth) {
    const original = String(value || "");
    if (context.measureText(original).width <= maxWidth) return original;
    let shortened = original;
    while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) {
      shortened = shortened.slice(0, -1);
    }
    return `${shortened.trim()}…`;
  }

  function resultCanvasWrapText(context, value, maxWidth, maxLines = 2) {
    const words = String(value || "").trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    words.forEach(word => {
      const next = current ? `${current} ${word}` : word;
      if (!current || context.measureText(next).width <= maxWidth) {
        current = next;
      } else {
        lines.push(current);
        current = word;
      }
    });
    if (current) lines.push(current);
    if (lines.length > maxLines) {
      const visible = lines.slice(0, maxLines);
      visible[maxLines - 1] = resultCanvasFitText(
        context,
        `${visible[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`,
        maxWidth
      );
      return visible;
    }
    return lines;
  }

  function loadResultBrandLogo() {
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = "korte-dos-logo.png";
    });
  }

  function drawResultStat(context, x, y, width, value, label) {
    resultCanvasRoundRect(context, x, y, width, 94, 18);
    context.fillStyle = "rgba(255,255,255,.07)";
    context.fill();
    context.strokeStyle = "rgba(255,255,255,.14)";
    context.lineWidth = 1.5;
    context.stroke();
    context.textAlign = "left";
    context.fillStyle = "#ffffff";
    context.font = '950 34px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(String(value), x + 20, y + 42);
    context.fillStyle = "#9eacc0";
    context.font = '850 16px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(String(label).toUpperCase(), x + 20, y + 73);
  }

  function drawResultPodiumCard(context, row, rank, x, y, width, height) {
    if (!row) return;
    const display = standingDisplay(row);
    const decider = requiresPodiumDecider(row);
    const accent = decider ? "#f59e0b" : rank === 1 ? "#e9c229" : rank === 2 ? "#aeb9c8" : "#b9794e";
    const rankFill = decider ? "#fff3cd" : rank === 1 ? "#f4d45c" : rank === 2 ? "#c7d0dc" : "#c9885c";
    const place = decider ? "PODIUM DECIDER" : rank === 1 ? "CHAMPION" : rank === 2 ? "RUNNER-UP" : "THIRD PLACE";

    context.save();
    context.shadowColor = rank === 1 ? "rgba(151,111,0,.22)" : "rgba(15,23,42,.12)";
    context.shadowBlur = rank === 1 ? 34 : 24;
    context.shadowOffsetY = 12;
    resultCanvasRoundRect(context, x, y, width, height, 26);
    context.fillStyle = rank === 1 ? "#fffdf3" : "#ffffff";
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = accent;
    context.lineWidth = rank === 1 ? 4 : 3;
    context.stroke();

    if (decider) {
      resultCanvasRoundRect(context, x + width / 2 - 44, y - 24, 88, 48, 24);
    } else {
      context.beginPath();
      context.arc(x + width / 2, y, 31, 0, Math.PI * 2);
    }
    context.fillStyle = rankFill;
    context.fill();
    context.strokeStyle = "#f4f6f9";
    context.lineWidth = 8;
    context.stroke();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = decider || rank === 1 ? "#493800" : "#273244";
    context.font = `950 ${decider ? 18 : 24}px "DM Sans", "Segoe UI", sans-serif`;
    context.fillText(String(standingRankLabel(row)), x + width / 2, y + 1);

    const isPrimaryCard = height >= 350;
    const avatarRadius = isPrimaryCard ? 48 : 42;
    const avatarY = y + (isPrimaryCard ? 88 : 76);
    const placeY = avatarY + avatarRadius + 30;
    const nameY = placeY + 40;
    const recordY = nameY + (isPrimaryCard ? 72 : 62);
    const metaY = y + height - (isPrimaryCard ? 28 : 18);
    const avatarGradient = context.createLinearGradient(
      x + width / 2 - avatarRadius,
      avatarY - avatarRadius,
      x + width / 2 + avatarRadius,
      avatarY + avatarRadius
    );
    avatarGradient.addColorStop(0, rank === 1 ? "#087f73" : "#4338ca");
    avatarGradient.addColorStop(1, rank === 1 ? "#06b6d4" : "#e11d48");
    context.beginPath();
    context.arc(x + width / 2, avatarY, avatarRadius, 0, Math.PI * 2);
    context.fillStyle = avatarGradient;
    context.fill();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 6;
    context.stroke();
    context.fillStyle = "#ffffff";
    context.font = `900 ${rank === 1 ? 31 : 27}px "DM Sans", "Segoe UI", sans-serif`;
    context.fillText(playerInitials(row.name), x + width / 2, avatarY + 1);

    context.textBaseline = "alphabetic";
    context.fillStyle = "#7b8798";
    context.font = '900 20px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(place, x + width / 2, placeY);
    context.fillStyle = "#172033";
    context.font = `950 ${isPrimaryCard ? 35 : 31}px "DM Sans", "Segoe UI", sans-serif`;
    context.fillText(
      resultCanvasFitText(context, row.name, width - 42),
      x + width / 2,
      nameY
    );

    const scoreFontSize = isPrimaryCard ? 54 : 48;
    context.font = `950 ${scoreFontSize}px "DM Sans", "Segoe UI", sans-serif`;
    const pointsText = display.score;
    const pointsWidth = context.measureText(pointsText).width;
    context.font = '800 20px "DM Sans", "Segoe UI", sans-serif';
    const pointsLabel = display.label.toLowerCase();
    const pointsLabelWidth = context.measureText(pointsLabel).width;
    const scoreStart = x + (width - pointsWidth - pointsLabelWidth - 11) / 2;
    context.textAlign = "left";
    context.fillStyle = "#172033";
    context.font = `950 ${scoreFontSize}px "DM Sans", "Segoe UI", sans-serif`;
    context.fillText(pointsText, scoreStart, recordY);
    context.fillStyle = "#7b8798";
    context.font = '800 20px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(pointsLabel, scoreStart + pointsWidth + 11, recordY - 2);
    context.textAlign = "center";
    context.fillStyle = "#6b7280";
    context.font = '750 20px "DM Sans", "Segoe UI", sans-serif';
    const podiumMeta = `${row.games} ${row.games === 1 ? "game" : "games"} • ${display.meta}`;
    context.fillText(resultCanvasFitText(context, podiumMeta, width - 36), x + width / 2, metaY);
    context.restore();
  }

  function drawModernResultPodiumCard(context, row, rank, x, y, width, height) {
    if (!row) return;
    const display = standingDisplay(row);
    const decider = requiresPodiumDecider(row);
    const accent = decider ? "#e7a11a" : rank === 1 ? "#d5a900" : rank === 2 ? "#8e9caf" : "#b76b3b";
    const rankFill = decider ? "#fff1c2" : rank === 1 ? "#f7d85f" : rank === 2 ? "#d9e0e9" : "#d79668";
    const place = decider ? "PODIUM DECIDER" : rank === 1 ? "CHAMPION" : rank === 2 ? "RUNNER-UP" : "THIRD PLACE";
    const medalText = decider ? "#9a6700" : rank === 1 ? "#987500" : rank === 2 ? "#59687b" : "#95552f";
    const avatarStart = decider ? "#d18a0b" : rank === 1 ? "#b88a00" : rank === 2 ? "#66758a" : "#96542e";
    const avatarEnd = decider ? "#f4bd42" : rank === 1 ? "#f0c92d" : rank === 2 ? "#aab5c3" : "#d28a5c";

    context.save();
    context.shadowColor = "rgba(15,23,42,.08)";
    context.shadowBlur = 22;
    context.shadowOffsetY = 10;
    resultCanvasRoundRect(context, x, y, width, height, 22);
    context.fillStyle = rank === 1 ? "#fffdf5" : "#ffffff";
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = accent;
    context.lineWidth = 2;
    context.stroke();

    context.save();
    resultCanvasRoundRect(context, x, y, width, height, 22);
    context.clip();
    context.fillStyle = accent;
    context.fillRect(x, y, width, 8);
    context.restore();

    if (decider) {
      resultCanvasRoundRect(context, x + 22, y + 24, 72, 44, 22);
    } else {
      context.beginPath();
      context.arc(x + 44, y + 46, 22, 0, Math.PI * 2);
    }
    context.fillStyle = rankFill;
    context.fill();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = decider || rank === 1 ? "#493800" : "#273244";
    context.font = `950 ${decider ? 15 : 19}px "DM Sans", "Segoe UI", sans-serif`;
    context.fillText(String(standingRankLabel(row)), decider ? x + 58 : x + 44, y + 47);

    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = "#758297";
    context.font = '900 16px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(place, x + 78, y + 52);

    const avatarRadius = 38;
    const heightAdjustment = Math.max(0, height - 300);
    const avatarY = y + 105 + heightAdjustment * .25;
    const nameY = y + 170 + heightAdjustment * .45;
    const scoreY = y + 229 + heightAdjustment * .65;
    const avatarGradient = context.createLinearGradient(
      x + width / 2 - avatarRadius,
      avatarY - avatarRadius,
      x + width / 2 + avatarRadius,
      avatarY + avatarRadius
    );
    avatarGradient.addColorStop(0, avatarStart);
    avatarGradient.addColorStop(1, avatarEnd);
    context.beginPath();
    context.arc(x + width / 2, avatarY, avatarRadius, 0, Math.PI * 2);
    context.fillStyle = avatarGradient;
    context.fill();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 5;
    context.stroke();
    context.fillStyle = "#ffffff";
    context.font = '900 26px "DM Sans", "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(playerInitials(row.name), x + width / 2, avatarY + 1);

    context.textBaseline = "alphabetic";
    context.fillStyle = "#172033";
    context.font = '950 31px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(resultCanvasFitText(context, row.name, width - 42), x + width / 2, nameY);

    const scoreFontSize = 46;
    context.font = `950 ${scoreFontSize}px "DM Sans", "Segoe UI", sans-serif`;
    const pointsText = display.score;
    const pointsWidth = context.measureText(pointsText).width;
    context.font = '800 18px "DM Sans", "Segoe UI", sans-serif';
    const pointsLabel = display.label.toLowerCase();
    const pointsLabelWidth = context.measureText(pointsLabel).width;
    const scoreStart = x + (width - pointsWidth - pointsLabelWidth - 11) / 2;
    context.textAlign = "left";
    context.fillStyle = medalText;
    context.font = `950 ${scoreFontSize}px "DM Sans", "Segoe UI", sans-serif`;
    context.fillText(pointsText, scoreStart, scoreY);
    context.fillStyle = "#7b8798";
    context.font = '800 18px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(pointsLabel, scoreStart + pointsWidth + 11, scoreY - 2);

    context.textAlign = "center";
    context.fillStyle = medalText;
    context.font = '900 24px "DM Sans", "Segoe UI", sans-serif';
    const podiumMeta = `${row.games} ${row.games === 1 ? "game" : "games"} • ${display.meta}`;
    context.fillText(resultCanvasFitText(context, podiumMeta, width - 36), x + width / 2, y + height - 26);
    context.restore();
  }

  async function downloadBrandedResult() {
    if (String(state.session?.status || "") !== "completed") {
      throw new Error("End the session before downloading the final result.");
    }
    try {
      await document.fonts?.ready;
    } catch (_) {}
    const matches = completedMatches();
    const standings = standingsRows(matches);
    const scoring = rankingCopy();
    const topStandings = standings.slice(0, 10);
    const podiumStandings = PERFORMANCE.podiumRows(standings);
    const hasPodiumDecider = podiumStandings.some(requiresPodiumDecider);
    const featuredPodium = podiumStandings.slice(0, 3);
    const featuredPodiumIds = new Set(featuredPodium.map(row => asId(row.id)));
    const podiumIds = new Set(podiumStandings.map(row => asId(row.id)));
    const displayedStandings = [
      ...podiumStandings,
      ...topStandings.filter(row => !podiumIds.has(asId(row.id))),
    ];
    const remaining = displayedStandings.filter(row => !featuredPodiumIds.has(asId(row.id)));
    const canvasWidth = 1440;
    const listTop = 986;
    const rowHeight = 82;
    const footerHeight = 110;
    const listHeight = remaining.length ? remaining.length * rowHeight : 104;
    const canvasHeight = Math.max(1490, listTop + listHeight + footerHeight + 42);
    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not create the result image.");

    context.fillStyle = "#f1f3f6";
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    const headerGradient = context.createLinearGradient(0, 0, canvasWidth, 360);
    headerGradient.addColorStop(0, "#0c1728");
    headerGradient.addColorStop(.66, "#14233a");
    headerGradient.addColorStop(1, "#10302d");
    context.fillStyle = headerGradient;
    context.fillRect(0, 0, canvasWidth, 360);

    context.beginPath();
    context.arc(1360, -30, 190, 0, Math.PI * 2);
    context.strokeStyle = "rgba(201,243,29,.10)";
    context.lineWidth = 38;
    context.stroke();

    const logo = await loadResultBrandLogo();
    if (logo) {
      context.drawImage(logo, 64, 28, 112, 112);
    } else {
      context.beginPath();
      context.arc(120, 84, 52, 0, Math.PI * 2);
      context.fillStyle = "#c9f31d";
      context.fill();
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = "#111827";
      context.font = '950 25px "DM Sans", "Segoe UI", sans-serif';
      context.fillText("KD", 120, 85);
    }

    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = "#ffffff";
    context.font = '950 34px "DM Sans", "Segoe UI", sans-serif';
    context.fillText("KORTE DOS PICKLEBALL", 198, 78);
    context.fillStyle = "#c9f31d";
    context.font = '900 19px "DM Sans", "Segoe UI", sans-serif';
    context.fillText("OFFICIAL OPEN PLAY RESULTS", 199, 109);

    drawResultStat(context, 856, 28, 160, matches.length, "Matches");
    drawResultStat(context, 1024, 28, 160, standings.length, "Players");
    drawResultStat(context, 1192, 28, 160, averageGameDuration(), "Avg. game");

    context.beginPath();
    context.moveTo(64, 143);
    context.lineTo(1376, 143);
    context.strokeStyle = "rgba(255,255,255,.10)";
    context.lineWidth = 1;
    context.stroke();

    resultCanvasRoundRect(context, 72, 164, 276, 34, 17);
    context.fillStyle = "rgba(201,243,29,.12)";
    context.fill();
    context.fillStyle = "#dfff73";
    context.font = '900 15px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(
      isCompetitiveMode()
        ? "COMPETITIVE SESSION RESULTS"
        : isWinPercentageMode()
          ? "WIN PERCENTAGE SESSION RESULTS"
          : "PERFORMANCE SESSION RESULTS",
      90,
      187
    );

    context.fillStyle = "#ffffff";
    context.font = '950 52px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(
      isCompetitiveMode()
        ? "Competitive Open Play"
        : isWinPercentageMode()
          ? "Win Percentage Open Play"
          : "Performance Open Play",
      72,
      252
    );
    context.fillStyle = "#b8c4d5";
    context.font = '700 23px "DM Sans", "Segoe UI", sans-serif';
    resultCanvasWrapText(context, sessionTitle(), 1250, 2).forEach((line, index) => {
      context.fillText(line, 72, 292 + index * 30);
    });
    context.fillStyle = "#aab8ca";
    context.font = '800 17px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(
      isCompetitiveMode()
        ? "Exact Elo • Win % • Wins • Head-to-head • Opponent strength • Best upset"
        : isWinPercentageMode()
          ? "Individual Win Percentage • Every win counts equally"
          : "Individual Session Points • Opponent strength matters",
      72,
      333
    );

    context.fillStyle = "#172033";
    context.font = '950 30px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(hasPodiumDecider ? "Podium decider required" : "Podium leaders", 72, 416);
    context.fillStyle = "#718096";
    context.font = '750 18px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(
      hasPodiumDecider ? "Official places remain TBD until one separating result is recorded." : "Korte DOS podium",
      72,
      447
    );

    drawModernResultPodiumCard(context, featuredPodium[1], featuredPodium[1]?.rank || 2, 72, 506, 408, 340);
    drawModernResultPodiumCard(context, featuredPodium[0], featuredPodium[0]?.rank || 1, 516, 466, 408, 380);
    drawModernResultPodiumCard(context, featuredPodium[2], featuredPodium[2]?.rank || 3, 960, 546, 408, 300);

    context.fillStyle = "#172033";
    context.font = '950 30px "DM Sans", "Segoe UI", sans-serif';
    const leaderboardTitle = displayedStandings.length > 10
      ? "TOP 10 + PODIUM TIES"
      : `TOP ${displayedStandings.length} LEADERBOARD`;
    const modernLeaderboardTitle = leaderboardTitle
      .replace("TOP", "Top")
      .replace("LEADERBOARD", "leaderboard")
      .replace("PODIUM TIES", "podium ties");
    context.fillText(modernLeaderboardTitle, 72, 906);
    context.textAlign = "right";
    context.fillStyle = "#718096";
    context.font = '750 18px "DM Sans", "Segoe UI", sans-serif';
    const resultCountLabel = `Showing ${displayedStandings.length} of ${standings.length} players`;
    const hasSharedRanks = displayedStandings.some(row => row.sharedRank);
    context.fillText(
      hasSharedRanks ? `${resultCountLabel} • T = tied rank` : resultCountLabel,
      1368,
      906
    );
    context.textAlign = "left";
    context.fillStyle = "#718096";
    context.font = '800 16px "DM Sans", "Segoe UI", sans-serif';
    context.fillText("RANK", 90, 962);
    context.fillText("PLAYER", 190, 962);
    context.textAlign = "right";
    context.fillText(scoring.summary.toUpperCase(), 1350, 962);

    if (!remaining.length) {
      resultCanvasRoundRect(context, 72, listTop, 1296, 74, 14);
      context.fillStyle = "#ffffff";
      context.fill();
      context.textAlign = "center";
      context.fillStyle = "#718096";
      context.font = '750 21px "DM Sans", "Segoe UI", sans-serif';
      context.fillText("The podium contains the full leaderboard.", 720, listTop + 49);
    } else {
      remaining.forEach((row, index) => {
        const rank = standingRankLabel(row);
        const display = standingDisplay(row);
        const y = listTop + index * rowHeight;
        resultCanvasRoundRect(context, 72, y, 1296, 72, 13);
        context.fillStyle = "#ffffff";
        context.fill();
        context.strokeStyle = "#dde4ec";
        context.lineWidth = 1.5;
        context.stroke();

        context.textAlign = "center";
        resultCanvasRoundRect(context, 88, y + 14, 48, 44, 12);
        context.fillStyle = "#eef2f6";
        context.fill();
        context.fillStyle = "#46556a";
        const rankText = String(rank);
        context.font = `950 ${rankText.length > 2 ? 18 : 24}px "DM Sans", "Segoe UI", sans-serif`;
        context.fillText(rankText, 112, y + 45);

        context.beginPath();
        context.arc(166, y + 36, 22, 0, Math.PI * 2);
        context.fillStyle = "#334155";
        context.fill();
        context.fillStyle = "#ffffff";
        context.font = '900 13px "DM Sans", "Segoe UI", sans-serif';
        context.textBaseline = "middle";
        context.fillText(playerInitials(row.name), 166, y + 37);

        context.textAlign = "left";
        context.textBaseline = "alphabetic";
        context.fillStyle = "#253044";
        context.font = '900 27px "DM Sans", "Segoe UI", sans-serif';
        context.fillText(resultCanvasFitText(context, row.name, 760), 202, y + 32);
        context.fillStyle = "#8490a0";
        context.font = '750 17px "DM Sans", "Segoe UI", sans-serif';
        context.fillText(`${row.games} ${row.games === 1 ? "game" : "games"} played`, 202, y + 57);

        context.textAlign = "right";
        context.fillStyle = display.tone === "is-negative"
          ? "#b53b4c"
          : display.tone === "is-neutral"
            ? "#46556a"
            : "#087f73";
        context.font = '950 27px "DM Sans", "Segoe UI", sans-serif';
        context.fillText(display.compactScore, 1350, y + 32);
        context.fillStyle = "#8490a0";
        context.font = '750 17px "DM Sans", "Segoe UI", sans-serif';
        const rowStatus = requiresPodiumDecider(row)
          ? "DECIDER REQUIRED"
          : row.sharedRank
            ? "TIED RANK"
            : row.eligible
            ? "Qualified"
            : "Provisional";
        context.fillText(`${rowStatus} • ${display.meta}`, 1350, y + 57);
      });
    }

    const footerY = canvasHeight - footerHeight;
    context.fillStyle = "#111827";
    context.fillRect(0, footerY, canvasWidth, footerHeight);
    context.textAlign = "left";
    context.fillStyle = "#c9f31d";
    context.font = '950 24px "DM Sans", "Segoe UI", sans-serif';
    context.fillText("KORTE DOS PICKLEBALL", 72, footerY + 43);
    context.fillStyle = "#91a0b4";
    context.font = '750 19px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(hasPodiumDecider ? "Podium pending • Decider required" : "Official session result", 72, footerY + 76);
    const poweredLabel = "Powered by ";
    const poweredBrand = "Korte DOS CDO Pickleball";
    context.font = '750 20px "DM Sans", "Segoe UI", sans-serif';
    const poweredLabelWidth = context.measureText(poweredLabel).width;
    context.font = '900 20px "DM Sans", "Segoe UI", sans-serif';
    const poweredBrandWidth = context.measureText(poweredBrand).width;
    let poweredX = (canvasWidth - poweredLabelWidth - poweredBrandWidth) / 2;
    context.textAlign = "left";
    context.fillStyle = "#91a0b4";
    context.font = '750 20px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(poweredLabel, poweredX, footerY + 62);
    poweredX += poweredLabelWidth;
    context.fillStyle = "#c9f31d";
    context.font = '900 20px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(poweredBrand, poweredX, footerY + 62);
    context.textAlign = "right";
    context.fillStyle = "#91a0b4";
    context.font = '750 20px "DM Sans", "Segoe UI", sans-serif';
    context.fillText(formatDate(state.session?.date || localDateValue()), 1368, footerY + 62);

    const resultBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!resultBlob) throw new Error("The result image could not be prepared.");
    const resultUrl = URL.createObjectURL(resultBlob);
    const link = document.createElement("a");
    link.href = resultUrl;
    link.download = `korte-dos-open-play-results-${state.session?.date || localDateValue()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(resultUrl), 0);
    notify("Branded Korte DOS result downloaded.");
  }

  function exportCsv() {
    const standings = standingsRows(completedMatches());
    const rows = [[
      "rank",
      "player",
      "ranking_mode",
      "ranking_score",
      "session_points",
      "performance_rating",
      "wins",
      "losses",
      "win_percentage",
      "games",
      "qualified",
      "average_opponent_rating",
      "best_upset",
      "exact_session_points",
      "exact_performance_rating",
      "average_opponent_rating_exact",
      "best_upset_exact",
      "head_to_head_wins",
      "head_to_head_losses",
      "head_to_head_games",
      "head_to_head_win_percentage",
      "rank_criterion",
      "rank_reason",
      "tiebreak_reason",
      "podium_decider_required",
      "podium_decider_group_id",
    ]];
    standings.forEach(row => {
      const display = standingDisplay(row);
      const winPercentageMode = isWinPercentageMode(row.mode);
      rows.push([
        requiresPodiumDecider(row) ? "TBD" : row.rank || "",
        row.name,
        sessionRankingMode(),
        display.score,
        winPercentageMode ? "" : row.points,
        winPercentageMode ? "" : row.rating,
        row.wins,
        row.losses,
        row.winPercentage,
        row.games,
        row.eligible ? "yes" : "no",
        winPercentageMode ? "" : row.averageOpponentRating,
        winPercentageMode ? "" : row.bestUpset,
        winPercentageMode ? "" : row.pointsExact,
        winPercentageMode ? "" : row.ratingExact,
        winPercentageMode ? "" : row.averageOpponentRatingExact,
        winPercentageMode ? "" : row.bestUpsetExact,
        isCompetitiveMode(row.mode) ? row.headToHeadWins : "",
        isCompetitiveMode(row.mode) ? row.headToHeadLosses : "",
        isCompetitiveMode(row.mode) ? row.headToHeadGames : "",
        isCompetitiveMode(row.mode) ? row.headToHeadPercentage : "",
        row.rankCriterion || "",
        row.rankReason || "",
        row.tieBreakReason || "",
        requiresPodiumDecider(row) ? "yes" : "no",
        row.podiumDeciderGroupId || "",
      ]);
    });
    const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `korte-dos-play-manager-${state.session?.date || localDateValue()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    notify("Standings CSV exported.");
  }

  function updateTimers() {
    root()?.querySelectorAll("[data-pm-start]").forEach(element => {
      const start = Date.parse(element.dataset.pmStart || "");
      if (!Number.isFinite(start)) {
        element.textContent = "00:00";
        return;
      }
      const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const minutes = Math.floor(seconds / 60);
      element.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    });
    root()?.querySelectorAll("[data-pm-wait-start]").forEach(element => {
      element.textContent = queueWaitLabel(element.dataset.pmWaitStart);
    });
    root()?.querySelectorAll("[data-pm-clock]").forEach(element => {
      element.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    });
  }

  function startClock() {
    if (state.clockTimer) return;
    state.clockTimer = setInterval(updateTimers, 1000);
  }

  async function handleClick(event) {
    const button = event.target.closest("[data-pm-action]");
    if (!button) return;
    const action = button.dataset.pmAction;

    if (action === "new-session") {
      state.session = null;
      state.players = [];
      state.rounds = [];
      state.prefill = null;
      state.lineupSelection = null;
      state.lineupTrigger = null;
      state.winnerCorrection = null;
      state.winnerCorrectionTrigger = null;
      state.shareToken = null;
      state.shareSessionId = null;
      state.view = "setup";
      renderShell();
      return;
    }
    if (action === "continue-live") {
      state.view = "live";
      renderShell();
      return;
    }
    if (action === "edit-setup") {
      state.view = "setup";
      renderShell();
      return;
    }
    if (action === "sample-roster") {
      const box = root()?.querySelector("#pm2Names");
      if (box) box.value = [
        "Alex Santos", "Bea Reyes", "Carlo Mendoza", "Dana Cruz",
        "Evan Lim", "Faye Navarro", "Gio Ramos", "Hana Torres",
        "Ivan Dela Cruz", "Joy Aquino", "Kai Flores", "Lia Garcia",
      ].join("\n");
      updateSetupSummary();
      return;
    }
    if (action === "import-paid") {
      await withBusy(importPaidPlayers);
      return;
    }
    if (action === "replace-player") {
      openReplacementDialog(button);
      return;
    }
    if (action === "choose-players") {
      openChoosePlayersDialog(button);
      return;
    }
    if (action === "start-match") {
      await withBusy(() => startReadyMatch(Number(button.dataset.courtIndex)));
      return;
    }
    if (action === "correct-winner") {
      openWinnerCorrectionDialog(button);
      return;
    }
    if (action === "winner") {
      await withBusy(() => recordWinner(Number(button.dataset.courtIndex), button.dataset.side));
      return;
    }
    if (action === "skip-player") {
      await withBusy(() => skipPlayer(button.dataset.playerId));
      return;
    }
    if (action === "add-player") {
      openPlayerDialog("add", button);
      return;
    }
    if (action === "edit-player-skill") {
      openPlayerDialog("edit", button, button.dataset.playerId);
      return;
    }
    if (action === "close-dialog") {
      const dialog = button.closest("dialog");
      if (dialog?.id === "pm2AddDialog") state.playerEditor = null;
      if (dialog?.id === "pm2ReplaceDialog") state.replacement = null;
      if (dialog?.id === "pm2ChooseDialog") state.lineupSelection = null;
      dialog?.close();
      return;
    }
    if (action === "share-live") {
      await openShareDialog(button);
      return;
    }
    if (action === "copy-text-update") {
      await copyTextUpdate();
      return;
    }
    if (action === "copy-live-link") {
      await withBusy(copyLiveLink);
      return;
    }
    if (action === "native-share-live") {
      try {
        await nativeShareLive();
      } catch (error) {
        notify(error?.message || "The share sheet could not be opened.", true);
      }
      return;
    }
    if (action === "rotate-live-link") {
      await withBusy(rotateLiveLink);
      return;
    }
    if (action === "disable-live-link") {
      await withBusy(disableLiveLink);
      return;
    }
    if (action === "export") {
      exportCsv();
      return;
    }
    if (action === "download-result") {
      await withBusy(downloadBrandedResult);
      return;
    }
    if (action === "end-session") {
      await withBusy(endSession);
      return;
    }
    if (action === "display") {
      state.displayModeRevision += 1;
      state.displayMode = !state.displayMode;
      renderShell();
      return;
    }
    if (action === "scroll") {
      const target = root()?.querySelector(`#${CSS.escape(button.dataset.target || "")}`);
      target?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    }
  }

  async function handleChange(event) {
    if (
      event.target.matches('input[name="skillLevel"]') &&
      event.target.closest("#pm2AddDialog")
    ) {
      updateSkillPicker(event.target.closest("#pm2AddDialog"), event.target.value);
      return;
    }
    if (event.target.matches("[data-pm-lineup-slot]")) {
      updateChoosePlayersDialog();
      return;
    }
    if (event.target.id === "pm2ReplacementPlayer") {
      updateReplacementPreview();
      return;
    }
    if (
      event.target.matches('input[name="replacementSource"]') &&
      event.target.closest("#pm2ReplaceDialog")
    ) {
      syncReplacementSource(event.target.closest("#pm2ReplaceDialog"));
      updateReplacementPreview();
      return;
    }
    if (
      event.target.matches('input[name="outgoingAction"]') &&
      event.target.closest("#pm2ReplaceDialog")
    ) {
      updateReplacementPreview();
      return;
    }
    if (event.target.id === "pm2SessionSelect") {
      const id = event.target.value;
      if (!id) {
        state.session = null;
        state.players = [];
        state.rounds = [];
        state.view = "setup";
        renderShell();
        return;
      }
      await withBusy(async () => {
        await loadSession(id);
        renderShell();
      });
      return;
    }
    if (event.target.closest('[data-pm-form="setup"]')) updateSetupSummary();
  }

  function handleInput(event) {
    if (event.target.id === "pm2ReplacementName") {
      updateReplacementPreview();
      return;
    }
    if (event.target.closest('[data-pm-form="setup"]')) updateSetupSummary();
  }

  async function handleSubmit(event) {
    const form = event.target.closest("[data-pm-form]");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.pmForm === "setup") {
      await withBusy(startSession);
      return;
    }
    if (form.dataset.pmForm === "add-player") {
      const data = new FormData(form);
      const name = data.get("playerName");
      const skillLevel = normalizeSkillLevel(data.get("skillLevel"));
      const editor = state.playerEditor || { mode: "add", playerId: "" };
      await withBusy(async () => {
        if (editor.mode === "edit") {
          await savePlayerDetails(editor.playerId, name, skillLevel);
        } else {
          await addWalkIn(name, skillLevel);
        }
        state.playerEditor = null;
        state.playerEditorTrigger = null;
      });
      return;
    }
    if (form.dataset.pmForm === "replace-player") {
      await withBusy(async () => {
        await replaceCourtPlayer(form);
        root()?.querySelector("#pm2ReplaceDialog")?.close();
      });
      return;
    }
    if (form.dataset.pmForm === "choose-players") {
      await withBusy(() => saveReadyLineup(form));
      return;
    }
    if (form.dataset.pmForm === "correct-winner") {
      await withBusy(correctMatchWinner);
    }
  }

  async function openFromReservations() {
    const date = document.getElementById("opRegDate")?.value || localDateValue();
    const courtId = document.getElementById("opRegCourt")?.value;
    state.prefill = {
      date,
      courtIds: courtId ? [asId(courtId)] : [],
    };
    await window.goto("gamemgr");
    state.view = "setup";
    renderShell();
  }

  window.PlayManager = {
    render,
    openFromReservations,
    getState: () => ({ ...state }),
  };
  window.pmOpenFromReservations = openFromReservations;
})();
