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
      sceneMode: isMobile ? Cesium.SceneMode.SCENE2D : Cesium.SceneMode.SCENE3D,
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
    drawHeading(null);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  function showVessel(mmsi) {
    var v = vessels.get(mmsi);
    if (!v) return;
    selectedMmsi = mmsi;
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
    var is2D = scene.mode === Cesium.SceneMode.SCENE2D;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.alt),
      orientation: {
        heading: 0,
        pitch: is2D ? Cesium.Math.toRadians(-90) : Cesium.Math.toRadians(-58),
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

  // ---------- start ----------
  setStatus('warm', 'CONNECTING');
  flyTo('durban');
  connectLive();
  setTimeout(function () { if (!liveConnected) loadSnapshot(); }, 8000);
})();
