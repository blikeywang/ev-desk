/* Public fallbacks remain available when the owner's read-only local hub is off. */
(function(){
  var local=/^(localhost|127\.0\.0\.1)$/.test(location.hostname)?"http://localhost:8790":"";
  var personal="http://127.0.0.1:8765";
  window.EV_DESK_CONFIG=window.EV_DESK_CONFIG||{
    arenaApi:local,
    marketApi:local,
    marketApis:[local,personal].filter(Boolean),
    personalDataApi:personal
  };
})();
