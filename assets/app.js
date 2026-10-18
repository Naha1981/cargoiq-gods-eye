(function () {
  'use strict';

  var WS_URL = 'wss://cargoiq-gods-eye.onrender.com/stream';
  var SNAPSHOT_URL = 'data/vessels-snapshot.json';
  var MAX_VESSELS = 400;

  var VIEW = {
    durban:   { lon: 31.045, lat: -29.872, alt: 11000 },
    richards: { lon: 32.062, lat: -28.795, alt: 16000 },
    dispute:  { lon: 31.0395, lat: -29.8698, alt: 2200 }
  };
  var DISPUTE = {
    lon: 31.0395, lat: -29.8698,
    title: 'Disputed container - DUR-2026-0412'
  };

  var isMobile = (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) ||
                 /Android|iPhone|iPad/i.test(navigator.userAgent || '');

  var $ = function (id) { return document.getElementById(id); };
  var pill = $('status-pill'), statusText = $('status-text'), countChip = $('vessel-count');

  function setStatus(mode, text) {
    pill.classList.remove('pill-live', 'pill-warm', 'pill-off');
    pill.classList.add(mode === 'live' ? 'pill-live' : mode === 'off' ? 'pill-off' : 'pill-warm');
    statusText.textContent = text;
  }

  var LITE = new URLSearchParams(location.search).get('lite') === '1';
  var viewer;
  if (LITE) {
    var noopCanvas = document.createElement('canvas');
    viewer = {
      entities: { add: function () { return { position: null, point: {}, label: {} }; }, remove: function () {} },
      camera: { flyTo: function () {}, setView: function () {} },
      scene: {
        canvas: noopCanvas, pick: function () { return undefined; }, skyAtmosphere: null,
        globe: {}, screenSpaceCameraController: {}, primitives: {},
        requestRender: function () {}, isDestroyed: function () { return false; }
      },
      trackedEntity: null, resolutionScale: 1, terrainProvider: null,
      isDestroyed: function () { return false; }
    };
  }
  try {
    if (LITE) throw 'lite';
    if (window.Cesium && Cesium.Ion) { Cesium.Ion.defaultAccessToken = ''; }
    var imagery = new Cesium.UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      credit: 'Esri, Maxar, Earthstar Geographics'
    });
    viewer = new Cesium.Viewer('cesiumContainer', {
      baseLayer: new Cesium.ImageryLayer(imagery),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
      sceneMode: Cesium.SceneMode.SCENE3D,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity
    });
  } catch (e) {
    if (LITE) { $('cesiumContainer').style.background = '#0b1220'; } else { $('fatal').classList.remove('hidden'); return; }
  }

  // Keyless terrain (progressive enhancement; flat ellipsoid if it fails)
  if (!LITE) Cesium.CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid', {
    requestVertexNormals: false,
    credit: 'Re:Earth Terrain'
  }).then(function (tp) {
    if (!viewer.isDestroyed()) viewer.terrainProvider = tp;
  }).catch(function () { /* ellipsoid fallback */ });

  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = !isMobile;
  if (isMobile) {
    viewer.resolutionScale = 0.8;
    var noteShown = false;
    setTimeout(function () {
      if (noteShown) return;
      if (document.querySelector('.card:not(.hidden), #scrub-bar:not(.hidden), #fp-hud:not(.hidden)')) return; // never overlap a panel
      noteShown = true;
      $('desktop-note').classList.remove('hidden');
      setTimeout(function () { $('desktop-note').classList.add('hidden'); }, 9000);
    }, 2500);
    // dismiss permanently as soon as any panel/card opens
    new MutationObserver(function () {
      if (document.querySelector('.card:not(.hidden), #scrub-bar:not(.hidden), #fp-hud:not(.hidden)')) {
        noteShown = true;
        $('desktop-note').classList.add('hidden');
      }
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }
  $('desktop-note-ok').addEventListener('click', function () { $('desktop-note').classList.add('hidden'); });
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a0f1a');
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 250;

  var scene = viewer.scene;

  // ---------- state ----------
  var vessels = new Map();      // mmsi -> {entity, rec, fromSnapshot}
  var liveConnected = false;
  var lastLiveMsg = 0;
  var selectedMmsi = null;
  var headingEntity = null;
  var pulsePhase = 0;

  function colorFor(rec, fromSnapshot) {
    var sog = typeof rec.sog === 'number' ? rec.sog : 0;
    var c = sog > 1 ? '#38bdf8' : '#94a3b8';
    var col = Cesium.Color.fromCssColorString(c);
    return fromSnapshot ? col.withAlpha(0.55) : col;
  }

  function upsertVessel(rec, fromSnapshot) {
    if (typeof rec.lat !== 'number' || typeof rec.lon !== 'number') return;
    if (!rec.mmsi) return;
    if (vessels.size >= MAX_VESSELS && !vessels.has(rec.mmsi)) return;

    var v = vessels.get(rec.mmsi);
    if (v && !fromSnapshot && v.fromSnapshot) {
      scene.primitives; // no-op
      v.fromSnapshot = false;
    }
    var pos = Cesium.Cartesian3.fromDegrees(rec.lon, rec.lat);
    if (!v) {
      var entity = viewer.entities.add({
        position: new Cesium.ConstantPositionProperty(pos),
        point: {
          pixelSize: 8,
          color: colorFor(rec, !!fromSnapshot),
          outlineColor: Cesium.Color.fromCssColorString('#0a0f1a'),
          outlineWidth: 1.5,
          scaleByDistance: new Cesium.NearFarScalar(2000, 1.5, 400000, 0.55),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: rec.name || ('MMSI ' + rec.mmsi),
          font: '11px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#e5e7eb'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000),
          scaleByDistance: new Cesium.NearFarScalar(1000, 1.0, 8000, 0.75),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      v = { entity: entity, rec: rec, fromSnapshot: !!fromSnapshot };
      vessels.set(rec.mmsi, v);
    } else {
      v.entity.position = new Cesium.ConstantPositionProperty(pos);
      v.entity.point.color = colorFor(rec, v.fromSnapshot && !!fromSnapshot);
      if (rec.name) v.entity.label.text = rec.name;
      v.rec = rec;
    }
    var hist = v.history || (v.history = []);
    var last = hist[hist.length - 1];
    if (!last || last.lon !== rec.lon || last.lat !== rec.lat) {
      hist.push({ lon: rec.lon, lat: rec.lat });
      if (hist.length > 60) hist.shift();
    }
  }

  function updateCount() {
    countChip.textContent = vessels.size + (vessels.size === 1 ? ' vessel' : ' vessels');
  }

  // ---------- disputed container pin ----------
  var disputeEntity = viewer.entities.add({
    position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(DISPUTE.lon, DISPUTE.lat)),
    point: {
      pixelSize: 14,
      color: Cesium.Color.fromCssColorString('#ef4444'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: {
      text: 'DISPUTED - DUR-2026-0412',
      font: 'bold 12px sans-serif',
      fillColor: Cesium.Color.fromCssColorString('#fca5a5'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -22),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 500000),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });

  // ---------- picking ----------
  var handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(function (movement) {
    var picked = scene.pick(movement.position);
    if (Cesium.defined(picked) && picked.id === disputeEntity) {
      showPeek('dispute', null); peekPinned = true;
      return;
    }
    if (Cesium.defined(picked) && picked.id) {
      var found = null;
      vessels.forEach(function (v, mmsi) { if (v.entity === picked.id) found = mmsi; });
      if (found) { showPeek('vessel', found); peekPinned = true; return; }
    }
    hidePeek();
    $('info-card').classList.add('hidden');
    $('dispute-card').classList.add('hidden');
    selectedMmsi = null;
    stopTrack();
    drawHeading(null);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  var trailEntity = null, ringEntity = null;
  function startTrack(mmsi) {
    var v = vessels.get(mmsi);
    if (!v) return;
    selectedMmsi = mmsi;
    viewer.trackedEntity = v.entity;
    $('track-name').textContent = (v.rec.name || ('MMSI ' + mmsi)) + ' - tracking';
    $('track-chip').classList.remove('hidden');
    if (trailEntity) viewer.entities.remove(trailEntity);
    trailEntity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(function () {
          var vv = vessels.get(mmsi);
          if (!vv || !vv.history || vv.history.length < 2) return [];
          return vv.history.map(function (p) { return Cesium.Cartesian3.fromDegrees(p.lon, p.lat); });
        }, false),
        width: 3,
        material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.18, color: Cesium.Color.fromCssColorString('#38bdf8') }),
        clampToGround: false
      }
    });
    if (ringEntity) viewer.entities.remove(ringEntity);
    ringEntity = viewer.entities.add({
      position: new Cesium.CallbackProperty(function () {
        var vv = vessels.get(mmsi);
        return vv ? vv.entity.position.getValue() : null;
      }, false),
      ellipse: {
        semiMajorAxis: 900, semiMinorAxis: 900,
        height: 0,
        material: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.0),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.8),
        outlineWidth: 3
      }
    });
  }
  function stopTrack() {
    viewer.trackedEntity = undefined;
    $('track-chip').classList.add('hidden');
    if (trailEntity) { viewer.entities.remove(trailEntity); trailEntity = null; }
    if (ringEntity) { viewer.entities.remove(ringEntity); ringEntity = null; }
  }
  $('track-stop').addEventListener('click', function () { stopTrack(); });

  function showVessel(mmsi) {
    var v = vessels.get(mmsi);
    if (!v) return;
    startTrack(mmsi);
    var r = v.rec;
    $('info-title').textContent = r.name || ('MMSI ' + mmsi);
    var sog = (typeof r.sog === 'number') ? r.sog.toFixed(1) + ' kn' : '-';
    var cog = (typeof r.cog === 'number') ? Math.round(r.cog) + '\u00B0' : '-';
    $('info-body').innerHTML =
      '<dt>MMSI</dt><dd>' + mmsi + '</dd>' +
      '<dt>Speed</dt><dd>' + sog + '</dd>' +
      '<dt>Course</dt><dd>' + cog + '</dd>' +
      '<dt>Feed</dt><dd>' + (v.fromSnapshot ? 'Recent snapshot' : 'Live now') + '</dd>';
    $('dispute-card').classList.add('hidden');
    $('info-card').classList.remove('hidden');
    drawHeading(v);
  }

  function drawHeading(v) {
    if (headingEntity) { viewer.entities.remove(headingEntity); headingEntity = null; }
    if (!v || typeof v.rec.sog !== 'number' || v.rec.sog < 1 || typeof v.rec.cog !== 'number') return;
    var r = v.rec;
    var rad = Cesium.Math.toRadians(r.cog);
    var len = Math.min(Math.max(r.sog, 1), 25) * 0.004; // degrees, scaled by speed
    var dLat = Math.cos(rad) * len;
    var dLon = Math.sin(rad) * len / Math.max(Math.cos(Cesium.Math.toRadians(r.lat)), 0.2);
    headingEntity = viewer.entities.add({
      polyline: {
        positions: [
          Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
          Cesium.Cartesian3.fromDegrees(r.lon + dLon, r.lat + dLat)
        ],
        width: 2.5,
        material: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.85),
        clampToGround: false
      }
    });
  }

  $('info-close').addEventListener('click', function () { $('info-card').classList.add('hidden'); selectedMmsi = null; drawHeading(null); });
  $('dispute-close').addEventListener('click', function () { $('dispute-card').classList.add('hidden'); });

  // ---------- fly-to ----------
  function flyTo(target) {
    var t = VIEW[target];
    if (!t) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.alt),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-58),
        roll: 0
      },
      duration: 2.4
    });
    if (target === 'dispute') {
      setTimeout(function () { $('dispute-card').classList.remove('hidden'); }, 2600);
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.flybtn'), function (btn) {
    btn.addEventListener('click', function () { flyTo(btn.getAttribute('data-target')); });
  });

  // ---------- attribution modal ----------
  $('attr-btn').addEventListener('click', function () { $('attr-modal').classList.remove('hidden'); });
  $('attr-close').addEventListener('click', function () { $('attr-modal').classList.add('hidden'); });
  $('attr-modal').addEventListener('click', function (e) { if (e.target === $('attr-modal')) $('attr-modal').classList.add('hidden'); });

  // ---------- data plane ----------
  function ingestMessage(m, fromSnapshot) {
    if (m.MessageType === 'NahaLabsInit' && Array.isArray(m.Vessels)) {
      m.Vessels.forEach(function (rec) { upsertVessel(rec, false); });
      updateCount();
      return;
    }
    var meta = m.MetaData || {};
    var mmsi = String(meta.MMSI || '');
    if (!mmsi) return;
    var existing = vessels.get(mmsi);
    var rec = existing ? existing.rec : { mmsi: mmsi };
    if (meta.ShipName) rec.name = String(meta.ShipName).trim();
    if (m.MessageType === 'PositionReport') {
      var p = m.Message.PositionReport;
      if (typeof p.Latitude !== 'number' || typeof p.Longitude !== 'number') return;
      rec.lat = p.Latitude; rec.lon = p.Longitude;
      rec.sog = p.Sog; rec.cog = p.Cog; rec.hdg = p.TrueHeading;
      upsertVessel(rec, !!fromSnapshot);
      updateCount();
    } else if (m.MessageType === 'ShipStaticData') {
      var s = m.Message.ShipStaticData || {};
      if (s.Type != null) rec.type = s.Type;
      if (existing) existing.rec = rec;
    }
  }

  function loadSnapshot() {
    fetch(SNAPSHOT_URL, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (snap) {
      if (!snap || !Array.isArray(snap.vessels) || liveConnected) return;
      var n = 0;
      snap.vessels.forEach(function (rec) {
        if (!vessels.has(rec.mmsi)) { upsertVessel(rec, true); n++; }
      });
      updateCount();
      if (!liveConnected) {
        var when = snap.captured_at ? snap.captured_at.replace('T', ' ').slice(5, 16) + ' UTC' : 'recently';
        setStatus('warm', 'SNAPSHOT - ' + when);
      }
    }).catch(function () {
      if (!liveConnected) setStatus('off', 'OFFLINE');
    });
  }

  var wsRetry = 0;
  function connectLive() {
    var ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { scheduleRetry(); return; }
    var gotAny = false;
    var opener = setTimeout(function () {
      if (!gotAny) { try { ws.close(); } catch (e) {} }
    }, 45000); // Render free cold start can take a while
    ws.onopen = function () { wsRetry = 0; };
    ws.onmessage = function (ev) {
      gotAny = true;
      clearTimeout(opener);
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      var isInit = m.MessageType === 'NahaLabsInit';
      var hasLiveShips = (m.MessageType === 'PositionReport') ||
                         (isInit && Array.isArray(m.Vessels) && m.Vessels.length > 0);
      if (isInit && (!Array.isArray(m.Vessels) || m.Vessels.length === 0)) {
        loadSnapshot(); // relay is up but its upstream is dry: show last real picture
        setStatus('warm', 'RECONNECTING');
        return;
      }
      lastLiveMsg = Date.now();
      if (hasLiveShips && !liveConnected) {
        liveConnected = true;
        setStatus('live', 'LIVE');
      }
      ingestMessage(m, false);
    };
    ws.onclose = function () {
      clearTimeout(opener);
      liveConnected = false;
      if (vessels.size === 0) loadSnapshot(); else setStatus('warm', 'RECONNECTING');
      scheduleRetry();
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function scheduleRetry() {
    wsRetry = Math.min(wsRetry + 1, 6);
    setTimeout(connectLive, Math.min(5000 * wsRetry, 30000));
  }

  // liveness watchdog: drop to snapshot label if stream goes quiet
  setInterval(function () {
    if (liveConnected && Date.now() - lastLiveMsg > 45000) {
      liveConnected = false;
      setStatus('warm', 'LIVE PAUSED');
    }
  }, 10000);

  // pulse the disputed pin + keep selected-vessel heading fresh, throttled re-render
  setInterval(function () {
    pulsePhase += 0.6;
    var px = 12 + Math.sin(pulsePhase) * 4;
    if (disputeEntity.point) disputeEntity.point.pixelSize = px;
    if (selectedMmsi) {
      var v = vessels.get(selectedMmsi);
      if (v) drawHeading(v);
    }
    if (!scene.isDestroyed()) scene.requestRender();
  }, 1500);


  // ---------- CCTV (verified free public cameras, refreshing stills) ----------
  var CAMERAS = [
    { id: 'vetchs', name: "Vetch's Pier - Durban harbour mouth", lon: 31.0570, lat: -29.8690,
      img: 'https://durbancoastlive.com/incoming/vetchs/vetchs.jpg', source: 'Durban Coast Live - still frame, refreshes periodically' },
    { id: 'bluewaters', name: 'Blue Waters - Durban beachfront', lon: 31.0378, lat: -29.8362,
      img: 'https://durbancoastlive.com/incoming/blueWaters/bwSouth.jpg', source: 'Durban Coast Live - still frame, refreshes periodically' }
  ];
  var camEntities = [];
  var camRefreshTimer = null;
  CAMERAS.forEach(function (cam) {
    var ent = viewer.entities.add({
      position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat)),
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString('#f59e0b'),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: 'CAM', font: 'bold 10px sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#fbbf24'),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 120000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    cam._entity = ent;
    camEntities.push(ent);
  });
  function openCam(cam) {
    $('cam-title').textContent = cam.name;
    $('cam-source').textContent = cam.source + ' - position approximate';
    var img = $('cam-img');
    var bust = function () { img.src = cam.img + '?t=' + Date.now(); };
    bust();
    if (camRefreshTimer) clearInterval(camRefreshTimer);
    camRefreshTimer = setInterval(bust, 10000);
    $('cam-panel').classList.remove('hidden');
  }
  function closeCam() {
    $('cam-panel').classList.add('hidden');
    if (camRefreshTimer) { clearInterval(camRefreshTimer); camRefreshTimer = null; }
  }
  $('cam-close').addEventListener('click', closeCam);
  function nearestCamTo(lon, lat) {
    var best = null, bd = 1e9;
    CAMERAS.forEach(function (c) {
      var d = (c.lon - lon) * (c.lon - lon) + (c.lat - lat) * (c.lat - lat);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  document.querySelector('[data-target=\'dispute\']').addEventListener('click', function () {
    setTimeout(openCase, 2700);
  });
  $('dispute-cam').addEventListener('click', function () {
    var c = nearestCamTo(DISPUTE.lon, DISPUTE.lat);
    if (c) { openCam(c); flyToPoint(c.lon, c.lat, 6000); }
  });
  $('vessel-cam').addEventListener('click', function () {
    if (!selectedMmsi) return;
    var v = vessels.get(selectedMmsi);
    if (!v) return;
    var c = nearestCamTo(v.rec.lon, v.rec.lat);
    if (c) { openCam(c); flyToPoint(c.lon, c.lat, 6000); }
  });
  function flyToPoint(lon, lat, alt) {
    viewer.trackedEntity = undefined;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 2.2
    });
  }
  handler.setInputAction(function (movement) {
    var picked = scene.pick(movement.position);
    if (Cesium.defined(picked) && picked.id) {
      var cam = null;
      CAMERAS.forEach(function (c) { if (c._entity === picked.id) cam = c; });
      if (cam) { showPeek('cam', cam); peekPinned = true; return; }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // ---------- Port conditions (Open-Meteo, keyless, CC BY 4.0) ----------
  function loadConditions() {
    var marine = fetch('https://marine-api.open-meteo.com/v1/marine?latitude=-29.87&longitude=31.05&current=wave_height,wave_period,wave_direction,swell_wave_height&timezone=Africa%2FJohannesburg').then(function (r) { return r.json(); });
    var wx = fetch('https://api.open-meteo.com/v1/forecast?latitude=-29.87&longitude=31.05&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=Africa%2FJohannesburg&wind_speed_unit=kn').then(function (r) { return r.json(); });
    Promise.all([marine, wx]).then(function (res) {
      var m = res[0].current || {}, w = res[1].current || {};
      var dirs = ['N','NE','E','SE','S','SW','W','NW'];
      var compass = function (deg) { return (typeof deg === 'number') ? dirs[Math.round(deg / 45) % 8] : '-'; };
      $('cond-body').innerHTML =
        '<dt>Waves</dt><dd>' + (m.wave_height != null ? m.wave_height + ' m' : '-') + ' / ' + (m.wave_period != null ? m.wave_period + ' s' : '-') + ' ' + compass(m.wave_direction) + '</dd>' +
        '<dt>Swell</dt><dd>' + (m.swell_wave_height != null ? m.swell_wave_height + ' m' : '-') + '</dd>' +
        '<dt>Wind</dt><dd>' + (w.wind_speed_10m != null ? Math.round(w.wind_speed_10m) + ' kn' : '-') + ' ' + compass(w.wind_direction_10m) + (w.wind_gusts_10m != null ? ' (gusts ' + Math.round(w.wind_gusts_10m) + ' kn)' : '') + '</dd>' +
        '<dt>Updated</dt><dd>' + ((m.time || w.time || '').replace('T', ' ')) + '</dd>';
    }).catch(function () {
      $('cond-body').innerHTML = '<dt>Status</dt><dd>Conditions feed unavailable</dd>';
    });
  }
  $('cond-btn').addEventListener('click', function () {
    $('cond-panel').classList.toggle('hidden');
    if (!$('cond-panel').classList.contains('hidden')) loadConditions();
  });
  $('cond-close').addEventListener('click', function () { $('cond-panel').classList.add('hidden'); });

  // ---------- Case replay (fictional DUR-2026-0412) ----------
  var REPLAY = [
    { t: 'Day 1, 06:12', title: 'Arrival - outer anchorage', desc: 'MV Umhlanga Trader arrives off Durban and waits for a berth. The delay clock dispute starts here.', lon: 31.175, lat: -29.795, alt: 22000 },
    { t: 'Day 1, 14:40', title: 'Berthing - DGT berth 108', desc: 'Vessel berths at Durban Container Terminal. The terminal says the berth was ready earlier; the carrier disagrees.', lon: 31.0393, lat: -29.8702, alt: 7000 },
    { t: 'Day 1, 18:05', title: 'Free time expires', desc: 'Container MSKU 482931 7: free time expires while the parties dispute whose clock counts.', lon: 31.0395, lat: -29.8698, alt: 2600 },
    { t: 'Day 2, 09:15', title: 'Demurrage invoice issued', desc: 'Invoice raised. The evidence pack stays BLOCKED while 2 contradictions remain open.', lon: 31.0395, lat: -29.8698, alt: 2600 }
  ];
  var replayTimer = null, replayIdx = -1;
  function replayStep() {
    if (replayIdx >= REPLAY.length) { stopReplay(); return; }
    var ev = REPLAY[replayIdx];
    $('replay-title').textContent = 'Step ' + (replayIdx + 1) + ' of ' + REPLAY.length + ' - ' + ev.title;
    $('replay-desc').textContent = ev.t + '. ' + ev.desc;
    $('replay-card').classList.remove('hidden');
    flyToPoint(ev.lon, ev.lat, ev.alt);
    replayIdx++;
    replayTimer = setTimeout(replayStep, 5200);
  }
  function startReplay() {
    stopReplay();
    replayIdx = 0;
    $('replay-btn').innerHTML = '&#9632; Stop replay';
    replayStep();
  }
  function stopReplay() {
    if (replayTimer) { clearTimeout(replayTimer); replayTimer = null; }
    replayIdx = -1;
    $('replay-btn').innerHTML = '&#9654; Replay case DUR-2026-0412';
    $('replay-card').classList.add('hidden');
  }
  $('replay-btn').addEventListener('click', function () {
    if (replayIdx >= 0) stopReplay(); else startReplay();
  });
  $('replay-close').addEventListener('click', stopReplay);


  // ---------- voice commands (push-to-talk + typed fallback) ----------
  // ---------- voice alias + fuzzy layer (ASR mis-transcription tolerant) ----------
  function normVoice(t) {
    return (t || '').toLowerCase()
      .replace(/[\u2018\u2019']/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99;
    var m = a.length, n = b.length, d = [];
    for (var i = 0; i <= m; i++) { d[i] = [i]; }
    for (var j = 0; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    }
    return d[m][n];
  }
  function aliasHit(t, names) {
    // exact alias phrase containment first
    for (var k = 0; k < names.length; k++) {
      if (t.indexOf(names[k]) >= 0) return { ok: true, how: 'alias' };
    }
    // fuzzy: any alias word close to any heard word
    var words = t.split(' ');
    for (k = 0; k < names.length; k++) {
      var aliasWords = names[k].split(' ');
      for (var a = 0; a < aliasWords.length; a++) {
        var aw = aliasWords[a];
        if (aw.length < 4) continue;
        for (var w = 0; w < words.length; w++) {
          if (words[w].length >= 4 && lev(words[w], aw) <= (aw.length >= 7 ? 2 : 1)) return { ok: true, how: 'fuzzy' };
        }
      }
    }
    return { ok: false };
  }
  var VOICE_PLACES = [
    { key: 'durban', names: ['durban', 'derban', 'durbun', 'ethekwini', 'ethekweni', 'tekwini'], view: 'durban', reply: 'Flying to Durban harbour.', audio: 'durban' },
    { key: 'richards', names: ['richards bay', 'richards', 'richard bay', 'richards bae', 'richardspay'], view: 'richards', reply: 'Flying to Richards Bay. Note: terrestrial A I S coverage there is currently zero. A known dead zone.', audio: 'richards' },
    { key: 'capetown', audio: 'place-capetown', names: ['cape town', 'capetown', 'kaapstad'], lon: 18.43, lat: -33.91, alt: 55000, reply: 'Cape Town is outside the current evidence coverage. Durban and Richards Bay are instrumented.' },
    { key: 'gqeberha', audio: 'place-gqeberha', names: ['gqeberha', 'port elizabeth', 'qeberha', 'gheberha', 'geberha'], lon: 25.63, lat: -33.97, alt: 55000, reply: 'Gqeberha, Port Elizabeth, is outside the current evidence coverage.' },
    { key: 'coega', audio: 'place-coega', names: ['coega', 'ngqura', 'kuga', 'incura'], lon: 25.69, lat: -33.79, alt: 40000, reply: 'Coega, Ngqura, is outside the current evidence coverage.' },
    { key: 'eastlondon', audio: 'place-eastlondon', names: ['east london', 'buffalo city'], lon: 27.91, lat: -33.02, alt: 40000, reply: 'East London is outside the current evidence coverage.' },
    { key: 'saldanha', audio: 'place-saldanha', names: ['saldanha', 'saldana'], lon: 17.95, lat: -33.02, alt: 40000, reply: 'Saldanha is outside the current evidence coverage.' },
    { key: 'mosselbay', audio: 'place-mosselbay', names: ['mossel bay', 'mosel bay'], lon: 22.13, lat: -34.18, alt: 40000, reply: 'Mossel Bay is outside the current evidence coverage.' }
  ];
  var VOICE_TERMINALS = [
    { key: 'dgt', audio: 'term-dgt', names: ['dgt', 'berth 108', 'berth one zero eight', 'durban general', 'container terminal', 'dct'], lon: 31.0395, lat: -29.8698, alt: 8000, reply: 'Flying to the Durban container terminal area, where the disputed container is held.' },
    { key: 'bayhead', audio: 'term-bayhead', names: ['bayhead', 'bay head'], lon: 31.031, lat: -29.871, alt: 10000, reply: 'Flying to Bayhead.' },
    { key: 'point', audio: 'term-point', names: ['the point', 'point terminal', 'point waterfront'], lon: 31.041, lat: -29.856, alt: 10000, reply: 'Flying to the Point area.' },
    { key: 'maydon', audio: 'term-maydon', names: ['maydon wharf', 'madonna wharf', 'maiden wharf'], lon: 31.018, lat: -29.885, alt: 10000, reply: 'Flying to Maydon Wharf.' },
    { key: 'islandview', audio: 'term-islandview', names: ['island view', 'islandview'], lon: 31.005, lat: -29.878, alt: 10000, reply: 'Flying to Island View.' }
  ];
  var VOICE_DISPUTE_WORDS = ['dispute', 'disputed', 'container', 'msku', 'musku', 'umhlanga', 'umshlanga', 'the case', 'our case'];
  function logVoiceMiss(heard, resolved) {
    try {
      var buf = JSON.parse(localStorage.getItem('gev-voice-log') || '[]');
      buf.push({ heard: heard, resolved: resolved, ts: new Date().toISOString() });
      if (buf.length > 50) buf = buf.slice(-50);
      localStorage.setItem('gev-voice-log', JSON.stringify(buf));
    } catch (e) {}
    try {
      fetch('https://cargoiq-gods-eye.onrender.com/voice-miss', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ heard: heard, resolved: resolved, ts: Date.now() })
      }).catch(function () {});
    } catch (e) {}
  }
  function findVesselFuzzy(heard) {
    var t = normVoice(heard);
    var best = null, bestScore = 0;
    vessels.forEach(function (v, mmsi) {
      var vn = normVoice(v.rec && v.rec.name ? v.rec.name : '');
      if (!vn) return;
      var score = 0;
      if (vn === t) score = 100;
      else if (vn.indexOf(t) >= 0 || t.indexOf(vn) >= 0) score = 80;
      else {
        var vtok = vn.split(' '), ttok = t.split(' ');
        for (var i = 0; i < ttok.length; i++) {
          if (ttok[i].length < 3) continue;
          for (var j = 0; j < vtok.length; j++) {
            if (vtok[j].length < 3) continue;
            var d = lev(ttok[i], vtok[j]);
            if (d === 0) score = Math.max(score, 60);
            else if (d <= 1) score = Math.max(score, 45);
            else if (d <= 2 && vtok[j].length >= 6) score = Math.max(score, 30);
          }
        }
      }
      if (score > bestScore) { bestScore = score; best = mmsi; }
    });
    return bestScore >= 30 ? { mmsi: best, score: bestScore } : null;
  }

  var voiceRepliesAudio = {}, voiceToastTimer = null;
  function cargoSay(text, audioKey) {
    var r = $('voice-reply');
    r.textContent = text;
    r.classList.remove('hidden');
    $('voice-panel').classList.remove('hidden');
    var toast = $('voice-toast');
    toast.textContent = text;
    toast.classList.remove('hidden');
    if (voiceToastTimer) clearTimeout(voiceToastTimer);
    voiceToastTimer = setTimeout(function () { toast.classList.add('hidden'); }, 6000);
    if (audioKey) setTimeout(function () { $('voice-panel').classList.add('hidden'); }, 1400);
    if (audioKey) {
      var a = voiceRepliesAudio[audioKey];
      if (!a) {
        a = new Audio('assets/voice/' + audioKey + '.mp3');
        voiceRepliesAudio[audioKey] = a;
      }
      a.currentTime = 0;
      a.play().catch(function () { /* audio not bundled yet or autoplay blocked - text reply stands */ });
    }
  }
  function cargoHeard(text) {
    var h = $('voice-heard');
    h.textContent = text;
    h.classList.remove('hidden');
    $('voice-panel').classList.remove('hidden');
  }
  function findVesselByName(name) {
    var needle = name.toLowerCase().trim();
    var best = null;
    vessels.forEach(function (v, mmsi) {
      var vn = (v.rec && v.rec.name ? v.rec.name : '').toLowerCase();
      if (!vn) return;
      if (vn === needle) { best = mmsi; return; }
      if (!best && (vn.indexOf(needle) >= 0 || needle.indexOf(vn) >= 0)) best = mmsi;
    });
    return best;
  }
  function handleVoiceCommand(raw) {
    var t0 = (raw || '').toLowerCase().trim();
    if (!t0) return;
    cargoHeard(raw);
    var t = normVoice(t0);
    var resolved = 'miss';

    if (/\bstop\b|\bcancel\b/.test(t)) {
      stopReplay(); stopTrack(); resolved = 'stop';
      cargoSay('Stopped. The harbour is yours.', 'stop');
    } else if (aliasHit(t, VOICE_DISPUTE_WORDS).ok) {
      flyTo('dispute');
      setTimeout(function () { $('dispute-card').classList.remove('hidden'); $('info-card').classList.add('hidden'); }, 2500);
      resolved = 'dispute';
      cargoSay('Showing disputed container MSKU 482931 7, held at Durban Container Terminal. Sample data, fictional records.', 'dispute');
    } else if (/replay|walk me|timeline|play the case/.test(t)) {
      startReplay(); resolved = 'replay';
      cargoSay('Replaying case DUR-2026-0412: arrival, berthing, free-time expiry, invoice.', 'replay');
    } else if (aliasHit(t, ['condition', 'conditions', 'weather', 'wave', 'waves', 'wind', 'swell', 'whether']).ok) {
      $('cond-panel').classList.remove('hidden');
      loadConditions(); resolved = 'conditions';
      cargoSay('Here are the current port conditions for Durban.', 'conditions');
    } else if (aliasHit(t, ['camera', 'cameras', 'cctv', 'footage', 'pier', 'webcam', 'footage']).ok) {
      var c = null;
      if (selectedMmsi && vessels.get(selectedMmsi)) {
        var v0 = vessels.get(selectedMmsi);
        c = nearestCamTo(v0.rec.lon, v0.rec.lat);
      } else {
        c = nearestCamTo(DISPUTE.lon, DISPUTE.lat);
      }
      if (c) { openCam(c); flyToPoint(c.lon, c.lat, 6000); }
      resolved = 'camera';
      cargoSay('Opening the nearest live camera. Position approximate.', 'camera');
    } else if (/track|find|where is|locate|follow|show me the vessel|show the vessel/.test(t)) {
      var name = t.replace(/track|find|where is|locate|follow|show me|show|the vessel|the ship|vessel|ship|please/g, ' ').replace(/\s+/g, ' ').trim();
      var hit = name ? findVesselFuzzy(name) : null;
      if (hit) {
        showVessel(hit.mmsi);
        flyToPoint(vessels.get(hit.mmsi).rec.lon, vessels.get(hit.mmsi).rec.lat, 15000);
        resolved = 'track:' + (vessels.get(hit.mmsi).rec.name || hit.mmsi) + ' score ' + hit.score;
        cargoSay('Tracking ' + (vessels.get(hit.mmsi).rec.name || ('MMSI ' + hit.mmsi)) + '.', 'track');
      } else {
        resolved = 'miss:vessel:' + name;
        cargoSay('I could not find that vessel in the current feed. Try its name as shown on the map.', 'missvessel');
      }
    } else if (caseIntent(t)) {
      openCase(); resolved = 'case:' + CASE.id;
      cargoSay('Case DUR-2026-0412. Container MSKU 482931 7, demurrage dispute. Timeline and evidence on screen.', 'dispute');
    } else {
      var placed = false;
      for (var p = 0; p < VOICE_TERMINALS.length; p++) {
        var term = VOICE_TERMINALS[p];
        if (aliasHit(t, term.names).ok) { flyToPoint(term.lon, term.lat, term.alt); resolved = 'terminal:' + term.key; cargoSay(term.reply, term.audio || null); placed = true; break; }
      }
      if (!placed) {
        for (p = 0; p < VOICE_PLACES.length; p++) {
          var pl = VOICE_PLACES[p];
          if (aliasHit(t, pl.names).ok) {
            if (pl.view) flyTo(pl.view); else flyToPoint(pl.lon, pl.lat, pl.alt);
            resolved = 'place:' + pl.key;
            cargoSay(pl.reply, pl.audio || null);
            placed = true; break;
          }
        }
      }
      if (!placed) {
        if (/help|what can you/.test(t)) {
          resolved = 'help';
          cargoSay('Try: show Durban, show the disputed container, track a vessel name, nearest camera, port conditions, replay the case, or stop.', 'help');
        } else {
          cargoSay('I did not catch a command. Tap "What you can say" for examples.', 'miss');
        }
      }
    }
    logVoiceMiss(raw, resolved);
  }
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false, finalHeard = '';
  var voiceBtn = $('voice-btn');
  var inIframe = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  function voiceStatus(msg) { $('voice-status').textContent = msg; }
  function setListening(on) {
    listening = on;
    voiceBtn.classList.toggle('listening', on);
    if (on) voiceStatus('Listening... tap the mic again to stop.');
    else if (!voiceStatusLocked) voiceStatus('Tap the mic to speak. Tap again to stop. Or type below.');
  }
  var voiceStatusLocked = false;
  function voiceError(err) {
    var msg = 'Something stopped the microphone. Typing below always works.';
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      msg = inIframe
        ? 'Microphone is blocked inside the CargoIQ page frame. We are fixing that now - type below meanwhile, or open the map directly at nahalabs.co.za/gods-eye.'
        : 'Microphone permission denied. Allow the mic for this site in your browser settings, then tap the mic again. Typing below works too.';
    } else if (err === 'audio-capture') {
      msg = 'No microphone found on this device. Typing below works.';
    } else if (err === 'network') {
      msg = 'Speech service unreachable (network). Check your connection or type below.';
    } else if (err === 'no-speech') {
      msg = 'I heard nothing. Tap the mic and speak closer to the phone, or type below.';
    } else if (err === 'aborted') {
      return; // user tapped stop - no error
    }
    voiceStatusLocked = true;
    voiceStatus(msg);
    setTimeout(function () { voiceStatusLocked = false; if (!listening) setListening(false); }, 9000);
  }
  if (SR) {
    rec = new SR();
    rec.lang = 'en-ZA';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    rec.onresult = function (e) {
      var interim = '', fin = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) fin += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (interim) { finalHeard = interim; voiceStatus('Hearing: "' + interim + '"'); }
      if (fin) {
        handleVoiceCommand(fin.trim());
        finalHeard = '';
        try { rec.stop(); } catch (err) {}
      }
    };
    rec.onend = function () { setListening(false); };
    rec.onerror = function (e) { setListening(false); voiceError(e.error); };
    voiceBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      $('voice-panel').classList.remove('hidden');
      if (listening) { try { rec.stop(); } catch (err) {} setListening(false); return; }
      voiceStatusLocked = false;
      try { rec.start(); setListening(true); } catch (err) { voiceError('start-failed'); }
    });
  } else {
    voiceBtn.addEventListener('click', function () {
      $('voice-panel').classList.toggle('hidden');
      voiceStatus('This browser cannot do speech recognition (common in older iPhones and embedded views). Type your command below - it works the same.');
    });
  }
  $('voice-close').addEventListener('click', function () { $('voice-panel').classList.add('hidden'); });
  function sendTyped() {
    var v = $('voice-text').value;
    $('voice-text').value = '';
    handleVoiceCommand(v);
  }
  $('voice-send').addEventListener('click', sendTyped);
  $('voice-text').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendTyped(); });


  // ---------- evidence scrubber + pins (items 1+2) ----------
  var SCRUB = { index: null, evidence: null, hist: {}, wx: null, marine: null, entities: [], active: false, t: null };
  function fmtSAST(epochSec) {
    return new Date(epochSec * 1000).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', hour12: false });
  }
  function fmtHour(epochSec) {
    return new Date(epochSec * 1000).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  fetch('data/scrub-index.json').then(function (r) { return r.json(); }).then(function (j) { SCRUB.index = j; }).catch(function () {});
  var evidenceEntities = [];
  fetch('data/evidence.json').then(function (r) { return r.json(); }).then(function (j) {
    SCRUB.evidence = j;
    j.items.forEach(function (item) {
      var ent = viewer.entities.add({
        position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(item.lon, item.lat)),
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString('#ef4444'),
          outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: 'EV', font: 'bold 10px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#fca5a5'),
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 120000),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      ent._evidence = item;
      evidenceEntities.push(ent);
    });
  }).catch(function () {});
  function camFrameFor(item, t) {
    var img = $('ev-img');
    var cid = item.cam || 'vetchs';
    var slot = null;
    if (SCRUB.index && SCRUB.index.cam && SCRUB.index.cam[cid]) {
      var want = Math.floor(t / 3600), bestD = 1e9;
      SCRUB.index.cam[cid].forEach(function (s2) {
        if (Math.abs(s2 - want) < bestD) { bestD = Math.abs(s2 - want); slot = s2; }
      });
    }
    if (slot !== null && bestD <= 6) {
      img.src = 'data/cam/' + cid + '/' + slot + '.jpg';
      $('ev-meta').innerHTML = '<dt>Time</dt><dd>' + fmtSAST(item.ts) + ' SAST</dd><dt>Frame</dt><dd>Archived frame ' + fmtHour(slot * 3600) + ' SAST</dd>';
    } else {
      var cam = CAMERAS.filter(function (c) { return c.id === cid; })[0];
      img.src = (cam ? cam.img : CAMERAS[0].img) + '?t=' + Date.now();
      $('ev-meta').innerHTML = '<dt>Time</dt><dd>' + fmtSAST(item.ts) + ' SAST</dd><dt>Frame</dt><dd>Live frame (no archive at this time yet)</dd>';
    }
    img.classList.remove('hidden');
  }
  function openEvidence(item) {
    $('ev-title').innerHTML = item.title + ' <span class="dispute-badge">DISPUTE ' + (SCRUB.evidence ? SCRUB.evidence.case : '') + '</span>';
    $('ev-desc').textContent = item.desc;
    if (item.type === 'cam') {
      camFrameFor(item, SCRUB.t || Date.now() / 1000);
    } else {
      $('ev-img').classList.add('hidden');
      $('ev-meta').innerHTML = '<dt>Time</dt><dd>' + fmtSAST(item.ts) + ' SAST</dd><dt>Type</dt><dd>' + (item.type === 'doc' ? 'Document' : 'Log note') + '</dd>';
    }
    $('ev-card').classList.remove('hidden');
    flyToPoint(item.lon, item.lat, 6000);
  }
  $('ev-close').addEventListener('click', function () { $('ev-card').classList.add('hidden'); });
  handler.setInputAction(function (movement) {
    var picked = scene.pick(movement.position);
    if (Cesium.defined(picked) && picked.id && picked.id._evidence) {
      showPeek('evidence', picked.id._evidence); peekPinned = true;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  function loadScrubWeather() {
    if (SCRUB.wx) return;
    fetch('https://api.open-meteo.com/v1/forecast?latitude=-29.87&longitude=31.05&hourly=wind_speed_10m,wind_gusts_10m&wind_speed_unit=kn&past_days=7&forecast_days=3&timezone=UTC')
      .then(function (r) { return r.json(); }).then(function (j) { SCRUB.wx = j.hourly || {}; }).catch(function () {});
    fetch('https://marine-api.open-meteo.com/v1/marine?latitude=-29.87&longitude=31.05&hourly=wave_height,swell_wave_height&past_days=7&forecast_days=3&timezone=UTC')
      .then(function (r) { return r.json(); }).then(function (j) { SCRUB.marine = j.hourly || {}; }).catch(function () {});
  }
  function nearestHourly(series, t) {
    if (!series || !series.time) return null;
    var best = null, bd = 1e9;
    for (var i = 0; i < series.time.length; i++) {
      var ts = new Date(series.time[i] + 'Z').getTime() / 1000;
      if (Math.abs(ts - t) < bd) { bd = Math.abs(ts - t); best = i; }
    }
    return best;
  }
  function loadHistoryDay(dayStr) {
    if (SCRUB.hist[dayStr]) return SCRUB.hist[dayStr];
    SCRUB.hist[dayStr] = fetch('data/ais-history/' + dayStr + '.jsonl')
      .then(function (r) { if (!r.ok) throw 0; return r.text(); })
      .then(function (txt) {
        return txt.trim().split('\n').map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      }).catch(function () { return []; });
    return SCRUB.hist[dayStr];
  }
  function utcDay(t) { return new Date(t * 1000).toISOString().slice(0, 10); }
  function clearScrubEntities() {
    SCRUB.entities.forEach(function (e) { viewer.entities.remove(e); });
    SCRUB.entities = [];
  }
  function applyScrub(t) {
    SCRUB.t = t;
    var inWindow = SCRUB.evidence && t >= CASE.events[0].ts && t <= CASE.events[3].ts;
    var winPrefix = inWindow ? 'DISPUTED WINDOW - ' : '';
    var now = Date.now() / 1000;
    var isFuture = t > now + 300;
    var isLive = Math.abs(t - now) < 450;
    var bar = $('scrub-bar');
    if (isLive) {
      SCRUB.active = false;
      bar.classList.remove('scrubbed');
      $('scrub-readout').textContent = 'Live - now';
      clearScrubEntities();
      vessels.forEach(function (v) { v.entity.show = true; });
      evidenceEntities.forEach(function (e) { e.show = true; });
      return;
    }
    SCRUB.active = true;
    bar.classList.add('scrubbed');
    var label = fmtSAST(t) + ' SAST' + (isFuture ? ' - forecast' : ' - positions as of nearest snapshot');
    // weather at t
    var wtxt = '';
    if (SCRUB.wx && SCRUB.wx.time) {
      var wi = nearestHourly(SCRUB.wx, t);
      var mi = SCRUB.marine && SCRUB.marine.time ? nearestHourly(SCRUB.marine, t) : null;
      if (wi !== null) {
        wtxt = ' | wind ' + Math.round(SCRUB.wx.wind_speed_10m[wi]) + 'kn';
        if (mi !== null && SCRUB.marine.wave_height[mi] != null) wtxt += ' | waves ' + SCRUB.marine.wave_height[mi] + 'm';
      }
    }
    $('scrub-readout').textContent = winPrefix + label + wtxt;
    // vessels at t
    if (isFuture) {
      clearScrubEntities();
      vessels.forEach(function (v) { v.entity.show = true; });
    } else {
      Promise.all([loadHistoryDay(utcDay(t)), loadHistoryDay(utcDay(t - 86400))]).then(function (days) {
        var recs = days[0].concat(days[1]);
        var best = null, bd = 1e9;
        recs.forEach(function (r) { if (Math.abs(r.ts - t) < bd) { bd = Math.abs(r.ts - t); best = r; } });
        if (!best) return;
        clearScrubEntities();
        vessels.forEach(function (v) { v.entity.show = false; });
        (best.vessels || []).forEach(function (vv) {
          if (vv.lat == null || vv.lon == null) return;
          SCRUB.entities.push(viewer.entities.add({
            position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(vv.lon, vv.lat)),
            point: {
              pixelSize: 7,
              color: (SCRUB.evidence && t >= CASE.events[0].ts && t <= CASE.events[3].ts) ? Cesium.Color.fromCssColorString('#ef4444') : Cesium.Color.fromCssColorString('#94a3b8'),
              outlineColor: Cesium.Color.fromCssColorString('#38bdf8'), outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label: {
              text: vv.name || '', font: '10px sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#cbd5e1'),
              outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -14),
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60000),
              disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
          }));
        });
        $('scrub-readout').textContent = winPrefix + fmtSAST(t) + ' SAST | positions as of ' + fmtHour(best.ts) + ' SAST' + wtxt;
      });
    }
    $('scrub-readout').classList.toggle('in-window', !!inWindow);
    // evidence pins: highlight within 45min, dim future pins
    evidenceEntities.forEach(function (e) {
      var dt = e._evidence.ts - t;
      if (dt > 2700) { e.point.pixelSize = 6; e.point.color = Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.3); }
      else if (Math.abs(dt) <= 2700) { e.point.pixelSize = 14; e.point.color = Cesium.Color.fromCssColorString('#ef4444'); }
      else { e.point.pixelSize = 10; e.point.color = Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.75); }
    });
  }
  var slider = $('scrub-slider');
  var NOW_MIN = Math.floor(Date.now() / 1000) - 48 * 3600;
  slider.addEventListener('input', function () {
    loadScrubWeather();
    applyScrub(NOW_MIN + parseInt(slider.value, 10) * 900);
  });
  $('scrub-chip').addEventListener('click', function () {
    var bar = $('scrub-bar');
    bar.classList.toggle('hidden');
    if (bar.classList.contains('hidden') || Math.abs((NOW_MIN + parseInt(slider.value, 10) * 900) - Date.now() / 1000) < 450) {
      slider.value = 192;
      applyScrub(Date.now() / 1000);
    } else {
      loadScrubWeather();
      applyScrub(NOW_MIN + parseInt(slider.value, 10) * 900);
    }
    $('scrub-min').textContent = fmtSAST(NOW_MIN);
    $('scrub-max').textContent = fmtSAST(NOW_MIN + 384 * 900);
    var w = $('scrub-window');
    var lo = Math.max(0, (CASE.events[0].ts - NOW_MIN) / 900), hi = Math.min(384, (CASE.events[3].ts - NOW_MIN) / 900);
    w.style.left = (lo / 384 * 100) + '%';
    w.style.width = ((hi - lo) / 384 * 100) + '%';
  });


  // ---------- case dossier + export (items 3+4) ----------
  var CASE = {
    id: 'DUR-2026-0412', container: 'MSKU 482931 7', vessel: 'MV Umhlanga Trader',
    events: [
      { ts: 1792210320, title: 'Arrival - outer anchorage', desc: 'Vessel arrives off Durban. Waiting time starts in the carrier account.' },
      { ts: 1792240800, title: 'Berthing - DGT berth 108', desc: 'Terminal says the berth was ready earlier; carrier disagrees.' },
      { ts: 1792253100, title: 'Free time expires', desc: 'Container free time expires while the clock is disputed.' },
      { ts: 1792307700, title: 'Demurrage invoice issued', desc: 'Invoice raised. Evidence pack BLOCKED: 2 open contradictions.' }
    ]
  };
  function openCase() {
    var tl = $('case-timeline');
    tl.innerHTML = '';
    var items = CASE.events.map(function (e) { return { ts: e.ts, title: e.title, desc: e.desc, kind: 'event' }; });
    if (SCRUB.evidence) {
      SCRUB.evidence.items.forEach(function (i) { items.push({ ts: i.ts, title: i.title, desc: i.desc, kind: 'evidence', ref: i }); });
    }
    items.sort(function (a, b) { return a.ts - b.ts; });
    items.forEach(function (it) {
      var div = document.createElement('div');
      div.className = 'case-event';
      var extra = '';
      if (it.ref && it.ref.provenance) extra += ' <span class="prov prov-' + it.ref.provenance + '">' + it.ref.provenance + '</span>';
      if (it.ref && it.ref.linked) extra += ' <span class="linked-badge">LINKED</span>';
      div.innerHTML = '<div class="t">' + fmtSAST(it.ts) + ' SAST - ' + (it.kind === 'evidence' ? 'EVIDENCE' : 'EVENT') + '</div><div><b>' + it.title + '</b>' + extra + '</div><div class="d">' + it.desc + '</div>';
      if (it.ref) div.addEventListener('click', function () { openEvidence(it.ref); });
      tl.appendChild(div);
    });
    $('case-card').classList.remove('hidden');
  }
  $('case-close').addEventListener('click', function () { $('case-card').classList.add('hidden'); });
  $('case-replay').addEventListener('click', function () { $('case-card').classList.add('hidden'); startReplay(); });
  $('case-share').addEventListener('click', function () {
    var url = 'https://nahalabs.co.za/gods-eye/?case=' + CASE.id + '&replay=1';
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
    cargoSay('Replay link copied: ' + url, null);
  });
  $('case-pdf').addEventListener('click', function () {
    try {
      var doc = new window.jspdf.jsPDF();
      var y = 18;
      doc.setFontSize(16); doc.text('CargoIQ Evidence Pack - Case ' + CASE.id, 14, y); y += 8;
      doc.setFontSize(10);
      doc.text('Container: ' + CASE.container + '   Vessel: ' + CASE.vessel, 14, y); y += 6;
      doc.text('Issue: Demurrage - free-time expiry vs berthing delay (2 open contradictions)', 14, y); y += 6;
      doc.text('Sample data. Fictional records.', 14, y); y += 10;
      doc.setFontSize(12); doc.text('Timeline (SAST)', 14, y); y += 7;
      doc.setFontSize(10);
      CASE.events.forEach(function (e) {
        doc.text(fmtSAST(e.ts) + '  ' + e.title, 14, y); y += 5;
        var lines = doc.splitTextToSize(e.desc, 175);
        doc.text(lines, 20, y); y += lines.length * 5 + 2;
      });
      if (SCRUB.evidence) {
        y += 4; doc.setFontSize(12); doc.text('Evidence on record', 14, y); y += 7; doc.setFontSize(10);
        SCRUB.evidence.items.forEach(function (i) {
          doc.text(fmtSAST(i.ts) + '  [' + i.type + '] ' + i.title, 14, y); y += 6;
        });
      }
      var wi = SCRUB.wx && SCRUB.wx.time ? nearestHourly(SCRUB.wx, CASE.events[1].ts) : null;
      var mi = SCRUB.marine && SCRUB.marine.time ? nearestHourly(SCRUB.marine, CASE.events[1].ts) : null;
      if (wi !== null) {
        y += 4; doc.setFontSize(12); doc.text('Conditions at berthing window (Open-Meteo, CC BY 4.0)', 14, y); y += 7; doc.setFontSize(10);
        doc.text('Wind ' + Math.round(SCRUB.wx.wind_speed_10m[wi]) + ' kn, gusts ' + Math.round(SCRUB.wx.wind_gusts_10m[wi]) + ' kn', 14, y); y += 5;
        if (mi !== null && SCRUB.marine.wave_height[mi] != null) { doc.text('Waves ' + SCRUB.marine.wave_height[mi] + ' m', 14, y); y += 5; }
      }
      y += 6;
      doc.text('Live replay: https://nahalabs.co.za/gods-eye/?case=' + CASE.id + '&replay=1', 14, y);
      doc.save(CASE.id + '-evidence-pack.pdf');
      cargoSay('Evidence pack PDF downloaded for case ' + CASE.id + '.', null);
    } catch (e) {
      cargoSay('PDF export failed in this browser. The replay link still works.', null);
    }
  });
  function caseIntent(t) {
    return /everything about|tell me about|show me the case|the case|evidence pack|dossier|msku|musku|482931|4 8 2 9 3 1/.test(t);
  }

  // ---------- item 5: vessel world-line (standing 3D path across history) ----------
  var worldLine = [];
  function clearWorldLine() {
    worldLine.forEach(function (e) { viewer.entities.remove(e); });
    worldLine = [];
  }
  function showWorldLine(mmsi) {
    clearWorldLine();
    if (!SCRUB.index || !SCRUB.index.ais_days || !SCRUB.index.ais_days.length) {
      cargoSay('No AIS history yet. The archive started today and fills in over time.', null);
      return;
    }
    Promise.all(SCRUB.index.ais_days.map(loadHistoryDay)).then(function (days) {
      var pts = [];
      days.forEach(function (recs) {
        recs.forEach(function (r) {
          (r.vessels || []).forEach(function (vv) {
            if (String(vv.mmsi) === String(mmsi) && vv.lat != null) pts.push({ ts: r.ts, lat: vv.lat, lon: vv.lon });
          });
        });
      });
      pts.sort(function (a, b) { return a.ts - b.ts; });
      if (pts.length < 2) {
        cargoSay('Only ' + pts.length + ' archived position(s) for this vessel so far. The world-line builds as the archive fills.', null);
        return;
      }
      worldLine.push(viewer.entities.add({
        polyline: {
          positions: pts.map(function (p) { return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 40); }),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: Cesium.Color.fromCssColorString('#22d3ee') })
        }
      }));
      pts.forEach(function (p) {
        worldLine.push(viewer.entities.add({
          position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 40)),
          point: { pixelSize: 5, color: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.55), disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: {
            text: fmtHour(p.ts), font: '9px sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#a5f3fc').withAlpha(0.8),
            outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, 12),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        }));
      });
      cargoSay('World-line drawn: ' + pts.length + ' archived positions, time-tagged.', null);
    });
  }
  $('vessel-worldline').addEventListener('click', function () {
    if (!selectedMmsi) return;
    showWorldLine(selectedMmsi);
  });
  $('vessel-worldline-clear').addEventListener('click', clearWorldLine);

  // ---------- item 6: forecast berth-risk layer ----------
  function loadBerthRisk() {
    loadScrubWeather();
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      if ((!SCRUB.wx || !SCRUB.wx.time || !SCRUB.marine || !SCRUB.marine.time) && tries < 30) return;
      clearInterval(poll);
      var el = $('risk-body');
      if (!SCRUB.wx || !SCRUB.wx.time) { el.innerHTML = '<dt>Status</dt><dd>Forecast unavailable</dd>'; return; }
      var now = Date.now() / 1000;
      var html = '';
      for (var b = 0; b < 8; b++) {
        var t0 = now + b * 6 * 3600;
        var worstWind = 0, worstWave = 0;
        for (var h = 0; h < 6; h++) {
          var wi = nearestHourly(SCRUB.wx, t0 + h * 3600);
          var mi = nearestHourly(SCRUB.marine, t0 + h * 3600);
          if (wi !== null) worstWind = Math.max(worstWind, SCRUB.wx.wind_gusts_10m[wi] || 0);
          if (mi !== null && SCRUB.marine.wave_height[mi] != null) worstWave = Math.max(worstWave, SCRUB.marine.wave_height[mi]);
        }
        var risky = worstWind > 25 || worstWave > 2.5;
        var d = new Date(t0 * 1000);
        var lbl = d.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', hour: '2-digit', hour12: false });
        html += '<dt>' + lbl + '</dt><dd style="color:' + (risky ? '#f87171' : '#4ade80') + '">' +
          (risky ? 'RISK' : 'clear') + ' - gusts ' + Math.round(worstWind) + 'kn, waves ' + worstWave.toFixed(1) + 'm</dd>';
      }
      el.innerHTML = html;
      // forecast-vs-actual delta when an older issued forecast exists
      if (SCRUB.index && SCRUB.index.forecast_days && SCRUB.index.forecast_days.length > 1) {
        var older = SCRUB.index.forecast_days[SCRUB.index.forecast_days.length - 2];
        fetch('data/forecast/' + older + '.json').then(function (r) { return r.json(); }).then(function (old) {
          if (!old.wx || !old.wx.time) return;
          var oi = nearestHourly(old.wx, now), ai = nearestHourly(SCRUB.wx, now);
          if (oi === null || ai === null) return;
          var delta = Math.round((SCRUB.wx.wind_speed_10m[ai] || 0) - (old.wx.wind_speed_10m[oi] || 0));
          $('risk-delta').textContent = 'Forecast issued ' + older + ' vs current for now: wind ' + (delta >= 0 ? '+' : '') + delta + ' kn. Forecast-vs-actual builds daily from here.';
        }).catch(function () {});
      } else {
        $('risk-delta').textContent = 'Forecast snapshots are being archived daily; forecast-vs-actual comparison activates from the second day.';
      }
    }, 500);
  }
  $('risk-btn').addEventListener('click', function () {
    $('risk-panel').classList.toggle('hidden');
    if (!$('risk-panel').classList.contains('hidden')) loadBerthRisk();
  });
  $('risk-close').addEventListener('click', function () { $('risk-panel').classList.add('hidden'); });


  // ---------- item 7: incident reconstruction + NTSB first-person replay ----------
  var RECON = { photos: [], entities: [] };
  function reconSave() {
    try {
      var slim = RECON.photos.map(function (p) { return { name: p.name, ts: p.ts, lat: p.lat, lon: p.lon, assumed: p.assumed, img: p.img }; });
      var json = JSON.stringify(slim);
      if (json.length < 2500000) localStorage.setItem('gev-recon', json);
    } catch (e) {}
  }
  function reconRender() {
    var list = $('recon-list');
    list.innerHTML = '';
    RECON.photos.forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'recon-photo';
      row.innerHTML = '<img src="' + p.img + '" alt=""><div class="meta"><div class="t">' + (p.ts ? fmtSAST(p.ts) + ' SAST' : 'no timestamp') + '</div><div>' + (p.assumed ? 'Position assumed - berth' : 'GPS-pinned') + '</div><div>' + p.name + '</div></div>';
      row.addEventListener('click', function () { flyToPoint(p.lon, p.lat, 3500); });
      list.appendChild(row);
    });
  }
  function reconPin(p) {
    var ent = viewer.entities.add({
      position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 30)),
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString('#a78bfa'),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: 'PHOTO', font: 'bold 9px sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#c4b5fd'),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -17),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      polyline: {
        positions: [Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 30), Cesium.Cartesian3.fromDegrees(DISPUTE.lon, DISPUTE.lat, 30)],
        width: 1.5,
        material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString('#a78bfa').withAlpha(0.6) })
      }
    });
    RECON.entities.push(ent);
  }
  function reconAdd(p) {
    RECON.photos.push(p);
    reconPin(p);
    reconRender();
    reconSave();
  }
  $('recon-upload').addEventListener('change', function (ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    if (RECON.photos.length + files.length > 6) { cargoSay('Keep it to 6 photos for now - the sharpest angles.', null); files = files.slice(0, Math.max(0, 6 - RECON.photos.length)); }
    files.forEach(reconIngestFile);
    ev.target.value = '';
  });
  function reconIngestFile(f) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = reader.result;
      var done = function (gps, ts) {
        reconAdd({
          name: f.name, img: img, ts: ts || null,
          lat: gps && gps.latitude ? gps.latitude : DISPUTE.lat,
          lon: gps && gps.longitude ? gps.longitude : DISPUTE.lon,
          assumed: !(gps && gps.latitude)
        });
      };
      if (window.exifr) {
        window.exifr.parse(f, { gps: true, pick: ['DateTimeOriginal'] }).then(function (meta) {
          var gps = meta && meta.latitude != null ? meta : null;
          var ts = meta && meta.DateTimeOriginal ? Math.floor(new Date(meta.DateTimeOriginal).getTime() / 1000) : null;
          done(gps, ts);
        }).catch(function () { done(null, null); });
      } else { done(null, null); }
    };
    reader.readAsDataURL(f);
  }
  $('recon-samples').addEventListener('click', function () {
    ['sample-quayside.jpg', 'sample-gate.jpg', 'sample-yard.jpg'].forEach(function (name) {
      fetch('data/recon/' + name).then(function (r) { return r.blob(); }).then(function (b) {
        reconIngestFile(new File([b], name, { type: 'image/jpeg' }));
      }).catch(function () {});
    });
  });
  $('recon-clear').addEventListener('click', function () {
    RECON.photos = [];
    RECON.entities.forEach(function (e) { viewer.entities.remove(e); });
    RECON.entities = [];
    reconRender(); reconSave();
  });
  $('recon-btn').addEventListener('click', function () { $('recon-panel').classList.toggle('hidden'); });
  $('recon-close').addEventListener('click', function () { $('recon-panel').classList.add('hidden'); });
  try {
    var saved = JSON.parse(localStorage.getItem('gev-recon') || '[]');
    saved.forEach(function (p) { RECON.photos.push(p); reconPin(p); });
    reconRender();
  } catch (e) {}

  // NTSB-style first-person replay: vantage camera + synced narration + telemetry HUD
  var FP = { timer: null, idx: -1, audio: null };
  var FP_STEPS = [
    { ts: 1792210320, step: '1/4 - Arrival, outer anchorage', cap: 'Day one, 06:12. MV Umhlanga Trader holds at the outer anchorage, 11 km off Durban. The dispute clock starts here.',
      eye: { lon: 31.19, lat: -29.80, alt: 400 }, look: { lon: 31.175, lat: -29.795 }, audio: 'ntsb1' },
    { ts: 1792240800, step: '2/4 - Berthing, DGT berth 108', cap: 'Day one, 14:40. The vessel berths. The terminal log says the berth was ready at 12:00. The carrier log disagrees.',
      eye: { lon: 31.050, lat: -29.861, alt: 120 }, look: { lon: 31.0393, lat: -29.8702 }, audio: 'ntsb2' },
    { ts: 1792253100, step: '3/4 - Free-time expiry', cap: 'Day one, 18:05. Free time expires on MSKU 482931 7. Two clocks. Two stories.',
      eye: { lon: 31.0435, lat: -29.8660, alt: 80 }, look: { lon: 31.0395, lat: -29.8698 }, audio: 'ntsb3' },
    { ts: 1792307700, step: '4/4 - Invoice issued', cap: 'Day two, 09:15. The demurrage invoice is issued. Two contradictions remain open. This is where the evidence decides.',
      eye: { lon: 31.0435, lat: -29.8660, alt: 80 }, look: { lon: 31.0395, lat: -29.8698 }, audio: 'ntsb4' }
  ];
  function fpStep() {
    if (FP.idx >= FP_STEPS.length) { fpStop(); return; }
    var st = FP_STEPS[FP.idx];
    var heading = Cesium.Math.toRadians(Cesium.Math.toDegrees(Math.atan2(st.look.lon - st.eye.lon, st.look.lat - st.eye.lat)));
    viewer.trackedEntity = undefined;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(st.eye.lon, st.eye.lat, st.eye.alt),
      orientation: { heading: heading, pitch: Cesium.Math.toRadians(-12), roll: 0 }
    });
    var tele = '';
    if (SCRUB.wx && SCRUB.wx.time) {
      var wi = nearestHourly(SCRUB.wx, st.ts);
      var mi = SCRUB.marine && SCRUB.marine.time ? nearestHourly(SCRUB.marine, st.ts) : null;
      if (wi !== null) {
        tele = 'wind ' + Math.round(SCRUB.wx.wind_speed_10m[wi]) + ' kn gusting ' + Math.round(SCRUB.wx.wind_gusts_10m[wi]) + ' kn';
        if (mi !== null && SCRUB.marine.wave_height[mi] != null) tele += ' | waves ' + SCRUB.marine.wave_height[mi] + ' m';
        tele += ' (Open-Meteo archive)';
      }
    }
    $('fp-step').textContent = st.step + ' - ' + fmtSAST(st.ts) + ' SAST';
    $('fp-tele').textContent = tele;
    $('fp-cap').textContent = st.cap;
    $('fp-hud').classList.remove('hidden');
    if (FP.audio) { try { FP.audio.pause(); } catch (e) {} }
    FP.audio = new Audio('assets/voice/' + st.audio + '.mp3');
    FP.audio.play().catch(function () {});
    FP.idx++;
    FP.timer = setTimeout(fpStep, 9500);
  }
  function fpStart() {
    fpStop();
    loadScrubWeather();
    FP.idx = 0;
    setTimeout(fpStep, 400);
  }
  function fpStop() {
    if (FP.timer) { clearTimeout(FP.timer); FP.timer = null; }
    if (FP.audio) { try { FP.audio.pause(); } catch (e) {} FP.audio = null; }
    FP.idx = -1;
    $('fp-hud').classList.add('hidden');
  }
  $('recon-fp').addEventListener('click', function () { $('recon-panel').classList.add('hidden'); fpStart(); });
  $('fp-stop').addEventListener('click', fpStop);


  // ---------- instant preview cards (tap/hover any map item) ----------
  var peekCurrent = null, peekPinned = false;
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  function compassOf(deg) {
    if (typeof deg !== 'number') return '-';
    var dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return dirs[Math.round(deg / 45) % 8];
  }
  function hidePeek() { peekCurrent = null; peekPinned = false; $('peek-card').classList.add('hidden'); }
  function showPeek(kind, ref) {
    peekCurrent = { kind: kind, ref: ref };
    var badge = '', title = '', rows = '', source = '', moreLabel = 'Full details';
    if (kind === 'vessel') {
      var v = vessels.get(ref);
      if (!v) return;
      var r = v.rec;
      var isCaseShip = (r.name || '') === 'MV Umhlanga Trader';
      badge = isCaseShip ? ' <span class="dispute-badge">DISPUTED</span>' : '';
      title = esc(r.name || ('Ship ' + ref)) + badge;
      rows =
        '<dt>Ship ID</dt><dd>MMSI ' + esc(ref) + '</dd>' +
        '<dt>Speed</dt><dd>' + (typeof r.sog === 'number' ? r.sog.toFixed(1) + ' knots' : 'Not moving / unknown') + '</dd>' +
        '<dt>Heading</dt><dd>' + (typeof r.cog === 'number' ? compassOf(r.cog) + ' (' + Math.round(r.cog) + '\u00B0)' : '-') + '</dd>' +
        '<dt>Position</dt><dd>' + (typeof r.lat === 'number' ? Math.abs(r.lat).toFixed(3) + '\u00B0 S, ' + Math.abs(r.lon).toFixed(3) + '\u00B0 E' : '-') + '</dd>' +
        '<dt>Position age</dt><dd>' + (v.fromSnapshot ? 'From the last saved picture of the harbour' : 'Live right now') + '</dd>' +
        (isCaseShip ? '<dt>Dispute</dt><dd>This ship is part of dispute DUR-2026-0412</dd>' : '');
      source = 'Live AIS position';
    } else if (kind === 'cam') {
      title = esc(ref.name);
      var cover = ref.id === 'vetchs' ? 'Covers the harbour mouth and the Vetch\'s Pier side' : 'Covers the beachfront and the northern approach';
      rows =
        '<dt>Where</dt><dd>' + esc(ref.name.split(' - ')[1] || 'Durban') + '</dd>' +
        '<dt>Coverage</dt><dd>' + cover + '</dd>' +
        '<dt>Refresh</dt><dd>Grabs a fresh photo about every 10 seconds while open</dd>';
      source = esc(ref.source);
      moreLabel = 'Open live view';
    } else if (kind === 'evidence') {
      var inWin = SCRUB.evidence && ref.ts >= CASE.events[0].ts && ref.ts <= CASE.events[3].ts;
      badge = ' <span class="dispute-badge">DISPUTED</span>';
      title = esc(ref.title) + badge;
      var kindLabel = ref.type === 'cam' ? 'Camera photo' : ref.type === 'doc' ? 'Document' : 'Log note';
      rows =
        '<dt>What</dt><dd>' + kindLabel + '</dd>' +
        '<dt>Time</dt><dd>' + fmtSAST(ref.ts) + ' SAST</dd>' +
        '<dt>Dispute</dt><dd>Evidence in case ' + esc(SCRUB.evidence ? SCRUB.evidence.case : 'DUR-2026-0412') + (inWin ? ' - inside the disputed window' : '') + '</dd>';
      source = 'Sample data. Fictional records.';
      moreLabel = 'Open evidence';
    } else if (kind === 'dispute') {
      badge = ' <span class="dispute-badge">DISPUTED</span>';
      title = 'Disputed container' + badge;
      rows =
        '<dt>Case</dt><dd>DUR-2026-0412</dd>' +
        '<dt>Container</dt><dd>MSKU 482931 7</dd>' +
        '<dt>Issue</dt><dd>Demurrage: free-time expiry vs berthing delay</dd>' +
        '<dt>Status</dt><dd>2 open contradictions on the evidence timeline</dd>';
      source = 'Sample data. Fictional records.';
      moreLabel = 'Open case card';
    }
    $('peek-title').innerHTML = title;
    $('peek-body').innerHTML = rows;
    $('peek-source').textContent = source;
    $('peek-more').textContent = moreLabel;
    $('peek-card').classList.remove('hidden');
  }
  $('peek-close').addEventListener('click', hidePeek);
  $('peek-more').addEventListener('click', function () {
    if (!peekCurrent) return;
    var k = peekCurrent.kind, r = peekCurrent.ref;
    hidePeek();
    if (k === 'vessel') showVessel(r);
    else if (k === 'cam') openCam(r);
    else if (k === 'evidence') openEvidence(r);
    else if (k === 'dispute') { $('info-card').classList.add('hidden'); $('dispute-card').classList.remove('hidden'); }
  });
  // Hover previews on desktop pointers
  if (!isMobile && !LITE && window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
    var lastHover = 0;
    handler.setInputAction(function (movement) {
      if (peekPinned) return;
      var now = Date.now();
      if (now - lastHover < 150) return;
      lastHover = now;
      var picked = scene.pick(movement.endPosition);
      if (Cesium.defined(picked) && picked.id) {
        if (picked.id === disputeEntity) { showPeek('dispute', null); return; }
        if (picked.id._evidence) { showPeek('evidence', picked.id._evidence); return; }
        var cam = null;
        CAMERAS.forEach(function (c) { if (c._entity === picked.id) cam = c; });
        if (cam) { showPeek('cam', cam); return; }
        var m = null;
        vessels.forEach(function (v, mmsi) { if (v.entity === picked.id) m = mmsi; });
        if (m) { showPeek('vessel', m); return; }
      }
      hidePeek();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  // ---------- deep links ----------
  var qs = new URLSearchParams(location.search);
  var wantVessel = qs.get('vessel');
  if (wantVessel) {
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      if (vessels.has(wantVessel)) {
        clearInterval(poll);
        showVessel(wantVessel);
        flyToPoint(vessels.get(wantVessel).rec.lon, vessels.get(wantVessel).rec.lat, 15000);
      } else if (tries > 40) { clearInterval(poll); }
    }, 2000);
  }
  var wantCam = qs.get('cam');
  if (wantCam) {
    CAMERAS.forEach(function (c) { if (c.id === wantCam) { openCam(c); flyToPoint(c.lon, c.lat, 8000); } });
  }
  if (qs.get('replay') === '1') { setTimeout(startReplay, 2500); }
  if (qs.get('cond') === '1') { $('cond-panel').classList.remove('hidden'); loadConditions(); }
  if (qs.get('scrub') === '1') { $('scrub-chip').click(); }
  if (qs.get('case')) { setTimeout(openCase, 2200); }
  if (qs.get('risk') === '1') { $('risk-btn').click(); }
  if (qs.get('recon') === '1') { $('recon-btn').click(); }
  if (qs.get('fp') === '1') { setTimeout(fpStart, 2500); }
  if (qs.get('mic') === 'start') { setTimeout(function () { $('voice-btn').click(); }, 2500); }
  if (qs.get('peek')) {
    var want = qs.get('peek'), tries0 = 0;
    var peekPoll = setInterval(function () {
      tries0++;
      if (want === 'vessel' && vessels.size) { clearInterval(peekPoll); showPeek('vessel', vessels.keys().next().value); peekPinned = true; }
      else if (want === 'cam') { clearInterval(peekPoll); showPeek('cam', CAMERAS[0]); peekPinned = true; }
      else if (want === 'dispute') { clearInterval(peekPoll); showPeek('dispute', null); peekPinned = true; }
      else if (tries0 > 20) clearInterval(peekPoll);
    }, 500);
  }
  if (qs.get('micerror')) { setTimeout(function () { $('voice-panel').classList.remove('hidden'); voiceError(qs.get('micerror')); }, 2500); }
  if (qs.get('t')) {
    setTimeout(function () {
      var t = parseInt(qs.get('t'), 10);
      if (!t) return;
      if ($('scrub-bar').classList.contains('hidden')) $('scrub-chip').click();
      var v = Math.round((t - NOW_MIN) / 900);
      slider.value = Math.max(0, Math.min(384, v));
      loadScrubWeather();
      applyScrub(NOW_MIN + parseInt(slider.value, 10) * 900);
    }, 2500);
  }
  if (qs.get('samples') === '1') { setTimeout(function () { $('recon-btn').click(); $('recon-samples').click(); }, 2500); }
  if (qs.get('say')) { setTimeout(function () { handleVoiceCommand(qs.get('say')); }, 3000); }

  // ---------- start ----------
  setStatus('warm', 'CONNECTING');
  var deepLink = new URLSearchParams(location.search).get('fly');
  flyTo(VIEW[deepLink] ? deepLink : 'durban');
  if (LITE) { loadSnapshot(); setStatus('warm', 'SAMPLE MODE'); }
  else {
    connectLive();
    setTimeout(function () { if (!liveConnected) loadSnapshot(); }, 8000);
  }
})();
