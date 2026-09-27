(function(){
  if (window.__lbCompat) return; window.__lbCompat = true;
  /* Honest compatibility layer for proxied guest pages. NOTHING here
     pretends a capability succeeded when it did not. Each stub explains
     why the real API cannot be exposed, fails immediately and
     predictably, and leaves a diagnostic on the console channel the
     engine shim forwards to DevTools. */
  var once = {};
  var diag = function(key, msg){
    if (once[key]) return; once[key] = true;
    try { console.info("[lb] " + msg); } catch (e) {}
  };
  /* Service Worker: a guest page CANNOT get a real service worker
     here. SW registration is bound to the document's origin, and the
     proxied page lives on the LobsterBrowse origin; registering the
     site's worker would install it at the proxy origin (scope fights
     with the Zeolite root-scope worker at /zlsw/sw.js) and it would
     fetch against /r/-route URLs, not the site. So we expose the API
     shape with deterministic, immediate failures:
     - register()/getRegistration(s) fail/resolve WITHOUT hanging;
     - `ready` resolves undefined (never-resolving would hang pages
       that `await navigator.serviceWorker.ready`);
     - a one-time console diagnostic says exactly why. */
  var sw = {
    register: function(){ return Promise.reject(new Error("service workers are not available for proxied pages: the page would register at the proxy origin and collide with the engine's own worker")); },
    getRegistration: function(){ return Promise.resolve(undefined); },
    getRegistrations: function(){ return Promise.resolve([]); },
    addEventListener: function(){},
    removeEventListener: function(){},
    ready: Promise.resolve(undefined)
  };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: function(){ diag("sw", "service workers are unavailable for proxied pages; registration will fail immediately"); return sw; }, configurable: true }); } catch (e) {}
  /* Notifications: the permission would apply to the LobsterBrowse
     origin, not the proxied site, so granting it would let a guest
     page fire system notifications that appear to come from
     LobsterBrowse. Deliberate policy: deterministic "denied", never
     granted, with a one-time diagnostic. */
  try {
    if (window.Notification) {
      var denied = function(){ return Promise.resolve("denied"); };
      Notification.permission = "denied";
      Notification.requestPermission = function(){ diag("notif", "notifications are denied for proxied pages: the permission belongs to the proxy origin, not the site"); return denied(); };
      diag("notif", "notifications are denied for proxied pages: the permission belongs to the proxy origin, not the site");
    }
  } catch (e) {}
  /* beforeinstallprompt: must stay suppressed. The browser would offer
     to install LOBSTERBROWSE itself (the PWA the user is looking at),
     not the proxied site, so letting it through is always wrong here. */
  window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); });
})();
