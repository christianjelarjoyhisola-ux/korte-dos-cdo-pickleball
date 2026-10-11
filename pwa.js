/* Installation enhances the existing site; booking still requires a connection. */
(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = () => {
    navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    }).catch(error => console.warn('Home-screen offline support unavailable:', error));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
