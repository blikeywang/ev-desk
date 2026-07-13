/* Production can point both fields at the deployed Worker origin.
   Local development discovers the default Worker port automatically. */
(function(){
  var local=/^(localhost|127\.0\.0\.1)$/.test(location.hostname)?"http://localhost:8790":"";
  window.EV_DESK_CONFIG=window.EV_DESK_CONFIG||{
    arenaApi:local,
    marketApi:local
  };
})();
