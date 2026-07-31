(function () {
  'use strict';

  const base = {
    renderGameManager: window.renderGameManager,
    loadSession: window.gmLoadSession,
    createSession: window.gmCreateOrOpenSession,
    saveSessionMeta: window.gmSaveSessionMeta,
    savePlayers: window.gmSavePlayers,
    loadPaste: window.gmLoadPaste,
    handleRotationOptionChange: window.gmHandleRotationOptionChange,
    completeSession: window.gmCompleteSession,
    renderLiveStats: window.gmRenderLiveStats,
  };

  const PREF_KEY = 'korte_dos_open_play_preferences_v2';
  const ROSTER_KEY = 'korte_dos_open_play_saved_roster_v2';
  const MUTE_KEY = 'korte_dos_open_play_muted';
  const SKILLS = [
    ['0', 'Unrated'],
    ['1', 'Beginner · 2.0'],
    ['2', 'Adv Beginner · 2.5'],
    ['3', 'Intermediate · 3.0'],
    ['4', 'Adv Intermediate · 3.5'],
    ['5', 'Advanced · 4.0'],
    ['6', 'Expert · 4.5+'],
  ];
  const MODE_LABELS = {
    balanced: 'Auto-balanced',
    skill_separated: 'Skill-separated',
    winners_losers: 'Winners vs Losers',
    mixed_doubles: 'Mixed Doubles',
    skill_courts: 'Skill Courts',
    king_court: 'King / Queen of Court',
    club_wars: 'Club Wars',
    tournament: 'Tournament Schedule',
    queue: 'Strict Fair Queue',
  };
  const MODE_HELP = {
    balanced: 'Balances court time, team strength, and repeat partners or opponents.',
    skill_separated: 'Keeps players near the same skill tier, even when a court must wait.',
    winners_losers: 'Stages recent winners with winners and challengers with challengers while protecting queue fairness.',
    mixed_doubles: 'Builds one male and one female player per team, then balances skill and repeats.',
    skill_courts: 'Creates court groups by skill and rotates players inside the closest pool.',
    king_court: 'Moves winners toward the top court and losers down after results.',
    club_wars: 'Builds every match with one pair from each named player group.',
    tournament: 'Keeps locked teams together and follows a round-robin style schedule.',
    queue: 'Uses strict first-in order; finished players return to the back.',
  };

  let recentResult = null;
  let recentResultTimer = 0;
  let selectedCardPlayerId = null;
  let muted = localStorage.getItem(MUTE_KEY) === '1';

  function safeJson(value, fallback) {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function profileOf(player) {
    const raw = safeJson(player?.profile, {});
    return {
      skillLevel: Math.max(0, Math.min(6, Number(raw.skillLevel ?? raw.skill_level ?? player?.skill_level ?? 0) || 0)),
      gender: ['male', 'female', 'other', 'unspecified'].includes(String(raw.gender || player?.gender || 'unspecified'))
        ? String(raw.gender || player?.gender || 'unspecified')
        : 'unspecified',
      groupName: String(raw.groupName ?? raw.group_name ?? player?.group_name ?? '').trim().slice(0, 50),
      lockedPartnerId: String(raw.lockedPartnerId ?? raw.locked_partner_id ?? player?.locked_partner_id ?? '').trim() || null,
      duprId: String(raw.duprId ?? raw.dupr_id ?? player?.dupr_id ?? '').trim().slice(0, 40),
      checkedInAt: raw.checkedInAt || raw.checked_in_at || player?.checked_in_at || null,
    };
  }

  function sessionSettings(session = _gm.session) {
    return {
      organizerType: 'club',
      kingPartners: 'remix',
      skillCourtStyle: 'balanced',
      ...(safeJson(session?.settings, {})),
    };
  }

  function preferenceSnapshot() {
    return {
      location: ($('gmLocation')?.value || 'Korte DOS Open Play').trim(),
      organizerType: $('gmOrganizerType')?.value || 'club',
      format: $('gmFormat')?.value || 'doubles',
      style: $('gmMode')?.value || 'balanced',
      timeLabel: $('gmTimeLabel')?.value || '',
      publicCheckIn: Boolean($('gmPublicCheckIn')?.checked),
      muted,
    };
  }

  function savePreferences() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(preferenceSnapshot())); } catch (_) {}
  }

  function loadPreferences() {
    return safeJson(localStorage.getItem(PREF_KEY), {});
  }

  function setSessionFields(session) {
    const prefs = loadPreferences();
    const settings = sessionSettings(session);
    if ($('gmLocation')) $('gmLocation').value = session?.location || prefs.location || 'Korte DOS Open Play';
    if ($('gmOrganizerType')) $('gmOrganizerType').value = settings.organizerType || prefs.organizerType || 'club';
    if ($('gmPublicCheckIn')) $('gmPublicCheckIn').checked = Boolean(settings.publicCheckIn ?? prefs.publicCheckIn);
    muted = session?.settings?.muted ?? prefs.muted ?? muted;
    updateMuteButton();
  }

  function rosterEntries() {
    const saved = safeJson(localStorage.getItem(ROSTER_KEY), []);
    return Array.isArray(saved) ? saved : [];
  }

  function rememberRoster(players) {
    const byName = new Map(rosterEntries().map(player => [String(player.name || '').toLowerCase(), player]));
    (players || []).forEach(player => {
      const name = String(player.full_name || player.fullName || '').trim();
      if (!name) return;
      byName.set(name.toLowerCase(), { name, profile: profileOf(player) });
    });
    const next = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500);
    try { localStorage.setItem(ROSTER_KEY, JSON.stringify(next)); } catch (_) {}
    renderRosterDatalist();
  }

  function renderRosterDatalist() {
    const list = $('gmSavedRosterNames');
    if (list) list.innerHTML = rosterEntries().map(player => `<option value="${esc(player.name)}"></option>`).join('');
  }

  function newGameId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function teamIds(game) {
    return [...(game?.teamA || []), ...(game?.teamB || [])].filter(Boolean).map(String);
  }

  function cleanGameForHistory(game) {
    const copy = { ...game };
    delete copy.stagedMatches;
    delete copy.queueBeforeResult;
    delete copy.completedGames;
    return copy;
  }

  function gameDurationMinutes(game) {
    const start = Date.parse(game?.startedAt || game?.started_at || '');
    const end = Date.parse(game?.resultAt || game?.result_at || '');
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 60000 : null;
  }

  function allCompletedGames(rounds = _gm.rounds) {
    const games = [];
    (rounds || []).forEach((round, roundIndex) => {
      (round.assignments || []).forEach((court, courtIndex) => {
        (court.completedGames || []).forEach(game => {
          if (game?.winner) games.push({ ...game, roundId: round.id, roundIndex, courtIndex });
        });
        if (court?.winner) games.push({ ...cleanGameForHistory(court), roundId: round.id, roundIndex, courtIndex });
      });
    });
    return games.sort((a, b) => Date.parse(a.resultAt || 0) - Date.parse(b.resultAt || 0));
  }

  function averageGameMinutes() {
    const values = allCompletedGames().map(gameDurationMinutes).filter(value => value && value >= 2 && value <= 180);
    if (!values.length) return 12;
    return Math.max(5, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
  }

  function fullWaveRotationStyle() {
    return ['king_court', 'tournament'].includes(gmRotationOptions().style);
  }

  function fullWaveRotationMessage() {
    return gmRotationOptions().style === 'king_court'
      ? 'Record every court result, then use Next Rotation so winners and losers move together.'
      : 'Record every court result, then use Next Rotation to advance the tournament schedule.';
  }

  function stagedMatches(round) {
    if (fullWaveRotationStyle()) return [];
    const first = round?.assignments?.[0];
    return Array.isArray(first?.stagedMatches) ? first.stagedMatches : [];
  }

  function withStaged(assignments, staged) {
    const next = (assignments || []).map(game => ({ ...game }));
    if (next[0]) {
      if (fullWaveRotationStyle()) delete next[0].stagedMatches;
      else next[0].stagedMatches = staged;
    }
    return next;
  }

  function stagedIds(round) {
    return new Set(stagedMatches(round).flatMap(teamIds));
  }

  function availableQueueIds(round, includeStaged = false) {
    const ids = gmQueueIds(round);
    if (includeStaged) return ids;
    const reserved = stagedIds(round);
    return ids.filter(id => !reserved.has(String(id)));
  }

  function activeAlgorithmPlayers(ids) {
    const wanted = new Set((ids || []).map(String));
    return (_gm.players || []).map(gmNormalizePlayer)
      .filter(player => wanted.has(String(player.id)) && player.status === 'active')
      .map(player => ({
        id: String(player.id),
        name: player.full_name,
        seed_order: player.seed_order,
        skill_level: player.skill_level,
        gender: player.gender,
        group_name: player.group_name,
        locked_partner_id: player.locked_partner_id,
      }));
  }

  function autoStageMatches(round, count, existing = stagedMatches(round)) {
    if (fullWaveRotationStyle()) return [];
    const result = [...existing];
    const desired = Math.max(0, Number(count) || 0);
    const reserved = new Set(result.flatMap(teamIds));
    const ids = gmQueueIds(round).filter(id => !reserved.has(String(id)));
    if (result.length >= desired || ids.length < gmPlayersPerGame()) return result;
    const courtIds = Array.from({ length: desired - result.length }, (_, index) => `stage-${index}`);
    const generated = gmRotationApi().generateAssignments({
      active: activeAlgorithmPlayers(ids),
      courtIds,
      courtNames: {},
      rounds: _gm.rounds,
      format: gmRotationOptions().format,
      style: gmRotationOptions().style,
      random: () => 0,
    });
    generated.assignments.forEach((game, index) => {
      result.push({
        id: newGameId(),
        teamA: game.teamA,
        teamB: game.teamB,
        auto: true,
        label: `Up Next ${result.length + 1}`,
        order: result.length + index,
      });
    });
    return result.slice(0, desired);
  }

  async function persistLatestRound(assignments, queueSnapshot, successMessage) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last) return null;
    const sessionId = _gm.session.id;
    try {
      const saved = await DB.updateOpenPlayGameRound(
        last.id,
        { assignments, queueSnapshot },
        { assignments: last.assignments || [], queueSnapshot: last.queue_snapshot || [] }
      );
      _gm.rounds[_gm.rounds.length - 1] = saved;
      gmRenderBoard();
      if (successMessage) toast(successMessage);
      return saved;
    } catch (error) {
      console.error('persistLatestRound:', error);
      toast(error?.message || 'The live rotation changed. Reloaded; please try again.', 'err');
      await gmLoadSession(sessionId);
      return null;
    }
  }

  function updateMuteButton() {
    if ($('gmMuteBtn')) $('gmMuteBtn').textContent = muted ? 'Sound off' : 'Sound on';
  }

  function announce(message) {
    if (muted || !message) return;
    if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
      window.speechSynthesis.cancel();
      const speech = new SpeechSynthesisUtterance(message);
      speech.rate = 0.92;
      window.speechSynthesis.speak(speech);
    }
  }

  window.gmPreferenceChanged = function () {
    savePreferences();
    if (_gm.session) gmSaveSessionMeta().catch(error => toast(error?.message || 'Could not save session preferences.', 'err'));
  };

  window.gmToggleMute = async function () {
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    savePreferences();
    updateMuteButton();
    if (_gm.session) await gmSaveSessionMeta().catch(() => {});
    if (!muted) announce('Open Play announcements are on.');
  };

  window.gmNormalizePlayer = function (player, index) {
    const profile = profileOf(player);
    return {
      id: player?.id,
      session_id: player?.session_id,
      full_name: player?.full_name || player?.fullName || '',
      source_registration_id: player?.source_registration_id || player?.sourceRegistrationId || null,
      status: player?.status || 'no_show',
      seed_order: Number(player?.seed_order ?? player?.seedOrder ?? index),
      profile,
      skill_level: profile.skillLevel,
      gender: profile.gender,
      group_name: profile.groupName,
      locked_partner_id: profile.lockedPartnerId,
      dupr_id: profile.duprId,
      checked_in_at: profile.checkedInAt,
    };
  };

  function skillOptions(selected) {
    return SKILLS.map(([value, label]) =>
      `<option value="${value}" ${Number(selected) === Number(value) ? 'selected' : ''}>${label}</option>`
    ).join('');
  }

  function playerStats(playerId) {
    const history = gmBuildHistory(_gm.rounds);
    const games = history.resultCount?.[String(playerId)] || 0;
    const wins = history.winCount?.[String(playerId)] || 0;
    return { games, wins, losses: Math.max(0, games - wins), pct: games ? Math.round(wins / games * 100) : 0 };
  }

  window.gmRenderPlayers = function () {
    const wrap = $('gmPlayerList');
    if (!wrap) return;
    renderRosterDatalist();
    const players = (_gm.players || []).map(gmNormalizePlayer);
    const dups = gmDuplicateNames(players);
    const warn = $('gmPlayerWarnings');
    if (warn) {
      const checkedIn = players.filter(player => player.status === 'active');
      warn.innerHTML = [
        dups.size ? '<div class="gm-warn" style="margin-bottom:8px">Duplicate names found. Confirm they are different players.</div>' : '',
        checkedIn.length && checkedIn.length < gmPlayersPerGame()
          ? `<div class="gm-warn" style="margin-bottom:8px">Only ${checkedIn.length} checked in. You need ${gmPlayersPerGame()} to start.</div>`
          : '',
      ].join('');
    }
    if (!players.length) {
      wrap.innerHTML = '<div class="gm-empty">Import paid players, paste a roster, or add a walk-in.</div>';
      return;
    }
    const partnerOptions = current => [
      '<option value="">No locked partner</option>',
      ...players.filter(candidate => candidate.id && String(candidate.id) !== String(current.id) && candidate.status === 'active')
        .map(candidate => `<option value="${esc(candidate.id)}" ${String(current.locked_partner_id || '') === String(candidate.id) ? 'selected' : ''}>${esc(candidate.full_name)}</option>`),
    ].join('');
    wrap.innerHTML = players.map((player, index) => {
      const key = player.full_name.trim().toLowerCase();
      const stats = playerStats(player.id);
      const statusClass = player.status === 'removed' ? 'is-removed' : player.status === 'break' ? 'is-break' : '';
      return `<div class="gm-player-row ${dups.has(key) ? 'dup' : ''} ${statusClass}" data-id="${esc(player.id || '')}" data-source="${esc(player.source_registration_id || '')}" data-original-name="${esc(player.full_name)}" data-checked-in="${esc(player.checked_in_at || '')}">
        <span class="gm-player-no">${index + 1}</span>
        <input class="fi gm-player-name" list="gmSavedRosterNames" value="${esc(player.full_name)}" placeholder="Player name" onchange="gmApplySavedRosterProfile(this)"/>
        <select class="fi gm-player-status" onchange="gmPlayerStatusChanged(this)">
          <option value="no_show" ${player.status === 'no_show' ? 'selected' : ''}>Not here yet</option>
          <option value="active" ${player.status === 'active' ? 'selected' : ''}>Checked in</option>
          <option value="break" ${player.status === 'break' ? 'selected' : ''}>On break</option>
          <option value="removed" ${player.status === 'removed' ? 'selected' : ''}>Checked out</option>
        </select>
        <button class="btn btn-g btn-sm gm-player-detail-btn" type="button" onclick="gmTogglePlayerDetails(this)" title="Player details">&#9881;</button>
        <button class="btn btn-d btn-sm gm-player-remove-btn" type="button" onclick="gmRemovePlayerRow(this)" title="Check out">X</button>
        <div class="gm-player-details">
          <div><label class="fl">Skill</label><select class="fi gm-player-skill">${skillOptions(player.skill_level)}</select></div>
          <div><label class="fl">Gender</label><select class="fi gm-player-gender">
            <option value="unspecified" ${player.gender === 'unspecified' ? 'selected' : ''}>Unspecified</option>
            <option value="male" ${player.gender === 'male' ? 'selected' : ''}>Male</option>
            <option value="female" ${player.gender === 'female' ? 'selected' : ''}>Female</option>
            <option value="other" ${player.gender === 'other' ? 'selected' : ''}>Other</option>
          </select></div>
          <div><label class="fl">Club Wars Group</label><input class="fi gm-player-group" value="${esc(player.group_name || '')}" maxlength="50" placeholder="Group A"/></div>
          <div><label class="fl">Locked Partner</label><select class="fi gm-player-partner" ${gmRotationOptions().format === 'singles' ? 'disabled' : ''}>${partnerOptions(player)}</select></div>
          <div><label class="fl">DUPR ID</label><input class="fi gm-player-dupr" value="${esc(player.dupr_id || '')}" maxlength="40" placeholder="Optional"/></div>
          <div><label class="fl">Session</label><div class="gm-player-detail-stat">${stats.wins}W · ${stats.losses}L · ${stats.pct}%</div></div>
        </div>
      </div>`;
    }).join('');
  };

  window.gmTogglePlayerDetails = function (button) {
    button.closest('.gm-player-row')?.classList.toggle('details-open');
  };

  window.gmApplySavedRosterProfile = function (input) {
    const saved = rosterEntries().find(player => player.name.toLowerCase() === input.value.trim().toLowerCase());
    const row = input.closest('.gm-player-row');
    if (!saved || !row) return;
    const profile = profileOf(saved);
    if (row.querySelector('.gm-player-skill')) row.querySelector('.gm-player-skill').value = profile.skillLevel;
    if (row.querySelector('.gm-player-gender')) row.querySelector('.gm-player-gender').value = profile.gender;
    if (row.querySelector('.gm-player-group')) row.querySelector('.gm-player-group').value = profile.groupName;
    if (row.querySelector('.gm-player-dupr')) row.querySelector('.gm-player-dupr').value = profile.duprId;
  };

  window.gmCollectPlayers = function () {
    return [...document.querySelectorAll('.gm-player-row')].map((row, index) => {
      const id = row.dataset.id || null;
      const status = row.querySelector('.gm-player-status')?.value || 'no_show';
      let checkedInAt = row.dataset.checkedIn || null;
      if (status === 'active' && !checkedInAt) checkedInAt = new Date().toISOString();
      return {
        id,
        fullName: row.querySelector('.gm-player-name')?.value.trim() || (id ? row.dataset.originalName || '' : ''),
        sourceRegistrationId: row.dataset.source || null,
        status,
        seedOrder: index,
        profile: {
          skillLevel: Number(row.querySelector('.gm-player-skill')?.value || 0),
          gender: row.querySelector('.gm-player-gender')?.value || 'unspecified',
          groupName: row.querySelector('.gm-player-group')?.value.trim() || '',
          lockedPartnerId: row.querySelector('.gm-player-partner')?.value || null,
          duprId: row.querySelector('.gm-player-dupr')?.value.trim() || '',
          checkedInAt,
        },
      };
    }).filter(player => player.id || player.fullName || player.status !== 'removed');
  };

  window.gmPlayerStatusChanged = function (select) {
    const row = select.closest('.gm-player-row');
    if (!row) return;
    row.classList.toggle('is-removed', select.value === 'removed');
    row.classList.toggle('is-break', select.value === 'break');
    if (select.value === 'active' && !row.dataset.checkedIn) row.dataset.checkedIn = new Date().toISOString();
  };

  window.gmAddWalkIn = function () {
    const current = document.querySelectorAll('.gm-player-row').length
      ? gmCollectPlayers().map((player, index) => ({
          id: player.id || '',
          full_name: player.fullName,
          source_registration_id: player.sourceRegistrationId,
          status: player.status,
          seed_order: index,
          profile: player.profile,
        }))
      : (_gm.players || []);
    _gm.players = [...current, {
      id: '',
      full_name: '',
      source_registration_id: null,
      status: 'no_show',
      seed_order: current.length,
      profile: { skillLevel: 0, gender: 'unspecified', groupName: '', lockedPartnerId: null, duprId: '', checkedInAt: null },
    }];
    gmRenderPlayers();
    setTimeout(() => {
      const inputs = document.querySelectorAll('.gm-player-name');
      inputs[inputs.length - 1]?.focus();
    }, 30);
  };

  window.gmSavePlayers = async function () {
    const saved = await base.savePlayers();
    if (saved) rememberRoster(_gm.players);
    return saved;
  };

  function parseRosterText(raw) {
    const lines = String(raw || '').replace(/\r/g, '').split(/\n|,/);
    let section = 'players';
    let organizersSkipped = 0;
    const names = [];
    lines.forEach(line => {
      let value = line.trim();
      if (!value) return;
      if (/organizers?/i.test(value) && value.length < 50) { section = 'organizers'; return; }
      if (/participants?|players?|attendees?/i.test(value) && value.length < 50) { section = 'players'; return; }
      if (section === 'organizers') { organizersSkipped += 1; return; }
      value = value
        .replace(/^[\s•·▪◦*\-–—]+/, '')
        .replace(/^\d+[.)\-\s]+/, '')
        .replace(/\s+(paid|going|joined|waitlist|beginner|intermediate|advanced|expert)(\s.*)?$/i, '')
        .trim();
      if (!value || /^(name|status|skill|reclub|guest|member|total|\d+\s*(players?|spots?))$/i.test(value)) return;
      if (/^https?:\/\//i.test(value) || value.length > 90) return;
      names.push(value);
    });
    return {
      names: [...new Map(names.map(name => [name.toLowerCase(), name])).values()],
      organizersSkipped,
    };
  }

  window.gmLoadPaste = async function () {
    const raw = ($('gmPasteBox')?.value || '').trim();
    if (!raw) return;
    try {
      const url = new URL(raw);
      if (url.searchParams.get('gm') || url.searchParams.get('gmDate')) return base.loadPaste();
    } catch (_) {}
    const parsed = parseRosterText(raw);
    if (!parsed.names.length) {
      toast('No player names were found in that roster.', 'err');
      return;
    }
    $('gmPasteBox').value = parsed.names.join('\n');
    await base.loadPaste();
    toast(`${parsed.names.length} players loaded${parsed.organizersSkipped ? `; ${parsed.organizersSkipped} organizer entr${parsed.organizersSkipped === 1 ? 'y' : 'ies'} skipped` : ''}. Review check-in before starting.`);
  };

  window.gmUpdateModeHelp = function () {
    const note = $('gmModeHelp');
    if (!note) return;
    const { format, style } = gmRotationOptions();
    const doublesOnly = new Set(['skill_separated', 'mixed_doubles', 'skill_courts', 'king_court', 'club_wars', 'tournament']);
    if ($('gmMode')) {
      [...$('gmMode').options].forEach(option => {
        option.disabled = format === 'singles' && doublesOnly.has(option.value);
      });
    }
    note.textContent = `${MODE_HELP[style] || MODE_HELP.balanced} Uses ${format === 'singles' ? 'two players per court' : 'four players per court'}.`;
  };

  window.gmHandleRotationOptionChange = async function () {
    const previousStyle = gmRotationApi().parseMode(_gm.session?.mode).style;
    const doublesOnly = new Set(['skill_separated', 'mixed_doubles', 'skill_courts', 'king_court', 'club_wars', 'tournament']);
    if ($('gmFormat')?.value === 'singles' && doublesOnly.has($('gmMode')?.value)) {
      $('gmMode').value = 'balanced';
      toast('Singles uses its dedicated one-on-one balancing flow.', 'inf');
    }
    const result = await base.handleRotationOptionChange();
    const nextStyle = gmRotationOptions().style;
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (last && previousStyle !== nextStyle && Array.isArray(last.assignments?.[0]?.stagedMatches)) {
      const assignments = last.assignments.map(game => ({ ...game }));
      delete assignments[0].stagedMatches;
      await persistLatestRound(assignments, last.queue_snapshot, 'Rotation style updated; Up Next was cleared for a fresh draw.');
    }
    gmRenderBoard();
    return result;
  };

  window.gmSessionModeLabel = function (session) {
    const mode = gmRotationApi().parseMode(session?.mode);
    return `${mode.format === 'singles' ? 'Singles' : 'Doubles'} · ${MODE_LABELS[mode.style] || MODE_LABELS.balanced}`;
  };

  window.gmAddTemporaryCourt = function () {
    const number = (_gm.courts || []).length + 1;
    const name = prompt('Temporary court name', `Court ${number}`);
    if (!name?.trim()) return;
    _gm.courts.push({ id: `temporary-${Date.now().toString(36)}`, name: name.trim(), temporary: true });
    gmRenderCourtPicker([...gmSelectedCourtIds(), _gm.courts[_gm.courts.length - 1].id]);
    gmRefreshSourceSummary();
  };

  window.renderGameManager = async function () {
    const prefs = loadPreferences();
    if ($('gmLocation') && !$('gmLocation').value) $('gmLocation').value = prefs.location || 'Korte DOS Open Play';
    if ($('gmOrganizerType')) $('gmOrganizerType').value = prefs.organizerType || 'club';
    await base.renderGameManager();
    setSessionFields(_gm.session);
    try { rememberRoster(await DB.getOpenPlayGameAllPlayers()); } catch (_) {}
    renderRosterDatalist();
    gmRenderBoard();
  };

  window.gmLoadSession = async function (id) {
    const loaded = await base.loadSession(id);
    if (loaded) {
      setSessionFields(_gm.session);
      rememberRoster(_gm.players);
      gmRenderPlayers();
      gmRenderBoard();
    }
    return loaded;
  };

  window.gmCreateOrOpenSession = async function () {
    const session = await base.createSession();
    if (!session) return null;
    const settings = {
      ...sessionSettings(session),
      organizerType: $('gmOrganizerType')?.value || 'club',
      publicCheckIn: Boolean($('gmPublicCheckIn')?.checked),
      muted,
    };
    const saved = await DB.updateOpenPlayGameSession(session.id, {
      location: ($('gmLocation')?.value || 'Korte DOS Open Play').trim(),
      settings,
      shareEnabled: session.share_enabled ?? true,
    });
    _gm.session = saved || session;
    savePreferences();
    return _gm.session;
  };

  window.gmSaveSessionMeta = async function () {
    await base.saveSessionMeta();
    if (!_gm.session) return;
    const saved = await DB.updateOpenPlayGameSession(_gm.session.id, {
      location: ($('gmLocation')?.value || 'Korte DOS Open Play').trim(),
      settings: {
        ...sessionSettings(_gm.session),
        organizerType: $('gmOrganizerType')?.value || 'club',
        publicCheckIn: Boolean($('gmPublicCheckIn')?.checked),
        muted,
      },
    });
    _gm.session = saved || _gm.session;
    savePreferences();
  };

  window.gmGenerateAssignments = function (active, courtIds, rounds) {
    const { format, style } = gmRotationOptions();
    const courtNames = Object.fromEntries(courtIds.map(id => [String(id), gmCourtNames([id])[0]]));
    return gmRotationApi().generateAssignments({ active, courtIds, courtNames, rounds, format, style });
  };

  window.gmGenerateNextRound = async function () {
    if (gmLiveMutationBlocked()) return;
    if (_gm.rounds.length && _gm.rounds[_gm.rounds.length - 1]?.assignments?.some(game => !game.winner)) {
      toast('Record or close every live court before starting a new full rotation.', 'inf');
      return;
    }
    if (!await gmSavePlayers()) return;
    await gmSaveSessionMeta();
    const active = _gm.players.map(gmNormalizePlayer).filter(player => player.status === 'active' && player.full_name)
      .map(player => ({
        id: String(player.id),
        name: player.full_name,
        seed_order: player.seed_order,
        skill_level: player.skill_level,
        gender: player.gender,
        group_name: player.group_name,
        locked_partner_id: player.locked_partner_id,
      }));
    const courtIds = gmSelectedCourtIds();
    if (active.length < gmPlayersPerGame()) { toast(`Need at least ${gmPlayersPerGame()} checked-in players.`, 'err'); return; }
    if (!courtIds.length) { toast('Choose at least one court.', 'err'); return; }
    const generated = gmGenerateAssignments(active, courtIds, _gm.rounds);
    if (!generated.assignments.length) { toast('The selected matching mode cannot form a complete game from the checked-in roster.', 'err'); return; }
    const now = new Date().toISOString();
    let assignments = generated.assignments.map(game => ({
      ...game,
      gameId: newGameId(),
      startedAt: now,
      teamAScore: null,
      teamBScore: null,
      completedGames: [],
    }));
    const previewRound = { assignments, queue_snapshot: generated.queueSnapshot };
    assignments = withStaged(assignments, autoStageMatches(previewRound, assignments.length, []));
    const roundNo = (_gm.rounds[_gm.rounds.length - 1]?.round_no || 0) + 1;
    const sessionId = _gm.session.id;
    try {
      await DB.addOpenPlayGameRound({
        sessionId,
        roundNo,
        assignments,
        queueSnapshot: generated.queueSnapshot,
        partnerHistory: generated.partnerHistory,
        opponentHistory: generated.opponentHistory,
        completedAt: null,
      });
      announce(`Round ${roundNo} is ready. ${assignments.map(game => `${game.courtName}: ${teamIds(game).map(gmPlayerName).join(', ')}`).join('. ')}`);
      toast(`Round ${roundNo} started.`);
      await gmLoadSession(sessionId);
    } catch (error) {
      console.error('gmGenerateNextRound parity:', error);
      toast(error?.message || 'Could not start the rotation.', 'err');
      await gmLoadSession(sessionId);
    }
  };

  window.gmRoundPlayingIds = function (round) {
    if (_gm.session && ['completed', 'cancelled'].includes(_gm.session.status)) return new Set();
    return new Set((round?.assignments || []).filter(game => !game.winner)
      .flatMap(game => teamIds(game)));
  };

  window.gmQueueIds = function (round) {
    const activeIds = new Set(gmActivePlayers().map(player => String(player.id)));
    const playingIds = gmRoundPlayingIds(round);
    const fromRound = (round?.queue_snapshot || []).filter(Boolean).map(String)
      .filter(id => activeIds.has(id) && !playingIds.has(id));
    const missing = [...activeIds].filter(id => !playingIds.has(id) && !fromRound.includes(id));
    return [...fromRound, ...missing];
  };

  window.gmSetWinner = async function (assignmentIndex, winner) {
    if (gmLiveMutationBlocked()) return;
    const last = _gm.rounds[_gm.rounds.length - 1];
    const current = last?.assignments?.[assignmentIndex];
    if (!current || current.winner) { toast('This court already has a saved result.', 'inf'); return; }
    if (teamIds(current).length !== gmPlayersPerGame()) { toast('Fill every player slot before recording a winner.', 'err'); return; }
    const queueBeforeResult = gmQueueIds(last);
    const finishedIds = teamIds(current);
    const resultAt = new Date().toISOString();
    const assignments = (last.assignments || []).map((game, index) => index === assignmentIndex
      ? { ...game, winner, resultAt, queueBeforeResult, gameId: game.gameId || newGameId() }
      : game);
    const queueSnapshot = [...queueBeforeResult, ...finishedIds.filter(id => !queueBeforeResult.includes(id))];
    const saved = await persistLatestRound(assignments, queueSnapshot);
    if (!saved) return;
    const winningIds = winner === 'A' ? current.teamA : current.teamB;
    announce(`${current.courtName || 'Court'} result. ${winningIds.filter(Boolean).map(gmPlayerName).join(' and ')} won.`);
    showRecentUndo({
      roundId: last.id,
      assignmentIndex,
      resultAt,
      queueBeforeResult,
    }, `${current.courtName || 'Court'} result saved. The court is waiting for staff to start Up Next.`);
  };

  function showRecentUndo(result, message) {
    recentResult = result;
    clearTimeout(recentResultTimer);
    if ($('gmUndoResultText')) $('gmUndoResultText').textContent = message;
    $('gmUndoResultBar')?.classList.add('show');
    recentResultTimer = setTimeout(() => {
      recentResult = null;
      $('gmUndoResultBar')?.classList.remove('show');
    }, 10000);
  }

  window.gmUndoRecentResult = async function () {
    if (!recentResult) { toast('The 10-second result undo window has closed.', 'inf'); return; }
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last || String(last.id) !== String(recentResult.roundId)) return;
    const assignments = (last.assignments || []).map((game, index) => {
      if (index !== recentResult.assignmentIndex || game.resultAt !== recentResult.resultAt) return game;
      const copy = { ...game };
      delete copy.winner;
      delete copy.resultAt;
      delete copy.queueBeforeResult;
      return copy;
    });
    const saved = await persistLatestRound(assignments, recentResult.queueBeforeResult, 'Result undone.');
    if (saved) {
      recentResult = null;
      clearTimeout(recentResultTimer);
      $('gmUndoResultBar')?.classList.remove('show');
    }
  };

  window.gmAddStagedMatch = async function () {
    if (gmLiveMutationBlocked()) return;
    if (fullWaveRotationStyle()) { toast(fullWaveRotationMessage(), 'inf'); return; }
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last) { toast('Start the session before adding an Up Next match.', 'inf'); return; }
    const current = stagedMatches(last);
    const next = autoStageMatches(last, current.length + 1, current);
    if (next.length === current.length) {
      const teamSize = gmRotationOptions().format === 'singles' ? 1 : 2;
      next.push({ id: newGameId(), teamA: Array(teamSize).fill(null), teamB: Array(teamSize).fill(null), auto: false, label: `Up Next ${next.length + 1}` });
    }
    await persistLatestRound(withStaged(last.assignments, next), last.queue_snapshot, 'Up Next match added.');
  };

  window.gmRemoveStagedMatch = async function (stageIndex) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last) return;
    const next = stagedMatches(last).filter((_, index) => index !== stageIndex);
    await persistLatestRound(withStaged(last.assignments, next), last.queue_snapshot, 'Up Next match removed.');
  };

  window.gmStagePlayerChanged = async function (stageIndex, team, slot, playerId) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last) return;
    const next = stagedMatches(last).map(game => ({ ...game, teamA: [...(game.teamA || [])], teamB: [...(game.teamB || [])] }));
    const match = next[stageIndex];
    if (!match) return;
    const duplicate = next.flatMap(teamIds).some(id => String(id) === String(playerId)) && String(match[team]?.[slot] || '') !== String(playerId || '');
    if (playerId && duplicate) { toast('That player is already staged in Up Next.', 'err'); gmRenderNextUp(last); return; }
    match[team][slot] = playerId || null;
    match.auto = false;
    await persistLatestRound(withStaged(last.assignments, next), last.queue_snapshot);
  };

  window.gmStartStagedMatch = async function (stageIndex, requestedCourtIndex) {
    if (gmLiveMutationBlocked()) return;
    if (fullWaveRotationStyle()) { toast(fullWaveRotationMessage(), 'inf'); return; }
    const last = _gm.rounds[_gm.rounds.length - 1];
    const stage = stagedMatches(last)[stageIndex];
    if (!stage || teamIds(stage).length !== gmPlayersPerGame()) { toast('Fill every Up Next slot first.', 'err'); return; }
    const eligibleCourts = (last.assignments || []).map((game, index) => ({ game, index }))
      .filter(item => item.game.winner || teamIds(item.game).length < gmPlayersPerGame());
    let courtIndex = Number(requestedCourtIndex);
    if (!Number.isInteger(courtIndex) || !eligibleCourts.some(item => item.index === courtIndex)) courtIndex = eligibleCourts[0]?.index;
    if (!Number.isInteger(courtIndex)) { toast('No finished or open court is ready yet.', 'inf'); return; }
    const selectedIds = teamIds(stage);
    const queue = gmQueueIds(last);
    if (selectedIds.some(id => !queue.includes(id))) { toast('An Up Next player is no longer checked in or waiting. Review the staged match.', 'err'); return; }
    let assignments = (last.assignments || []).map((game, index) => {
      if (index !== courtIndex) return { ...game };
      const archive = [...(game.completedGames || [])];
      if (game.winner) archive.push(cleanGameForHistory(game));
      return {
        courtId: game.courtId,
        courtName: game.courtName,
        teamA: [...stage.teamA],
        teamB: [...stage.teamB],
        gameId: newGameId(),
        startedAt: new Date().toISOString(),
        teamAScore: null,
        teamBScore: null,
        completedGames: archive,
      };
    });
    let nextStages = stagedMatches(last).filter((_, index) => index !== stageIndex);
    const queueSnapshot = queue.filter(id => !selectedIds.includes(id));
    const preview = { ...last, assignments, queue_snapshot: queueSnapshot };
    nextStages = autoStageMatches(preview, Math.max(1, assignments.length), nextStages);
    assignments = withStaged(assignments, nextStages);
    const saved = await persistLatestRound(assignments, queueSnapshot, `${assignments[courtIndex].courtName || 'Court'} started.`);
    if (saved) {
      recentResult = null;
      $('gmUndoResultBar')?.classList.remove('show');
      announce(`${assignments[courtIndex].courtName || 'Court'}. ${selectedIds.map(gmPlayerName).join(', ')}. Please start.`);
    }
  };

  window.gmCallStagedMatch = function (stageIndex) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    const match = stagedMatches(last)[stageIndex];
    if (!match) return;
    const names = teamIds(match).map(gmPlayerName);
    if (!names.length) return;
    const message = `Up next: ${names.join(', ')}. Please get ready.`;
    announce(message);
    toast(`Calling ${names.join(', ')}.`);
  };

  window.gmCallNextPlayers = function () {
    if (fullWaveRotationStyle()) { toast(fullWaveRotationMessage(), 'inf'); return; }
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last || !stagedMatches(last).length) { toast('No staged Up Next match is ready.', 'inf'); return; }
    gmCallStagedMatch(0);
  };

  function selectOptions(currentId, round, excludeIds = [], unstagedOnly = false) {
    const blocked = new Set(excludeIds.filter(Boolean).map(String));
    const source = unstagedOnly ? availableQueueIds(round) : gmQueueIds(round);
    const ids = [...new Set([currentId, ...source].filter(Boolean).map(String))]
      .filter(id => String(id) === String(currentId || '') || !blocked.has(id));
    return [
      `<option value="" ${!currentId ? 'selected' : ''}>Open slot</option>`,
      ...ids.map(id => `<option value="${esc(id)}" ${String(currentId || '') === id ? 'selected' : ''}>${esc(gmPlayerName(id))}</option>`),
    ].join('');
  }

  window.gmRenderNextUp = function (round) {
    const wrap = $('gmNextUp');
    if (!wrap) return;
    if (fullWaveRotationStyle()) {
      wrap.innerHTML = `<div class="gm-empty">${esc(fullWaveRotationMessage())}</div>`;
      return;
    }
    const stages = stagedMatches(round);
    const teamSize = gmRotationOptions().format === 'singles' ? 1 : 2;
    const finishedCourts = (round?.assignments || []).map((game, index) => ({ game, index }))
      .filter(item => item.game.winner || teamIds(item.game).length < gmPlayersPerGame());
    const used = stages.flatMap(teamIds);
    wrap.innerHTML = stages.length ? stages.map((stage, stageIndex) => {
      const courtOptions = finishedCourts.map(item =>
        `<option value="${item.index}">${esc(item.game.courtName || `Court ${item.index + 1}`)}</option>`
      ).join('');
      const team = (key, label, cls) => `<div class="gm-team ${cls}">
        <div class="gm-team-label">${label}</div>
        <div style="display:grid;gap:6px">${Array.from({ length: teamSize }, (_, slot) => {
          const current = stage[key]?.[slot] || '';
          return `<select class="gm-slot-select" aria-label="${label} player ${slot + 1}" onchange="gmStagePlayerChanged(${stageIndex},'${key}',${slot},this.value)">${selectOptions(current, round, used.filter(id => id !== current))}</select>`;
        }).join('')}</div>
      </div>`;
      return `<div class="gm-next-card">
        <div class="gm-next-title"><span>${esc(stage.label || `Up Next ${stageIndex + 1}`)}</span><span>${stage.auto ? 'AUTO' : 'EDITED'}</span></div>
        <div class="gm-matchup" style="padding:0;grid-template-columns:minmax(0,1fr) 22px minmax(0,1fr)">
          ${team('teamA', 'Team A', 'gm-team-a')}<div class="gm-vs">VS</div>${team('teamB', 'Team B', 'gm-team-b')}
        </div>
        <div class="gm-next-actions">
          <button class="btn btn-g btn-sm" type="button" onclick="gmCallStagedMatch(${stageIndex})">Call Players</button>
          ${finishedCourts.length ? `<select class="fi" id="gmStageCourt_${stageIndex}" style="width:auto;min-width:110px;padding:7px">${courtOptions}</select><button class="btn btn-p btn-sm" type="button" onclick="gmStartStagedMatch(${stageIndex},Number($('gmStageCourt_${stageIndex}').value))">Start</button>` : '<button class="btn btn-p btn-sm" type="button" disabled title="Finish a court first">Start</button>'}
          <button class="btn btn-d btn-sm" type="button" onclick="gmRemoveStagedMatch(${stageIndex})">Remove</button>
        </div>
      </div>`;
    }).join('') : '<div class="gm-empty">No full Up Next group. Add a match to fill slots manually.</div>';
  };

  window.gmUpdateCourtSlot = async function (courtIndex, team, slot, replacementId) {
    if (gmLiveMutationBlocked()) return;
    const last = _gm.rounds[_gm.rounds.length - 1];
    const court = last?.assignments?.[courtIndex];
    if (!court || court.winner) { toast('Correct a completed match from Match Log.', 'inf'); gmRenderBoard(); return; }
    const assignments = (last.assignments || []).map(game => ({ ...game, teamA: [...(game.teamA || [])], teamB: [...(game.teamB || [])] }));
    const oldId = assignments[courtIndex][team][slot] || null;
    if (replacementId && assignments.some((game, index) => index !== courtIndex && teamIds(game).includes(String(replacementId)))) {
      toast('That player is already on another court.', 'err'); gmRenderBoard(); return;
    }
    assignments[courtIndex][team][slot] = replacementId || null;
    let queue = gmQueueIds(last).filter(id => String(id) !== String(replacementId || ''));
    if (oldId && gmActivePlayers().some(player => String(player.id) === String(oldId)) && !queue.includes(String(oldId))) queue.push(String(oldId));
    await persistLatestRound(assignments, queue, replacementId ? 'Court player replaced.' : 'Player pulled; the slot is open.');
  };

  window.gmAutoFillCourt = async function (courtIndex) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    const court = last?.assignments?.[courtIndex];
    if (!court || court.winner) return;
    const missing = gmPlayersPerGame() - teamIds(court).length;
    if (missing <= 0) return;
    const replacements = availableQueueIds(last).slice(0, missing);
    if (replacements.length < missing) { toast('Not enough waiting players to fill every open slot.', 'inf'); return; }
    const assignments = (last.assignments || []).map(game => ({ ...game, teamA: [...(game.teamA || [])], teamB: [...(game.teamB || [])] }));
    const target = assignments[courtIndex];
    let cursor = 0;
    ['teamA', 'teamB'].forEach(team => {
      target[team] = target[team].map(id => id || replacements[cursor++]);
    });
    const queue = gmQueueIds(last).filter(id => !replacements.includes(id));
    await persistLatestRound(assignments, queue, 'Best available replacements added.');
  };

  window.gmRenameCourt = async function (courtIndex, name) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last || !name.trim()) { gmRenderBoard(); return; }
    const assignments = (last.assignments || []).map((game, index) => index === courtIndex ? { ...game, courtName: name.trim().slice(0, 60) } : game);
    await persistLatestRound(assignments, last.queue_snapshot);
  };

  window.gmUpdateCourtScore = async function (courtIndex, side, rawValue) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last) return;
    const value = rawValue === '' ? null : Math.max(0, Math.min(99, Number(rawValue) || 0));
    const field = side === 'A' ? 'teamAScore' : 'teamBScore';
    const assignments = (last.assignments || []).map((game, index) => index === courtIndex ? { ...game, [field]: value } : game);
    await persistLatestRound(assignments, last.queue_snapshot);
  };

  window.gmCallCourt = function (courtIndex) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    const game = last?.assignments?.[courtIndex];
    if (!game) return;
    announce(`${game.courtName || 'Court'}. ${teamIds(game).map(gmPlayerName).join(', ')}.`);
  };

  window.gmCloseCourt = async function (courtIndex) {
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last || last.assignments.length <= 1) { toast('At least one live court must remain in the round.', 'inf'); return; }
    if (!confirm('Close this court and return its players to the queue?')) return;
    const closing = last.assignments[courtIndex];
    const assignments = last.assignments.filter((_, index) => index !== courtIndex);
    const queue = [...gmQueueIds(last), ...teamIds(closing).filter(id => !gmQueueIds(last).includes(id))];
    await persistLatestRound(withStaged(assignments, stagedMatches(last)), queue, 'Court closed.');
  };

  window.gmAddLiveCourt = async function () {
    if (gmLiveMutationBlocked()) return;
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last) { toast('Start the session before adding a live court.', 'inf'); return; }
    const usedCourts = new Set(last.assignments.map(game => String(game.courtId)));
    const court = (_gm.courts || []).find(item => !usedCourts.has(String(item.id)));
    if (!court) { toast('Add or select another facility court first.', 'inf'); return; }
    const queueIds = availableQueueIds(last);
    if (queueIds.length < gmPlayersPerGame()) { toast('Not enough unstaged waiting players for another court.', 'inf'); return; }
    const generated = gmRotationApi().generateAssignments({
      active: activeAlgorithmPlayers(queueIds),
      courtIds: [String(court.id)],
      courtNames: { [String(court.id)]: court.name },
      rounds: _gm.rounds,
      format: gmRotationOptions().format,
      style: gmRotationOptions().style,
    });
    const game = generated.assignments[0];
    if (!game) { toast('The selected mode cannot form another complete match.', 'inf'); return; }
    let assignments = [...last.assignments, { ...game, gameId: newGameId(), startedAt: new Date().toISOString(), completedGames: [] }];
    const selected = teamIds(game);
    const queue = gmQueueIds(last).filter(id => !selected.includes(id));
    assignments = withStaged(assignments, stagedMatches(last));
    await persistLatestRound(assignments, queue, `${court.name} added.`);
  };

  function slotSelect(game, courtIndex, team, slot, round) {
    const current = game[team]?.[slot] || '';
    const otherAssigned = (round.assignments || []).flatMap((item, index) => index === courtIndex ? [] : teamIds(item));
    return `<select class="gm-slot-select" aria-label="${team === 'teamA' ? 'Team A' : 'Team B'} player ${slot + 1}" ${game.winner ? 'disabled' : ''} onchange="gmUpdateCourtSlot(${courtIndex},'${team}',${slot},this.value)">${selectOptions(current, round, otherAssigned, true)}</select>`;
  }

  window.gmRenderBoard = function () {
    const board = $('gmBoard');
    const meta = $('gmSessionMeta');
    const ended = Boolean(_gm.session && ['completed', 'cancelled'].includes(_gm.session.status));
    $('sec-gamemgr')?.classList.toggle('gm-has-live', Boolean(_gm.session && _gm.rounds.length));
    if ($('gmFormat')) $('gmFormat').disabled = ended || _gm.rounds.length > 0;
    if ($('gmMode')) $('gmMode').disabled = ended;
    if (meta) {
      meta.textContent = _gm.session
        ? `${_gm.session.location || $('gmLocation')?.value || 'Open Play'} · ${gmSessionModeLabel(_gm.session)} · ${_gm.session.status || 'draft'}`
        : 'No active rotation session.';
    }
    if (!board) return;
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!last) {
      gmRenderLiveStats(null);
      board.innerHTML = '<div class="gm-empty">No live courts yet. Check in players, then start the session.</div>';
      if ($('gmNextUp')) $('gmNextUp').innerHTML = '<div class="gm-empty">Up Next appears after play starts.</div>';
      if ($('gmQueue')) $('gmQueue').innerHTML = '<span class="gm-empty">Waiting players appear here.</span>';
      if ($('gmMatchLog')) $('gmMatchLog').innerHTML = '<div class="gm-empty">Completed matches appear here.</div>';
      gmRenderStandings();
      return;
    }
    gmRenderLiveStats(last);
    const teamSize = gmRotationOptions().format === 'singles' ? 1 : 2;
    const fullWave = fullWaveRotationStyle();
    board.innerHTML = (last.assignments || []).map((game, courtIndex) => {
      const full = teamIds(game).length === gmPlayersPerGame();
      const status = ended ? 'ENDED' : game.winner ? 'READY' : full ? 'LIVE' : 'OPEN';
      const winnerLabel = game.winner === 'A' ? 'TEAM A WON' : game.winner === 'B' ? 'TEAM B WON' : '';
      return `<article class="gm-court-card">
        <div class="gm-court-hd">
          <input class="gm-court-name-input" value="${esc(game.courtName || `Court ${courtIndex + 1}`)}" aria-label="Court name" onchange="gmRenameCourt(${courtIndex},this.value)" ${ended ? 'disabled' : ''}/>
          <div class="gm-court-hd-meta"><span class="gm-live-badge">${status}</span><span class="gm-timer" data-gm-started-at="${esc(game.startedAt || '')}" data-gm-ended-at="${esc(game.resultAt || '')}">00:00</span></div>
        </div>
        <div class="gm-matchup">
          <div class="gm-team gm-team-a ${game.winner === 'A' ? 'win' : ''}">
            <div class="gm-team-label"><span>Team A</span>${game.winner === 'A' ? '<span>WINNER</span>' : ''}</div>
            <div style="display:grid;gap:6px">${Array.from({ length: teamSize }, (_, slot) => slotSelect({ ...game, winner: game.winner || (ended ? 'ended' : '') }, courtIndex, 'teamA', slot, last)).join('')}</div>
          </div>
          <div class="gm-vs">VS</div>
          <div class="gm-team gm-team-b ${game.winner === 'B' ? 'win' : ''}">
            <div class="gm-team-label"><span>Team B</span>${game.winner === 'B' ? '<span>WINNER</span>' : ''}</div>
            <div style="display:grid;gap:6px">${Array.from({ length: teamSize }, (_, slot) => slotSelect({ ...game, winner: game.winner || (ended ? 'ended' : '') }, courtIndex, 'teamB', slot, last)).join('')}</div>
          </div>
        </div>
        <div class="gm-score-row">
          <input class="gm-score-input" type="number" min="0" max="99" value="${game.teamAScore ?? ''}" aria-label="Team A score" onchange="gmUpdateCourtScore(${courtIndex},'A',this.value)" ${game.winner || ended ? 'disabled' : ''}/>
          <span class="gm-mini">SCORE</span>
          <input class="gm-score-input" type="number" min="0" max="99" value="${game.teamBScore ?? ''}" aria-label="Team B score" onchange="gmUpdateCourtScore(${courtIndex},'B',this.value)" ${game.winner || ended ? 'disabled' : ''}/>
        </div>
        ${winnerLabel ? `<div class="gm-result-note">${winnerLabel} · ${fullWave ? esc(fullWaveRotationMessage()) : 'Start a staged match when the court is ready.'}</div>` : ''}
        <div class="gm-result-actions">
          ${ended
            ? '<button class="gm-result-btn" type="button" disabled>Session ended</button><button class="gm-result-btn" type="button" disabled>Results locked</button>'
            : game.winner
            ? `${fullWave
              ? '<button class="gm-result-btn team-a" type="button" disabled>Await all results</button>'
              : `<button class="gm-result-btn team-a" type="button" onclick="gmStartFirstStagedOnCourt(${courtIndex})">Start Up Next</button>`}<button class="gm-result-btn team-b" type="button" onclick="gmCallCourt(${courtIndex})">Announce Result</button>`
            : `<button class="gm-result-btn team-a" type="button" onclick="gmSetWinner(${courtIndex},'A')" ${full ? '' : 'disabled'}>Team A Wins</button><button class="gm-result-btn team-b" type="button" onclick="gmSetWinner(${courtIndex},'B')" ${full ? '' : 'disabled'}>Team B Wins</button>`}
        </div>
        <div class="gm-court-tools">
          <button class="btn btn-g btn-sm" type="button" onclick="gmCallCourt(${courtIndex})" ${ended ? 'disabled' : ''}>Call Court</button>
          ${!full && !game.winner ? `<button class="btn btn-g btn-sm" type="button" onclick="gmAutoFillCourt(${courtIndex})">Auto Replace</button>` : ''}
          <button class="btn btn-d btn-sm" type="button" onclick="gmCloseCourt(${courtIndex})" ${ended ? 'disabled' : ''}>Close Court</button>
        </div>
      </article>`;
    }).join('');
    gmRenderNextUp(last);
    gmRenderQueue(last);
    gmRenderStandings();
    gmRenderMatchLog();
    tickTimers();
  };

  window.gmStartFirstStagedOnCourt = function (courtIndex) {
    if (fullWaveRotationStyle()) { toast(fullWaveRotationMessage(), 'inf'); return; }
    const last = _gm.rounds[_gm.rounds.length - 1];
    if (!stagedMatches(last).length) { toast('No Up Next match is staged.', 'inf'); return; }
    gmStartStagedMatch(0, courtIndex);
  };

  function tickTimers() {
    document.querySelectorAll('[data-gm-started-at]').forEach(element => {
      const start = Date.parse(element.dataset.gmStartedAt || '');
      const ended = Date.parse(element.dataset.gmEndedAt || '');
      if (!Number.isFinite(start)) { element.textContent = '--:--'; return; }
      const seconds = Math.max(0, Math.floor(((Number.isFinite(ended) ? ended : Date.now()) - start) / 1000));
      element.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    });
  }
  setInterval(tickTimers, 1000);

  window.gmRenderQueue = function (round) {
    const queue = $('gmQueue');
    if (!queue) return;
    const ids = availableQueueIds(round);
    const history = gmBuildHistory(_gm.rounds);
    const average = averageGameMinutes();
    const wave = Math.max(1, (round?.assignments?.length || 1) * gmPlayersPerGame());
    queue.classList.toggle('gm-queue-list', ids.length > 0);
    queue.innerHTML = ids.length ? ids.map((id, index) => {
      const games = history.resultCount?.[id] || 0;
      const wins = history.winCount?.[id] || 0;
      const waitMinutes = (Math.floor(index / wave) + 1) * average;
      return `<div class="gm-queue-row">
        <span class="gm-queue-no">${index + 1}</span>
        <div><div class="gm-queue-name">${esc(gmPlayerName(id))}</div><div class="gm-queue-meta">${wins}W / ${games}G · about ${waitMinutes} min · avg game ${average} min</div></div>
        <button class="gm-chip-action" type="button" onclick="gmSkipQueuePlayer('${esc(id)}')" title="Move to back">${index + 1 === ids.length ? 'last' : 'skip'}</button>
      </div>`;
    }).join('') : '<span class="gm-empty">No unstaged waiting players right now.</span>';
  };

  function standingsRows() {
    const history = gmBuildHistory(_gm.rounds);
    const completed = allCompletedGames();
    const opponentStrength = {};
    completed.forEach(game => {
      const a = (game.teamA || []).filter(Boolean).map(String);
      const b = (game.teamB || []).filter(Boolean).map(String);
      a.forEach(id => { opponentStrength[id] = (opponentStrength[id] || 0) + b.reduce((sum, opponent) => sum + (history.winCount?.[opponent] || 0), 0); });
      b.forEach(id => { opponentStrength[id] = (opponentStrength[id] || 0) + a.reduce((sum, opponent) => sum + (history.winCount?.[opponent] || 0), 0); });
    });
    return gmActivePlayers().map(player => {
      const id = String(player.id);
      const games = history.resultCount?.[id] || 0;
      const wins = history.winCount?.[id] || 0;
      return { id, name: player.full_name, games, wins, losses: games - wins, pct: games ? wins / games : 0, opponentStrength: opponentStrength[id] || 0 };
    }).sort((a, b) => b.wins - a.wins || b.opponentStrength - a.opponentStrength || b.pct - a.pct || b.games - a.games || a.name.localeCompare(b.name));
  }

  window.gmRenderStandings = function () {
    const wrap = $('gmStandings');
    if (!wrap) return;
    const rows = standingsRows();
    wrap.innerHTML = rows.length ? rows.map((player, index) => `<button type="button" class="gm-standing-row" style="width:100%;text-align:left" onclick="gmOpenPlayerCard('${esc(player.id)}')">
      <span class="gm-standing-rank">${index < 3 ? ['🥇','🥈','🥉'][index] : index + 1}</span>
      <span class="gm-standing-name">${esc(player.name)}${player.games < 5 ? ' · provisional' : ''}</span>
      <span class="gm-standing-meta">${player.wins}W-${player.losses}L · ${Math.round(player.pct * 100)}%</span>
    </button>`).join('') : '<div class="gm-empty">No checked-in players yet.</div>';
  };

  window.gmRenderMatchLog = function () {
    const wrap = $('gmMatchLog');
    if (!wrap) return;
    const games = allCompletedGames();
    wrap.innerHTML = games.length ? games.map((game, index) => {
      const winners = game.winner === 'A' ? game.teamA : game.teamB;
      const losers = game.winner === 'A' ? game.teamB : game.teamA;
      const score = game.teamAScore != null || game.teamBScore != null ? ` · ${game.teamAScore ?? 0}-${game.teamBScore ?? 0}` : '';
      return `<div class="gm-log-row">
        <span class="gm-log-no">#${index + 1}</span>
        <div class="gm-log-copy"><b>${esc(game.courtName || 'Court')}${esc(score)}</b><span>${esc(winners.filter(Boolean).map(gmPlayerName).join(' / '))} beat ${esc(losers.filter(Boolean).map(gmPlayerName).join(' / '))}</span></div>
        ${game.gameId ? `<button class="btn btn-g btn-sm" type="button" onclick="gmSwapMatchWinner('${esc(game.roundId || '')}','${esc(game.gameId)}')">Swap Winner</button>` : '<span class="gm-mini">Legacy result</span>'}
      </div>`;
    }).join('') : '<div class="gm-empty">Completed matches appear here.</div>';
  };

  window.gmSwapMatchWinner = async function (roundId, gameId) {
    if (!roundId || !gameId) return;
    try {
      await DB.correctOpenPlayGameResult(roundId, gameId);
      toast('Winner corrected.');
      await gmLoadSession(_gm.session.id);
    } catch (error) {
      console.error('gmSwapMatchWinner:', error);
      toast(error?.message || 'Could not correct that result.', 'err');
    }
  };

  window.gmRenderLiveStats = function (round) {
    base.renderLiveStats(round);
    const active = gmActivePlayers().length;
    const waiting = round ? availableQueueIds(round).length : 0;
    const status = (_gm.session?.status || 'setup').toUpperCase();
    if ($('gmBarStatus')) $('gmBarStatus').textContent = status;
    if ($('gmBarPlayers')) $('gmBarPlayers').textContent = active;
    if ($('gmBarQueue')) $('gmBarQueue').textContent = waiting;
    if ($('gmBarCourts')) $('gmBarCourts').textContent = round?.assignments?.length || gmSelectedCourtIds().length || 0;
    if ($('gmLiveResults')) $('gmLiveResults').textContent = allCompletedGames().length;
    updateMuteButton();
  };

  function openOverlay(id) {
    const overlay = $(id);
    if (!overlay) return;
    overlay.hidden = false;
    overlay.inert = false;
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      overlay.classList.add('show');
      overlay.querySelector('[role="dialog"]')?.focus();
    });
  }

  window.gmCloseOverlay = function (id) {
    const overlay = $(id);
    if (!overlay) return;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.inert = true;
    setTimeout(() => { overlay.hidden = true; }, 220);
  };

  function publicUrl() {
    const url = new URL('open-play-live.html', location.href);
    if (_gm.session?.id) url.searchParams.set('gm', _gm.session.id);
    return url.toString();
  }

  window.gmShareLive = async function () {
    if (!_gm.session) { toast('Create or open a session first.', 'err'); return; }
    if (_gm.session.share_enabled === false) {
      const saved = await DB.updateOpenPlayGameSession(_gm.session.id, { shareEnabled: true });
      _gm.session = saved || { ..._gm.session, share_enabled: true };
    }
    if ($('gmShareUrl')) $('gmShareUrl').value = publicUrl();
    if ($('gmShareToggleBtn')) $('gmShareToggleBtn').textContent = _gm.session.share_enabled === false ? 'Enable Sharing' : 'Disable Sharing';
    openOverlay('gmShareModal');
  };

  window.gmCopyPublicLink = async function () {
    await gmClipboard(publicUrl(), 'Public live link copied.');
  };

  window.gmTogglePublicSharing = async function () {
    if (!_gm.session) return;
    const enabled = _gm.session.share_enabled === false;
    const saved = await DB.updateOpenPlayGameSession(_gm.session.id, { shareEnabled: enabled });
    _gm.session = saved || { ..._gm.session, share_enabled: enabled };
    if ($('gmShareToggleBtn')) $('gmShareToggleBtn').textContent = enabled ? 'Disable Sharing' : 'Enable Sharing';
    toast(enabled ? 'Public live sharing enabled.' : 'Public live sharing disabled.');
  };

  function renderSummary() {
    const rows = standingsRows();
    if ($('gmSummaryTitle')) $('gmSummaryTitle').textContent = 'SESSION LEADERBOARD';
    if ($('gmSummarySubtitle')) $('gmSummarySubtitle').textContent = `${_gm.session?.location || 'Open Play'} · ${fmtD(_gm.session?.date || gmToday())}`;
    if ($('gmSummaryLeaders')) $('gmSummaryLeaders').innerHTML = rows.length ? rows.map((player, index) => `<button class="gm-leader-row" type="button" onclick="gmOpenPlayerCard('${esc(player.id)}')">
      <span class="gm-leader-rank">${index < 3 ? ['🥇','🥈','🥉'][index] : index + 1}</span>
      <span style="text-align:left"><b>${esc(player.name)}</b><span class="gm-mini" style="display:block">${player.games} games · opponent strength ${player.opponentStrength}</span></span>
      <b>${player.wins}W-${player.losses}L · ${Math.round(player.pct * 100)}%</b>
    </button>`).join('') : '<div class="gm-empty">No completed results in this session.</div>';
  }

  window.gmOpenPlayerCard = function (playerId) {
    selectedCardPlayerId = String(playerId);
    renderSummary();
    const player = standingsRows().find(row => String(row.id) === selectedCardPlayerId);
    const profile = profileOf((_gm.players || []).find(item => String(item.id) === selectedCardPlayerId));
    const card = $('gmPlayerShareCard');
    if (card && player) {
      const rank = standingsRows().findIndex(row => row.id === player.id) + 1;
      card.style.display = '';
      card.innerHTML = `<div class="gm-mini" style="color:rgba(255,255,255,.7)">KORTE DOS · OPEN PLAY</div><h3>${esc(player.name)}</h3><div style="margin-top:3px;opacity:.75">${esc(SKILLS[profile.skillLevel]?.[1] || 'Unrated')} · Rank #${rank}</div>
        <div class="gm-share-card-stats"><div><b>${player.games}</b><span>Games</span></div><div><b>${player.wins}</b><span>Wins</span></div><div><b>${player.losses}</b><span>Losses</span></div><div><b>${Math.round(player.pct * 100)}%</b><span>Win rate</span></div></div>`;
    }
    if ($('gmDownloadCardBtn')) $('gmDownloadCardBtn').style.display = player ? '' : 'none';
    openOverlay('gmSummaryModal');
  };

  window.gmOpenLifetimeLeaderboard = async function () {
    try {
      const [players, rounds] = await Promise.all([
        DB.getOpenPlayGameAllPlayers(),
        DB.getOpenPlayGameAllRounds(),
      ]);
      const byId = new Map((players || []).map(player => [String(player.id), player]));
      const history = gmRotationApi().buildHistory(rounds || []);
      const byName = new Map();
      byId.forEach((player, id) => {
        const key = String(player.full_name || '').trim().toLowerCase();
        if (!key) return;
        const games = history.resultCount?.[id] || 0;
        const wins = history.winCount?.[id] || 0;
        const current = byName.get(key) || { name: player.full_name, games: 0, wins: 0 };
        current.games += games;
        current.wins += wins;
        byName.set(key, current);
      });
      const minimum = Math.max(1, Math.min(50, Number(sessionSettings().minimumLifetimeGames) || 10));
      const rows = [...byName.values()].map(player => ({
        ...player,
        losses: player.games - player.wins,
        pct: player.games ? player.wins / player.games : 0,
      })).filter(player => player.games >= minimum)
        .sort((a, b) => b.pct - a.pct || b.games - a.games || a.name.localeCompare(b.name));
      if ($('gmSummaryTitle')) $('gmSummaryTitle').textContent = 'LIFETIME LEADERBOARD';
      if ($('gmSummarySubtitle')) $('gmSummarySubtitle').textContent = `Cloud-synced history · minimum ${minimum} games`;
      if ($('gmSummaryLeaders')) $('gmSummaryLeaders').innerHTML = rows.length ? rows.map((player, index) => `<div class="gm-leader-row">
        <span class="gm-leader-rank">${index < 3 ? ['🥇','🥈','🥉'][index] : index + 1}</span>
        <span><b>${esc(player.name)}</b><span class="gm-mini" style="display:block">${player.games} lifetime games</span></span>
        <b>${Math.round(player.pct * 100)}% · ${player.wins}W</b>
      </div>`).join('') : `<div class="gm-empty">No player has reached ${minimum} completed games yet.</div>`;
      if ($('gmPlayerShareCard')) $('gmPlayerShareCard').style.display = 'none';
      if ($('gmDownloadCardBtn')) $('gmDownloadCardBtn').style.display = 'none';
      openOverlay('gmSummaryModal');
    } catch (error) {
      console.error('gmOpenLifetimeLeaderboard:', error);
      toast(error?.message || 'Could not load lifetime standings.', 'err');
    }
  };

  window.gmDownloadSelectedPlayerCard = function () {
    const player = standingsRows().find(row => String(row.id) === String(selectedCardPlayerId));
    if (!player) return;
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 1080, 1080);
    gradient.addColorStop(0, '#0b2744');
    gradient.addColorStop(1, '#0e5a8a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1080, 1080);
    ctx.fillStyle = '#c9cf43';
    ctx.fillRect(72, 72, 150, 14);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 42px Arial';
    ctx.fillText('KORTE DOS · OPEN PLAY', 72, 145);
    ctx.font = '700 86px Arial';
    ctx.fillText(player.name.slice(0, 22), 72, 280);
    ctx.font = '700 44px Arial';
    ctx.fillStyle = '#c9cf43';
    ctx.fillText(`SESSION RANK #${standingsRows().findIndex(row => row.id === player.id) + 1}`, 72, 350);
    const labels = [['GAMES', player.games], ['WINS', player.wins], ['LOSSES', player.losses], ['WIN RATE', `${Math.round(player.pct * 100)}%`]];
    labels.forEach(([label, value], index) => {
      const x = 72 + (index % 2) * 476;
      const y = 510 + Math.floor(index / 2) * 230;
      ctx.fillStyle = 'rgba(255,255,255,.1)';
      ctx.fillRect(x, y, 430, 180);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 72px Arial';
      ctx.fillText(String(value), x + 28, y + 82);
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.font = '700 28px Arial';
      ctx.fillText(label, x + 28, y + 134);
    });
    const link = document.createElement('a');
    link.download = `${player.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'player'}-open-play-stats.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  window.gmCompleteSession = async function () {
    await base.completeSession();
    if (_gm.session?.status === 'completed') {
      renderSummary();
      openOverlay('gmSummaryModal');
      const top = standingsRows().slice(0, 3).map(row => row.name);
      if (top.length) announce(`Session complete. First place ${top[0]}.${top[1] ? ` Second ${top[1]}.` : ''}${top[2] ? ` Third ${top[2]}.` : ''}`);
    }
  };

  window.gmNewSessionFromCurrent = function () {
    const carried = (_gm.players || []).map((player, index) => {
      const normalized = gmNormalizePlayer(player, index);
      return { ...normalized, id: '', session_id: null, source_registration_id: null, status: 'no_show', profile: { ...normalized.profile, checkedInAt: null } };
    });
    gmCloseOverlay('gmSummaryModal');
    gmResetSessionState();
    _gm.players = carried;
    if ($('gmDate')) $('gmDate').value = gmToday();
    gmRenderPlayers();
    gmRenderBoard();
    toast('New session prepared with the saved roster. Check in arriving players.');
  };

  window.gmExportCsv = function () {
    if (!_gm.session) { toast('Open a session first.', 'err'); return; }
    const history = gmBuildHistory(_gm.rounds);
    const rows = [['player','status','skill','gender','group','dupr_id','games','wins','losses','win_rate']];
    (_gm.players || []).map(gmNormalizePlayer).forEach(player => {
      const id = String(player.id);
      const games = history.resultCount?.[id] || 0;
      const wins = history.winCount?.[id] || 0;
      rows.push([player.full_name, player.status, SKILLS[player.skill_level]?.[1] || 'Unrated', player.gender, player.group_name, player.dupr_id, games, wins, games - wins, games ? Math.round(wins / games * 100) : 0]);
    });
    rows.push([], ['match_no','court','team_a','team_b','score_a','score_b','winner','started_at','result_at']);
    allCompletedGames().forEach((game, index) => rows.push([
      index + 1,
      game.courtName || '',
      (game.teamA || []).filter(Boolean).map(gmPlayerName).join(' / '),
      (game.teamB || []).filter(Boolean).map(gmPlayerName).join(' / '),
      game.teamAScore ?? '',
      game.teamBScore ?? '',
      game.winner || '',
      game.startedAt || '',
      game.resultAt || '',
    ]));
    const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `open-play-dupr-export-${_gm.session.date}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Session and DUPR-ready CSV exported.');
  };
})();
