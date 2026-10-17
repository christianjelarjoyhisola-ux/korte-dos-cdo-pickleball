/* Broadcasts are untrusted invalidation hints. Only the snapshot RPC supplies board data. */
(function (root) {
  'use strict';
  const FALLBACK_MS = 3000;
  const RECONCILE_MS = 60000;
  const COALESCE_MS = 150;

  function capability(snapshot, now) {
    const value = snapshot?.liveUpdates;
    if (value?.mode !== 'broadcast' || value.reconcileMs !== RECONCILE_MS ||
        !/^player-live:[0-9a-f]{64}$/.test(String(value.topic || ''))) return null;
    const expires = Date.parse(value.expiresAt || '');
    if (!Number.isFinite(expires)) return null;
    // Use the authoritative server clock when present, so an incorrectly set
    // phone clock does not extend a link's remaining lifetime.
    const generated = Date.parse(snapshot.generatedAt || '');
    return { topic: value.topic, expiresAt: now + Math.max(0, expires - (Number.isFinite(generated) ? generated : now)) };
  }

  function create(options) {
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    let timer = null, timerAt = null, expiryTimer = null, unsubscribe = null, generation = 0;
    let stopped = false, paused = false, inFlight = false, dirty = false, immediate = false;
    let joined = false, failures = 0, retryAt = 0, current = null, lastStarted = -Infinity;
    const canRead = () => !stopped && !paused && !options.isHidden?.() && options.isOnline?.() !== false;
    const clearPoll = () => { if (timer !== null) clearTimer(timer); timer = null; timerAt = null; };

    function detach() {
      generation++;
      joined = false;
      const remove = unsubscribe;
      unsubscribe = null;
      try { Promise.resolve(remove?.()).catch(() => {}); } catch (_) {}
    }
    function stop() {
      stopped = true;
      dirty = false;
      clearPoll();
      if (expiryTimer !== null) clearTimer(expiryTimer);
      expiryTimer = null;
      detach();
    }
    function expire() {
      if (stopped) return;
      stop();
      options.onUnavailable?.();
    }
    function plan() {
      if (!canRead() || inFlight) { clearPoll(); return; }
      if (current && current.expiresAt <= now()) { expire(); return; }
      let delay = dirty
        ? immediate ? 0 : Math.max(COALESCE_MS, lastStarted + FALLBACK_MS - now())
        : failures ? Math.max(0, retryAt - now()) : joined && current ? RECONCILE_MS : FALLBACK_MS;
      // An unhealthy RPC backs off even if public hints continue arriving.
      // Explicit refresh and a visibility/online wake can retry immediately.
      if (failures && !immediate) delay = Math.max(delay, retryAt - now());
      const due = now() + delay;
      // Further hints must not push an already queued read into the future.
      if (timer !== null && timerAt <= due) return;
      clearPoll();
      timerAt = due;
      timer = setTimer(read, delay);
    }
    function request(force = false) {
      if (stopped) return;
      dirty = true;
      immediate = immediate || force;
      plan();
    }
    function configure(snapshot) {
      // Anchor the server's remaining lifetime at request start, conservatively
      // subtracting network time rather than extending an expiring share.
      const next = capability(snapshot, lastStarted);
      if (expiryTimer !== null) clearTimer(expiryTimer);
      expiryTimer = null;
      if (!next || next.topic !== current?.topic) detach();
      current = next;
      if (!next) return true;
      if (next.expiresAt <= now()) { expire(); return false; }
      expiryTimer = setTimer(expire, Math.min(2147483647, next.expiresAt - now()));
      if (!unsubscribe && options.subscribe && canRead()) {
        const version = ++generation;
        try {
          const remove = options.subscribe(next.topic, {
            // Deliberately ignore the payload, including forged names/scores.
            changed() { if (version === generation) request(); },
            status(status) {
              if (version !== generation || stopped) return;
              if (status === 'SUBSCRIBED') {
                if (!joined) { joined = true; request(failures === 0); }
              } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
                joined = false;
                if (status === 'CLOSED') detach();
                plan();
              }
            },
          });
          if (version === generation) unsubscribe = typeof remove === 'function' ? remove : () => {};
          else { try { Promise.resolve(remove?.()).catch(() => {}); } catch (_) {} }
        } catch (_) { joined = false; }
      }
      return true;
    }
    async function read() {
      timer = null;
      timerAt = null;
      if (!canRead() || inFlight) return;
      if (current && current.expiresAt <= now()) { expire(); return; }
      dirty = false;
      immediate = false;
      inFlight = true;
      lastStarted = now();
      options.onLoading?.(true);
      try {
        const snapshot = await options.fetchSnapshot();
        if (stopped) return;
        if (!snapshot) { expire(); return; }
        failures = 0;
        retryAt = 0;
        if (configure(snapshot)) options.onSnapshot?.(snapshot);
      } catch (error) {
        if (!stopped) {
          failures++;
          retryAt = now() + (failures >= 4 ? RECONCILE_MS : FALLBACK_MS * (2 ** failures));
          options.onError?.(error);
        }
      } finally {
        inFlight = false;
        options.onLoading?.(false);
        // Hints received during the read are not erased by its completion.
        plan();
      }
    }
    return {
      start() { request(true); },
      refresh() { request(true); },
      pause() { paused = true; clearPoll(); detach(); },
      wake() {
        paused = false;
        if (!canRead()) { clearPoll(); detach(); return; }
        request(true);
      },
      dispose: stop,
    };
  }
  const api = { create, capability, FALLBACK_MS, RECONCILE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LiveBoardUpdates = api;
})(typeof window === 'undefined' ? globalThis : window);
