(function(){
  if (window.__lbCompat) return; window.__lbCompat = true;
  var sw = { register: function(){ return Promise.reject(new Error("service workers unavailable")); },
             getRegistration: function(){ return Promise.resolve(undefined); },
             getRegistrations: function(){ return Promise.resolve([]); },
             addEventListener: function(){}, removeEventListener: function(){},
             ready: new Promise(function(){}) };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: function(){ return sw; }, configurable: true }); } catch (e) {}
  try { if (window.Notification) { Notification.permission = "denied"; Notification.requestPermission = function(){ return Promise.resolve("denied"); }; } } catch (e) {}
  window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); });
