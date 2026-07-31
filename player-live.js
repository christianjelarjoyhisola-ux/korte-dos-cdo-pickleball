(() => {
  "use strict";

  const POLL_MS = 3000;
  const PLAYER_NAME_KEY = "korte_dos_player_live_name_v1";
  const state = {
    token: String(location.hash || "").slice(1).trim(),
    snapshot: null,
    signature: "",
    selectedName: "",
    inFlight: false,
    failures: 0,
    terminal: false,
    winnerReveal: null,
    winnerRevealTimer: null,
    matchupReveals: [],
    pendingMatchupReveals: [],
    matchupRevealTimer: null,
    pollTimer: null,
    clockTimer: null,
    shareFeedbackTimer: null,
    navObserver: null,
    hasRendered: false,
  };

  const root = () => document.getElementById("playerLiveRoot");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "Open Play";
    const [year, month, day] = String(value).split("-").map(Number);
    if (!year || !month || !day) return String(value);
    return new Date(year, month - 1, day).toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function elapsedLabel(value) {
    const started = Date.parse(value || "");
    if (!Number.isFinite(started)) return "00:00";
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function relativeTime(value) {
    const generated = Date.parse(value || "");
    if (!Number.isFinite(generated)) return "Waiting for update";
    const seconds = Math.max(0, Math.floor((Date.now() - generated) / 1000));
    if (seconds < 5) return "Updated just now";
    if (seconds < 60) return `Updated ${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `Updated ${minutes}m ago`;
  }

  function readSelectedName() {
    try {
      return localStorage.getItem(PLAYER_NAME_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function saveSelectedName(name) {
    state.selectedName = String(name || "");
    try {
      if (state.selectedName) localStorage.setItem(PLAYER_NAME_KEY, state.selectedName);
      else localStorage.removeItem(PLAYER_NAME_KEY);
    } catch (_) {}
  }

  function statusLabel(status) {
    if (status === "paused") return "PAUSED";
    if (status === "completed") return "FINAL";
    return "LIVE";
  }

  function updateHeader() {
    const pill = document.getElementById("plbStatusPill");
    const freshness = document.getElementById("plbFreshness");
    if (!pill || !freshness) return;

    pill.className = "plb-status-pill";
    if (state.terminal) {
      pill.textContent = "UNAVAILABLE";
      pill.classList.add("is-offline");
      freshness.textContent = "This player link is no longer active";
      return;
    }
    if (!state.snapshot) {
      pill.textContent = state.failures ? "OFFLINE" : "CONNECTING";
      pill.classList.add(state.failures ? "is-offline" : "is-loading");
      freshness.textContent = state.failures ? "Could not reach the live board" : "Opening live board…";
      return;
    }
    if (state.failures) {
      pill.textContent = "RECONNECTING";
      pill.classList.add("is-reconnecting");
      freshness.textContent = `${relativeTime(state.snapshot.generatedAt)} · retrying`;
      return;
    }
    const status = state.snapshot.session?.status || "active";
    pill.textContent = statusLabel(status);
    pill.classList.add(`is-${status}`);
    freshness.textContent = relativeTime(state.snapshot.generatedAt);
  }

  function isMine(name) {
    return Boolean(state.selectedName && String(name) === state.selectedName);
  }

  function playerStanding(name) {
    return (state.snapshot?.standings || []).find(item =>
      String(item?.name || "") === String(name || "")
    ) || null;
  }

  function formatSessionPoints(value, suffix = "") {
    const points = Number(value || 0);
    const absolute = Math.abs(points).toFixed(1).replace(/\.0$/, "");
    const signed = points > 0 ? `+${absolute}` : points < 0 ? `−${absolute}` : "0";
    return suffix ? `${signed} ${suffix}` : signed;
  }

  function formatCompetitivePoints(row, suffix = "") {
    const points = Number(row?.pointsExact ?? row?.points ?? 0);
    const absolute = Math.abs(points).toFixed(2).replace(/\.?0+$/, "");
    const signed = points > 0 ? `+${absolute}` : points < 0 ? `−${absolute}` : "0";
    return suffix ? `${signed} ${suffix}` : signed;
  }

  function performanceTone(value) {
    const points = Number(value || 0);
    return points > 0 ? "is-positive" : points < 0 ? "is-negative" : "is-neutral";
  }

  function rankingMode(snapshot = state.snapshot) {
    if (!window.PB_USE_LOCAL_DATA) return "performance";
    const mode = String(snapshot?.ratingSystem?.mode || "");
    const metric = String(snapshot?.ratingSystem?.rankingMetric || "");
    if (mode === "competitive" || metric === "competitive") return "competitive";
    return mode === "win_percentage" || metric === "win_percentage"
      ? "win_percentage"
      : "performance";
  }

  function isWinPercentageMode(snapshot = state.snapshot) {
    return rankingMode(snapshot) === "win_percentage";
  }

  function isCompetitiveMode(snapshot = state.snapshot) {
    return rankingMode(snapshot) === "competitive";
  }

  function winPercentage(row) {
    if (Number.isFinite(Number(row?.winPercentage))) return Number(row.winPercentage);
    const games = Number(row?.games || 0);
    return games ? Math.round((Number(row?.wins || 0) / games) * 1000) / 10 : 0;
  }

  function standingDisplay(row, snapshot = state.snapshot) {
    if (isCompetitiveMode(snapshot)) {
      const wins = Number(row?.wins || 0);
      const games = Number(row?.games || 0);
      const losses = Number(row?.losses ?? Math.max(0, games - wins));
      const percentage = `${winPercentage(row).toFixed(1).replace(/\.0$/, "")}%`;
      return {
        score: formatCompetitivePoints(row),
        compactScore: formatCompetitivePoints(row, "pts"),
        aria: `${formatCompetitivePoints(row, "exact Performance Points")}, ${percentage} win percentage`,
        label: "PTS",
        meta: `${percentage} · ${wins}W-${losses}L`,
        detail: `Opponent strength ${Math.round(Number(row?.averageOpponentRating || 0))}`,
        tone: performanceTone(row?.pointsExact ?? row?.points),
      };
    }
    if (isWinPercentageMode(snapshot)) {
      const wins = Number(row?.wins || 0);
      const games = Number(row?.games || 0);
      const losses = Number(row?.losses ?? Math.max(0, games - wins));
      const percentage = `${winPercentage(row).toFixed(1).replace(/\.0$/, "")}%`;
      return {
        score: percentage,
        compactScore: percentage,
        aria: `${percentage} win percentage`,
        label: "WIN %",
        meta: `${wins}W-${losses}L`,
        tone: games === 0
          ? "is-neutral"
          : winPercentage(row) >= 50
            ? "is-positive"
            : "is-negative",
      };
    }
    return {
      score: formatSessionPoints(row?.points),
      compactScore: formatSessionPoints(row?.points, "pts"),
      aria: formatSessionPoints(row?.points, "Session Points"),
      label: "POINTS",
      meta: `PR ${Math.round(Number(row?.rating || 0))}`,
      tone: performanceTone(row?.points),
    };
  }

  function rankingCopy(snapshot = state.snapshot) {
    if (isCompetitiveMode(snapshot)) {
      return {
        hero: "Courts, queue order, and decisive individual competitive rankings—updated automatically.",
        complete: "This session is complete. Final Competitive standings and any required podium decider are shown below.",
        eyebrow: "Elo + record + head-to-head + strength",
        title: "Competitive Top 10",
        finalTitle: "Final Competitive Leaders",
        podium: "Competitive podium",
      };
    }
    if (isWinPercentageMode(snapshot)) {
      return {
        hero: "Courts, queue order, and each player's win percentage—updated automatically.",
        complete: "This session is complete. Final Win Percentage standings are shown below.",
        eyebrow: "Ranked by win percentage",
        title: "Win Percentage Top 10",
        finalTitle: "Final Win Percentage Leaders",
        podium: "Win Percentage podium",
      };
    }
    return {
      hero: "Courts, queue order, and individual opponent-adjusted Session Points—updated automatically.",
      complete: "This session is complete. Final Individual Performance standings are shown below.",
      eyebrow: "Ranked by Session Points",
      title: "Top 10 Performance",
      finalTitle: "Final Performance Leaders",
      podium: "Performance podium",
    };
  }

  function requiresPodiumDecider(row) {
    return Boolean(row?.requiresPodiumDecider);
  }

  function rankLabel(row) {
    if (!row?.eligible) return "P";
    if (requiresPodiumDecider(row)) return "TBD";
    if (row?.sharedRank) return `T${row.rank}`;
    return row?.rank || "—";
  }

  function rankDescription(row) {
    if (!row?.eligible) return "Provisional";
    if (requiresPodiumDecider(row)) return "Podium decider required";
    if (row?.sharedRank) return `Tied at rank ${row.rank}`;
    return `Rank ${row?.rank}`;
  }

  function rankingReason(row) {
    if (requiresPodiumDecider(row)) return "Identical competitive results · decider required";
    return String(row?.rankReason || row?.tieBreakReason || "").trim();
  }

  function playerRecord(name) {
    const standing = playerStanding(name);
    if (!standing) return "No games yet";
    const games = Number(standing.games || 0);
    const display = standingDisplay(standing);
    return `${display.compactScore} · ${games}G`;
  }

  function nameFitClass(name) {
    const length = String(name || "").trim().length;
    if (length > 28) return "is-very-long";
    if (length > 18) return "is-long";
    return "";
  }

  function playerItem(name) {
    return `
      <li class="plb-player ${isMine(name) ? "is-mine" : ""}">
        <span class="${nameFitClass(name)}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        ${isMine(name) ? `<b>YOU</b>` : ""}
      </li>
    `;
  }

  function matchEventKey(snapshot, game, courtIndex) {
    if (!game?.startedAt) return "";
    const roundNo = Number(snapshot?.latestRound?.roundNo || snapshot?.session?.currentRound || 0);
    return [
      roundNo,
      Number(courtIndex),
      String(game.courtName || ""),
      String(game.startedAt),
      Number(game.gameCount || 1),
    ].join(":");
  }

  function matchupRevealsForUpdate(previousSnapshot, nextSnapshot) {
    if (String(nextSnapshot?.session?.status || "active") !== "active") return [];
    const previousAssignments = previousSnapshot?.latestRound?.assignments || [];
    const nextAssignments = nextSnapshot?.latestRound?.assignments || [];
    const previousRoundNo = Number(previousSnapshot?.latestRound?.roundNo || previousSnapshot?.session?.currentRound || 0);
    const nextRoundNo = Number(nextSnapshot?.latestRound?.roundNo || nextSnapshot?.session?.currentRound || 0);
    return nextAssignments.flatMap((game, courtIndex) => {
      if (!game || game.winner || !game.startedAt) return [];
      const eventKey = matchEventKey(nextSnapshot, game, courtIndex);
      const previousGame = previousAssignments[courtIndex];
      const previousKey = previousGame && !previousGame.winner
        ? matchEventKey(previousSnapshot, previousGame, courtIndex)
        : "";
      const actualAdvance = (
        !previousGame ||
        Boolean(previousGame.winner) ||
        nextRoundNo !== previousRoundNo ||
        String(previousGame.courtName || "") !== String(game.courtName || "") ||
        Number(game.gameCount || 1) > Number(previousGame.gameCount || 1)
      );
      if (!eventKey || eventKey === previousKey || !actualAdvance) return [];
      return [{
        eventKey,
        courtIndex,
        courtName: game.courtName || `Court ${courtIndex + 1}`,
        team1: Array.isArray(game.team1) ? game.team1 : [],
        team2: Array.isArray(game.team2) ? game.team2 : [],
      }];
    });
  }

  function winnerRevealForUpdate(previousSnapshot, nextSnapshot) {
    const previousCount = Number(previousSnapshot?.resultCount || 0);
    const nextCount = Number(nextSnapshot?.resultCount || 0);
    const result = nextSnapshot?.latestResult;
    if (nextCount <= previousCount || !result || !["A", "B"].includes(result.winner)) return null;
    return {
      ...result,
      team1: Array.isArray(result.team1) ? result.team1 : [],
      team2: Array.isArray(result.team2) ? result.team2 : [],
    };
  }

  function winningNames(result) {
    return result?.winner === "A" ? (result.team1 || []) : (result.team2 || []);
  }

  function renderWinnerReveal(result) {
    if (!result) return "";
    const teamLabel = result.winner === "A" ? "Team 1" : "Team 2";
    const teamClass = result.winner === "A" ? "team-one" : "team-two";
    const names = winningNames(result);
    return `
      <div class="plb-winner-reveal ${teamClass}" aria-hidden="true">
        <span class="plb-winner-reveal-sparks"></span>
        <div class="plb-winner-reveal-copy">
          <span>${escapeHtml(result.courtName || "Court")} · ${teamLabel}</span>
          <strong class="plb-winner-reveal-names">
            ${(names.length ? names : [teamLabel]).map(name => `
              <span class="${nameFitClass(name)}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            `).join("")}
          </strong>
          <b><i>✓</i> WIN</b>
        </div>
      </div>
    `;
  }

  function renderMatchupReveal(matchup) {
    if (!matchup) return "";
    const teamNames = (names, fallback) => (names.length ? names : [fallback]).map(name => `
      <span class="${nameFitClass(name)}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    `).join("");
    return `
      <div class="plb-matchup-reveal" aria-hidden="true">
        <div class="plb-matchup-reveal-head">
          <span class="plb-matchup-live-dot"></span>
          <strong>New match</strong>
          <span>${escapeHtml(matchup.courtName || "Court")}</span>
        </div>
        <div class="plb-matchup-reveal-grid">
          <section class="plb-matchup-reveal-team team-one">
            <b>Team 1</b>
            <div>${teamNames(matchup.team1 || [], "Team 1")}</div>
          </section>
          <span class="plb-matchup-reveal-vs">VS</span>
          <section class="plb-matchup-reveal-team team-two">
            <b>Team 2</b>
            <div>${teamNames(matchup.team2 || [], "Team 2")}</div>
          </section>
        </div>
      </div>
    `;
  }

  function scheduleMatchupRevealEnd() {
    clearTimeout(state.matchupRevealTimer);
    const reducedMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    state.matchupRevealTimer = setTimeout(() => {
      state.matchupReveals = [];
      document.querySelectorAll(".plb-matchup-reveal").forEach(reveal => reveal.remove());
      document.querySelectorAll(".plb-court-card.has-matchup-reveal").forEach(card => {
        card.classList.remove("has-matchup-reveal");
      });
    }, reducedMotion ? 120 : 1750);
  }

  function beginMatchupReveals(reveals) {
    if (!reveals.length) return;
    state.pendingMatchupReveals = [];
    state.matchupReveals = reveals;
    renderBoard();
    announceUpdate(state.snapshot);
    scheduleMatchupRevealEnd();
  }

  function scheduleWinnerRevealEnd(pendingMatchups = []) {
    clearTimeout(state.winnerRevealTimer);
    const reducedMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    state.winnerRevealTimer = setTimeout(() => {
      state.winnerReveal = null;
      document.querySelectorAll(".plb-winner-reveal").forEach(reveal => reveal.remove());
      document.querySelectorAll(".plb-court-card.has-winner-reveal").forEach(card => {
        card.classList.remove("has-winner-reveal");
      });
      if (pendingMatchups.length) beginMatchupReveals(pendingMatchups);
    }, reducedMotion ? 120 : 1900);
  }

  function resolveUpNext(round) {
    const projected = round?.upNext;
    const projectedPlayers = Array.isArray(projected?.players)
      ? projected.players.filter(Boolean)
      : [
          ...(projected?.team1 || []),
          ...(projected?.team2 || []),
        ].filter(Boolean);
    if (projectedPlayers.length === 4) {
      return {
        players: projectedPlayers,
        team1: Array.isArray(projected?.team1) ? projected.team1.filter(Boolean) : projectedPlayers.slice(0, 2),
        team2: Array.isArray(projected?.team2) ? projected.team2.filter(Boolean) : projectedPlayers.slice(2, 4),
        courtName: projected.courtName || "Ready court",
        reserved: true,
      };
    }
    return {
      players: (round?.queue || []).slice(0, 4),
      team1: (round?.queue || []).slice(0, 2),
      team2: (round?.queue || []).slice(2, 4),
      courtName: "",
      reserved: false,
    };
  }

  function myPosition(snapshot) {
    const name = state.selectedName;
    if (!name) return null;
    if (!(snapshot.players || []).includes(name)) {
      return {
        eyebrow: "Player not active",
        title: "Ask the session manager",
        detail: "Your saved name is no longer in this live roster.",
        tone: "muted",
      };
    }
    const sessionStatus = String(snapshot.session?.status || "active");
    const assignments = snapshot.latestRound?.assignments || [];
    const liveGame = assignments.find(game =>
      !game.winner && [...(game.team1 || []), ...(game.team2 || [])].includes(name)
    );
    const queue = snapshot.latestRound?.queue || [];
    const queueIndex = queue.indexOf(name);
    const upNext = resolveUpNext(snapshot.latestRound);
    const reservedIndex = upNext.reserved ? upNext.players.indexOf(name) : -1;

    if (sessionStatus === "completed") {
      const standing = playerStanding(name);
      const display = standingDisplay(standing, snapshot);
      return {
        eyebrow: "Session complete",
        title: "Final results are posted",
        detail: standing
          ? `${display.aria} · ${display.meta} · ${requiresPodiumDecider(standing) ? "Podium decider required" : standing.eligible ? `Final rank #${standing.rank}` : "Provisional"}`
          : `See the final ${isCompetitiveMode(snapshot) ? "Competitive" : isWinPercentageMode(snapshot) ? "Win Percentage" : "Individual Performance"} standings below.`,
        tone: "finished",
      };
    }

    if (sessionStatus === "paused") {
      if (liveGame) {
        const team = (liveGame.team1 || []).includes(name) ? "Team 1" : "Team 2";
        return {
          eyebrow: "Session paused",
          title: liveGame.courtName || "Current court",
          detail: `${team} · Play will continue when the manager resumes`,
          tone: "muted",
        };
      }
      if (reservedIndex >= 0) {
        return {
          eyebrow: "Session paused",
          title: upNext.courtName,
          detail: "Your next lineup is reserved and will start when play resumes.",
          tone: "muted",
        };
      }
      if (queueIndex >= 0) {
        return {
          eyebrow: "Session paused",
          title: `Queue position #${queueIndex + 1}`,
          detail: "Your position is saved until play resumes.",
          tone: "muted",
        };
      }
      return {
        eyebrow: "Session paused",
        title: "Your position is on hold",
        detail: "Check again when the manager resumes play.",
        tone: "muted",
      };
    }

    if (liveGame) {
      const team = (liveGame.team1 || []).includes(name) ? "Team 1" : "Team 2";
      return {
        eyebrow: "You are playing now",
        title: liveGame.courtName || "Live court",
        detail: `${team} · Check the court card below`,
        tone: "playing",
      };
    }

    if (reservedIndex >= 0) {
      return {
        eyebrow: "You are up next",
        title: upNext.courtName,
        detail: "Your place is reserved in the next match.",
        tone: "next",
      };
    }

    if (queueIndex >= 0) {
      if (queueIndex < 4) {
        if (upNext.reserved) {
          return {
            eyebrow: "You are on deck",
            title: `Queue position #${queueIndex + 1}`,
            detail: "One match is already reserved ahead of your group.",
            tone: "waiting",
          };
        }
        return {
          eyebrow: "You are up next",
          title: "Stay close to the courts",
          detail: `Ready group · Queue position #${queueIndex + 1}`,
          tone: "next",
        };
      }
      return {
        eyebrow: "Your queue position",
        title: `#${queueIndex + 1}`,
        detail: upNext.reserved
          ? `${queueIndex} waiting player${queueIndex === 1 ? "" : "s"} ahead, plus one reserved match`
          : `${queueIndex - 3} player${queueIndex - 3 === 1 ? "" : "s"} ahead of the next group`,
        tone: "waiting",
      };
    }

    const finalGame = assignments.find(game =>
      game.winner && [...(game.team1 || []), ...(game.team2 || [])].includes(name)
    );
    if (finalGame) {
      return {
        eyebrow: "Last court",
        title: finalGame.courtName || "Game complete",
        detail: "Waiting for the queue to update",
        tone: "finished",
      };
    }

    return {
      eyebrow: "Waiting for an assignment",
      title: "Stay close to the courts",
      detail: "The manager is updating the next playing group.",
      tone: "waiting",
    };
  }

  function renderMyPosition(snapshot) {
    const position = myPosition(snapshot);
    if (!position) return "";
    return `
      <section class="plb-my-card is-${position.tone}" aria-label="Your live position">
        <span>${escapeHtml(position.eyebrow)}</span>
        <strong>${escapeHtml(position.title)}</strong>
        <small>${escapeHtml(position.detail)}</small>
      </section>
    `;
  }

  function resolveDispatchGroups(round, upNext) {
    const queue = Array.isArray(round?.queue) ? round.queue.filter(Boolean) : [];
    const groups = [];

    if (upNext?.reserved && upNext.players?.length === 4) {
      groups.push({
        kind: "ready",
        players: upNext.players,
        team1: upNext.team1?.length ? upNext.team1 : upNext.players.slice(0, 2),
        team2: upNext.team2?.length ? upNext.team2 : upNext.players.slice(2, 4),
        courtName: upNext.courtName || "Ready court",
      });
    }

    let queueOffset = 0;
    while (groups.length < 3) {
      const players = queue.slice(queueOffset, queueOffset + 4);
      queueOffset += 4;
      groups.push({
        kind: players.length === 4 ? "auto" : "waiting",
        players,
        team1: players.slice(0, 2),
        team2: players.slice(2, 4),
        courtName: "",
      });
    }

    return groups.slice(0, 3).map((group, index) => ({
      ...group,
      order: index + 1,
    }));
  }

  function renderDispatchPlayer(name) {
    if (!name) {
      return `<span class="plb-dispatch-player is-empty">Open slot</span>`;
    }
    return `
      <span class="plb-dispatch-player ${isMine(name) ? "is-mine" : ""}">
        <strong class="${nameFitClass(name)}" title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
        ${isMine(name) ? `<b>YOU</b>` : ""}
      </span>
    `;
  }

  function renderDispatchTeam(label, names) {
    const players = Array.isArray(names) ? names : [];
    return `
      <section class="plb-dispatch-team" aria-label="${escapeHtml(label)}">
        <span class="plb-dispatch-team-label">${escapeHtml(label)}</span>
        <div>
          ${[players[0], players[1]].map(renderDispatchPlayer).join("")}
        </div>
      </section>
    `;
  }

  function renderDispatchCard(group, sessionStatus = "active") {
    const playerCount = group.players.length;
    const complete = playerCount === 4;
    const ready = group.kind === "ready";
    const paused = sessionStatus === "paused";
    const status = paused ? "PAUSED" : ready ? "READY" : complete ? "AUTO" : "WAITING";
    const eyebrow = ready ? "Open court" : complete ? `Next group ${group.order}` : `Queue group ${group.order}`;
    const title = ready
      ? group.courtName
      : complete
        ? "Any open court"
        : `Need ${4 - playerCount} more`;
    const detail = paused
      ? "Position held until play resumes"
      : ready
        ? "Lineup reserved for this court"
        : complete
          ? "Moves to the first court that opens"
          : `${playerCount} of 4 players available`;
    const containsMine = group.players.some(isMine);

    return `
      <article
        class="plb-dispatch-card is-${group.kind} ${containsMine ? "has-mine" : ""}"
        data-plb-dispatch-order="${group.order}"
        style="--plb-order:${group.order - 1}"
      >
        <header class="plb-dispatch-card-head">
          <span class="plb-dispatch-order" aria-hidden="true">${group.order}</span>
          <div>
            <span>${escapeHtml(eyebrow)}</span>
            <strong>${escapeHtml(title)}</strong>
          </div>
          <b class="plb-dispatch-status">${status}</b>
        </header>
        <div class="plb-dispatch-matchup">
          ${renderDispatchTeam("Team 1", group.team1)}
          ${renderDispatchTeam("Team 2", group.team2)}
        </div>
        <footer>${escapeHtml(detail)}</footer>
      </article>
    `;
  }

  function renderCourt(game, index, sessionStatus = "active") {
    const hasWinner = Boolean(game.winner);
    const ready = hasWinner && sessionStatus !== "completed";
    const final = hasWinner && sessionStatus === "completed";
    const live = !hasWinner && sessionStatus === "active";
    const paused = !hasWinner && sessionStatus === "paused";
    const courtState = ready ? "READY" : final ? "FINAL" : paused ? "PAUSED" : live ? "LIVE" : "ENDED";
    const courtStateClass = ready ? "is-ready" : final ? "is-final" : paused ? "is-paused" : live ? "is-live" : "is-ended";
    const teamOneWon = game.winner === "A";
    const teamTwoWon = game.winner === "B";
    const selectedOnCourt = [...(game.team1 || []), ...(game.team2 || [])].some(isMine);
    const reveal = state.winnerReveal;
    const revealOnCourt = reveal && (
      Number(reveal.courtIndex) === index ||
      (!Number.isFinite(Number(reveal.courtIndex)) && String(reveal.courtName || "") === String(game.courtName || ""))
    );
    const currentMatchKey = matchEventKey(state.snapshot, game, index);
    const matchupReveal = state.matchupReveals.find(matchup =>
      Number(matchup.courtIndex) === index && matchup.eventKey === currentMatchKey
    );
    return `
      <article class="plb-court-card ${courtStateClass} ${selectedOnCourt ? "has-mine" : ""} ${revealOnCourt ? "has-winner-reveal" : ""} ${matchupReveal ? "has-matchup-reveal" : ""}">
        <header class="plb-court-head">
          <div>
            <h3>${escapeHtml(game.courtName || `Court ${index + 1}`)}</h3>
          </div>
          <div class="plb-court-state">
            <span class="plb-court-pill ${courtStateClass}">${courtState}</span>
            ${hasWinner
              ? `<span class="plb-court-time">Game ${Number(game.gameCount || 1)}</span>`
              : live
                ? `<span class="plb-court-time" data-live-start="${escapeHtml(game.startedAt || "")}">${elapsedLabel(game.startedAt)}</span>`
                : `<span class="plb-court-time">${paused ? "Paused" : "Session ended"}</span>`
            }
          </div>
        </header>
        <div class="plb-match">
          <section class="plb-team team-one ${teamOneWon ? "is-winner" : ""}" aria-label="Team 1${teamOneWon ? ", winner" : ""}">
            <div class="plb-team-label"><span>Team 1</span>${teamOneWon ? "<b>WINNER</b>" : ""}</div>
            <ul>${(game.team1 || []).map(playerItem).join("")}</ul>
          </section>
          <section class="plb-team team-two ${teamTwoWon ? "is-winner" : ""}" aria-label="Team 2${teamTwoWon ? ", winner" : ""}">
            <div class="plb-team-label"><span>Team 2</span>${teamTwoWon ? "<b>WINNER</b>" : ""}</div>
            <ul>${(game.team2 || []).map(playerItem).join("")}</ul>
          </section>
        </div>
        ${hasWinner ? `
          <div class="plb-result-line ${ready ? "is-ready" : ""}">${teamOneWon ? "Team 1" : "Team 2"} won${ready ? " &middot; Waiting for next match" : " this game"}</div>
        ` : ""}
        ${revealOnCourt ? renderWinnerReveal(reveal) : ""}
        ${matchupReveal ? renderMatchupReveal(matchupReveal) : ""}
      </article>
    `;
  }

  function renderUpNext(upNext, sessionStatus = "active") {
    const groups = resolveDispatchGroups(state.snapshot?.latestRound || {}, upNext);
    return `
      <div class="plb-next-grid plb-dispatch-grid">
        ${groups.map(group => renderDispatchCard(group, sessionStatus)).join("")}
      </div>
    `;
  }

  function renderQueue(queue, reservedAhead = false) {
    if (!queue.length) return `<div class="plb-empty">Everyone is currently on court.</div>`;
    const visibleQueue = queue.slice(0, 10);
    return `
      <ol class="plb-queue-list" id="plbQueueList" tabindex="0" aria-label="Waiting players in playing order">
        ${visibleQueue.map((name, index) => `
          <li class="${isMine(name) ? "is-mine" : ""}" style="--plb-order:${index}">
            <span class="plb-queue-number">${index + 1}</span>
            <span class="plb-queue-player">
              <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
              <small>${escapeHtml(playerRecord(name))}</small>
            </span>
            ${index < 4 ? `<span class="plb-up-badge">${reservedAhead ? "ON DECK" : "UP NEXT"}</span>` : ""}
            ${isMine(name) ? `<span class="plb-you-badge">YOU</span>` : ""}
          </li>
        `).join("")}
      </ol>
      ${queue.length > visibleQueue.length
        ? `<p class="plb-list-note">Showing the next 10 of ${queue.length} waiting players.</p>`
        : ""}
    `;
  }

  function renderPodiumPlayer(row, index) {
    const labels = ["Champion", "Runner-up", "Third place"];
    const games = Number(row?.games || 0);
    const rank = Number(row?.rank || index + 1);
    const display = standingDisplay(row);
    const decider = requiresPodiumDecider(row);
    const reason = rankingReason(row);
    return `
      <article class="plb-podium-card is-rank-${Math.min(rank, 3)} ${decider ? "is-decider" : ""} ${isMine(row?.name) ? "is-mine" : ""}" role="listitem">
        <span class="plb-podium-rank" aria-label="${escapeHtml(rankDescription(row))}">${rankLabel(row)}</span>
        <span class="plb-podium-avatar" aria-hidden="true">${escapeHtml(String(row?.name || "P").trim().charAt(0).toUpperCase() || "P")}</span>
        <small>${decider ? "Podium decider" : labels[Math.min(rank, 3) - 1]}</small>
        <strong title="${escapeHtml(row?.name || "Player")}">${escapeHtml(row?.name || "Player")}</strong>
        <b class="${display.tone}" aria-label="${display.aria}">${display.score}<span>${display.label.toLowerCase()}</span></b>
        <p>${games} games · ${display.meta}</p>
        ${reason ? `<p class="plb-podium-reason">${escapeHtml(reason)}</p>` : ""}
      </article>
    `;
  }

  function renderPodiumDeciderNotice(rows) {
    const deciderRows = (Array.isArray(rows) ? rows : []).filter(requiresPodiumDecider);
    if (!deciderRows.length) return "";
    const groups = new Map();
    deciderRows.forEach(row => {
      const groupId = String(row?.podiumDeciderGroupId || `rank-${row?.rank || "podium"}`);
      const names = groups.get(groupId) || [];
      names.push(String(row?.name || "Player"));
      groups.set(groupId, names);
    });
    const message = [...groups.values()]
      .map(names => `${names.join(", ")} have identical competitive results`)
      .join("; ");
    return `
      <div class="plb-decider-notice" role="status">
        <strong>Podium Decider Required</strong>
        <span>${escapeHtml(message)}. Official places remain TBD until one separating result is recorded.</span>
      </div>
    `;
  }

  function renderStandings(standings, sessionStatus = "active") {
    if (!standings.length) return `<div class="plb-empty">Standings will appear after play begins.</div>`;
    const topStandings = standings.slice(0, 10);
    const scoring = rankingCopy();
    if (sessionStatus === "completed") {
      const leaders = standings.filter(row => row?.eligible && Number(row.rank) <= 3);
      const deciderRows = leaders.filter(requiresPodiumDecider);
      const leaderRows = new Set(leaders);
      const remaining = topStandings.filter(row => !leaderRows.has(row));
      return `
        <div class="plb-final-standings" id="plbStandingsTable" tabindex="0" aria-label="Player standings">
          ${renderPodiumDeciderNotice(deciderRows)}
          ${leaders.length ? `
            <div class="plb-podium" role="list" aria-label="${scoring.podium}">
              ${leaders.map(renderPodiumPlayer).join("")}
            </div>
          ` : `<div class="plb-empty">No player completed the 3 games required for the podium.</div>`}
          ${remaining.length ? `
            <ol class="plb-final-list">
              ${remaining.map(row => {
                const games = Number(row.games || 0);
                const display = standingDisplay(row);
                return `
                  <li class="${isMine(row.name) ? "is-mine" : ""}">
                    <span aria-label="${escapeHtml(rankDescription(row))}">${rankLabel(row)}</span>
                    <strong>${escapeHtml(row.name)}</strong>
                    <small>${requiresPodiumDecider(row) ? "Decider required" : row.eligible ? "Qualified" : "Provisional"} · ${games} games · ${display.meta}</small>
                    <b class="${display.tone}">${display.compactScore}</b>
                  </li>
                `;
              }).join("")}
            </ol>
          ` : ""}
        </div>
      `;
    }
    return `
      ${renderPodiumDeciderNotice(topStandings)}
      <div class="plb-table-wrap" id="plbStandingsTable" tabindex="0" aria-label="Player standings">
        <table class="plb-standings">
          <thead>
            <tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">${isWinPercentageMode() ? "Win %" : "Points"}</th><th scope="col">Games</th></tr>
          </thead>
          <tbody>
            ${topStandings.map((row, index) => {
              const display = standingDisplay(row);
              return `
                <tr class="${isMine(row.name) ? "is-mine" : ""}" style="--plb-order:${index}">
                  <td><span aria-label="${escapeHtml(rankDescription(row))}">${rankLabel(row)}</span></td>
                  <th scope="row">${escapeHtml(row.name)}${isMine(row.name) ? ` <b>YOU</b>` : ""}<small>${requiresPodiumDecider(row) ? `Decider required · ${display.meta}` : row.eligible ? `${display.meta}${rankingReason(row) ? ` · ${escapeHtml(rankingReason(row))}` : ""}` : `${Number(row.games || 0)} of 3 games · ${display.meta}`}</small></th>
                  <td class="${display.tone}"><strong>${display.score}</strong></td>
                  <td>${Number(row.games || 0)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderLatestResult(result) {
    if (!result || !["A", "B"].includes(result.winner)) return "";
    const winners = result.winner === "A" ? result.team1 : result.team2;
    const label = result.winner === "A" ? "Team 1" : "Team 2";
    return `
      <aside class="plb-latest-result" aria-label="Latest result">
        <span>Latest result</span>
        <strong>${escapeHtml(result.courtName || "Court")} · ${escapeHtml(label)}</strong>
        <p>${(winners?.length ? winners : [label]).map(escapeHtml).join(" &amp; ")} won</p>
      </aside>
    `;
  }

  function syncMobileNav() {
    const nav = document.querySelector(".plb-mobile-nav");
    const links = [...(nav?.querySelectorAll("a[href^='#']") || [])];
    const currentId = links
      .find(link => link.getAttribute("aria-current") === "location")
      ?.getAttribute("href")
      ?.slice(1) || "";
    state.navObserver?.disconnect();
    state.navObserver = null;
    if (!links.length || !("IntersectionObserver" in window)) return;

    const byId = new Map(links.map(link => [link.getAttribute("href").slice(1), link]));
    const sections = [...byId.keys()].map(id => document.getElementById(id)).filter(Boolean);
    const setCurrent = id => {
      links.forEach(link => {
        if (link === byId.get(id)) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    };
    setCurrent(sections.some(section => section.id === currentId) ? currentId : (sections[0]?.id || ""));
    state.navObserver = new IntersectionObserver(entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      if (visible[0]?.target?.id) setCurrent(visible[0].target.id);
    }, {
      rootMargin: "-24% 0px -62% 0px",
      threshold: 0,
    });
    sections.forEach(section => state.navObserver.observe(section));
  }

  function renderBoard() {
    const element = root();
    const snapshot = state.snapshot;
    if (!element || !snapshot) return;
    const initialRender = !state.hasRendered;
    const activeElement = document.activeElement;
    const focusedId = element.contains(activeElement) ? activeElement.id : "";
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const nestedScroll = {};
    ["plbQueueList", "plbStandingsTable"].forEach(id => {
      const scrollRegion = document.getElementById(id);
      if (scrollRegion) nestedScroll[id] = scrollRegion.scrollTop;
    });
    const players = snapshot.players || [];
    const scoring = rankingCopy(snapshot);

    const session = snapshot.session || {};
    const round = snapshot.latestRound || { assignments: [], queue: [], roundNo: session.currentRound || 0 };
    const assignments = round.assignments || [];
    const queue = round.queue || [];
    const results = snapshot.resultCount === undefined
      ? assignments.filter(game => Boolean(game.winner)).length
      : Number(snapshot.resultCount || 0);
    const sessionStatus = session.status || "active";
    const standings = snapshot.standings || [];
    const standingsShown = sessionStatus === "completed"
      ? new Set([
          ...standings.slice(0, 10),
          ...standings.filter(row => row?.eligible && Number(row.rank) <= 3),
        ]).size
      : Math.min(10, standings.length);
    const upNext = sessionStatus === "completed"
      ? { players: queue.slice(0, 4), courtName: "", reserved: false }
      : resolveUpNext(round);
    const sessionActive = sessionStatus === "active";
    const liveCourts = assignments.filter(game => !game.winner).length;
    const readyCourts = sessionStatus !== "completed"
      ? assignments.filter(game => Boolean(game.winner)).length
      : 0;
    const courtsEyebrow = sessionActive
      ? "Now playing"
      : sessionStatus === "paused"
        ? "Play is paused"
        : "Session complete";
    const courtsTitle = sessionActive
      ? "Live Courts"
      : sessionStatus === "paused"
        ? "Paused Courts"
        : "Final Court State";
    const courtsCountLabel = sessionActive
      ? `${liveCourts} live${readyCourts ? ` &middot; ${readyCourts} ready` : ""}`
      : `${assignments.length} shown`;
    const nextEyebrow = sessionActive
      ? upNext.reserved ? "Reserved lineup" : "Ready group"
      : sessionStatus === "paused"
        ? "Queue paused"
        : "At session end";
    const nextTitle = sessionActive
      ? "Up Next"
      : sessionStatus === "paused"
        ? "Up Next (Paused)"
        : "Queue at End";
    const statusMessage = sessionStatus === "paused"
      ? "The manager paused this session. Court and queue positions remain visible."
      : sessionStatus === "completed"
        ? scoring.complete
        : "";
    const dispatchMarkup = renderUpNext(upNext, sessionStatus);
    const queueMarkup = renderQueue(queue, upNext.reserved);
    const standingsMarkup = renderStandings(standings, sessionStatus);
    const headerStats = document.getElementById("plbHeaderStats");
    if (headerStats) {
      headerStats.innerHTML = `
        <div><strong>${assignments.length}</strong><span>Courts</span></div>
        <div><strong>${players.length}</strong><span>Players</span></div>
        <div><strong>${queue.length}</strong><span>Waiting</span></div>
        <div><strong>${results}</strong><span>Results</span></div>
      `;
    }
    const headerSession = document.getElementById("plbHeaderSession");
    if (headerSession) {
      headerSession.innerHTML = `
        <strong>${escapeHtml(session.timeLabel || "Korte DOS Open Play")}</strong>
        <span>${escapeHtml(formatDate(session.date))} · Round ${Number(round.roundNo || session.currentRound || 0)}</span>
      `;
    }

    document.title = `Round ${Number(round.roundNo || 0)} · Korte DOS Live`;
    element.className = `plb-board${initialRender ? " is-initial-render" : ""}`;
    element.setAttribute("aria-busy", "false");
    element.innerHTML = `
      <section class="plb-session-hero">
        <div>
          <span class="plb-eyebrow">${escapeHtml(statusLabel(sessionStatus))} · OPEN PLAY</span>
          <h1>Live Match Center</h1>
          <p>${escapeHtml(scoring.hero)}</p>
        </div>
        <div class="plb-session-meta">
          <span>${escapeHtml(formatDate(session.date))}</span>
          <strong>${escapeHtml(session.timeLabel || "Korte DOS Open Play")} · Round ${Number(round.roundNo || session.currentRound || 0)}</strong>
        </div>
      </section>

      ${statusMessage ? `<div class="plb-session-banner is-${escapeHtml(sessionStatus)}">${escapeHtml(statusMessage)}</div>` : ""}

      <div class="plb-connection-note ${state.failures ? "is-error" : ""}" id="plbConnectionNote" role="status" aria-live="polite">
        ${state.failures ? "Connection interrupted. Showing the last update while reconnecting." : "Live connection active. This page refreshes automatically."}
      </div>

      <div class="plb-live-layout" id="plbLiveBoard">
        <div class="plb-live-content">
          <section class="plb-section" id="plbCourts" aria-labelledby="plbCourtsTitle">
            <div class="plb-round-strip">
              <div class="plb-round-copy">
                <span>${courtsEyebrow}</span>
                <h2 id="plbCourtsTitle">${courtsTitle}</h2>
                <small>${courtsCountLabel}</small>
              </div>
              <button class="plb-refresh" type="button" data-plb-action="refresh" aria-label="Refresh live board">
                <span aria-hidden="true">↻</span> Refresh
              </button>
            </div>
            <div class="plb-courts">
              ${assignments.map((game, index) => renderCourt(game, index, sessionStatus)).join("") || `<div class="plb-empty plb-empty-large">Court assignments have not started yet.</div>`}
            </div>
          </section>

          ${sessionStatus !== "completed" ? `
            <section class="plb-panel plb-next-panel plb-dispatch-panel" id="plbDispatch" aria-labelledby="plbNextTitle">
              <div class="plb-panel-head">
                <div><span>${nextEyebrow}</span><h2 id="plbNextTitle">${nextTitle}</h2></div>
                <b>3 court dispatch slots</b>
              </div>
              <div class="plb-panel-body">${dispatchMarkup}</div>
            </section>
          ` : `
            <section class="plb-panel plb-next-panel plb-dispatch-panel is-complete" id="plbDispatch" aria-labelledby="plbNextTitle">
              <div class="plb-panel-head">
                <div><span>Session complete</span><h2 id="plbNextTitle">Up Next</h2></div>
                <b>Closed</b>
              </div>
              <div class="plb-empty">Court dispatch closed when the session ended.</div>
            </section>
          `}
        </div>

        <aside class="plb-live-rail" aria-label="Playing order and standings">
          <section class="plb-panel plb-queue-panel" id="plbQueue" aria-labelledby="plbQueueTitle">
            <div class="plb-panel-head">
              <div><span>Playing order</span><h2 id="plbQueueTitle">Player Queue</h2></div>
              <b>${queue.length} waiting</b>
            </div>
            <div class="plb-panel-body">${queueMarkup}</div>
          </section>

          <section class="plb-panel plb-standings-panel" id="plbStandings" aria-labelledby="plbStandingsTitle">
            <div class="plb-panel-head">
              <div><span>${scoring.eyebrow}</span><h2 id="plbStandingsTitle">${sessionStatus === "completed" ? scoring.finalTitle : scoring.title}</h2></div>
              <b>${standingsShown} shown</b>
            </div>
            <div class="plb-panel-body">${standingsMarkup}</div>
          </section>
        </aside>
      </div>

      ${renderLatestResult(snapshot.latestResult)}

      <section class="plb-player-tools" aria-label="Personalize this live board">
        <section class="plb-find-card">
          <label for="plbFindName">
            <span>Find my position</span>
            <select id="plbFindName" aria-describedby="plbFindHelp">
              <option value="">Choose your name</option>
              ${state.selectedName && !players.includes(state.selectedName)
                ? `<option value="${escapeHtml(state.selectedName)}" selected>${escapeHtml(state.selectedName)} (not active)</option>`
                : ""}
              ${players.map(name => `
                <option value="${escapeHtml(name)}" ${name === state.selectedName ? "selected" : ""}>${escapeHtml(name)}</option>
              `).join("")}
            </select>
          </label>
          <p id="plbFindHelp">Saved only on this device. Your name is highlighted on courts, in dispatch, the queue, and standings.</p>
        </section>
        ${renderMyPosition(snapshot)}
      </section>
    `;
    state.hasRendered = true;

    Object.entries(nestedScroll).forEach(([id, top]) => {
      const scrollRegion = document.getElementById(id);
      if (scrollRegion) scrollRegion.scrollTop = top;
    });
    if (focusedId) {
      element.querySelector(`#${CSS.escape(focusedId)}`)?.focus({ preventScroll: true });
      window.scrollTo(scrollX, scrollY);
    }
    document.body.classList.add("plb-board-ready");
    syncMobileNav();
    updateHeader();
    updateClocks();
  }

  function renderUnavailable() {
    const element = root();
    if (!element) return;
    document.body.classList.remove("plb-board-ready");
    state.navObserver?.disconnect();
    const headerStats = document.getElementById("plbHeaderStats");
    if (headerStats) {
      headerStats.innerHTML = `
        <div><strong>–</strong><span>Courts</span></div>
        <div><strong>–</strong><span>Players</span></div>
        <div><strong>–</strong><span>Waiting</span></div>
        <div><strong>–</strong><span>Results</span></div>
      `;
    }
    const headerSession = document.getElementById("plbHeaderSession");
    if (headerSession) {
      headerSession.innerHTML = `<strong>Open Play</strong><span>Link unavailable</span>`;
    }
    element.className = "plb-message-card";
    element.setAttribute("aria-busy", "false");
    element.innerHTML = `
      <span class="plb-message-icon" aria-hidden="true">×</span>
      <span class="plb-eyebrow">Player link unavailable</span>
      <h1>This live board is no longer active.</h1>
      <p>The session may have ended, or the manager may have generated a new link. Ask Korte DOS staff for the latest QR code.</p>
    `;
    const announcement = document.getElementById("plbAnnouncements");
    if (announcement) {
      announcement.textContent = "This player link is no longer active. Ask Korte DOS staff for the latest QR code.";
    }
    updateHeader();
  }

  function renderConnectionError() {
    const element = root();
    if (!element) return;
    document.body.classList.remove("plb-board-ready");
    element.className = "plb-message-card";
    element.setAttribute("aria-busy", "false");
    element.innerHTML = `
      <span class="plb-message-icon is-warn" aria-hidden="true">↻</span>
      <span class="plb-eyebrow">Connection problem</span>
      <h1>The courts could not load yet.</h1>
      <p>Check your internet connection, then try again. The board will also reconnect automatically.</p>
      <button class="plb-refresh is-primary" type="button" data-plb-action="refresh">Try Again</button>
    `;
    updateHeader();
  }

  function contentSignature(snapshot) {
    const session = snapshot.session || {};
    const round = snapshot.latestRound || {};
    const cleanNames = names => Array.isArray(names) ? names.map(String) : [];
    const cleanGame = game => ({
      courtName: String(game?.courtName || ""),
      team1: cleanNames(game?.team1),
      team2: cleanNames(game?.team2),
      startedAt: String(game?.startedAt || ""),
      winner: String(game?.winner || ""),
      gameCount: Number(game?.gameCount || 0),
    });
    const cleanResult = result => result ? {
      eventId: String(result.eventId || ""),
      roundNo: Number(result.roundNo || 0),
      courtIndex: Number(result.courtIndex || 0),
      courtName: String(result.courtName || ""),
      team1: cleanNames(result.team1),
      team2: cleanNames(result.team2),
      winner: String(result.winner || ""),
      resultAt: String(result.resultAt || ""),
    } : null;

    return JSON.stringify({
      session: {
        date: String(session.date || ""),
        timeLabel: String(session.timeLabel || ""),
        status: String(session.status || "active"),
        currentRound: Number(session.currentRound || 0),
      },
      players: cleanNames(snapshot.players),
      latestRound: snapshot.latestRound ? {
        roundNo: Number(round.roundNo || 0),
        assignments: Array.isArray(round.assignments) ? round.assignments.map(cleanGame) : [],
        queue: cleanNames(round.queue),
        upNext: round.upNext ? {
          courtName: String(round.upNext.courtName || ""),
          players: cleanNames(round.upNext.players),
          team1: cleanNames(round.upNext.team1),
          team2: cleanNames(round.upNext.team2),
        } : null,
      } : null,
      standings: Array.isArray(snapshot.standings)
        ? snapshot.standings.map(row => ({
            name: String(row?.name || ""),
            wins: Number(row?.wins || 0),
            losses: Number(row?.losses || 0),
            games: Number(row?.games || 0),
            winPercentage: Number(row?.winPercentage || 0),
            mode: String(row?.mode || ""),
            rating: Number(row?.rating || 0),
            ratingExact: Number(row?.ratingExact || 0),
            points: Number(row?.points || 0),
            pointsExact: Number(row?.pointsExact || 0),
            eligible: Boolean(row?.eligible),
            rank: row?.rank == null ? null : Number(row.rank),
            sharedRank: Boolean(row?.sharedRank),
            averageOpponentRating: Number(row?.averageOpponentRating || 0),
            averageOpponentRatingExact: Number(row?.averageOpponentRatingExact || 0),
            bestUpset: Number(row?.bestUpset || 0),
            bestUpsetExact: Number(row?.bestUpsetExact || 0),
            headToHeadGames: Number(row?.headToHeadGames || 0),
            headToHeadWins: Number(row?.headToHeadWins || 0),
            headToHeadLosses: Number(row?.headToHeadLosses || 0),
            headToHeadPercentage: Number(row?.headToHeadPercentage || 0),
            rankCriterion: String(row?.rankCriterion || ""),
            rankReason: String(row?.rankReason || ""),
            tieBreakReason: String(row?.tieBreakReason || ""),
            requiresPodiumDecider: Boolean(row?.requiresPodiumDecider),
            podiumDeciderGroupId: String(row?.podiumDeciderGroupId || ""),
          }))
        : [],
      ratingSystem: snapshot.ratingSystem ? {
        mode: String(snapshot.ratingSystem.mode || ""),
        name: String(snapshot.ratingSystem.name || ""),
        version: String(snapshot.ratingSystem.version || ""),
        minGames: Number(snapshot.ratingSystem.minGames || 3),
        rankingMetric: String(snapshot.ratingSystem.rankingMetric || ""),
      } : null,
      resultCount: Number(snapshot.resultCount || 0),
      latestResult: cleanResult(snapshot.latestResult),
    });
  }

  function announceUpdate(snapshot) {
    const announcement = document.getElementById("plbAnnouncements");
    if (!announcement || !snapshot) return;
    const round = snapshot.latestRound || {};
    const assignments = round.assignments || [];
    const queue = round.queue || [];
    const sessionStatus = String(snapshot.session?.status || "active");
    const unfinishedCourts = assignments.filter(game => !game.winner).length;
    const courtUpdate = sessionStatus === "active"
      ? `${unfinishedCourts} active court${unfinishedCourts === 1 ? "" : "s"}.`
      : sessionStatus === "paused"
        ? `Session paused with ${unfinishedCourts} unfinished court${unfinishedCourts === 1 ? "" : "s"}.`
        : `Session complete with ${assignments.length} court${assignments.length === 1 ? "" : "s"} shown.`;
    const resultCount = snapshot.resultCount === undefined
      ? assignments.filter(game => Boolean(game.winner)).length
      : Number(snapshot.resultCount || 0);
    const position = myPosition(snapshot);
    const playerUpdate = position
      ? ` ${position.eyebrow}: ${position.title}.`
      : "";
    const selectedStanding = state.selectedName
      ? (snapshot.standings || []).find(row => String(row?.name || "") === state.selectedName)
      : null;
    const performanceUpdate = selectedStanding
      ? ` Your score is ${standingDisplay(selectedStanding, snapshot).aria}, ${standingDisplay(selectedStanding, snapshot).meta}; ${requiresPodiumDecider(selectedStanding) ? "podium decider required" : selectedStanding.eligible ? `rank ${selectedStanding.rank}` : "provisional"}.`
      : "";
    const reveal = state.winnerReveal;
    const winnerUpdate = reveal
      ? ` ${winningNames(reveal).join(" and ")} won on ${reveal.courtName || "their court"}.`
      : "";
    const matchupUpdate = state.matchupReveals.length
      ? ` ${state.matchupReveals.map(matchup => {
          const team1 = (matchup.team1 || []).join(" and ") || "Team 1";
          const team2 = (matchup.team2 || []).join(" and ") || "Team 2";
          return `New match on ${matchup.courtName}: ${team1} versus ${team2}.`;
        }).join(" ")}`
      : "";
    announcement.textContent = [
      `Live board updated. Round ${Number(round.roundNo || snapshot.session?.currentRound || 0)}.`,
      courtUpdate,
      `${queue.length} player${queue.length === 1 ? "" : "s"} waiting.`,
      `${resultCount} result${resultCount === 1 ? "" : "s"} recorded.`,
      winnerUpdate,
      matchupUpdate,
      playerUpdate,
      performanceUpdate,
    ].join(" ").trim();
  }

  function updateClocks() {
    document.querySelectorAll("[data-live-start]").forEach(element => {
      element.textContent = elapsedLabel(element.dataset.liveStart);
    });
    updateHeader();
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.terminal || document.hidden) return;
    const delay = state.failures
      ? Math.min(60000, POLL_MS * (2 ** Math.min(state.failures, 3)))
      : POLL_MS;
    state.pollTimer = setTimeout(fetchSnapshot, delay);
  }

  function setShareFeedback(message) {
    const label = document.querySelector("[data-plb-share-label]");
    if (!label) return;
    clearTimeout(state.shareFeedbackTimer);
    label.textContent = message;
    state.shareFeedbackTimer = setTimeout(() => {
      label.textContent = "Share";
    }, 2200);
  }

  async function copyBoardLink(url) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return;
    }
    const input = document.createElement("textarea");
    input.value = url;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Copy was not available");
  }

  async function shareBoard(button) {
    const shareData = {
      title: "Korte DOS Live Match Center",
      text: "Follow the Korte DOS live courts, queue, and standings.",
      url: location.href,
    };
    button.disabled = true;
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        setShareFeedback("Shared");
      } else {
        await copyBoardLink(shareData.url);
        setShareFeedback("Link copied");
      }
    } catch (error) {
      if (error?.name !== "AbortError") setShareFeedback("Try again");
    } finally {
      button.disabled = false;
    }
  }

  async function fetchSnapshot({ showBusy = false } = {}) {
    if (state.inFlight || state.terminal || document.hidden) return;
    state.inFlight = true;
    if (showBusy) {
      document.querySelectorAll('[data-plb-action="refresh"]').forEach(button => {
        button.disabled = true;
      });
    }
    try {
      const snapshot = await DB.getPublicOpenPlayGameLiveBoard(state.token);
      if (!snapshot) {
        state.terminal = true;
        state.snapshot = null;
        renderUnavailable();
        return;
      }
      const hadSnapshot = Boolean(state.snapshot);
      const winnerReveal = hadSnapshot ? winnerRevealForUpdate(state.snapshot, snapshot) : null;
      const matchupReveals = hadSnapshot ? matchupRevealsForUpdate(state.snapshot, snapshot) : [];
      const signature = contentSignature(snapshot);
      state.snapshot = snapshot;
      state.failures = 0;
      if (signature !== state.signature) {
        state.signature = signature;
        if (winnerReveal || matchupReveals.length) {
          clearTimeout(state.winnerRevealTimer);
          clearTimeout(state.matchupRevealTimer);
          state.winnerReveal = winnerReveal;
          state.pendingMatchupReveals = winnerReveal ? matchupReveals : [];
          state.matchupReveals = winnerReveal ? [] : matchupReveals;
        }
        renderBoard();
        if (hadSnapshot) announceUpdate(snapshot);
        if (winnerReveal) scheduleWinnerRevealEnd(matchupReveals);
        else if (matchupReveals.length) scheduleMatchupRevealEnd();
      } else {
        const note = document.getElementById("plbConnectionNote");
        if (note) {
          note.classList.remove("is-error");
          note.textContent = "Live connection active. This page refreshes automatically.";
        }
        updateHeader();
      }
    } catch (error) {
      state.failures += 1;
      if (!state.snapshot) renderConnectionError();
      else {
        const note = document.getElementById("plbConnectionNote");
        if (note) {
          note.classList.add("is-error");
          note.textContent = "Connection interrupted. Showing the last update while reconnecting.";
        }
        updateHeader();
      }
    } finally {
      state.inFlight = false;
      if (showBusy) {
        document.querySelectorAll('[data-plb-action="refresh"]').forEach(button => {
          button.disabled = false;
        });
      }
      schedulePoll();
    }
  }

  function handleClick(event) {
    const button = event.target.closest("[data-plb-action]");
    if (!button) return;
    if (button.dataset.plbAction === "refresh") {
      clearTimeout(state.pollTimer);
      fetchSnapshot({ showBusy: true });
      return;
    }
    if (button.dataset.plbAction === "share") {
      void shareBoard(button);
    }
  }

  function handleChange(event) {
    if (event.target.id !== "plbFindName") return;
    saveSelectedName(event.target.value);
    renderBoard();
    announceUpdate(state.snapshot);
  }

  function start() {
    state.selectedName = readSelectedName();
    document.addEventListener("click", handleClick);
    root()?.addEventListener("change", handleChange);
    state.clockTimer = setInterval(updateClocks, 1000);

    if (!/^[0-9a-f]{64}$/.test(state.token)) {
      state.terminal = true;
      renderUnavailable();
      return;
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearTimeout(state.pollTimer);
      } else {
        fetchSnapshot();
      }
    });
    window.addEventListener("online", fetchSnapshot);
    window.addEventListener("offline", () => {
      state.failures = Math.max(1, state.failures);
      updateHeader();
      const note = document.getElementById("plbConnectionNote");
      if (note) {
        note.classList.add("is-error");
        note.textContent = "You are offline. Showing the last saved live update.";
      }
    });
    window.addEventListener("hashchange", () => location.reload());
    fetchSnapshot();
  }

  start();
})();
