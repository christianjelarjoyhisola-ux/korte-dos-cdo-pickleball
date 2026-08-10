import { addOpenPlayPlayer, formatPeso, getState, subscribe } from "../data.js?v=20260803-9";

const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const initials = name => String(name || "Player")
  .split(/\s+/)
  .filter(Boolean)
  .map(part => part[0])
  .join("")
  .slice(0, 2)
  .toUpperCase();

const parseElapsed = value => {
  const [minutes = 0, seconds = 0] = String(value || "0:00").split(":").map(Number);
  return (minutes * 60) + seconds;
};

const formatElapsed = totalSeconds => {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
};

const uniqueByName = players => {
  const seen = new Set();
  return players.filter(player => {
    const key = String(player.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function createPlayModel(openPlay) {
  return {
    round: 3,
    notice: "Round 3 is live. Results will shape the next balanced rotation.",
    courts: openPlay.courts.slice(0, 2).map((court, index) => {
      const scores = String(court.score || "0 - 0").match(/\d+/g)?.map(Number) || [0, 0];
      return {
        ...court,
        label: `Match ${index + 1}`,
        scoreA: scores[0] || 0,
        scoreB: scores[1] || 0,
        elapsedBase: parseElapsed(court.elapsed),
        startedAt: Date.now(),
        status: "live"
      };
    }),
    queue: openPlay.queue.map(player => ({ ...player }))
  };
}

function renderPlayerPair(players) {
  return `<div class="rpi-player-pair">${players.map(player => `
    <span class="rpi-player">
      <span class="rpi-player-avatar" aria-hidden="true">${escapeHtml(initials(player))}</span>
      <span>${escapeHtml(player)}</span>
    </span>`).join("")}</div>`;
}

function renderCourtCard(court, round) {
  const isLive = court.status === "live";
  const statusLabel = isLive ? "Live" : "Result saved";
  return `
    <article class="rpi-court-card ${isLive ? "is-live" : "is-final"}" aria-labelledby="rpi-court-${court.id}">
      <header class="rpi-court-head">
        <div>
          <p>${escapeHtml(court.label)} / Round ${round}</p>
          <h3 id="rpi-court-${court.id}">${escapeHtml(court.name)}</h3>
        </div>
        <span class="rpi-live-badge ${isLive ? "" : "is-final"}"><span aria-hidden="true"></span>${statusLabel}</span>
      </header>
      <div class="rpi-match-clock">
        <span>Elapsed</span>
        <strong data-timer="${court.id}">${formatElapsed(court.elapsedBase)}</strong>
      </div>
      <div class="rpi-matchup">
        <section class="rpi-team" aria-label="Team one">
          <span class="rpi-team-label">Team one</span>
          ${renderPlayerPair(court.teamA)}
        </section>
        <div class="rpi-score" aria-label="Score ${court.scoreA} to ${court.scoreB}">
          <strong>${court.scoreA}</strong><span>to</span><strong>${court.scoreB}</strong>
        </div>
        <section class="rpi-team align-right" aria-label="Team two">
          <span class="rpi-team-label">Team two</span>
          ${renderPlayerPair(court.teamB)}
        </section>
      </div>
      <footer class="rpi-court-actions">
        ${isLive ? `
          <span>Record winner</span>
          <div>
            <button type="button" class="rpi-quiet-button" data-action="finish-match" data-court="${court.id}" data-winner="a">Team one</button>
            <button type="button" class="rpi-quiet-button" data-action="finish-match" data-court="${court.id}" data-winner="b">Team two</button>
          </div>` : `
          <span>Final score recorded</span>
          <button type="button" class="rpi-quiet-button" data-action="reopen-match" data-court="${court.id}">Reopen match</button>`}
      </footer>
    </article>`;
}

function waitLabel(index) {
  if (index < 2) return "Next";
  return `~${Math.ceil(index / 2) * 9} min`;
}

function renderQueue(queue) {
  if (!queue.length) {
    return `<div class="rpi-empty-state"><strong>Queue is clear</strong><span>New check-ins will appear here.</span></div>`;
  }

  return `<ol class="rpi-queue-list">${queue.map((player, index) => `
    <li>
      <span class="rpi-queue-position">${index + 1}</span>
      <span class="rpi-player-avatar" aria-hidden="true">${escapeHtml(initials(player.name))}</span>
      <span class="rpi-queue-person"><strong>${escapeHtml(player.name)}</strong><small>Level ${escapeHtml(player.level || "Open")}</small></span>
      <span class="rpi-wait ${index < 2 ? "is-next" : ""}">${escapeHtml(player.wait || waitLabel(index))}</span>
    </li>`).join("")}</ol>`;
}

function playMarkup(state, model, icon) {
  const openPlay = state.openPlay;
  const spotsLeft = Math.max(0, openPlay.capacity - openPlay.checkedIn);
  const completion = Math.min(100, (openPlay.checkedIn / openPlay.capacity) * 100);
  const allFinal = model.courts.every(court => court.status === "final");

  return `
    <section class="rpi-view rpi-play-view" aria-labelledby="rpi-play-title">
      <div class="rpi-play-hero">
        <div class="rpi-play-hero-copy">
          <div class="rpi-hero-kicker"><span class="rpi-pulse" aria-hidden="true"></span>Session in progress</div>
          <h2 id="rpi-play-title">${escapeHtml(openPlay.session)}</h2>
          <p>${escapeHtml(openPlay.time)} / Balanced rotation / ${model.courts.length} active courts</p>
        </div>
        <div class="rpi-hero-actions">
          <button type="button" class="button secondary" data-action="call-next">${icon("i-users")}Call next group</button>
          <button type="button" class="button primary" data-action="next-round">${icon("i-refresh")}${allFinal ? "Start next round" : "Generate next round"}</button>
        </div>
      </div>

      <div class="rpi-session-strip" aria-label="Session summary">
        <div class="rpi-session-progress">
          <div class="rpi-session-progress-copy"><span>Checked in</span><strong>${openPlay.checkedIn} of ${openPlay.capacity}</strong></div>
          <div class="rpi-progress-track" aria-hidden="true"><span style="width:${completion}%"></span></div>
          <small>${spotsLeft ? `${spotsLeft} spots still available` : "Session is at capacity"}</small>
        </div>
        <div class="rpi-session-stat"><span>Current round</span><strong>${model.round}</strong><small>Balanced doubles</small></div>
        <div class="rpi-session-stat"><span>Waiting now</span><strong>${model.queue.length}</strong><small>Estimated 9-18 min</small></div>
        <div class="rpi-session-stat"><span>Average game</span><strong>9:14</strong><small>Last six matches</small></div>
      </div>

      <div class="rpi-live-note" role="status" aria-live="polite">${icon("i-spark")}<span>${escapeHtml(model.notice)}</span></div>

      <div class="rpi-play-grid">
        <section class="rpi-live-courts" aria-labelledby="rpi-live-courts-title">
          <div class="section-heading">
            <div><h2 id="rpi-live-courts-title">Live courts</h2><p>Record a winner or move directly into the next balanced round.</p></div>
            <span class="rpi-sync-label">${icon("i-refresh")}Live sync on</span>
          </div>
          <div class="rpi-court-grid">${model.courts.map(court => renderCourtCard(court, model.round)).join("")}</div>
        </section>

        <aside class="rpi-play-rail" aria-label="Player queue and check-in">
          <section class="surface-card rpi-queue-card">
            <div class="rpi-rail-head"><div><p class="eyebrow">Rotation order</p><h2>Next up</h2></div><span>${model.queue.length} waiting</span></div>
            ${renderQueue(model.queue)}
          </section>

          <section class="surface-card rpi-checkin-card">
            <div class="rpi-rail-head"><div><p class="eyebrow">Walk-in desk</p><h2>Check in a participant</h2></div>${icon("i-plus")}</div>
            <p>Add an eligible player to the active session and rotation queue.</p>
            <form class="rpi-checkin-form" data-checkin-form>
              <label><span>Player name</span><input name="playerName" type="text" autocomplete="name" minlength="2" placeholder="Full name" required ${spotsLeft ? "" : "disabled"}></label>
              <label><span>Play level</span><select name="playerLevel" ${spotsLeft ? "" : "disabled"}><option value="2.5">2.5 / Beginner</option><option value="3.0">3.0 / Advancing</option><option value="Open">Open level</option></select></label>
              <button type="submit" class="button primary" ${spotsLeft ? "" : "disabled"}>${icon("i-check")}${spotsLeft ? "Check in player" : "Session full"}</button>
            </form>
          </section>
        </aside>
      </div>
    </section>`;
}

const heatmapRows = [
  ["6-9 AM", 44, 38, 46, 52, 65, 72, 58],
  ["9 AM-12 PM", 62, 56, 60, 67, 74, 86, 79],
  ["12-3 PM", 31, 34, 29, 36, 42, 68, 47],
  ["3-6 PM", 58, 63, 66, 72, 81, 91, 76],
  ["6-9 PM", 88, 91, 93, 95, 98, 96, 89],
  ["9-11 PM", 52, 57, 61, 68, 74, 83, 66]
];

function heatmapMarkup() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `
    <div class="rpi-heatmap-wrap">
      <table class="rpi-heatmap">
        <caption class="sr-only">Court utilization percentage by day and time window</caption>
        <thead><tr><th scope="col">Time</th>${days.map(day => `<th scope="col">${day}</th>`).join("")}</tr></thead>
        <tbody>${heatmapRows.map(([label, ...values]) => `<tr><th scope="row">${label}</th>${values.map(value => {
          const alpha = (0.08 + ((value / 100) * 0.78)).toFixed(2);
          return `<td><span style="--heat:${alpha}" class="${value >= 62 ? "is-strong" : ""}" title="${value}% utilized"><b>${value}%</b></span></td>`;
        }).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function trendChartMarkup() {
  const labels = ["May 18", "May 25", "Jun 1", "Jun 8", "Jun 15", "Jun 22", "Jun 29"];
  const revenue = [14200, 14980, 15160, 16740, 15880, 17360, 18420];
  const bookings = [23, 25, 24, 28, 27, 29, 31];
  const width = 720;
  const height = 220;
  const padX = 30;
  const padTop = 18;
  const padBottom = 34;
  const chartHeight = height - padTop - padBottom;
  const toPoints = (values, min, max) => values.map((value, index) => {
    const x = padX + (index * ((width - (padX * 2)) / (values.length - 1)));
    const y = padTop + ((max - value) / (max - min)) * chartHeight;
    return { x, y, value };
  });
  const revenuePoints = toPoints(revenue, 12000, 20000);
  const bookingPoints = toPoints(bookings, 18, 34);
  const pointString = points => points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const aria = labels.map((label, index) => `${label}: ${formatPeso(revenue[index])} revenue and ${bookings[index]} bookings`).join("; ");

  return `
    <div class="rpi-trend-legend" aria-hidden="true"><span class="revenue"><i></i>Revenue</span><span class="bookings"><i></i>Bookings</span></div>
    <svg class="rpi-trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Seven week revenue and booking trend. ${aria}">
      <g class="rpi-chart-grid">${[0, 1, 2, 3].map(index => {
        const y = padTop + (index * (chartHeight / 3));
        return `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}"/>`;
      }).join("")}</g>
      <polyline class="rpi-line revenue" points="${pointString(revenuePoints)}"/>
      <polyline class="rpi-line bookings" points="${pointString(bookingPoints)}"/>
      ${revenuePoints.map(point => `<circle class="rpi-point revenue" cx="${point.x}" cy="${point.y}" r="4"/>`).join("")}
      ${bookingPoints.map(point => `<circle class="rpi-point bookings" cx="${point.x}" cy="${point.y}" r="3.5"/>`).join("")}
      <g class="rpi-chart-labels">${labels.map((label, index) => {
        const x = padX + (index * ((width - (padX * 2)) / (labels.length - 1)));
        return `<text x="${x}" y="${height - 8}" text-anchor="middle">${label}</text>`;
      }).join("")}</g>
    </svg>`;
}

function sourceMixMarkup() {
  const sources = [
    ["Public booking", 41, "var(--violet)"],
    ["Returning players", 24, "var(--mint)"],
    ["Google discovery", 17, "var(--blue)"],
    ["Social channels", 12, "var(--coral)"],
    ["Front desk", 6, "var(--amber)"]
  ];
  return `
    <div class="rpi-source-chart">
      <div class="rpi-donut" role="img" aria-label="Booking source mix: ${sources.map(item => `${item[0]} ${item[1]} percent`).join(", ")}">
        <div><strong>59%</strong><span>digital discovery</span></div>
      </div>
      <ul>${sources.map(([label, value, color]) => `<li><i style="background:${color}"></i><span>${label}</span><strong>${value}%</strong></li>`).join("")}</ul>
    </div>`;
}

function roiResult(values) {
  const courts = Math.max(1, Number(values.courts) || 1);
  const rate = Math.max(0, Number(values.rate) || 0);
  const hours = Math.max(1, Number(values.hours) || 1);
  const days = Math.max(1, Number(values.days) || 1);
  const current = Math.min(100, Math.max(0, Number(values.current) || 0));
  const target = Math.min(100, Math.max(0, Number(values.target) || 0));
  const lift = Math.max(0, target - current) / 100;
  const recoveredHours = courts * hours * days * lift;
  const monthly = recoveredHours * rate;
  return { recoveredHours, monthly, annual: monthly * 12, lift: Math.max(0, target - current) };
}

function roiMarkup(state, roi) {
  const values = roiResult(roi);
  return `
    <section class="surface-card rpi-roi-card" aria-labelledby="rpi-roi-title">
      <div class="rpi-roi-heading">
        <div><p class="eyebrow">Editable scenario</p><h2 id="rpi-roi-title">What could stronger utilization mean?</h2><p>Change the assumptions to model an illustrative gross-booking opportunity for this venue.</p></div>
        <span class="rpi-assumption-badge">Assumptions, not a forecast</span>
      </div>
      <div class="rpi-roi-layout">
        <form class="rpi-roi-form" data-roi-form>
          <label><span>Courts</span><input type="number" name="courts" min="1" max="30" step="1" value="${roi.courts}"></label>
          <label><span>Average rate / court-hour</span><span class="rpi-input-prefix"><i>PHP</i><input type="number" name="rate" min="0" max="10000" step="10" value="${roi.rate}"></span></label>
          <label><span>Bookable hours / day</span><input type="number" name="hours" min="1" max="24" step="1" value="${roi.hours}"></label>
          <label><span>Operating days / month</span><input type="number" name="days" min="1" max="31" step="1" value="${roi.days}"></label>
          <label><span>Current utilization</span><span class="rpi-input-suffix"><input type="number" name="current" min="0" max="100" step="1" value="${roi.current}"><i>%</i></span></label>
          <label><span>Target utilization</span><span class="rpi-input-suffix"><input type="number" name="target" min="0" max="100" step="1" value="${roi.target}"><i>%</i></span></label>
        </form>
        <div class="rpi-roi-output" aria-live="polite">
          <span>Illustrative monthly uplift</span>
          <strong data-roi-monthly>${formatPeso(values.monthly)}</strong>
          <p><b data-roi-hours>${Math.round(values.recoveredHours)}</b> recovered court-hours at a <b data-roi-lift>${values.lift}</b>-point utilization lift.</p>
          <div><span>Annualized gross bookings</span><strong data-roi-annual>${formatPeso(values.annual)}</strong></div>
        </div>
      </div>
      <p class="rpi-roi-disclaimer">Illustrative model only. It multiplies available court-hours by the selected utilization lift and average rate. It excludes discounts, cancellations, payment fees, taxes, operating costs, seasonality, and implementation effects.</p>
    </section>`;
}

function insightsMarkup(state, roi, icon) {
  const metrics = state.metrics;
  return `
    <section class="rpi-view rpi-insights-view" aria-labelledby="rpi-insights-title">
      <div class="rpi-insights-hero">
        <div>
          <p class="eyebrow">Owner intelligence / Last 7 days</p>
          <h2 id="rpi-insights-title">See where demand grows, and where revenue still hides.</h2>
          <p>One clear view of court utilization, booking momentum, acquisition, and the next best operating moves.</p>
        </div>
        <button type="button" class="button secondary" data-action="export-insights">${icon("i-chart")}Export owner brief</button>
      </div>

      <div class="rpi-insight-metrics">
        <article><span>Gross bookings</span><strong>${formatPeso(metrics.revenue)}</strong><small class="is-positive">+14.8% from prior week</small></article>
        <article><span>Court utilization</span><strong>${metrics.occupancy}%</strong><small class="is-positive">+6 points in 30 days</small></article>
        <article><span>Completed bookings</span><strong>${metrics.bookings}</strong><small>4.4 daily average</small></article>
        <article><span>Revenue / court-hour</span><strong>${formatPeso(512)}</strong><small class="is-positive">+9.2% from prior week</small></article>
      </div>

      <div class="rpi-insights-grid">
        <section class="surface-card rpi-panel rpi-heatmap-panel" aria-labelledby="rpi-utilization-title">
          <div class="rpi-panel-heading"><div><p class="eyebrow">Demand map</p><h2 id="rpi-utilization-title">Utilization by time window</h2></div><div class="rpi-heat-legend"><span>Lower</span><i></i><i></i><i></i><i></i><span>Higher</span></div></div>
          ${heatmapMarkup()}
          <div class="rpi-insight-callout">${icon("i-spark")}<p><strong>Prime time is healthy.</strong> The clearest growth pocket is weekday 12-3 PM, where utilization averages 36%.</p></div>
        </section>

        <section class="surface-card rpi-panel rpi-source-panel" aria-labelledby="rpi-source-title">
          <div class="rpi-panel-heading"><div><p class="eyebrow">Acquisition</p><h2 id="rpi-source-title">Booking source mix</h2></div><span class="rpi-period-chip">This week</span></div>
          ${sourceMixMarkup()}
        </section>

        <section class="surface-card rpi-panel rpi-trend-panel" aria-labelledby="rpi-trend-title">
          <div class="rpi-panel-heading"><div><p class="eyebrow">Momentum</p><h2 id="rpi-trend-title">Revenue and bookings</h2></div><div class="rpi-trend-summary"><strong>+29.7%</strong><span>revenue in 7 weeks</span></div></div>
          ${trendChartMarkup()}
        </section>

        <section class="surface-card rpi-panel rpi-opportunity-panel" aria-labelledby="rpi-opportunities-title">
          <div class="rpi-panel-heading"><div><p class="eyebrow">Recommended actions</p><h2 id="rpi-opportunities-title">Underused slots</h2></div><span class="rpi-period-chip">3 opportunities</span></div>
          <div class="rpi-opportunity-list">
            <article><span class="rpi-opportunity-time">Wed / 12-3 PM</span><div><strong>Lunch rally offer</strong><p>31% utilized / 8 open court-hours</p></div><span class="rpi-opportunity-value">${formatPeso(3360)}</span><button type="button" data-action="create-offer" data-offer="Lunch rally">Create offer</button></article>
            <article><span class="rpi-opportunity-time">Tue / 6-9 AM</span><div><strong>Early-bird package</strong><p>38% utilized / repeat players nearby</p></div><span class="rpi-opportunity-value">${formatPeso(2240)}</span><button type="button" data-action="create-offer" data-offer="Early-bird package">Create offer</button></article>
            <article><span class="rpi-opportunity-time">Sun / 12-3 PM</span><div><strong>Family court bundle</strong><p>47% utilized / strongest family segment</p></div><span class="rpi-opportunity-value">${formatPeso(1680)}</span><button type="button" data-action="create-offer" data-offer="Family court bundle">Create offer</button></article>
          </div>
          <p class="rpi-opportunity-note">Opportunity values are open hours multiplied by the current average listed rate; they are not guaranteed revenue.</p>
        </section>
      </div>

      ${roiMarkup(state, roi)}
    </section>`;
}

export function renderPlayInsightsView(root, context) {
  const icon = context.icon || (id => `<svg aria-hidden="true"><use href="#${id}"/></svg>`);
  let currentState = getState();
  let playModel = createPlayModel(currentState.openPlay);
  let timerId = null;
  let destroyed = false;
  const roi = {
    courts: currentState.venue.courts,
    rate: 560,
    hours: 14,
    days: 30,
    current: currentState.metrics.occupancy,
    target: Math.min(95, currentState.metrics.occupancy + 8)
  };

  const syncTimers = () => {
    if (context.view !== "play") return;
    const now = Date.now();
    playModel.courts.forEach(court => {
      const node = root.querySelector(`[data-timer="${court.id}"]`);
      if (!node) return;
      const running = court.status === "live" ? Math.floor((now - court.startedAt) / 1000) : 0;
      node.textContent = formatElapsed(court.elapsedBase + running);
    });
  };

  const renderCurrent = () => {
    if (destroyed) return;
    currentState = getState();
    if (context.view === "play") {
      root.innerHTML = playMarkup(currentState, playModel, icon);
      syncTimers();
    } else {
      root.innerHTML = insightsMarkup(currentState, roi, icon);
    }
  };

  const playerPool = () => uniqueByName([
    ...playModel.courts.flatMap(court => [...court.teamA, ...court.teamB]).map(name => ({ name, level: "Open" })),
    ...getState().openPlay.queue.map(player => ({ ...player }))
  ]);

  const generateNextRound = () => {
    const pool = playerPool();
    if (pool.length < 8) {
      context.notify("More players needed", "Check in at least eight participants before generating two courts.");
      return;
    }
    playModel.round += 1;
    const shift = ((playModel.round - 3) * 4) % pool.length;
    const rotated = [...pool.slice(shift), ...pool.slice(0, shift)];
    const playing = rotated.slice(0, 8);
    playModel.courts = playModel.courts.map((court, index) => {
      const group = playing.slice(index * 4, (index + 1) * 4);
      return {
        ...court,
        label: `Match ${index + 1}`,
        teamA: [group[0].name, group[1].name],
        teamB: [group[2].name, group[3].name],
        scoreA: 0,
        scoreB: 0,
        elapsedBase: 0,
        startedAt: Date.now(),
        status: "live"
      };
    });
    playModel.queue = rotated.slice(8).map((player, index) => ({ ...player, wait: waitLabel(index) }));
    playModel.notice = `Round ${playModel.round} is live. Partners were balanced while preserving queue fairness.`;
    renderCurrent();
    context.notify(`Round ${playModel.round} generated`, "Two new matches are live and the waiting queue has been updated.");
  };

  const finishMatch = (courtId, winner) => {
    const court = playModel.courts.find(item => String(item.id) === String(courtId));
    if (!court || court.status !== "live") return;
    const running = Math.floor((Date.now() - court.startedAt) / 1000);
    court.elapsedBase += running;
    court.startedAt = Date.now();
    court.status = "final";
    court.scoreA = winner === "a" ? 11 : Math.min(9, court.scoreA || 7);
    court.scoreB = winner === "b" ? 11 : Math.min(9, court.scoreB || 7);
    playModel.notice = `${court.name} result saved. ${playModel.courts.every(item => item.status === "final") ? "Both courts are ready for the next round." : "One court is still in play."}`;
    renderCurrent();
  };

  const reopenMatch = courtId => {
    const court = playModel.courts.find(item => String(item.id) === String(courtId));
    if (!court) return;
    court.status = "live";
    court.startedAt = Date.now();
    playModel.notice = `${court.name} reopened for score correction.`;
    renderCurrent();
  };

  const updateRoi = form => {
    new FormData(form).forEach((value, key) => { roi[key] = Number(value); });
    const values = roiResult(roi);
    const monthly = root.querySelector("[data-roi-monthly]");
    const annual = root.querySelector("[data-roi-annual]");
    const hours = root.querySelector("[data-roi-hours]");
    const lift = root.querySelector("[data-roi-lift]");
    if (monthly) monthly.textContent = formatPeso(values.monthly);
    if (annual) annual.textContent = formatPeso(values.annual);
    if (hours) hours.textContent = Math.round(values.recoveredHours);
    if (lift) lift.textContent = values.lift;
  };

  const onClick = event => {
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode || !root.contains(actionNode)) return;
    const { action } = actionNode.dataset;
    if (action === "next-round") generateNextRound();
    if (action === "finish-match") finishMatch(actionNode.dataset.court, actionNode.dataset.winner);
    if (action === "reopen-match") reopenMatch(actionNode.dataset.court);
    if (action === "call-next") {
      const next = playModel.queue.slice(0, 4).map(player => player.name).join(", ");
      context.notify("Next group called", next || "The waiting queue is currently clear.");
    }
    if (action === "export-insights") context.notify("Owner brief prepared", "This showroom simulates a shareable PDF performance summary.");
    if (action === "create-offer") context.notify(`${actionNode.dataset.offer} drafted`, "The offer is ready for owner review; no message was sent in this demo.");
  };

  const onSubmit = event => {
    const form = event.target.closest("[data-checkin-form]");
    if (!form) return;
    event.preventDefault();
    const state = getState();
    if (state.openPlay.checkedIn >= state.openPlay.capacity) {
      context.notify("Session is at capacity", "No participant was added. Increase capacity or place the player on a waitlist.");
      return;
    }
    const data = new FormData(form);
    const name = String(data.get("playerName") || "").trim();
    const level = String(data.get("playerLevel") || "Open");
    if (name.length < 2) return;
    addOpenPlayPlayer({ name, level, wait: waitLabel(playModel.queue.length) });
    context.notify(`${name} checked in`, `Level ${level} / Added to the active rotation queue.`);
  };

  const onInput = event => {
    const form = event.target.closest("[data-roi-form]");
    if (form) updateRoi(form);
  };

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);

  const unsubscribe = subscribe((state, reason) => {
    if (destroyed || reason !== "open-play-player" || context.view !== "play") return;
    currentState = state;
    const latestPlayer = state.openPlay.queue.at(-1);
    const displayed = new Set([
      ...playModel.queue.map(player => player.name),
      ...playModel.courts.flatMap(court => [...court.teamA, ...court.teamB])
    ].map(name => name.toLowerCase()));
    if (latestPlayer && !displayed.has(latestPlayer.name.toLowerCase())) playModel.queue.push({ ...latestPlayer });
    playModel.notice = `${latestPlayer?.name || "Participant"} checked in and joined the rotation queue.`;
    renderCurrent();
  });

  renderCurrent();
  if (context.view === "play") timerId = window.setInterval(syncTimers, 1000);

  return () => {
    destroyed = true;
    if (timerId) window.clearInterval(timerId);
    unsubscribe();
    root.removeEventListener("click", onClick);
    root.removeEventListener("submit", onSubmit);
    root.removeEventListener("input", onInput);
  };
}
