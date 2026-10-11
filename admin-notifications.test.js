const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness({ subscribed = false, failSave = false, permission = 'granted', supported = true } = {}) {
  const nodes = new Map(); const calls = []; let prompts = 0, unsubscribed = false;
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent:'', disabled:false, classList:{ toggle(){} } }); return nodes.get(id); };
  const subscription = { endpoint:'https://fcm.googleapis.com/test', toJSON: () => ({ endpoint:'https://fcm.googleapis.com/test' }), unsubscribe: async () => { unsubscribed = true; } };
  const registration = { pushManager: { getSubscription: async () => subscribed ? subscription : null, subscribe: async () => subscription } };
  const context = { window:{ isSecureContext:true, matchMedia:()=>({matches:true}), ...(supported ? {PushManager:{},Notification:{}} : {}) },
    navigator:{userAgent:'test', serviceWorker:{ready:Promise.resolve(registration)}},
    Notification:{permission, requestPermission:async()=>{prompts++;return permission;}},
    document:{getElementById:node}, Date, Uint8Array, atob, setTimeout:()=>0,
    renderPaymentReviewNotificationSettings:async()=>{},
    DB:{manageDeviceNotifications:async(action)=>{ calls.push(action); if(failSave && action==='subscribe') throw Error('Network unavailable'); return {ok:true,subscribed,publicKey:'BA'.repeat(43)}; }} };
  vm.runInNewContext(fs.readFileSync('admin-notifications.js','utf8'),context);
  return {context,node,calls,get prompts(){return prompts;},get unsubscribed(){return unsubscribed;}};
}
test('loading settings never requests permission, and unsupported devices stay disabled', async()=>{
  const h=harness(); await h.context.window.renderNotifications(); assert.equal(h.prompts,0); assert.equal(h.node('phoneNotificationTest').disabled,true);
  const unsupported=harness({supported:false}); await unsupported.context.window.renderNotifications(); assert.equal(unsupported.node('phoneNotificationEnable').disabled,true); assert.equal(unsupported.calls.length,0);
});
test('an enabled badge requires successful server persistence',async()=>{
  const h=harness({failSave:true}); await h.context.window.renderNotifications(); await h.context.window.togglePhoneNotifications();
  assert.equal(h.prompts,1); assert.equal(h.node('phoneNotificationBadge').textContent,'Off this device'); assert.equal(h.node('phoneNotificationTest').disabled,true); assert.match(h.node('phoneNotificationStatus').textContent,/Network unavailable/);
});
test('turning off removes the server subscription before browser unsubscribe',async()=>{
  const h=harness({subscribed:true}); await h.context.window.renderNotifications(); await h.context.window.togglePhoneNotifications();
  assert.deepEqual(h.calls,['get','unsubscribe']); assert.equal(h.unsubscribed,true); assert.equal(h.prompts,0); assert.equal(h.node('phoneNotificationBadge').textContent,'Off this device');
});
test('denied permission cannot enable a new subscription',async()=>{
  const h=harness({permission:'denied'}); await h.context.window.renderNotifications(); await h.context.window.togglePhoneNotifications();
  assert.equal(h.prompts,0); assert.equal(h.node('phoneNotificationEnable').disabled,true); assert.deepEqual(h.calls,['get']);
});
test('push notifications hide payload details and notification clicks ignore arbitrary URLs',async()=>{
  const handlers={}, shown=[], opened=[];
  const context={URL, self:{location:{origin:'https://kortedoscdo.club'},addEventListener:(name,fn)=>handlers[name]=fn,
    registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>[],openWindow:async(url)=>opened.push(url)}}};
  vm.runInNewContext(fs.readFileSync('service-worker.js','utf8'),context);
  let work;
  handlers.push({data:{json:()=>({type:'payment-review',body:'Customer secret',url:'https://attacker.example'})},waitUntil:p=>work=p}); await work;
  assert.equal(JSON.stringify(shown).includes('Customer secret'),false);
  handlers.notificationclick({notification:{close(){},data:{url:'https://attacker.example'}},waitUntil:p=>work=p}); await work;
  assert.deepEqual(opened,['https://kortedoscdo.club/admin?section=payreview']);
});
