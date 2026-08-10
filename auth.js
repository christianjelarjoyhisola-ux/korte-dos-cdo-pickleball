/* ============================================================
   auth.js - deprecated compatibility shim

   Live authentication now lives in supabase-config.js and uses Supabase
   Auth. This file intentionally contains no demo users or passwords.
   ============================================================ */

(function installDeprecatedAuthShim() {
  if (window.Auth) return;

  window.Auth = {
    ROLES: ['owner', 'court_owner', 'staff', 'host'],
    ROLE_LABELS: {
      owner: 'System Owner',
      court_owner: 'Court Owner',
      staff: 'Court Staff',
      host: 'Open Play Host',
    },
    ROLE_PERMISSIONS: {
      owner: ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'maintenance', 'payments', 'vouchers', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only', 'fees'],
      court_owner: ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'maintenance', 'payments', 'vouchers', 'export', 'settings', 'fees'],
      staff: ['bookings', 'open_play', 'payment_review'],
      host: ['host_open_play'],
    },
    permissionsFor(role) { return this.ROLE_PERMISSIONS[role] || []; },
    can(action, role) { return this.permissionsFor(role || this.getSession()?.role).includes(action); },
    hasRole(role) {
      const session = this.getSession();
      if (!session) return false;
      return session.role === 'owner' || session.role === role;
    },
    getSession() { return null; },
    requireAuth() {
      window.location.href = 'login.html';
      return null;
    },
    async login() { return { ok: false, msg: 'Supabase auth is required.' }; },
    async logout() { window.location.href = 'login.html'; },
    async getAll() { return []; },
    async add() { return { ok: false, msg: 'Supabase auth is required.' }; },
    async update() { return { ok: false, msg: 'Supabase auth is required.' }; },
    async del() { return { ok: false, msg: 'Supabase auth is required.' }; },
  };
})();
