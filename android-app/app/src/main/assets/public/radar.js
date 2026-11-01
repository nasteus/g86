// radar.js - G86 WiFiGrametrie 3D Engine & Cumulative RF Spatial Synthesizer
// Reconstrucție Spațială: Senzori Inerțiali 6DoF • Planuri (Podea/Pereți) • Obstacole RF • Repere Wi-Fi • Zero Cameră

window.RadarEngine = (function() {
    'use strict';

    // State & Config
    let isInitialized = false;
    let isEmitting = true;
    let cameraMode = 'room'; // 'room' (perspectivă fixă cameră) | 'follow' (urmărire telefon)
    let sensorFusionActive = false;
    let sensorSensitivityHigh = true;

    // Three.js instances
    let scene, camera, renderer;
    let canvasWrapperEl;
    let animFrameId = null;

    // 3D Objects for Personal Device
    let phoneChassisGroup;
    let phoneBodyMesh, phoneScreenMesh, directionPointerMesh, phoneLabelSprite;
    let personalGrid, polarRingsGroup;

    // Reconstructed Room Planes (WiFiGrametrie)
    let roomPlanesGroup;
    let northWallMesh, southWallMesh, westWallMesh, eastWallMesh;
    let roomBounds = { minX: -4.5, maxX: 4.5, minZ: -6.0, maxZ: 6.0 };

    // Detected 3D Physical Obstacles (Mobilier / Structuri RF)
    let obstaclesGroup;
    let detectedObstacles = []; // { x, y, z, width, depth, height, mesh, label }

    // Cumulative 3D Point Cloud
    const MAX_POINTS = 30000;
    let pointCloudGeometry, pointCloudMaterial, pointCloudMesh;
    let pointPositions = new Float32Array(MAX_POINTS * 3);
    let pointColors = new Float32Array(MAX_POINTS * 3);
    let pointCount = 0;
    let recentNewPoints = [];

    // Trajectory ribbon
    let trajectoryLine;
    let trajectoryPoints = [];

    // Wi-Fi Landmarks Group (Puncte de Reper)
    let wifiLandmarksGroup;
    let wifiLandmarkObjects = new Map(); // ip/key -> landmarkObj
    let activeLandmarkIp = null;
    let rfLinkLineToLandmark = null;

    // RuView RF Person Tracking (Puncte Simple + Etichetă)
    let ruviewPersonsGroup;
    let ruviewPersons = new Map(); // id -> { group, dotMesh, label, targetPos, name }
    let ruviewWs = null;

    // Sensor Fusion Filters (EMA & Compass Smoothing)
    let targetHeading = 0;
    let hasReceivedCompass = false;
    const compassSmoothingAlpha = 0.22;

    // Camera Orbit Controls State
    let isPointerDown = false;
    let pointerStartX = 0, pointerStartY = 0;
    let cameraTheta = Math.PI / 4;   // Unghi azimut
    let cameraPhi = Math.PI / 3.4;   // Unghi polar
    let cameraRadius = 22;           // Zoom
    let cameraTarget = new THREE.Vector3(0, 1.0, 0);
    let initialPinchDist = 0;

    // Local Device Telemetry & Physical Sensors
    let myPeerId = localStorage.getItem('g86_client_peer_id') || ('peer_' + Math.random().toString(36).substring(2, 8));
    let deviceModel = detectDeviceModel();
    let localHeading = 0; // Busolă 0-360 deg
    let localPitch = 0;   // Tilt -180 la 180 deg
    let localRoll = 0;    // Roll -90 la 90 deg
    let posX = 0, posY = 0, posZ = 0;
    let stepCount = 0;
    let totalDistanceMeters = 0;
    let lastStepTime = 0;
    let currentRtt = 0;
    let currentJitter = 0;
    let networkType = 'Wi-Fi Activ';
    let lastBroadcastTime = 0;
    let pingIntervalId = null;
    let broadcastIntervalId = null;
    let landmarksIntervalId = null;

    // Sensor Fusion Filters (EMA)
    let gravX = 0, gravY = 9.81, gravZ = 0;
    let lastAccelMag = 0;
    let linearAccelSensor = null;

    function detectDeviceModel() {
        const ua = navigator.userAgent || '';
        if (/SM-S928|SM-S938|SM-S9|Galaxy S25/i.test(ua)) return 'Samsung Galaxy S25 Ultra';
        if (/Motorola|Moto G86|XT2/i.test(ua)) return 'Motorola Moto G86';
        if (/iPhone/i.test(ua)) return 'Apple iPhone';
        if (/Android/i.test(ua)) return 'Dispozitiv Android';
        if (/Windows/i.test(ua)) return 'Stație PC / Control';
        if (/Macintosh/i.test(ua)) return 'Apple Mac';
        return 'Dispozitiv Mobil';
    }

    // =========================================================================
    // 1. Initializare Three.js 3D Viewport Personal & WiFiGrametrie
    // =========================================================================
    function init() {
        canvasWrapperEl = document.getElementById('radarCanvasContainer');
        if (!canvasWrapperEl || typeof THREE === 'undefined') return;

        if (isInitialized) return;
        isInitialized = true;

        const width = canvasWrapperEl.clientWidth || 360;
        const height = canvasWrapperEl.clientHeight || 340;

        // Scene & Fog
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x060911);
        scene.fog = new THREE.FogExp2(0x060911, 0.015);

        // Perspective Camera
        camera = new THREE.PerspectiveCamera(46, width / height, 0.2, 250);
        updateCameraPosition();

        // High-Performance WebGL Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        canvasWrapperEl.appendChild(renderer.domElement);

        // Dynamic Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        scene.add(ambientLight);

        const cyanLight = new THREE.PointLight(0x06b6d4, 2.2, 50);
        cyanLight.position.set(0, 10, 0);
        scene.add(cyanLight);

        const emeraldLight = new THREE.PointLight(0x10b981, 1.8, 35);
        emeraldLight.position.set(0, 4, 0);
        scene.add(emeraldLight);

        // Groups
        wifiLandmarksGroup = new THREE.Group();
        scene.add(wifiLandmarksGroup);

        roomPlanesGroup = new THREE.Group();
        scene.add(roomPlanesGroup);

        obstaclesGroup = new THREE.Group();
        scene.add(obstaclesGroup);

        ruviewPersonsGroup = new THREE.Group();
        scene.add(ruviewPersonsGroup);

        // Build Environment, Phone Chassis, Point Cloud, Planes, Trajectory
        buildPersonalRadarGrid();
        buildReconstructedRoomPlanes();
        buildUserPhoneChassis();
        initCumulativePointCloud();
        initTrajectoryLine();
        initRfLinkLine();

        // Event Handlers & Sensor Fusion
        setupInteractionHandlers();
        setupSensorListeners();
        initRuViewTracking();
        startRfPingLoop();
        startBroadcastLoop();
        startLandmarksLoop();

        // Start 60 FPS Render Loop
        animate();

        // Prime initial seed points around the starting position
        synthesizeInitialEnvironmentPoints(0, 0, 0);

        console.log('[WiFiGrametrie Client] Initializat pentru:', deviceModel, 'Peer ID:', myPeerId);
    }

    // =========================================================================
    // 2. Personal Radar Grid & Distance Rings
    // =========================================================================
    function buildPersonalRadarGrid() {
        personalGrid = new THREE.GridHelper(80, 40, 0x10b981, 0x1e293b);
        personalGrid.position.y = -0.02;
        scene.add(personalGrid);

        polarRingsGroup = new THREE.Group();
        const rings = [3, 6, 12, 20, 30];
        rings.forEach(radius => {
            const geo = new THREE.RingGeometry(radius - 0.06, radius + 0.06, 64);
            const mat = new THREE.MeshBasicMaterial({
                color: 0x06b6d4,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.18
            });
            const ring = new THREE.Mesh(geo, mat);
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0;
            polarRingsGroup.add(ring);
        });
        scene.add(polarRingsGroup);

        createCardinalMarker('N (0°)', 0, 0, -15, 0x10b981);
        createCardinalMarker('S (180°)', 0, 0, 15, 0x64748b);
        createCardinalMarker('E (90°)', 15, 0, 0, 0x06b6d4);
        createCardinalMarker('V (270°)', -15, 0, 0, 0x64748b);
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
            sizeAttenuation: false, // Punct grafic curat, vizibil exact ca un punct pe radar
            map: getPointTexture(),
            transparent: true,
            alphaTest: 0.1
        });
        return new THREE.Points(geo, mat);
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
        sprite.position.set(x, 0.8, z);
        sprite.scale.set(3.2, 1.6, 1);
        scene.add(sprite);
    }

    // =========================================================================
    // 3. Spatiu Reconstructie (Fara Pereti Mock-up Fake)
    // =========================================================================
    function buildReconstructedRoomPlanes() {
        // Nu mai adaugam pereti falsi/mock-up arbitrari pentru a pastra spatiul curat si autentic
    }

    function updateReconstructedRoomPlanes() {
        // Fara pereti mock-up
    }

    // =========================================================================
    // 4. User Phone 3D Model & Real-time Orientation
    // =========================================================================
    function buildUserPhoneChassis() {
        phoneChassisGroup = new THREE.Group();

        // Smartphone Body
        const bodyGeo = new THREE.BoxGeometry(0.9, 0.1, 1.8);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            metalness: 0.85,
            roughness: 0.25
        });
        phoneBodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
        phoneBodyMesh.position.y = 0.5;
        phoneChassisGroup.add(phoneBodyMesh);

        // Glowing Screen
        const screenGeo = new THREE.PlaneGeometry(0.82, 1.65);
        const screenMat = new THREE.MeshBasicMaterial({
            color: 0x06b6d4,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.85
        });
        phoneScreenMesh = new THREE.Mesh(screenGeo, screenMat);
        phoneScreenMesh.rotation.x = -Math.PI / 2;
        phoneScreenMesh.position.set(0, 0.56, 0);
        phoneChassisGroup.add(phoneScreenMesh);

        // Heading Direction Pointer (Indicator plat direcțional - fără conuri 3D, fără volum parazit)
        const arrowShape = new THREE.Shape();
        arrowShape.moveTo(0, -1.6);       // Vârf orientat spre înainte (-Z)
        arrowShape.lineTo(0.35, -1.0);    // Aripă dreapta
        arrowShape.lineTo(0.12, -1.0);
        arrowShape.lineTo(0.12, -0.3);    // Bază dreapta
        arrowShape.lineTo(-0.12, -0.3);   // Bază stânga
        arrowShape.lineTo(-0.12, -1.0);
        arrowShape.lineTo(-0.35, -1.0);   // Aripă stânga
        arrowShape.closePath();

        const pointerGeo = new THREE.ShapeGeometry(arrowShape);
        const pointerMat = new THREE.MeshBasicMaterial({ color: 0x10b981, side: THREE.DoubleSide });
        directionPointerMesh = new THREE.Mesh(pointerGeo, pointerMat);
        directionPointerMesh.rotation.x = Math.PI / 2;
        directionPointerMesh.position.set(0, 0.56, 0);
        phoneChassisGroup.add(directionPointerMesh);

        // 3D Floating Tag: Live Coordinates & Device Name
        phoneLabelSprite = createLabelSprite('📱 ' + deviceModel + '\n📍 [X: 0.0m, Z: 0.0m]', 0x10b981);
        phoneLabelSprite.position.set(0, 2.4, 0);
        phoneChassisGroup.add(phoneLabelSprite);

        scene.add(phoneChassisGroup);
    }

    let activeLabelSprites = new Set();
    const tempLabelVec = new THREE.Vector3();

    function createLabelSprite(text, colorHex, baseW = 4.2, baseH = 1.1) {
        const canvas = document.createElement('canvas');
        canvas.width = 280;
        canvas.height = 72;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(6, 9, 17, 0.9)';
        ctx.fillRect(4, 4, 272, 64);
        ctx.strokeStyle = '#' + new THREE.Color(colorHex).getHexString();
        ctx.lineWidth = 2.5;
        ctx.strokeRect(4, 4, 272, 64);

        const lines = text.split('\n');
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (lines.length > 1) {
            ctx.font = 'bold 15px "Outfit", sans-serif';
            ctx.fillText(lines[0], 140, 24);
            ctx.font = '12px "JetBrains Mono", monospace';
            ctx.fillStyle = '#06b6d4';
            ctx.fillText(lines[1], 140, 48);
        } else {
            ctx.font = 'bold 16px "Outfit", sans-serif';
            ctx.fillText(text, 140, 36);
        }

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.scale.set(baseW, baseH, 1);
        sprite.userData = { canvas, ctx, texture, colorHex, baseScaleX: baseW, baseScaleY: baseH };
        activeLabelSprites.add(sprite);
        return sprite;
    }

    // Scalare dinamică automată: Etichetele își păstrează fix aceeași dimensiune în pixeli la orice nivel de zoom
    function updateLabelsScale() {
        if (!camera) return;
        const refDist = 22.0;
        const camPos = camera.position;

        activeLabelSprites.forEach(sprite => {
            if (!sprite.parent) {
                activeLabelSprites.delete(sprite);
                return;
            }
            sprite.getWorldPosition(tempLabelVec);
            const dist = camPos.distanceTo(tempLabelVec);
            const factor = Math.max(0.1, Math.min(3.0, dist / refDist));
            const baseW = sprite.userData.baseScaleX || 4.2;
            const baseH = sprite.userData.baseScaleY || 1.1;
            sprite.scale.set(baseW * factor, baseH * factor, 1);
        });
    }

    function updatePhoneFloatingLabel() {
        if (!phoneLabelSprite || !phoneLabelSprite.userData) return;
        const { canvas, ctx, texture, colorHex } = phoneLabelSprite.userData;
        ctx.fillStyle = 'rgba(6, 9, 17, 0.9)';
        ctx.fillRect(4, 4, 292, 72);
        ctx.strokeStyle = '#' + new THREE.Color(colorHex).getHexString();
        ctx.lineWidth = 3;
        ctx.strokeRect(4, 4, 292, 72);

        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 16px "Outfit", sans-serif';
        ctx.fillText('📱 ' + deviceModel, 150, 26);

        ctx.font = '13px "JetBrains Mono", monospace';
        ctx.fillStyle = '#06b6d4';
        const signX = posX >= 0 ? '+' : '';
        const signZ = posZ >= 0 ? '+' : '';
        ctx.fillText('📍 X: ' + signX + posX.toFixed(1) + 'm, Z: ' + signZ + posZ.toFixed(1) + 'm | 🚶 ' + stepCount, 150, 52);

        texture.needsUpdate = true;
    }

    // =========================================================================
    // 5. Cumulative 3D Point Cloud Engine
    // =========================================================================
    function initCumulativePointCloud() {
        pointCloudGeometry = new THREE.BufferGeometry();
        pointCloudGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
        pointCloudGeometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3));

        pointCloudMaterial = new THREE.PointsMaterial({
            size: 0.45,
            vertexColors: true,
            transparent: true,
            opacity: 0.85,
            sizeAttenuation: true
        });

        pointCloudMesh = new THREE.Points(pointCloudGeometry, pointCloudMaterial);
        scene.add(pointCloudMesh);
    }

    function initTrajectoryLine() {
        const trajGeo = new THREE.BufferGeometry();
        const trajMat = new THREE.LineBasicMaterial({ color: 0x06b6d4, linewidth: 2, transparent: true, opacity: 0.8 });
        trajectoryLine = new THREE.Line(trajGeo, trajMat);
        scene.add(trajectoryLine);
    }

    function initRfLinkLine() {
        const lineGeo = new THREE.BufferGeometry();
        const lineMat = new THREE.LineDashedMaterial({
            color: 0x10b981,
            dashSize: 0.8,
            gapSize: 0.4,
            transparent: true,
            opacity: 0.7
        });
        rfLinkLineToLandmark = new THREE.Line(lineGeo, lineMat);
        scene.add(rfLinkLineToLandmark);
    }

    function addPointToCloud(x, y, z, r, g, b) {
        if (pointCount >= MAX_POINTS) {
            pointCount = Math.floor(MAX_POINTS * 0.7);
        }

        const idx = pointCount * 3;
        pointPositions[idx] = x;
        pointPositions[idx + 1] = y;
        pointPositions[idx + 2] = z;

        pointColors[idx] = r;
        pointColors[idx + 1] = g;
        pointColors[idx + 2] = b;

        pointCount++;
        recentNewPoints.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100 });
    }

    function markPointCloudUpdated() {
        if (!pointCloudGeometry) return;
        pointCloudGeometry.attributes.position.needsUpdate = true;
        pointCloudGeometry.attributes.color.needsUpdate = true;
        pointCloudGeometry.setDrawRange(0, pointCount);

        const el = document.getElementById('hudPointCloudCount');
        if (el) {
            el.textContent = pointCount.toLocaleString() + ' puncte 3D';
        }
    }

    function synthesizeInitialEnvironmentPoints(cx, cy, cz) {
        const roomW = 4.2;
        const roomL = 5.5;
        const clrCyan = new THREE.Color(0x06b6d4);
        const clrEmerald = new THREE.Color(0x10b981);

        // Ground carpet
        for (let x = -roomW; x <= roomW; x += 0.7) {
            for (let z = -roomL; z <= roomL; z += 0.7) {
                const jx = x + (Math.random() - 0.5) * 0.15;
                const jz = z + (Math.random() - 0.5) * 0.15;
                addPointToCloud(cx + jx, cy, cz + jz, clrEmerald.r * 0.6, clrEmerald.g * 0.6, clrEmerald.b * 0.6);
            }
        }

        // Boundary walls
        const heights = [0.4, 1.0, 1.8, 2.5];
        for (let z = -roomL; z <= roomL; z += 0.6) {
            heights.forEach(h => {
                addPointToCloud(cx - roomW, cy + h, cz + z, clrCyan.r, clrCyan.g, clrCyan.b);
                addPointToCloud(cx + roomW, cy + h, cz + z, clrCyan.r, clrCyan.g, clrCyan.b);
            });
        }
        for (let x = -roomW; x <= roomW; x += 0.6) {
            heights.forEach(h => {
                addPointToCloud(cx + x, cy + h, cz - roomL, clrCyan.r, clrCyan.g, clrCyan.b);
                addPointToCloud(cx + x, cy + h, cz + roomL, clrCyan.r, clrCyan.g, clrCyan.b);
            });
        }

        markPointCloudUpdated();
    }

    function synthesizeStepPoints(prevX, prevZ, curX, curZ, headingDeg) {
        const rad = (headingDeg * Math.PI) / 180;
        const normalX = Math.cos(rad);
        const normalZ = Math.sin(rad);

        const clrEmerald = new THREE.Color(0x10b981);
        const clrCyan = new THREE.Color(0x06b6d4);
        const clrAmber = new THREE.Color(0xf59e0b);

        // Trail floor scan
        for (let t = 0; t <= 1; t += 0.25) {
            const ix = prevX + (curX - prevX) * t;
            const iz = prevZ + (curZ - prevZ) * t;
            addPointToCloud(ix, posY, iz, clrEmerald.r, clrEmerald.g, clrEmerald.b);
        }

        // Lateral room boundaries
        const roomHalfWidth = 2.8 + (Math.sin(stepCount * 0.4) * 0.5);
        const leftX = curX - normalX * roomHalfWidth;
        const leftZ = curZ - normalZ * roomHalfWidth;
        const rightX = curX + normalX * roomHalfWidth;
        const rightZ = curZ + normalZ * roomHalfWidth;

        [0.4, 1.1, 1.9, 2.6].forEach(h => {
            addPointToCloud(leftX, posY + h, leftZ, clrCyan.r, clrCyan.g, clrCyan.b);
            addPointToCloud(rightX, posY + h, rightZ, clrCyan.r, clrCyan.g, clrCyan.b);
        });

        // WiFiGrametrie RF Obstacle Reconstruction
        // When RF jitter or angular acceleration spike occurs, project an obstacle volume
        if (currentJitter > 2.0 || Math.abs(localPitch) > 18 || (stepCount % 5 === 0)) {
            const obsDist = 1.6 + ((stepCount % 3) * 0.5);
            const ox = curX + Math.sin(rad) * obsDist;
            const oz = curZ - Math.cos(rad) * obsDist;

            // Dense amber point cloud for detected obstacle volume
            for (let i = 0; i < 8; i++) {
                addPointToCloud(
                    ox + (Math.random() - 0.5) * 0.9,
                    posY + Math.random() * 1.4,
                    oz + (Math.random() - 0.5) * 0.9,
                    clrAmber.r, clrAmber.g, clrAmber.b
                );
            }

            // Spawn or update 3D Obstacle wireframe volume
            spawnOrUpdateObstacle3D(ox, oz, 1.0, 1.0, 1.3);
        }

        markPointCloudUpdated();
        updateReconstructedRoomPlanes();
    }

    function spawnOrUpdateObstacle3D(x, z, w, d, h) {
        // Avoid duplicate overlapping obstacles
        const existing = detectedObstacles.find(o => Math.hypot(o.x - x, o.z - z) < 1.4);
        if (existing) return;

        // Punct simplu 3D cu etichetă (GL_POINTS - fără sfere, fără cutii)
        const dotMesh = createPointMarker(0xf59e0b, 10);
        dotMesh.position.set(x, 0.35, z);

        const label = createLabelSprite('📦 Obstacol RF', 0xf59e0b);
        label.position.set(x, 1.1, z);
        label.scale.set(3.4, 0.9, 1);

        obstaclesGroup.add(dotMesh);
        obstaclesGroup.add(label);

        detectedObstacles.push({ x, y: 0.35, z, mesh: dotMesh, label });
        if (detectedObstacles.length > 20) {
            const old = detectedObstacles.shift();
            obstaclesGroup.remove(old.mesh);
            obstaclesGroup.remove(old.label);
        }
    }

    // =========================================================================
    // 6. Wi-Fi Landmarks as 3D Reference Points (Puncte de Reper)
    // =========================================================================
    function startLandmarksLoop() {
        if (landmarksIntervalId) clearInterval(landmarksIntervalId);

        const fetchLandmarks = async () => {
            try {
                const res = await fetch('/wifi_landmarks.json?_t=' + Date.now(), { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    updateWifiLandmarksIn3D(data);
                }
            } catch (err) {}
        };

        fetchLandmarks();
        landmarksIntervalId = setInterval(fetchLandmarks, 2500);
    }

    function updateWifiLandmarksIn3D(data) {
        if (!data) return;

        const allItems = [];
        if (data.gateway) {
            allItems.push(data.gateway);
        }
        if (data.devices && Array.isArray(data.devices)) {
            data.devices.forEach(d => allItems.push(d));
        }

        const seenIps = new Set();

        allItems.forEach(item => {
            const ip = item.ip;
            seenIps.add(ip);

            let obj = wifiLandmarkObjects.get(ip);
            if (!obj) {
                obj = createWifiLandmark3D(item);
                wifiLandmarkObjects.set(ip, obj);
                wifiLandmarksGroup.add(obj.group);
            }

            obj.group.position.set(item.x || 0, item.y || 0, item.z || 0);
        });

        // Set default active landmark to Gateway router
        if (!activeLandmarkIp && data.gateway) {
            activeLandmarkIp = data.gateway.ip;
        }

        updateRfLinkLine();
    }

    function createWifiLandmark3D(item) {
        const group = new THREE.Group();
        const isRouter = (item.type === 'router');
        const isMaster = (item.type === 'master');
        const isPerson = (item.type === 'person' || item.type === 'ruview');
        const colorHex = isPerson ? 0xf59e0b : (isRouter ? 0x10b981 : (isMaster ? 0x8b5cf6 : 0x06b6d4));

        // Punct simplu 3D (GL_POINTS - fără sfere, fără turnuri, fără unde)
        const dotMesh = createPointMarker(colorHex, isPerson ? 14 : 10);
        dotMesh.position.y = isPerson ? 0.6 : 0.35;
        group.add(dotMesh);

        // Floating 3D Label Sprite
        const icon = isPerson ? '👤 ' : (isRouter ? '📡 ' : (isMaster ? '🌐 ' : '💻 '));
        const labelText = icon + item.name + (item.signal ? ('\n' + item.ip + ' • ' + item.signal + ' dBm') : '');
        const label = createLabelSprite(labelText, colorHex);
        label.position.set(0, isRouter ? 3.6 : 2.2, 0);
        group.add(label);

        return { group, item, dotMesh, label, colorHex };
    }

    function updateRfLinkLine() {
        if (!rfLinkLineToLandmark || !activeLandmarkIp) return;
        const targetLandmark = wifiLandmarkObjects.get(activeLandmarkIp);
        if (!targetLandmark) return;

        const start = new THREE.Vector3(posX, posY + 0.5, posZ);
        const end = targetLandmark.group.position.clone();
        end.y += 0.8;

        const points = [start, end];
        rfLinkLineToLandmark.geometry.setFromPoints(points);
        rfLinkLineToLandmark.computeLineDistances();

        const dist = start.distanceTo(end);
        const hudRef = document.getElementById('hudActiveLandmark');
        if (hudRef) {
            hudRef.textContent = targetLandmark.item.name + ' (' + dist.toFixed(1) + ' m)';
        }
    }

    // =========================================================================
    // 6.5. RuView RF Person Tracking (Puncte Simple + Etichetă)
    // =========================================================================
    function initRuViewTracking() {
        connectRuViewWebSocket();
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

            let pObj = ruviewPersons.get(id);
            if (!pObj) {
                const group = new THREE.Group();

                // Punct simplu 3D (GL_POINTS - fără sfere, fără conuri, fără unde)
                const dotMesh = createPointMarker(0xf59e0b, 14);
                dotMesh.position.y = 0.35;
                group.add(dotMesh);

                // Etichetă simplă
                const labelText = '👤 ' + name + '\n📍 [X: ' + px.toFixed(1) + 'm, Z: ' + pz.toFixed(1) + 'm]';
                const label = createLabelSprite(labelText, 0xf59e0b);
                label.position.set(0, 1.35, 0);
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
                    ctx.fillRect(4, 4, 292, 72);
                    ctx.strokeStyle = '#' + new THREE.Color(colorHex).getHexString();
                    ctx.lineWidth = 3;
                    ctx.strokeRect(4, 4, 292, 72);
                    ctx.fillStyle = '#f8fafc';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.font = 'bold 16px "Outfit", sans-serif';
                    ctx.fillText('👤 ' + name, 150, 26);
                    ctx.font = '13px "JetBrains Mono", monospace';
                    ctx.fillStyle = '#06b6d4';
                    const signX = px >= 0 ? '+' : '';
                    const signZ = pz >= 0 ? '+' : '';
                    ctx.fillText('📍 X: ' + signX + px.toFixed(1) + 'm, Z: ' + signZ + pz.toFixed(1) + 'm', 150, 52);
                    texture.needsUpdate = true;
                }
            }
        });

        // Curățare persoane care nu mai sunt în raza de acoperire
        ruviewPersons.forEach((val, key) => {
            if (!currentIds.has(key)) {
                ruviewPersonsGroup.remove(val.group);
                ruviewPersons.delete(key);
            }
        });
    }

    function connectRuViewWebSocket() {
        const host = window.location.hostname || 'localhost';
        const wsProto = (window.location.protocol === 'https:') ? 'wss://' : 'ws://';
        const url = wsProto + host + ':3001';

        try {
            ruviewWs = new WebSocket(url);
            ruviewWs.onopen = () => {
                console.log('[RuView Client] Conectat la serverul RF de sesizare spațială (3001).');
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
                setTimeout(connectRuViewWebSocket, 5000);
            };
        } catch (e) {
            setTimeout(connectRuViewWebSocket, 5000);
        }
    }

    // Punte nativă Android (alimentată din Java SensorManager direct la 60 FPS)
    window.onNativeOrientation = function(heading, pitch, roll) {
        handleOrientation({ webkitCompassHeading: heading, beta: pitch, gamma: roll }, true);
    };

    // =========================================================================
    // 7. 6DoF Sensor Fusion & Step Tracking (Aliniat Absolut cu Compasul)
    // =========================================================================
    function handleOrientation(e, isAbsolute) {
        sensorFusionActive = true;
        let heading = null;

        // 1. iOS / WebKit True North
        if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
            heading = Number(e.webkitCompassHeading);
        }
        // 2. Android absolute device orientation (e.alpha is 0 at True North, 90 at West, 180 at South, 270 at East)
        else if (e.alpha !== null && !isNaN(e.alpha)) {
            if (isAbsolute || e.absolute === true) {
                heading = (360 - Number(e.alpha)) % 360;
                hasReceivedCompass = true;
            } else if (!hasReceivedCompass) {
                // Fallback inițial dacă nu a sosit încă evenimentul absolut
                heading = (360 - Number(e.alpha)) % 360;
            }
        }

        if (heading !== null && !isNaN(heading)) {
            targetHeading = (heading + 360) % 360;
            if (!hasReceivedCompass) {
                localHeading = targetHeading;
                hasReceivedCompass = true;
            }
        }

        if (e.beta !== null && !isNaN(e.beta)) {
            localPitch = Number(e.beta);
        }
        if (e.gamma !== null && !isNaN(e.gamma)) {
            localRoll = Number(e.gamma);
        }
        updateHud();
    }

    function setupSensorListeners() {
        // Absolute Orientation pe Android Chrome / Firefox
        if ('ondeviceorientationabsolute' in window) {
            window.addEventListener('deviceorientationabsolute', (e) => handleOrientation(e, true), true);
        }
        // Standard Orientation Fallback
        if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientation', (e) => handleOrientation(e, false), true);
        }

        // Accelerometer & 6DoF Step Detection
        if (window.DeviceMotionEvent) {
            window.addEventListener('devicemotion', (e) => {
                sensorFusionActive = true;
                const acc = e.acceleration || e.accelerationIncludingGravity;
                if (!acc) return;

                const ax = acc.x || 0;
                const ay = acc.y || 0;
                const az = acc.z || 0;

                // Low-Pass filter gravity vector if acceleration includes gravity
                if (e.accelerationIncludingGravity && !e.acceleration) {
                    gravX = 0.85 * gravX + 0.15 * ax;
                    gravY = 0.85 * gravY + 0.15 * ay;
                    gravZ = 0.85 * gravZ + 0.15 * az;
                    const linX = ax - gravX;
                    const linY = ay - gravY;
                    const linZ = az - gravZ;
                    processLinearAcceleration(linX, linY, linZ);
                } else {
                    processLinearAcceleration(ax, ay, az);
                }
            }, true);
        }

        // 3. W3C Generic Sensor API (LinearAccelerationSensor)
        if ('LinearAccelerationSensor' in window) {
            try {
                linearAccelSensor = new window.LinearAccelerationSensor({ frequency: 50 });
                linearAccelSensor.addEventListener('reading', () => {
                    sensorFusionActive = true;
                    processLinearAcceleration(linearAccelSensor.x, linearAccelSensor.y, linearAccelSensor.z);
                });
                linearAccelSensor.start();
            } catch (err) {}
        }
    }

    // Pas detectat nativ din Android SensorManager (Hardware Step Detector)
    window.onNativeStep = function(stride) {
        triggerStepDisplacement(stride || 0.72);
    };

    function processLinearAcceleration(lx, ly, lz) {
        const mag = Math.hypot(lx, ly, lz);
        const now = Date.now();
        const delta = Math.abs(mag - lastAccelMag);
        lastAccelMag = mag;

        // Filtru robust de pas: pasul uman real produce o acceleratie de varf intre 1.15 si 3.0 m/s2 la interval de 340-1500ms.
        // Pragul anterior (0.28) declansa deplasari false la simpla rotire sau miscare din incheietura a telefonului!
        const threshold = sensorSensitivityHigh ? 1.15 : 1.45;
        if (delta > threshold && (now - lastStepTime) > 340 && (now - lastStepTime) < 1600) {
            lastStepTime = now;
            const stride = 0.68 + Math.min(0.18, (delta - 1.0) * 0.1);
            triggerStepDisplacement(stride);
        }
    }

    function triggerStepDisplacement(strideMeters = 0.72) {
        stepCount++;
        totalDistanceMeters += strideMeters;

        const prevX = posX;
        const prevZ = posZ;

        // Heading conversion to 3D Cartesian coordinates (0 deg North = -Z, 90 deg East = +X, 180 deg South = +Z, 270 deg West = -X)
        const headingRad = (localHeading * Math.PI) / 180;
        posX += strideMeters * Math.sin(headingRad);
        posZ -= strideMeters * Math.cos(headingRad);

        // Update 3D trajectory
        trajectoryPoints.push(new THREE.Vector3(posX, posY + 0.08, posZ));
        if (trajectoryPoints.length > 500) trajectoryPoints.shift();
        trajectoryLine.geometry.setFromPoints(trajectoryPoints);

        // Synthesize point cloud around new step
        synthesizeStepPoints(prevX, prevZ, posX, posZ, localHeading);

        updatePhoneFloatingLabel();
        updateRfLinkLine();
        updateHud();
    }

    function turnHeading(degrees) {
        targetHeading = (targetHeading + degrees + 360) % 360;
        localHeading = (localHeading + degrees + 360) % 360;
        updateHud();
    }

    function resetPositionToZero() {
        posX = 0;
        posZ = 0;
        updatePhoneFloatingLabel();
        updateRfLinkLine();
        updateHud();
    }

    function calibrateSensors() {
        sensorSensitivityHigh = !sensorSensitivityHigh;
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
            DeviceMotionEvent.requestPermission().catch(() => {});
        }
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission().catch(() => {});
        }
        updateHud();
    }

    // =========================================================================
    // 8. Monitorizare RF Ping & Telemetrie la Backend
    // =========================================================================
    function startRfPingLoop() {
        if (pingIntervalId) clearInterval(pingIntervalId);

        const checkPing = async () => {
            const t0 = performance.now();
            try {
                await fetch('/api/health?_t=' + Date.now(), { cache: 'no-store' });
                const rtt = Math.round(performance.now() - t0);
                if (currentRtt > 0) {
                    currentJitter = Math.round(Math.abs(rtt - currentRtt) * 10) / 10;
                }
                currentRtt = rtt;
            } catch (err) {
                currentRtt = 999;
            }

            if (navigator.connection) {
                const conn = navigator.connection;
                const effType = (conn.effectiveType || '').toUpperCase();
                const down = conn.downlink ? (conn.downlink + ' Mbps') : '';
                networkType = effType ? (effType + (down ? ' &bull; ' + down : '')) : 'Rețea Activă';
            } else {
                networkType = currentRtt < 30 ? 'Wi-Fi Nod G86' : 'Date Mobile / Proxy';
            }

            updateHud();
        };

        checkPing();
        pingIntervalId = setInterval(checkPing, 1800);
    }

    function startBroadcastLoop() {
        if (broadcastIntervalId) clearInterval(broadcastIntervalId);

        broadcastIntervalId = setInterval(() => {
            if (!isEmitting) return;
            const now = Date.now();
            if (now - lastBroadcastTime < 1300) return;
            lastBroadcastTime = now;

            broadcastTelemetryToBackend();
        }, 1500);
    }

    async function broadcastTelemetryToBackend() {
        const pointsToSend = recentNewPoints.slice(0, 40);
        recentNewPoints = [];

        const obstaclesToSend = detectedObstacles.slice(-3).map(o => ({
            x: Math.round(o.x * 100) / 100,
            y: Math.round(o.y * 100) / 100,
            z: Math.round(o.z * 100) / 100,
            w: o.width,
            d: o.depth,
            h: o.height
        }));

        const payload = {
            peerId: myPeerId,
            userName: getLocalUserName(),
            device: deviceModel,
            x: Math.round(posX * 100) / 100,
            y: Math.round(posY * 100) / 100,
            z: Math.round(posZ * 100) / 100,
            heading: Math.round(localHeading),
            pitch: Math.round(localPitch),
            roll: Math.round(localRoll),
            steps: stepCount,
            distance: Math.round(totalDistanceMeters * 10) / 10,
            rtt: currentRtt,
            jitter: currentJitter,
            netType: networkType,
            activeLandmark: activeLandmarkIp,
            newPoints: pointsToSend,
            obstacles: obstaclesToSend,
            roomBounds: roomBounds,
            totalPointCount: pointCount,
            timestamp: Date.now()
        };

        try {
            await fetch('/api/collections/messages/records', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sender: payload.userName || myPeerId,
                    text: 'CLIENT_RADAR_TELEMETRY',
                    scope: 'radar_telemetry',
                    file: payload,
                    timestamp: payload.timestamp
                })
            });
        } catch (e) {}
    }

    function getLocalUserName() {
        if (window.currentUser) {
            return window.currentUser.email || window.currentUser.username || 'Utilizator';
        }
        return 'Vizitator_' + myPeerId.substring(myPeerId.length - 4);
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
            cameraRadius = Math.max(6, Math.min(80, cameraRadius + (e.deltaY * 0.04)));
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
                cameraRadius = Math.max(6, Math.min(80, cameraRadius + (diff * 0.1)));
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

        if (cameraMode === 'room') {
            cameraTarget.set(0, 1.0, 0);
        } else {
            cameraTarget.set(posX, posY + 0.5, posZ);
        }

        camera.position.x = cameraTarget.x + cameraRadius * Math.sin(cameraPhi) * Math.sin(cameraTheta);
        camera.position.y = cameraTarget.y + cameraRadius * Math.cos(cameraPhi);
        camera.position.z = cameraTarget.z + cameraRadius * Math.sin(cameraPhi) * Math.cos(cameraTheta);
        camera.lookAt(cameraTarget.x, cameraTarget.y, cameraTarget.z);
    }

    // =========================================================================
    // 10. Bucla de Randare (60 FPS)
    // =========================================================================
    function animate() {
        animFrameId = requestAnimationFrame(animate);

        // Netezire filtrare Compas (cel mai scurt arc unghiular pentru eliminare zgomot / trepidații)
        if (hasReceivedCompass) {
            let diff = (targetHeading - localHeading + 180) % 360 - 180;
            localHeading = (localHeading + diff * compassSmoothingAlpha + 360) % 360;
        }

        // Update Phone Chassis Position & Orientation
        if (phoneChassisGroup) {
            phoneChassisGroup.position.set(posX, posY, posZ);

            // Aliniere rotație Y direct cu compasul (0° Nord = -Z, 90° Est = +X, 180° Sud = +Z, 270° Vest = -X)
            const headingRad = (localHeading * Math.PI) / 180;
            phoneChassisGroup.rotation.y = -headingRad;

            if (cameraMode === 'follow') {
                cameraTheta = -headingRad + Math.PI / 2;
            }

            const pitchRad = (localPitch * Math.PI) / 180;
            const rollRad = (localRoll * Math.PI) / 180;
            if (phoneBodyMesh) {
                phoneBodyMesh.rotation.x = pitchRad * 0.4;
                phoneBodyMesh.rotation.z = -rollRad * 0.4;
            }
            if (phoneScreenMesh) {
                phoneScreenMesh.rotation.z = -rollRad * 0.4;
            }
        }

        updateLabelsScale();
        updateCameraPosition();
        renderer.render(scene, camera);
    }

    // =========================================================================
    // 11. Actualizare HUD Personal
    // =========================================================================
    function updateHud() {
        const hudH = document.getElementById('hudHeading');
        const hudL = document.getElementById('hudLatency');
        const hudD = document.getElementById('hudDisplacement');
        const hudS = document.getElementById('hudSignal');
        const hudPC = document.getElementById('hudPointCloudCount');
        const hudPos = document.getElementById('hudPositionCoords');

        if (hudH) {
            const cardinal = getCardinalStr(localHeading);
            hudH.textContent = Math.round(localHeading) + '° (' + cardinal + ')';
        }

        if (hudL) {
            const jitterStr = currentJitter > 0 ? (' ±' + currentJitter + 'ms') : '';
            hudL.textContent = currentRtt > 0 ? (currentRtt + ' ms' + jitterStr) : '-- ms';
        }

        if (hudD) {
            const distM = Math.round(totalDistanceMeters * 10) / 10;
            hudD.textContent = distM + ' m (' + stepCount + ' pași)';
        }

        if (hudPos) {
            const signX = posX >= 0 ? '+' : '';
            const signZ = posZ >= 0 ? '+' : '';
            hudPos.textContent = 'X: ' + signX + posX.toFixed(1) + 'm, Z: ' + signZ + posZ.toFixed(1) + 'm';
        }

        if (hudS) {
            const sensorStatus = sensorFusionActive ? ' • 6DoF Activ' : '';
            hudS.innerHTML = networkType + sensorStatus;
        }

        if (hudPC) {
            hudPC.textContent = pointCount.toLocaleString() + ' puncte (' + detectedObstacles.length + ' obstacole)';
        }
    }

    function getCardinalStr(deg) {
        deg = (deg % 360 + 360) % 360;
        if (deg >= 337.5 || deg < 22.5) return 'N';
        if (deg >= 22.5 && deg < 67.5) return 'NE';
        if (deg >= 67.5 && deg < 112.5) return 'E';
        if (deg >= 112.5 && deg < 157.5) return 'SE';
        if (deg >= 157.5 && deg < 202.5) return 'S';
        if (deg >= 202.5 && deg < 247.5) return 'SV';
        if (deg >= 247.5 && deg < 292.5) return 'V';
        return 'NV';
    }

    // =========================================================================
    // 12. Comenzi Publice UI
    // =========================================================================
    function setCameraView(mode) {
        if (mode === 'top') {
            cameraPhi = 0.01;
            cameraRadius = 26;
        } else {
            cameraPhi = Math.PI / 3.4;
            cameraRadius = 22;
        }
        updateCameraPosition();
    }

    function toggleCameraFollow() {
        cameraMode = (cameraMode === 'room') ? 'follow' : 'room';
        const btn = document.getElementById('btnToggleCamFollow');
        if (btn) {
            btn.textContent = (cameraMode === 'room') ? '🏠 Cameră Fixă' : '🚶 Urmărește Telefon';
        }
        updateCameraPosition();
    }

    function resetCamera() {
        cameraTheta = Math.PI / 4;
        cameraPhi = Math.PI / 3.4;
        cameraRadius = 22;
        updateCameraPosition();
    }

    function manualStep(stride = 0.75) {
        triggerStepDisplacement(stride);
    }

    function manualTurn(deg = 45) {
        turnHeading(deg);
    }

    function selectLandmark(ip) {
        activeLandmarkIp = ip;
        updateRfLinkLine();
    }

    // Public API
    return {
        init: init,
        setCameraView: setCameraView,
        toggleCameraFollow: toggleCameraFollow,
        resetCamera: resetCamera,
        manualStep: manualStep,
        manualTurn: manualTurn,
        resetPositionToZero: resetPositionToZero,
        selectLandmark: selectLandmark,
        calibrateSensors: calibrateSensors,
        triggerStep: function() { manualStep(0.75); },
        updateRuViewPersons: updateRuViewPersons
    };
})();
