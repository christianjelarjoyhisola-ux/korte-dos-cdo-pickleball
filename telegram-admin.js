(function telegramAdminModule(root) {
  'use strict';

  const PANEL_ID = 'telegramAdminPanel';
  const FUNCTION_NAME = 'send-telegram-notification';
  const API_NAME = 'telegram_owner_link';
  const PH_TIME_ZONE = 'Asia/Manila';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const state = {
    candidates: [],
    connections: [],
    generatedCode: null,
    loading: false,
    generatingFor: '',
    revokingFor: '',
    notice: 'Loading Telegram recipients...',
    noticeTone: '',
    loadSequence: 0,
    expiryTimer: null,
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function humanize(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return fallback || 'Not available';
    return text
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function parsedTime(value) {
    const milliseconds = Date.parse(String(value || ''));
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  function formatPhilippineTime(value) {
    const milliseconds = parsedTime(value);
    if (milliseconds == null) return 'Date unavailable';
    try {
      const formatted = new Intl.DateTimeFormat('en-PH', {
        timeZone: PH_TIME_ZONE,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(milliseconds));
      return `${formatted} PHT`;
    } catch (_) {
      return 'Date unavailable';
    }
  }

  function maskChatId(value) {
    const chatId = String(value == null ? '' : value).trim();
    if (!chatId) return 'Not shown';
    const visibleLength = Math.min(4, Math.max(1, Math.floor(chatId.length / 3)));
    return `••••${chatId.slice(-visibleLength)}`;
  }

  function candidateIdentity(candidate) {
    const name = String(candidate?.fullName || '').trim();
    const email = String(candidate?.email || '').trim();
    return {
      name: name || email || 'Account owner',
      email: name && email ? email : '',
    };
  }

  function telegramIdentity(connection) {
    const username = String(connection?.telegramUsername || '').trim().replace(/^@+/, '');
    const name = [
      String(connection?.telegramFirstName || '').trim(),
      String(connection?.telegramLastName || '').trim(),
    ].filter(Boolean).join(' ');
    if (username) return `@${username}`;
    return name || 'Telegram account';
  }

  function isConnected(connection) {
    const candidate = connection
      ? candidateFor(String(connection.accountId || ''))
      : null;
    return !!connection &&
      connection.connected === true &&
      !connection.revokedAt &&
      candidate?.eligible !== false;
  }

  function safeStartLink(rawLink, botUsername, code) {
    const connectionCode = String(code || '');
    const validate = (value) => {
      try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || (hostname !== 't.me' && hostname !== 'telegram.me')) return '';
        const username = url.pathname.replace(/^\/+|\/+$/g, '');
        if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return '';
        const linkCode = connectionCode || String(url.searchParams.get('start') || '');
        if (!linkCode) return '';
        if (connectionCode && url.searchParams.get('start') !== connectionCode) return '';
        return `https://t.me/${username}?start=${encodeURIComponent(linkCode)}`;
      } catch (_) {
        return '';
      }
    };

    const provided = validate(String(rawLink || '').trim());
    if (provided) return provided;

    const username = String(botUsername || '').trim().replace(/^@+/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username) || !connectionCode) return '';
    return validate(`https://t.me/${username}?start=${encodeURIComponent(connectionCode)}`);
  }

  function activeGeneratedCode() {
    const generated = state.generatedCode;
    if (!generated) return null;
    const expiresAt = parsedTime(generated.expiresAt);
    if (expiresAt == null || expiresAt <= Date.now()) {
      state.generatedCode = null;
      clearExpiryTimer();
      return null;
    }
    return generated;
  }

  function clearExpiryTimer() {
    if (state.expiryTimer != null && typeof root.clearTimeout === 'function') {
      root.clearTimeout(state.expiryTimer);
    }
    state.expiryTimer = null;
  }

  function scheduleCodeExpiry() {
    clearExpiryTimer();
    const generated = activeGeneratedCode();
    if (!generated || typeof root.setTimeout !== 'function') return;
    const remaining = Math.max(0, parsedTime(generated.expiresAt) - Date.now());
    const delay = Math.min(remaining + 50, 2147483647);
    state.expiryTimer = root.setTimeout(() => {
      if (activeGeneratedCode()) {
        scheduleCodeExpiry();
        return;
      }
      state.notice = 'The one-use connection code expired. Generate a new code when the owner is ready.';
      state.noticeTone = 'warn';
      paint();
    }, delay);
  }

  function invokeOwnerLink(action, values) {
    if (typeof _invokeEdgeFunction !== 'function') {
      return Promise.reject(new Error('Telegram owner-link service is unavailable.'));
    }
    return _invokeEdgeFunction(
      FUNCTION_NAME,
      { api: API_NAME, action, ...(values || {}) },
      { preferDirect: true },
    );
  }

  function ensurePanel() {
    const documentRef = root.document;
    if (!documentRef) return null;
    const payments = documentRef.getElementById('sec-payments');
    const readinessBody = documentRef.getElementById('integrationStatusBody');
    const readinessPanel = readinessBody?.closest?.('.panel');
    if (!payments || !readinessPanel || !payments.contains(readinessPanel)) return null;

    let panel = documentRef.getElementById(PANEL_ID);
    if (!panel) {
      panel = documentRef.createElement('section');
      panel.id = PANEL_ID;
      panel.className = 'panel';
      panel.setAttribute('aria-labelledby', 'telegramAdminHeading');
      panel.style.maxWidth = '980px';
      panel.style.marginBottom = '20px';
      panel.style.border = '1.5px solid rgba(var(--green-rgb),.3)';
      panel.addEventListener('click', onPanelClick);
    }

    if (readinessPanel.nextElementSibling !== panel) {
      readinessPanel.insertAdjacentElement('afterend', panel);
    }
    return panel;
  }

  function connectionFor(accountId) {
    return state.connections.find((item) => String(item?.accountId || '') === String(accountId || '')) || null;
  }

  function candidateFor(accountId) {
    return state.candidates.find((item) => String(item?.accountId || '') === String(accountId || '')) || null;
  }

  function generatedCodeMarkup() {
    const generated = activeGeneratedCode();
    if (!generated) return '';

    const command = `/start ${generated.code}`;
    const startLink = safeStartLink(generated.startLink, generated.botUsername, generated.code);
    const owner = candidateIdentity(candidateFor(generated.targetAccountId));
    return `
      <div class="integration-card ok" style="margin-bottom:14px" aria-labelledby="telegramCodeHeading">
        <div class="integration-top">
          <div>
            <div class="integration-name" id="telegramCodeHeading">One-use code for ${escapeHtml(owner.name)}</div>
            <div class="integration-meta">This code can be used once and expires exactly 7 days after it was generated.</div>
          </div>
          <span class="integration-badge ok">Ready to send</span>
        </div>
        <div class="fl" id="telegramStartCommandLabel">Send this exact message to the bot</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <code id="telegramStartCommand" aria-labelledby="telegramStartCommandLabel" style="flex:1 1 260px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);overflow-wrap:anywhere">${escapeHtml(command)}</code>
          <button class="btn btn-p btn-sm" type="button" data-tg-action="copy-command">Copy Command</button>
          ${startLink ? `<a class="btn btn-g btn-sm" href="${escapeHtml(startLink)}" target="_blank" rel="noopener noreferrer">Open Bot</a>` : ''}
        </div>
        <div class="integration-meta" style="margin-top:8px">
          Expires: <strong>${escapeHtml(formatPhilippineTime(generated.expiresAt))}</strong>
          ${startLink ? ` · <button class="btn btn-g btn-sm" type="button" data-tg-action="copy-link" style="padding:2px 8px">Copy Bot Link</button>` : ''}
        </div>
      </div>`;
  }

  function recipientRowsMarkup() {
    if (!state.connections.length) {
      return '<tr><td colspan="6" data-label="Recipients"><span class="integration-meta">No Telegram recipients are connected yet.</span></td></tr>';
    }

    return state.connections.map((connection) => {
      const accountId = String(connection?.accountId || '');
      const candidate = candidateFor(accountId);
      const identity = candidateIdentity(candidate);
      const connected = isConnected(connection);
      const statusLabel = connected ? 'Connected' : (connection?.revokedAt ? 'Revoked' : 'Disconnected');
      const statusClass = connected ? 'ok' : 'warn';
      const eventDate = connected ? connection?.connectedAt : (connection?.revokedAt || connection?.connectedAt);
      const dateLabel = connected ? 'Connected' : (connection?.revokedAt ? 'Revoked' : 'Updated');
      const telegramName = telegramIdentity(connection);
      const busy = state.revokingFor === accountId;
      return `
        <tr>
          <td data-label="Owner">
            <strong>${escapeHtml(identity.name)}</strong>
            ${identity.email ? `<div class="integration-meta">${escapeHtml(identity.email)}</div>` : ''}
          </td>
          <td data-label="Role">${escapeHtml(humanize(candidate?.role, 'Owner'))}</td>
          <td data-label="Account status">${escapeHtml(humanize(candidate?.status, 'Unknown'))}</td>
          <td data-label="Telegram">
            <strong>${escapeHtml(telegramName)}</strong>
            <div class="integration-meta">Chat ${escapeHtml(maskChatId(connection?.telegramChatId))}</div>
          </td>
          <td data-label="Connection">
            <span class="integration-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
            <div class="integration-meta">${escapeHtml(dateLabel)}: ${escapeHtml(formatPhilippineTime(eventDate))}</div>
          </td>
          <td data-label="Actions">
            ${connected
              ? `<button class="btn btn-d btn-sm" type="button" data-tg-action="revoke" data-account-id="${escapeHtml(accountId)}" aria-label="Revoke Telegram alerts for ${escapeHtml(identity.name)}" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? 'Removing...' : 'Revoke'}</button>`
              : '<span class="integration-meta">No alerts</span>'}
          </td>
        </tr>`;
    }).join('');
  }

  function candidateRowsMarkup() {
    if (!state.candidates.length) {
      return '<tr><td colspan="5" data-label="Eligible owners"><span class="integration-meta">No eligible owner accounts were returned by the server.</span></td></tr>';
    }

    return state.candidates.map((candidate) => {
      const accountId = String(candidate?.accountId || '');
      const identity = candidateIdentity(candidate);
      const connection = connectionFor(accountId);
      const connected = isConnected(connection);
      const eligible = candidate?.eligible === true;
      const pendingExpiry = parsedTime(candidate?.pendingCodeExpiresAt);
      const hasPendingCode = pendingExpiry != null && pendingExpiry > Date.now();
      const busy = state.generatingFor === accountId;
      let linkStatus = connected ? 'Receiving alerts' : (hasPendingCode ? 'Code awaiting use' : 'Not connected');
      if (!eligible && !connected) linkStatus = 'Not eligible';

      let buttonMarkup;
      if (connected) {
        buttonMarkup = '<button class="btn btn-g btn-sm" type="button" disabled>Connected</button>';
      } else if (!eligible) {
        buttonMarkup = '<button class="btn btn-g btn-sm" type="button" disabled>Unavailable</button>';
      } else {
        const label = busy ? 'Generating...' : (hasPendingCode ? 'Generate New Code' : 'Generate Code');
        buttonMarkup = `<button class="btn btn-p btn-sm" type="button" data-tg-action="create-code" data-account-id="${escapeHtml(accountId)}" aria-label="${hasPendingCode ? 'Generate a new' : 'Generate a'} Telegram connection code for ${escapeHtml(identity.name)}" ${busy ? 'disabled aria-busy="true"' : ''}>${label}</button>`;
      }

      return `
        <tr>
          <td data-label="Owner">
            <strong>${escapeHtml(identity.name)}</strong>
            ${identity.email ? `<div class="integration-meta">${escapeHtml(identity.email)}</div>` : ''}
          </td>
          <td data-label="Role">${escapeHtml(humanize(candidate?.role, 'Owner'))}</td>
          <td data-label="Account status">${escapeHtml(humanize(candidate?.status, 'Unknown'))}</td>
          <td data-label="Telegram status">
            <span class="integration-badge ${connected ? 'ok' : 'warn'}">${escapeHtml(linkStatus)}</span>
            ${hasPendingCode ? `<div class="integration-meta">Pending code expires ${escapeHtml(formatPhilippineTime(candidate.pendingCodeExpiresAt))}</div>` : ''}
          </td>
          <td data-label="Actions">${buttonMarkup}</td>
        </tr>`;
    }).join('');
  }

  function paint() {
    const panel = ensurePanel();
    if (!panel) return;
    const activeCount = state.connections.filter(isConnected).length;
    const noticeClass = state.noticeTone === 'ok' ? 'ok' : (state.noticeTone ? 'warn' : '');
    panel.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    panel.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div style="min-width:0">
          <h4 id="telegramAdminHeading" style="margin:0 0 6px;color:var(--green)">Telegram Alert Recipients</h4>
          <p class="integration-meta" style="margin:0;max-width:720px">
            Connect approved owners to pending-payment verification alerts. Every connection code is one-use and valid for exactly 7 days.
          </p>
        </div>
        <button class="btn btn-g btn-sm" type="button" data-tg-action="refresh" ${state.loading ? 'disabled aria-busy="true"' : ''}>${state.loading ? 'Refreshing...' : 'Refresh'}</button>
      </div>

      <div id="telegramAdminStatus" class="integration-card ${noticeClass}" role="status" aria-live="polite" aria-atomic="true" style="margin-bottom:14px;padding:9px 12px">
        <div class="integration-meta">${escapeHtml(state.notice)}</div>
      </div>

      ${generatedCodeMarkup()}

      <div class="tbl-wrap" style="margin-bottom:14px">
        <div class="tbl-hd">
          <div>
            <h3>Alert Recipients</h3>
            <div class="integration-meta">Only connected recipients receive pending verification alerts.</div>
          </div>
          <span class="integration-badge ${activeCount ? 'ok' : 'warn'}">${activeCount} active</span>
        </div>
        <div class="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Owner</th>
                <th scope="col">Role</th>
                <th scope="col">Account status</th>
                <th scope="col">Telegram</th>
                <th scope="col">Connection</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>${recipientRowsMarkup()}</tbody>
          </table>
        </div>
      </div>

      <div class="tbl-wrap">
        <div class="tbl-hd">
          <div>
            <h3>Connect an Owner</h3>
            <div class="integration-meta">Eligible accounts are supplied and authorized by the server.</div>
          </div>
        </div>
        <div class="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Owner</th>
                <th scope="col">Role</th>
                <th scope="col">Account status</th>
                <th scope="col">Telegram status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>${candidateRowsMarkup()}</tbody>
          </table>
        </div>
      </div>`;
  }

  function setNotice(message, tone) {
    state.notice = message;
    state.noticeTone = tone || '';
    paint();
  }

  async function loadRecipients(options) {
    const sequence = ++state.loadSequence;
    state.loading = true;
    if (!options?.quiet) {
      state.notice = state.candidates.length || state.connections.length
        ? 'Refreshing Telegram recipients...'
        : 'Loading Telegram recipients...';
      state.noticeTone = '';
    }
    paint();

    try {
      const response = await invokeOwnerLink('list');
      if (!response || response.ok !== true) throw new Error('List request failed.');
      if (sequence !== state.loadSequence) return false;
      state.candidates = Array.isArray(response.candidates) ? response.candidates : [];
      state.connections = Array.isArray(response.connections) ? response.connections : [];
      state.notice = `${state.connections.filter(isConnected).length} active Telegram recipient${state.connections.filter(isConnected).length === 1 ? '' : 's'}.`;
      state.noticeTone = 'ok';
      return true;
    } catch (_) {
      if (sequence !== state.loadSequence) return false;
      state.notice = 'Unable to load Telegram recipients. Check the connection and try again.';
      state.noticeTone = 'warn';
      return false;
    } finally {
      if (sequence === state.loadSequence) {
        state.loading = false;
        paint();
      }
    }
  }

  async function createCode(accountId) {
    if (!accountId || state.generatingFor) return;
    const candidate = candidateFor(accountId);
    if (!candidate || candidate.eligible !== true || isConnected(connectionFor(accountId))) {
      setNotice('That owner is not eligible for a new Telegram connection code.', 'warn');
      return;
    }

    state.generatingFor = accountId;
    state.notice = 'Generating a secure one-use code...';
    state.noticeTone = '';
    paint();
    try {
      const response = await invokeOwnerLink('create_code', { targetAccountId: accountId });
      const expiresAt = parsedTime(response?.expiresAt);
      if (
        !response ||
        response.ok !== true ||
        !response.code ||
        String(response.targetAccountId || '') !== accountId ||
        expiresAt == null ||
        expiresAt <= Date.now()
      ) {
        throw new Error('Invalid code response.');
      }

      state.generatedCode = {
        code: String(response.code),
        targetAccountId: accountId,
        expiresAt: String(response.expiresAt),
        botUsername: String(response.botUsername || ''),
        startLink: String(response.startLink || ''),
      };
      scheduleCodeExpiry();
      await loadRecipients({ quiet: true });
      state.notice = 'One-use code generated. Send the command or bot link to the intended owner only.';
      state.noticeTone = 'ok';
    } catch (_) {
      state.notice = 'Could not generate the connection code. Please try again.';
      state.noticeTone = 'warn';
    } finally {
      state.generatingFor = '';
      paint();
    }
  }

  async function revokeConnection(accountId) {
    if (!accountId || state.revokingFor) return;
    const connection = connectionFor(accountId);
    if (!isConnected(connection)) return;
    const owner = candidateIdentity(candidateFor(accountId));
    const confirmed = typeof root.confirm === 'function'
      ? root.confirm(`Revoke Telegram alerts for ${owner.name}? They will stop receiving pending verification alerts immediately.`)
      : false;
    if (!confirmed) return;

    state.revokingFor = accountId;
    state.notice = `Revoking Telegram alerts for ${owner.name}...`;
    state.noticeTone = '';
    paint();
    try {
      const response = await invokeOwnerLink('revoke', { accountId });
      if (!response || response.ok !== true) throw new Error('Revoke failed.');
      await loadRecipients({ quiet: true });
      state.notice = `Telegram alerts revoked for ${owner.name}.`;
      state.noticeTone = 'ok';
    } catch (_) {
      state.notice = 'Could not revoke this Telegram recipient. Please try again.';
      state.noticeTone = 'warn';
    } finally {
      state.revokingFor = '';
      paint();
    }
  }

  async function copyText(text, successMessage) {
    if (!text) return;
    try {
      if (root.navigator?.clipboard?.writeText) {
        await root.navigator.clipboard.writeText(text);
      } else {
        const documentRef = root.document;
        const field = documentRef.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        documentRef.body.appendChild(field);
        field.select();
        if (!documentRef.execCommand('copy')) throw new Error('Copy unavailable.');
        field.remove();
      }
      setNotice(successMessage, 'ok');
    } catch (_) {
      setNotice('Copy failed. Select the command and copy it manually.', 'warn');
    }
  }

  function onPanelClick(event) {
    const trigger = event.target?.closest?.('[data-tg-action]');
    if (!trigger || !event.currentTarget.contains(trigger) || trigger.disabled) return;
    const action = trigger.getAttribute('data-tg-action');
    if (action === 'refresh') {
      loadRecipients();
    } else if (action === 'create-code') {
      createCode(String(trigger.getAttribute('data-account-id') || ''));
    } else if (action === 'revoke') {
      revokeConnection(String(trigger.getAttribute('data-account-id') || ''));
    } else if (action === 'copy-command') {
      const generated = activeGeneratedCode();
      if (generated) copyText(`/start ${generated.code}`, 'Connection command copied.');
    } else if (action === 'copy-link') {
      const generated = activeGeneratedCode();
      const link = generated && safeStartLink(generated.startLink, generated.botUsername, generated.code);
      if (link) copyText(link, 'Bot link copied.');
    }
  }

  async function render() {
    if (!ensurePanel()) return false;
    activeGeneratedCode();
    paint();
    await loadRecipients();
    return true;
  }

  const publicApi = Object.freeze({ render });
  root.TelegramAdmin = publicApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...publicApi,
      _test: Object.freeze({
        escapeHtml,
        formatPhilippineTime,
        humanize,
        maskChatId,
        safeStartLink,
        WEEK_MS,
      }),
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
