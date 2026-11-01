// master_radar.js - G86 Backend Master 3D WiFiGrametrie Spatial Synthesizer
// Agregare Multi-Nod: Moto G86 Master • Router AP • Samsung S25 Ultra • Dispozitive Wi-Fi • Point Cloud Cumulativ & Planuri Reconstruite

window.MasterRadarEngine = (function() {
    'use strict';

    // State
    let isInitialized = false;
    let scene, camera, renderer;
    let canvasWrapperEl;
    let animFrameId = null;

    // 3D Master Scene Objects
    let beaconGroup;
    let globalGrid, rangeRingsGroup;

    // RuView RF Person Tracking (Puncte Simple + Etichetă)
    let ruviewPersonsGroup;
    let ruviewPersons = new Map(); // id -> { group, dotMesh, label, targetPos, name }
    let ruviewWs = null;

    // Reconstructed Master Room Planes (WiFiGrametrie)
    let masterPlanesGroup;
    let masterNorthWall, masterSouthWall, masterWestWall, masterEastWall;
    let masterBounds = { minX: -6.0, maxX: 6.0, minZ: -9.0, maxZ: 6.0 };

    // Master Detected 3D Obstacle Volumes
    let masterObstaclesGroup;
    let masterObstacles = new Map(); // key -> { mesh, label, data }

    // Active Remote Nodes Map: peerId -> NodeObj
    let remoteNodes = new Map();

    // Wi-Fi Discovered Landmarks Map: ip -> LandmarkObj
    let wifiLandmarks = new Map();
    let wifiLandmarksGroup;

    // Node Color Palette for Multi-User distinction
    const PALETTE = [
        0x06b6d4, // Cyan (e.g. Samsung S25 Ultra)
        0xf59e0b, // Chihlimbar / Amber
        0xf43f5e, // Trandafiriu / Rose
        0x10b981, // Smarald / Emerald
        0x3b82f6, // Albastru Regal / Royal Blue
        0xa855f7  // Violet
    ];

    // Master Unified Cumulative Point Cloud
    const MAX_GLOBAL_POINTS = 60000;
    let masterPointGeometry, masterPointMaterial, masterPointMesh;
    let masterPositions = new Float32Array(MAX_GLOBAL_POINTS * 3);
    let masterColors = new Float32Array(MAX_GLOBAL_POINTS * 3);
    let masterPointCount = 0;

    // Camera Orbit State
    let isPointerDown = false;
    let pointerStartX = 0, pointerStartY = 0;
    let cameraTheta = Math.PI / 4;
    let cameraPhi = Math.PI / 3.4;
    let cameraRadius = 38;
    let cameraTarget = new THREE.Vector3(0, 0, 0);
    let initialPinchDist = 0;

    // Real-time SSE & Polling
    let sseConnection = null;
    let pollIntervalId = null;
    let landmarksIntervalId = null;
    let knownTelemetryIds = new Set();

    // =========================================================================
    // 1. Initializare Three.js Master Viewport
    // =========================================================================
    function init() {
        canvasWrapperEl = document.getElementById('masterRadarCanvasContainer');
        if (!canvasWrapperEl || typeof THREE === 'undefined') return;

        if (isInitialized) return;
        isInitialized = true;

        const width = canvasWrapperEl.clientWidth || 360;
        const height = canvasWrapperEl.clientHeight || 360;

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x060911);
        scene.fog = new THREE.FogExp2(0x060911, 0.012);

        camera = new THREE.PerspectiveCamera(48, width / height, 0.5, 350);
        updateCameraPosition();

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        canvasWrapperEl.appendChild(renderer.domElement);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        scene.add(ambientLight);

        const purpleBeaconLight = new THREE.PointLight(0xa855f7, 2.5, 60);
        purpleBeaconLight.position.set(0, 10, 0);
        scene.add(purpleBeaconLight);

        wifiLandmarksGroup = new THREE.Group();
        scene.add(wifiLandmarksGroup);

        masterPlanesGroup = new THREE.Group();
        scene.add(masterPlanesGroup);

        masterObstaclesGroup = new THREE.Group();
        scene.add(masterObstaclesGroup);

        ruviewPersonsGroup = new THREE.Group();
        scene.add(ruviewPersonsGroup);

        buildMasterEnvironment();
        buildMasterRoomPlanes();
        buildMotoG86CentralBeacon();
        initMasterPointCloud();

        setupInteractionHandlers();
        setupSensorListeners();
        initTelemetryStream();
        initWifiLandmarksStream();
        initRuViewStream();

        animate();
        console.log('[Master WiFiGrametrie] Engine 3D pornit pe nodul central Moto G86.');
    }

    // =========================================================================
    // 2. Mediu 3D Global & Inele Polare
    // =========================================================================
    function buildMasterEnvironment() {
        globalGrid = new THREE.GridHelper(120, 60, 0x10b981, 0x1e293b);
        globalGrid.position.y = -0.05;
        scene.add(globalGrid);

        rangeRingsGroup = new THREE.Group();
        const rings = [5, 10, 20, 35, 50];
        rings.forEach(r => {
            const geo = new THREE.RingGeometry(r - 0.08, r + 0.08, 64);
            const mat = new THREE.MeshBasicMaterial({
                color: 0x8b5cf6,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.2
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.rotation.x = -Math.PI / 2;
            rangeRingsGroup.add(mesh);
        });
        scene.add(rangeRingsGroup);

        createCardinalMarker('N (0°)', 0, 0, -28, 0x10b981);
        createCardinalMarker('S (180°)', 0, 0, 28, 0x64748b);
        createCardinalMarker('E (90°)', 28, 0, 0, 0x06b6d4);
        createCardinalMarker('V (270°)', -28, 0, 0, 0x64748b);
    }

    // Helper: Punct Simplu 3D (GL_POINTS - fără sfere, fără volum 3D)
    let pointCircleTexture = null;
    function getPointTexture() {
        if (pointCircleTexture) return pointCircleTexture;
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.arc(16, 16, 12, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        pointCircleTexture = new THREE.CanvasTexture(canvas);
        return pointCircleTexture;
    }

    function createPointMarker(colorHex, sizePixels = 12) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        const mat = new THREE.PointsMaterial({
            color: colorHex,
            size: sizePixels,
            sizeAttenuation: false, // Punct grafic curat, vizibil exact ca pe radar
            map: getPointTexture(),
            transparent: true,
            alphaTest: 0.1
        });
        return new THREE.Points(geo, mat);
    }

    // Master Local Compass & Sensor Orientation
    let localHeading = 0;
    let targetHeading = 0;
    let hasReceivedCompass = false;
    let compassSmoothingAlpha = 0.22;
    let compassFollowMode = true; // Auto-align camera view with phone compass heading

    let masterPosX = 0;
    let masterPosZ = 0;
    let masterSteps = 0;
    let masterDistance = 0;
    const activeMasterLabelSprites = new Set();
    const tempLabelVec = new THREE.Vector3();

    window.onNativeStep = function(stride) {
        stride = stride || 0.72;
        masterSteps++;
        masterDistance += stride;
        const headingRad = (localHeading * Math.PI) / 180;
        masterPosX += stride * Math.sin(headingRad);
        masterPosZ -= stride * Math.cos(headingRad);
        if (beaconGroup) {
            beaconGroup.position.set(masterPosX, 0, masterPosZ);
        }
    };

    window.onNativeOrientation = function(heading, pitch, roll) {
        handleOrientation({ webkitCompassHeading: heading, beta: pitch, gamma: roll }, true);
    };

    function handleOrientation(e, isAbsolute) {
        let heading = null;
        if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
            heading = Number(e.webkitCompassHeading);
        } else if (e.alpha !== null && !isNaN(e.alpha)) {
            heading = (360 - Number(e.alpha)) % 360;
        }
        if (heading !== null && !isNaN(heading)) {
            targetHeading = (heading + 360) % 360;
            if (!hasReceivedCompass) {
                localHeading = targetHeading;
                hasReceivedCompass = true;
            }
        }
    }

    function setupSensorListeners() {
        if ('ondeviceorientationabsolute' in window) {
            window.addEventListener('deviceorientationabsolute', (e) => handleOrientation(e, true), true);
        }
        if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientation', (e) => handleOrientation(e, false), true);
        }
    }

    function createCardinalMarker(text, x, y, z, colorHex) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#060911';
        ctx.fillRect(0, 0, 128, 64);
        ctx.font = 'bold 22px "JetBrains Mono", monospace';
        ctx.fillStyle = '#' + new THREE.Color(colorHex).getHexString();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 64, 32);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.8 });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.position.set(x, 1.2, z);
        sprite.scale.set(4, 2, 1);
        sprite.userData = { baseScaleX: 4, baseScaleY: 2 };
        activeMasterLabelSprites.add(sprite);
        scene.add(sprite);
    }

    // =========================================================================
    // 3. Spatiu Reconstructie Master (Fara Pereti Mock-up)
    // =========================================================================
    function buildMasterRoomPlanes() {
        // Fara pereti mock-up artificiali
    }

    function expandMasterBoundsIfNeeded(x, z) {
        // Fara reconstructie de pereti falsi
    }

    // =========================================================================
    // 4. Central Beacon 3D (Moto G86 Node Master - Punct Simplu cu Etichetă)
    // =========================================================================
    function buildMotoG86CentralBeacon() {
        beaconGroup = new THREE.Group();

        // Punct simplu 3D (GL_POINTS - fără sfere, fără conuri, fără unde)
        const dotMesh = createPointMarker(0x8b5cf6, 16);
        dotMesh.position.y = 0.45;
        beaconGroup.add(dotMesh);

        // Indicator plat de orientare direcție (săgeată plană - fără con 3D)
        const arrowShape = new THREE.Shape();
        arrowShape.moveTo(0, -2.0);
        arrowShape.lineTo(0.42, -1.2);
        arrowShape.lineTo(0.16, -1.2);
        arrowShape.lineTo(0.16, -0.3);
        arrowShape.lineTo(-0.16, -0.3);
        arrowShape.lineTo(-0.16, -1.2);
        arrowShape.lineTo(-0.42, -1.2);
        arrowShape.closePath();
        const arrowGeo = new THREE.ShapeGeometry(arrowShape);
        const arrowMat = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, side: THREE.DoubleSide });
        const arrowMesh = new THREE.Mesh(arrowGeo, arrowMat);
        arrowMesh.rotation.x = Math.PI / 2;
        arrowMesh.position.set(0, 0.45, 0);
        beaconGroup.add(arrowMesh);

        // Floating Master Label Tag
        const tag = createLabelSprite('🌐 MOTO G86 (NODE MASTER)\n📍 Nod Central & Sinteză', 0x8b5cf6, 5.2, 1.4);
        tag.position.set(0, 1.8, 0);
        beaconGroup.add(tag);

        scene.add(beaconGroup);
    }

    function createLabelSprite(text, colorHex, baseW = 4.4, baseH = 1.2) {
        const canvas = document.createElement('canvas');
        canvas.width = 280;
        canvas.height = 76;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(6, 9, 17, 0.9)';
        ctx.fillRect(4, 4, 272, 68);
        ctx.strokeStyle = '#' + new THREE.Color(colorHex).getHexString();
        ctx.lineWidth = 3;
        ctx.strokeRect(4, 4, 272, 68);

        const lines = text.split('\n');
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (lines.length > 1) {
            ctx.font = 'bold 16px "Outfit", sans-serif';
            ctx.fillText(lines[0], 140, 26);
            ctx.font = '13px "JetBrains Mono", monospace';
            ctx.fillStyle = '#06b6d4';
            ctx.fillText(lines[1], 140, 50);
        } else {
            ctx.font = 'bold 16px "Outfit", sans-serif';
            ctx.fillText(text, 140, 38);
        }

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.scale.set(baseW, baseH, 1);
        sprite.userData = { canvas, ctx, texture, colorHex, baseScaleX: baseW, baseScaleY: baseH };
        activeMasterLabelSprites.add(sprite);
        return sprite;
    }

    // Scalare dinamică automată: Etichetele își păstrează fix aceeași dimensiune în pixeli la orice zoom
    function updateMasterLabelsScale() {
        if (!camera) return;
        const refDist = 28.0;
        const camPos = camera.position;

        activeMasterLabelSprites.forEach(sprite => {
            if (!sprite.parent) {
                activeMasterLabelSprites.delete(sprite);
                return;
            }
            sprite.getWorldPosition(tempLabelVec);
            const dist = camPos.distanceTo(tempLabelVec);
            const factor = Math.max(0.12, Math.min(3.5, dist / refDist));
            const baseW = (sprite.userData && sprite.userData.baseScaleX) || 4.4;
            const baseH = (sprite.userData && sprite.userData.baseScaleY) || 1.2;
            sprite.scale.set(baseW * factor, baseH * factor, 1);
        });
    }

    // =========================================================================
    // 5. Wi-Fi Landmarks Stream (Router AP & Dispozitive Rețea)
    // =========================================================================
    function initWifiLandmarksStream() {
        const fetchLandmarks = async () => {
            try {
                const res = await fetch('/wifi_landmarks.json?_t=' + Date.now(), { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    processWifiLandmarks(data);
                }
            } catch (err) {}
        };

        fetchLandmarks();
        landmarksIntervalId = setInterval(fetchLandmarks, 2500);
    }

    function processWifiLandmarks(data) {
        if (!data) return;

        const allItems = [];
        if (data.gateway) allItems.push(data.gateway);
        if (data.devices && Array.isArray(data.devices)) {
            data.devices.forEach(d => {
                if (d.type !== 'master') allItems.push(d);
            });
        }

        allItems.forEach(item => {
            const ip = item.ip;
            let landmark = wifiLandmarks.get(ip);
            if (!landmark) {
                landmark = createMasterLandmark3D(item);
                wifiLandmarks.set(ip, landmark);
                wifiLandmarksGroup.add(landmark.group);
            }
            landmark.group.position.set(item.x || 0, item.y || 0, item.z || 0);
            expandMasterBoundsIfNeeded(item.x || 0, item.z || 0);
        });

        updateMasterHud();
    }

    function createMasterLandmark3D(item) {
        const group = new THREE.Group();
        const isRouter = (item.type === 'router');
        const isPerson = (item.type === 'person' || item.type === 'ruview');
        const colorHex = isPerson ? 0xf59e0b : (isRouter ? 0x10b981 : 0x06b6d4);

        // Punct simplu 3D (GL_POINTS - fără sfere, fără turnuri, fără unde)
        const dotMesh = createPointMarker(colorHex, isPerson ? 14 : 10);
        dotMesh.position.y = isPerson ? 0.6 : 0.35;
        group.add(dotMesh);

        const icon = isPerson ? '👤 ' : (isRouter ? '📡 ' : '💻 ');
        const tag = createLabelSprite(icon + item.name + (item.signal ? ('\n' + item.ip + ' • ' + item.signal + ' dBm') : ''), colorHex);
        tag.position.set(0, dotMesh.position.y + 0.9, 0);
        group.add(tag);

        return { group, item, dotMesh, tag, colorHex };
    }

    // =========================================================================
    // 6. Master Unified Cumulative Point Cloud
    // =========================================================================
    function initMasterPointCloud() {
        masterPointGeometry = new THREE.BufferGeometry();
        masterPointGeometry.setAttribute('position', new THREE.BufferAttribute(masterPositions, 3));
        masterPointGeometry.setAttribute('color', new THREE.BufferAttribute(masterColors, 3));

        masterPointMaterial = new THREE.PointsMaterial({
            size: 0.5,
            vertexColors: true,
            transparent: true,
            opacity: 0.85,
            sizeAttenuation: true
        });

        masterPointMesh = new THREE.Points(masterPointGeometry, masterPointMaterial);
        scene.add(masterPointMesh);
    }

    function ingestRemotePoints(points, nodeColor) {
        if (!points || !Array.isArray(points) || points.length === 0) return;

        const clr = new THREE.Color(nodeColor);

        points.forEach(p => {
            if (masterPointCount >= MAX_GLOBAL_POINTS) {
                masterPointCount = Math.floor(MAX_GLOBAL_POINTS * 0.75);
            }

            const idx = masterPointCount * 3;
            masterPositions[idx] = p.x;
            masterPositions[idx + 1] = p.y;
            masterPositions[idx + 2] = p.z;

            masterColors[idx] = clr.r;
            masterColors[idx + 1] = clr.g;
            masterColors[idx + 2] = clr.b;

            masterPointCount++;
            expandMasterBoundsIfNeeded(p.x, p.z);
        });

        masterPointGeometry.attributes.position.needsUpdate = true;
        masterPointGeometry.attributes.color.needsUpdate = true;
        masterPointGeometry.setDrawRange(0, masterPointCount);

        updateMasterHud();
    }

    function ingestRemoteObstacles(obstacles) {
        if (!obstacles || !Array.isArray(obstacles)) return;

        obstacles.forEach(obs => {
            const key = obs.x.toFixed(1) + '_' + obs.z.toFixed(1);
            if (masterObstacles.has(key)) return;

            // Punct simplu cu etichetă (GL_POINTS - fără sfere, fără cutii 3D masive)
            const dotMesh = createPointMarker(0xf59e0b, 10);
            dotMesh.position.set(obs.x, 0.35, obs.z);

            const label = createLabelSprite('📦 Obstacol RF', 0xf59e0b);
            label.position.set(obs.x, 1.1, obs.z);
            label.scale.set(3.4, 0.9, 1);

            masterObstaclesGroup.add(dotMesh);
            masterObstaclesGroup.add(label);
            masterObstacles.set(key, { mesh: dotMesh, label, data: obs });
        });
    }

    // =========================================================================
    // 7. Multi-Device Ingestion & Telemetry Tracking
    // =========================================================================
    function getOrCreateRemoteNode(peerId, name, device) {
        if (remoteNodes.has(peerId)) {
            return remoteNodes.get(peerId);
        }

        const colorHex = PALETTE[remoteNodes.size % PALETTE.length];
        const group = new THREE.Group();

        // 3D Chassis for Connected Remote Device
        const bodyGeo = new THREE.BoxGeometry(0.9, 0.1, 1.8);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            metalness: 0.8,
            roughness: 0.2
        });
        const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
        bodyMesh.position.y = 0.5;
        group.add(bodyMesh);

        // Glowing Screen
        const screenGeo = new THREE.PlaneGeometry(0.82, 1.65);
        const screenMat = new THREE.MeshBasicMaterial({
            color: colorHex,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.85
        });
        const screenMesh = new THREE.Mesh(screenGeo, screenMat);
        screenMesh.rotation.x = -Math.PI / 2;
        screenMesh.position.set(0, 0.56, 0);
        group.add(screenMesh);

        // Indicator plat de direcție (fără conuri 3D)
        const arrowShape = new THREE.Shape();
        arrowShape.moveTo(0, -1.6);
        arrowShape.lineTo(0.35, -1.0);
        arrowShape.lineTo(0.12, -1.0);
        arrowShape.lineTo(0.12, -0.3);
        arrowShape.lineTo(-0.12, -0.3);
        arrowShape.lineTo(-0.12, -1.0);
        arrowShape.lineTo(-0.35, -1.0);
        arrowShape.closePath();

        const arrowGeo = new THREE.ShapeGeometry(arrowShape);
        const arrowMat = new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide });
        const arrow = new THREE.Mesh(arrowGeo, arrowMat);
        arrow.rotation.x = Math.PI / 2;
        arrow.position.set(0, 0.56, 0);
        group.add(arrow);

        // Floating Tag
        const tagText = (device || 'Dispozitiv Mobil') + '\n👤 ' + (name ? name.split('@')[0] : peerId.substring(0, 6));
        const tag = createLabelSprite(tagText, colorHex);
        tag.position.set(0, 2.6, 0);
        group.add(tag);

        // Trajectory Ribbon
        const trajGeo = new THREE.BufferGeometry();
        const trajMat = new THREE.LineBasicMaterial({ color: colorHex, linewidth: 2, transparent: true, opacity: 0.85 });
        const trajLine = new THREE.Line(trajGeo, trajMat);
        scene.add(trajLine);

        // RF Link Beam to Central Beacon
        const beamGeo = new THREE.BufferGeometry();
        const beamMat = new THREE.LineDashedMaterial({
            color: colorHex,
            dashSize: 1,
            gapSize: 0.6,
            transparent: true,
            opacity: 0.6
        });
        const beamLine = new THREE.Line(beamGeo, beamMat);
        scene.add(beamLine);

        const nodeObj = {
            peerId: peerId,
            userName: name,
            device: device,
            color: colorHex,
            group: group,
            bodyMesh: bodyMesh,
            screenMesh: screenMesh,
            arrow: arrow,
            tag: tag,
            trajLine: trajLine,
            beamLine: beamLine,
            history: [],
            lastSeen: Date.now(),
            targetPos: new THREE.Vector3(0, 0, 0),
            targetHeading: 0,
            targetPitch: 0,
            targetRoll: 0,
            steps: 0,
            distance: 0,
            rtt: 0,
            jitter: 0
        };

        scene.add(group);
        remoteNodes.set(peerId, nodeObj);
        updateMasterHud();
        return nodeObj;
    }

    function processIncomingTelemetry(record) {
        if (!record || !record.file) return;
        const data = record.file;
        const peerId = data.peerId;
        if (!peerId) return;

        const node = getOrCreateRemoteNode(peerId, data.userName, data.device);

        const x = data.x || 0;
        const y = data.y || 0;
        const z = data.z || 0;

        node.targetPos.set(x, y, z);
        node.targetHeading = data.heading || 0;
        node.targetPitch = data.pitch || 0;
        node.targetRoll = data.roll || 0;
        node.steps = data.steps || 0;
        node.distance = data.distance || 0;
        node.rtt = data.rtt || 0;
        node.jitter = data.jitter || 0;
        node.lastSeen = Date.now();

        expandMasterBoundsIfNeeded(x, z);

        const lastP = node.history[node.history.length - 1];
        if (!lastP || Math.hypot(lastP.x - x, lastP.z - z) > 0.3) {
            node.history.push({ x, y: y + 0.08, z });
            if (node.history.length > 400) node.history.shift();

            const pts = node.history.map(p => new THREE.Vector3(p.x, p.y, p.z));
            node.trajLine.geometry.setFromPoints(pts);
        }

        if (data.newPoints && Array.isArray(data.newPoints)) {
            ingestRemotePoints(data.newPoints, node.color);
        }

        if (data.obstacles && Array.isArray(data.obstacles)) {
            ingestRemoteObstacles(data.obstacles);
        }

        updateMasterHud();
    }

    // =========================================================================
    // 8. Real-Time Telemetry Listener (PocketBase SSE + Fast Polling)
    // =========================================================================
    function initTelemetryStream() {
        try {
            sseConnection = new EventSource('/api/realtime');
            sseConnection.addEventListener('PB_CONNECT', async (e) => {
                try {
                    const d = JSON.parse(e.data);
                    await fetch('/api/realtime', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            clientId: d.clientId,
                            subscriptions: ['messages/*']
                        })
                    });
                } catch (err) {}
            });

            sseConnection.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg && msg.record && msg.record.scope === 'radar_telemetry') {
                        processIncomingTelemetry(msg.record);
                    }
                } catch (err) {}
            };
        } catch (e) {
            console.warn('[Master WiFiGrametrie] Fallback la polling...');
        }

        const pollTelemetry = async () => {
            try {
                const res = await fetch('/api/collections/messages/records?filter=' + encodeURIComponent("(scope='radar_telemetry')") + '&sort=-timestamp&perPage=25', { cache: 'no-store' });
                if (res.ok) {
                    const d = await res.json();
                    const items = (d.items || []).reverse();
                    items.forEach(it => {
                        if (!knownTelemetryIds.has(it.id)) {
                            knownTelemetryIds.add(it.id);
                            processIncomingTelemetry(it);
                        }
                    });
                }
            } catch (err) {}
        };

        pollTelemetry();
        pollIntervalId = setInterval(pollTelemetry, 1300);
    }

    // =========================================================================
    // 9. Camera Orbit Controls
    // =========================================================================
    function setupInteractionHandlers() {
        const dom = canvasWrapperEl;

        dom.addEventListener('pointerdown', (e) => {
            isPointerDown = true;
            pointerStartX = e.clientX;
            pointerStartY = e.clientY;
            dom.setPointerCapture(e.pointerId);
        });

        dom.addEventListener('pointermove', (e) => {
            if (!isPointerDown) return;
            const dx = e.clientX - pointerStartX;
            const dy = e.clientY - pointerStartY;
            pointerStartX = e.clientX;
            pointerStartY = e.clientY;

            cameraTheta -= dx * 0.008;
            cameraPhi = Math.max(0.1, Math.min(Math.PI / 2.05, cameraPhi - dy * 0.008));
            updateCameraPosition();
        });

        const onPointerUp = (e) => {
            isPointerDown = false;
            try { dom.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        dom.addEventListener('pointerup', onPointerUp);
        dom.addEventListener('pointercancel', onPointerUp);

        dom.addEventListener('wheel', (e) => {
            e.preventDefault();
            cameraRadius = Math.max(8, Math.min(150, cameraRadius + (e.deltaY * 0.05)));
            updateCameraPosition();
        }, { passive: false });

        dom.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                initialPinchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: true });

        dom.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && initialPinchDist > 0) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const diff = initialPinchDist - dist;
                initialPinchDist = dist;
                cameraRadius = Math.max(8, Math.min(150, cameraRadius + (diff * 0.1)));
                updateCameraPosition();
            }
        }, { passive: true });

        window.addEventListener('resize', () => {
            if (!canvasWrapperEl || !renderer || !camera) return;
            const w = canvasWrapperEl.clientWidth;
            const h = canvasWrapperEl.clientHeight;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        });
    }

    function updateCameraPosition() {
        if (!camera) return;
        camera.position.x = cameraTarget.x + cameraRadius * Math.sin(cameraPhi) * Math.sin(cameraTheta);
        camera.position.y = cameraTarget.y + cameraRadius * Math.cos(cameraPhi);
        camera.position.z = cameraTarget.z + cameraRadius * Math.sin(cameraPhi) * Math.cos(cameraTheta);
        camera.lookAt(cameraTarget.x, cameraTarget.y, cameraTarget.z);
    }

    // =========================================================================
    // 9.5. RuView RF Person Tracking Stream (Port 3001)
    // =========================================================================
    function initRuViewStream() {
        const host = window.location.hostname || 'localhost';
        const wsProto = (window.location.protocol === 'https:') ? 'wss://' : 'ws://';
        const url = wsProto + host + ':3001';

        try {
            ruviewWs = new WebSocket(url);
            ruviewWs.onopen = () => {
                console.log('[Master RuView] Conectat la serverul RF de sesizare spațială (3001).');
            };
            ruviewWs.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    let list = [];
                    if (Array.isArray(data.persons)) {
                        list = data.persons;
                    } else if (Array.isArray(data.tracks)) {
                        list = data.tracks.map((t, idx) => ({
                            id: t.id || t.track_id || idx,
                            x: t.x || (t.position && t.position[0]) || 0,
                            y: t.y || (t.position && t.position[1]) || 0.4,
                            z: t.z || (t.position && t.position[2]) || 0,
                            label: t.label || ('Persoană ' + (t.id || (idx + 1)))
                        }));
                    } else if (data.x !== undefined && data.z !== undefined) {
                        list = [data];
                    }
                    if (list.length > 0) updateRuViewPersons(list);
                } catch (e) {}
            };
            ruviewWs.onerror = () => { try { ruviewWs.close(); } catch (e) {} };
            ruviewWs.onclose = () => {
                setTimeout(initRuViewStream, 5000);
            };
        } catch (e) {
            setTimeout(initRuViewStream, 5000);
        }
    }

    function updateRuViewPersons(personsList) {
        if (!Array.isArray(personsList) || !ruviewPersonsGroup) return;
        const currentIds = new Set();

        personsList.forEach((person, idx) => {
            const id = (person.id !== undefined && person.id !== null) ? String(person.id) : ('p_' + idx);
            currentIds.add(id);

            const px = Number(person.x) || 0;
            const py = Number(person.y) || 0.4;
            const pz = Number(person.z) || 0;
            const name = person.label || person.name || ('Persoană ' + (idx + 1));

            expandMasterBoundsIfNeeded(px, pz);

            let pObj = ruviewPersons.get(id);
            if (!pObj) {
                const group = new THREE.Group();

                // Punct simplu 3D (GL_POINTS - fără sfere, fără conuri, fără unde)
                const dotMesh = createPointMarker(0xf59e0b, 14);
                dotMesh.position.y = 0.4;
                group.add(dotMesh);

                // Etichetă simplă
                const labelText = '👤 ' + name + '\n📍 [X: ' + px.toFixed(1) + 'm, Z: ' + pz.toFixed(1) + 'm]';
                const label = createLabelSprite(labelText, 0xf59e0b);
                label.position.set(0, 1.5, 0);
                group.add(label);

                group.position.set(px, py, pz);
                ruviewPersonsGroup.add(group);

                pObj = { id, group, dotMesh, label, targetPos: new THREE.Vector3(px, py, pz), name };
                ruviewPersons.set(id, pObj);
            } else {
                pObj.targetPos.set(px, py, pz);
                pObj.group.position.lerp(pObj.targetPos, 0.25);

                if (pObj.label && pObj.label.userData) {
                    const { canvas, ctx, texture, colorHex } = pObj.label.userData;
                    ctx.fillStyle = 'rgba(6, 9, 17, 0.9)';
                    ctx.fillRect(4, 4, 272, 72);
                    ctx.strokeStyle = '#' + new THREE.Color(colorHex).getHexString();
                    ctx.lineWidth = 3;
                    ctx.strokeRect(4, 4, 272, 72);
                    ctx.fillStyle = '#f8fafc';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.font = 'bold 15px "Outfit", sans-serif';
                    ctx.fillText('👤 ' + name, 140, 26);
                    ctx.font = '12px "JetBrains Mono", monospace';
                    ctx.fillStyle = '#06b6d4';
                    const signX = px >= 0 ? '+' : '';
                    const signZ = pz >= 0 ? '+' : '';
                    ctx.fillText('📍 X: ' + signX + px.toFixed(1) + 'm, Z: ' + signZ + pz.toFixed(1) + 'm', 140, 52);
                    texture.needsUpdate = true;
                }
            }
        });

        ruviewPersons.forEach((val, key) => {
            if (!currentIds.has(key)) {
                ruviewPersonsGroup.remove(val.group);
                ruviewPersons.delete(key);
            }
        });

        updateMasterHud();
    }

    // =========================================================================
    // 10. Bucla de Randare (60 FPS - Fără unde pulsatorii, fără con rotativ)
    // =========================================================================
    function animate() {
        animFrameId = requestAnimationFrame(animate);

        // Netezire filtrare Compas local Moto G86
        if (hasReceivedCompass) {
            let diff = (targetHeading - localHeading + 180) % 360 - 180;
            localHeading = (localHeading + diff * compassSmoothingAlpha + 360) % 360;
        }

        if (beaconGroup) {
            const headingRad = (localHeading * Math.PI) / 180;
            beaconGroup.rotation.y = -headingRad;

            // Rotește camera o dată cu orientarea telefonului (Head-Up Navigation pe ecran)
            if (compassFollowMode && !isPointerDown) {
                cameraTheta = -headingRad + Math.PI / 2;
                cameraTarget.lerp(beaconGroup.position, 0.08);
                updateCameraPosition();
            }
        }

        remoteNodes.forEach(node => {
            node.group.position.lerp(node.targetPos, 0.15);
            // Aliniere rotație cu compasul
            const headingRad = (node.targetHeading * Math.PI) / 180;
            node.group.rotation.y = -headingRad;

            const pitchRad = (node.targetPitch * Math.PI) / 180;
            const rollRad = (node.targetRoll * Math.PI) / 180;
            node.bodyMesh.rotation.x = pitchRad * 0.4;
            node.bodyMesh.rotation.z = -rollRad * 0.4;
            node.screenMesh.rotation.z = -rollRad * 0.4;

            const p0 = new THREE.Vector3(0, 0.5, 0);
            const p1 = node.group.position.clone();
            p1.y = 0.5;
            node.beamLine.geometry.setFromPoints([p0, p1]);
            node.beamLine.computeLineDistances();
        });

        updateMasterLabelsScale();
        renderer.render(scene, camera);
    }

    // =========================================================================
    // 11. Actualizare Master HUD
    // =========================================================================
    function updateMasterHud() {
        const hudNodes = document.getElementById('masterHudActiveNodes');
        const hudPts = document.getElementById('masterHudTotalPoints');
        const hudArea = document.getElementById('masterHudArea');
        const listEl = document.getElementById('masterNodesList');

        const activeUsersCount = remoteNodes.size;
        const wifiCount = wifiLandmarks.size;
        const obstacleCount = masterObstacles.size;

        if (hudNodes) {
            hudNodes.textContent = (1 + activeUsersCount) + ' Noduri Active (' + wifiCount + ' Repere Wi-Fi)';
        }

        if (hudPts) {
            hudPts.textContent = masterPointCount.toLocaleString() + ' puncte (' + obstacleCount + ' obstacole)';
        }

        if (hudArea) {
            const approxArea = Math.max(25, (activeUsersCount + 1) * 35 + (masterPointCount * 0.04));
            hudArea.textContent = '~' + Math.round(approxArea) + ' m² sintetizați';
        }

        if (listEl) {
            if (activeUsersCount === 0) {
                listEl.innerHTML = '<div class="empty-state">Așteptare conectare utilizatori la rețea...</div>';
            } else {
                let html = '';
                remoteNodes.forEach(node => {
                    const hexStr = '#' + new THREE.Color(node.color).getHexString();
                    const ageSec = Math.round((Date.now() - node.lastSeen) / 1000);
                    const statusClass = ageSec < 6 ? 'online' : 'offline';
                    html += `
                        <div class="master-node-card" style="border-left: 3px solid ${hexStr};">
                            <div class="node-card-header">
                                <span class="node-card-title" style="color: ${hexStr};">${node.device || 'Nod'}</span>
                                <span class="status-badge ${statusClass}">${ageSec < 6 ? 'Activ' : ageSec + 's'}</span>
                            </div>
                            <div class="node-card-details">
                                <span>Utilizator: <strong>${node.userName || node.peerId}</strong></span>
                                <span>Poziție: <strong>X: ${node.targetPos.x.toFixed(1)}m, Z: ${node.targetPos.z.toFixed(1)}m</strong></span>
                                <span>Pași: <strong>${node.steps} (${node.distance.toFixed(1)} m)</strong></span>
                                <span>Orientare: <strong>${Math.round(node.targetHeading)}°</strong></span>
                                <span>Latență RF: <strong>${node.rtt} ms (±${node.jitter}ms)</strong></span>
                            </div>
                        </div>
                    `;
                });
                listEl.innerHTML = html;
            }
        }
    }

    // =========================================================================
    // 12. Comenzi Publice UI Master
    // =========================================================================
    function setCameraView(mode) {
        if (mode === 'top') {
            cameraPhi = 0.01;
            cameraRadius = 45;
        } else {
            cameraPhi = Math.PI / 3.4;
            cameraRadius = 38;
        }
        updateCameraPosition();
    }

    function resetCamera() {
        cameraTheta = Math.PI / 4;
        cameraPhi = Math.PI / 3.4;
        cameraRadius = 38;
        cameraTarget.set(0, 0, 0);
        updateCameraPosition();
    }

    // Auto-init on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 50));
    } else {
        setTimeout(init, 50);
    }

    return {
        init: init,
        setCameraView: setCameraView,
        resetCamera: resetCamera,
        updateRuViewPersons: updateRuViewPersons
    };
})();
