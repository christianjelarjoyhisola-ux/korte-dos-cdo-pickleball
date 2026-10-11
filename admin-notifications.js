/* Device permission is requested only from the Enable button's click handler. */
(function () {
  let registration, subscription, publicKey, enabled = false, busy = false, ready = false;
  const el = id => document.getElementById(id);
  const status = message => { el('phoneNotificationStatus').textContent = message; };
  function supported() {
    return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function controls() {
    el('phoneNotificationEnable').disabled = busy || !ready;
    el('phoneNotificationEnable').textContent = enabled ? 'Turn off this device' : 'Enable notifications';
    el('phoneNotificationTest').disabled = busy || !enabled;
    el('phoneNotificationBadge').textContent = enabled ? 'On this device' : 'Off this device';
    el('phoneNotificationBadge').classList.toggle('active', enabled);
  }
  const request = async (action, data = {}) => {
    if (!DB.manageDeviceNotifications) throw new Error('Device notifications require the live system.');
    const result = await DB.manageDeviceNotifications(action, data);
    if (!result?.ok) throw new Error(result?.error || 'Notifications could not be updated.');
    return result;
  };
  function keyBytes(value) {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  }
  async function loadPhone() {
    busy = true; ready = false; enabled = false; controls();
    status('Checking this device…');
    try {
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (ios && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches) {
        status('On iPhone or iPad, add the Admin page to your Home Screen, open it there, then enable notifications. Requires iOS 16.4 or later.');
        return;
      }
      if (!supported()) { status('This browser does not support device notifications. Use a current browser or the installed web app.'); return; }
      registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('The web app is still updating. Refresh and try again.')), 12000))]);
      subscription = await registration.pushManager.getSubscription();
      const result = await request('get', { endpoint: subscription?.endpoint });
      publicKey = result.publicKey;
      enabled = Boolean(subscription && result.subscribed);
      ready = Notification.permission !== 'denied' || Boolean(subscription && result.subscribed);
      if (Notification.permission === 'denied') status('Notifications are blocked. Allow them in your browser or phone settings, then refresh.');
      else status(enabled ? 'This device receives payment-review alerts, including while the app is closed.' : 'Choose Enable notifications, then Allow when your device asks.');
    } catch (error) { status(error.message || 'Unable to check notifications. Refresh to retry.'); }
    finally { busy = false; controls(); }
  }
  window.renderNotifications = async function () {
    if (busy) return;
    await Promise.all([renderPaymentReviewNotificationSettings(), loadPhone()]);
    el('notificationUpdated').textContent = 'Checked ' + new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  };
  window.togglePhoneNotifications = async function () {
    if (busy || !ready) return;
    busy = true; controls();
    try {
      if (enabled) {
        // Persist opt-out before discarding the endpoint needed to remove it.
        await request('unsubscribe', { endpoint: subscription.endpoint });
        enabled = false;
        await subscription.unsubscribe(); subscription = null;
        status('Phone notifications are off on this device.');
      } else {
        // Invoke permission synchronously from the tap (required by iOS).
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          ready = permission !== 'denied';
          status(permission === 'denied' ? 'Notifications are blocked. Allow them in device settings, then refresh.' : 'Permission was not granted. You can try again when ready.');
          return;
        }
        if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
        await request('subscribe', { subscription: subscription.toJSON() });
        enabled = true;
        status('Notifications enabled on this device. Choose Test phone to check delivery.');
      }
    } catch (error) { status(error.message || 'Unable to update this device. Please try again.'); }
    finally { busy = false; controls(); }
  };
  window.testPhoneNotifications = async function () {
    if (busy || !enabled) return;
    busy = true; controls();
    try {
      await request('test', { endpoint: subscription.endpoint });
      status('Test accepted by the push service. Check your notifications; delivery depends on your device settings.');
    } catch (error) { status(error.message || 'The test could not be sent.'); }
    finally { busy = false; controls(); }
  };
  window.turnOffNotificationEmail = async function () {
    if (_paymentReviewEmailBusy || !_paymentReviewEmailLoaded) return;
    el('paymentReviewEmailInput').value = '';
    await savePaymentReviewNotificationEmail();
  };
})();
