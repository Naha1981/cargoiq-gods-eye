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

  var viewer;
  try {
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
    $('fatal').classList.remove('hidden');
    return;
  }

  // Keyless terrain (progressive enhancement; flat ellipsoid if it fails)
  Cesium.CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid', {
    requestVertexNormals: false,
    credit: 'Re:Earth Terrain'
  }).then(function (tp) {
    if (!viewer.isDestroyed()) viewer.terrainProvider = tp;
  }).catch(function () { /* ellipsoid fallback */ });

  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = !isMobile;
  if (isMobile) {
    viewer.resolutionScale = 0.8;
    setTimeout(function () {
      $('desktop-note').classList.remove('hidden');
      setTimeout(function () { $('desktop-note').classList.add('hidden'); }, 9000);
    }, 2500);
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
      $('dispute-card').classList.remove('hidden');
      $('info-card').classList.add('hidden');
      return;
    }
    if (Cesium.defined(picked) && picked.id) {
      var found = null;
      vessels.forEach(function (v, mmsi) { if (v.entity === picked.id) found = mmsi; });
      if (found) { showVessel(found); return; }
    }
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
      if (cam) { openCam(cam); return; }
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
    { key: 'capetown', names: ['cape town', 'capetown', 'kaapstad'], lon: 18.43, lat: -33.91, alt: 55000, reply: 'Cape Town is outside the current evidence coverage. Durban and Richards Bay are instrumented.' },
    { key: 'gqeberha', names: ['gqeberha', 'port elizabeth', 'qeberha', 'gheberha', 'geberha'], lon: 25.63, lat: -33.97, alt: 55000, reply: 'Gqeberha, Port Elizabeth, is outside the current evidence coverage.' },
    { key: 'coega', names: ['coega', 'ngqura', 'kuga', 'incura'], lon: 25.69, lat: -33.79, alt: 40000, reply: 'Coega, Ngqura, is outside the current evidence coverage.' },
    { key: 'eastlondon', names: ['east london', 'buffalo city'], lon: 27.91, lat: -33.02, alt: 40000, reply: 'East London is outside the current evidence coverage.' },
    { key: 'saldanha', names: ['saldanha', 'saldana'], lon: 17.95, lat: -33.02, alt: 40000, reply: 'Saldanha is outside the current evidence coverage.' },
    { key: 'mosselbay', names: ['mossel bay', 'mosel bay'], lon: 22.13, lat: -34.18, alt: 40000, reply: 'Mossel Bay is outside the current evidence coverage.' }
  ];
  var VOICE_TERMINALS = [
    { key: 'dgt', names: ['dgt', 'berth 108', 'berth one zero eight', 'durban general', 'container terminal', 'dct'], lon: 31.0395, lat: -29.8698, alt: 8000, reply: 'Flying to the Durban container terminal area, where the disputed container is held.' },
    { key: 'bayhead', names: ['bayhead', 'bay head'], lon: 31.031, lat: -29.871, alt: 10000, reply: 'Flying to Bayhead.' },
    { key: 'point', names: ['the point', 'point terminal', 'point waterfront'], lon: 31.041, lat: -29.856, alt: 10000, reply: 'Flying to the Point area.' },
    { key: 'maydon', names: ['maydon wharf', 'madonna wharf', 'maiden wharf'], lon: 31.018, lat: -29.885, alt: 10000, reply: 'Flying to Maydon Wharf.' },
    { key: 'islandview', names: ['island view', 'islandview'], lon: 31.005, lat: -29.878, alt: 10000, reply: 'Flying to Island View.' }
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
        cargoSay('I could not find that vessel in the current feed. Try its name as shown on the map.', null);
      }
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
          cargoSay('Try: show Durban, show the disputed container, track a vessel name, nearest camera, port conditions, replay the case, or stop.', null);
        } else {
          cargoSay('I did not catch a command. Tap "What you can say" for examples.', null);
        }
      }
    }
    logVoiceMiss(raw, resolved);
  }
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false;
  var voiceBtn = $('voice-btn');
  function setListening(on) {
    listening = on;
    voiceBtn.classList.toggle('listening', on);
    $('voice-status').textContent = on ? 'Listening... speak now.' : 'Hold the mic and speak, or type below.';
  }
  if (SR) {
    rec = new SR();
    rec.lang = 'en-ZA';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = function (e) {
      var text = e.results[0][0].transcript;
      handleVoiceCommand(text);
    };
    rec.onend = function () { setListening(false); };
    rec.onerror = function () { setListening(false); };
    var startRec = function (ev) {
      ev.preventDefault();
      if (listening) { rec.stop(); return; }
      try { rec.start(); setListening(true); $('voice-panel').classList.remove('hidden'); } catch (err) {}
    };
    voiceBtn.addEventListener('click', startRec);
  } else {
    voiceBtn.addEventListener('click', function () {
      $('voice-panel').classList.toggle('hidden');
      $('voice-status').textContent = 'This browser has no speech recognition - type your command below.';
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
  if (qs.get('say')) { setTimeout(function () { handleVoiceCommand(qs.get('say')); }, 3000); }

  // ---------- start ----------
  setStatus('warm', 'CONNECTING');
  var deepLink = new URLSearchParams(location.search).get('fly');
  flyTo(VIEW[deepLink] ? deepLink : 'durban');
  connectLive();
  setTimeout(function () { if (!liveConnected) loadSnapshot(); }, 8000);
})();
