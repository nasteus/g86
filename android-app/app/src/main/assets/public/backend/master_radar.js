// master_radar.js - G86 Backend Master 3D Spatial Synthesizer
// Aggregates Multi-Node Telemetry & Cumulative Point Clouds • Runs on Moto G86 Node Master

window.MasterRadarEngine = (function() {
    'use strict';

    // State
    let isInitialized = false;
    let scene, camera, renderer;
    let canvasWrapperEl;
    let animFrameId = null;

    // 3D Master Scene Objects
    let beaconGroup, rippleRings = [], radarSweepMesh;
    let globalGrid, rangeRingsGroup;

    // Active Remote Nodes Map: peerId -> NodeObj
    let remoteNodes = new Map();

    // Node Color Palette for Multi-User distinction
    const PALETTE = [
        0x06b6d4, // Cyan (e.g. S25 Ultra)
        0xf59e0b, // Amber
        0xf43f5e, // Rose
        0x10b981, // Emerald
        0x3b82f6  // Royal Blue
    ];

    // Master Unified Cumulative Point Cloud (Combines all users' point clouds)
    const MAX_GLOBAL_POINTS = 50000;
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
    let focusedNodeId = null;

    // Real-time SSE & Polling
    let sseConnection = null;
    let pollIntervalId = null;
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

        // Scene & Fog
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x060911);
        scene.fog = new THREE.FogExp2(0x060911, 0.012);

        // Camera
        camera = new THREE.PerspectiveCamera(48, width / height, 0.5, 350);
        updateCameraPosition();

        // High-Performance WebGL Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        canvasWrapperEl.appendChild(renderer.domElement);

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        scene.add(ambientLight);

        const purpleBeaconLight = new THREE.PointLight(0xa855f7, 2.5, 60);
        purpleBeaconLight.position.set(0, 10, 0);
        scene.add(purpleBeaconLight);

        // Build Environment & Central Moto G86 Beacon
        buildMasterEnvironment();
        buildMotoG86CentralBeacon();
        initMasterPointCloud();

        // Setup Controls & Real-Time Telemetry Listener
        setupInteractionHandlers();
        initTelemetryStream();

        // Start Animation Loop
        animate();

        console.log('[Master Radar] Engine 3D pornit pe nodul central Moto G86.');
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
        scene.add(sprite);
    }

    // =========================================================================
    // 3. Nod Central: Moto G86 Beacon Transmitter
    // =========================================================================
    function buildMotoG86CentralBeacon() {
        beaconGroup = new THREE.Group();

        // Tower Chassis
        const towerGeo = new THREE.CylinderGeometry(0.35, 0.85, 3.8, 8);
        const towerMat = new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.3, metalness: 0.8 });
        const tower = new THREE.Mesh(towerGeo, towerMat);
        tower.position.y = 1.9;
        beaconGroup.add(tower);

        // Core Sphere
        const coreGeo = new THREE.SphereGeometry(0.7, 16, 16);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xa855f7, wireframe: true });
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.position.y = 4.0;
        beaconGroup.add(core);

        // Radar Sweep Line
        const sweepGeo = new THREE.BufferGeometry();
        sweepGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0.1, 0, 0, 0.1, -55]), 3));
        const sweepMat = new THREE.LineBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.8 });
        radarSweepMesh = new THREE.Line(sweepGeo, sweepMat);
        beaconGroup.add(radarSweepMesh);

        // Expanding RF Ripples
        for (let i = 0; i < 4; i++) {
            const rippleGeo = new THREE.RingGeometry(0.1, 0.4, 32);
            const rippleMat = new THREE.MeshBasicMaterial({
                color: 0xa855f7,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.8
            });
            const ripple = new THREE.Mesh(rippleGeo, rippleMat);
            ripple.rotation.x = -Math.PI / 2;
            ripple.position.y = 0.05;
            ripple.userData = { radius: i * 8, maxRadius: 40, speed: 0.16 };
            rippleRings.push(ripple);
            beaconGroup.add(ripple);
        }

        // Beacon Label
        const beaconLabel = createLabelSprite('MOTO G86 (BEACON MASTER)', 0xa855f7);
        beaconLabel.position.set(0, 5.6, 0);
        beaconGroup.add(beaconLabel);

        scene.add(beaconGroup);
    }

    function createLabelSprite(text, colorHex) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(6, 9, 17, 0.85)';
        ctx.fillRect(4, 4, 248, 56);
        ctx.strokeStyle = '#' + new THREE.Color(colorHex).getHexString();
        ctx.lineWidth = 3;
        ctx.strokeRect(4, 4, 248, 56);

        ctx.font = 'bold 18px "Outfit", sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 128, 32);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.scale.set(5.5, 1.4, 1);
        return sprite;
    }

    // =========================================================================
    // 4. Master Unified Cumulative Point Cloud
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
        });

        masterPointGeometry.attributes.position.needsUpdate = true;
        masterPointGeometry.attributes.color.needsUpdate = true;
        masterPointGeometry.setDrawRange(0, masterPointCount);

        updateMasterHud();
    }

    // =========================================================================
    // 5. Integrare Noduri Utilizator (Multi-Device Stitching)
    // =========================================================================
    function getOrCreateRemoteNode(peerId, name, device) {
        if (remoteNodes.has(peerId)) {
            return remoteNodes.get(peerId);
        }

        const colorHex = PALETTE[remoteNodes.size % PALETTE.length];
        const group = new THREE.Group();

        // 3D Pointer / Frustum Arrow
        const arrowGeo = new THREE.ConeGeometry(0.7, 2.0, 4);
        const arrowMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.3, metalness: 0.7 });
        const arrow = new THREE.Mesh(arrowGeo, arrowMat);
        arrow.rotation.x = Math.PI / 2;
        arrow.position.y = 0.5;
        group.add(arrow);

        // Position Aura Sphere
        const auraGeo = new THREE.SphereGeometry(0.5, 16, 16);
        const auraMat = new THREE.MeshBasicMaterial({ color: colorHex, wireframe: true });
        const aura = new THREE.Mesh(auraGeo, auraMat);
        aura.position.y = 0.5;
        group.add(aura);

        // Floating 3D Tag
        const tagText = (device || 'Nod') + ' (' + (name ? name.split('@')[0] : peerId.substring(0, 5)) + ')';
        const tag = createLabelSprite(tagText, colorHex);
        tag.position.set(0, 2.8, 0);
        group.add(tag);

        // Trajectory Ribbon
        const trajGeo = new THREE.BufferGeometry();
        const trajMat = new THREE.LineBasicMaterial({ color: colorHex, linewidth: 2, transparent: true, opacity: 0.8 });
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
            arrow: arrow,
            aura: aura,
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

        // Update trajectory history
        const lastP = node.history[node.history.length - 1];
        if (!lastP || Math.hypot(lastP.x - x, lastP.z - z) > 0.35) {
            node.history.push({ x, y: y + 0.1, z });
            if (node.history.length > 300) node.history.shift();

            const pts = node.history.map(p => new THREE.Vector3(p.x, p.y, p.z));
            node.trajLine.geometry.setFromPoints(pts);
        }

        // Ingest new cumulative point cloud slice from this device
        if (data.newPoints && Array.isArray(data.newPoints)) {
            ingestRemotePoints(data.newPoints, node.color);
        }

        updateMasterHud();
    }

    // =========================================================================
    // 6. Real-Time Telemetry Listener (PocketBase SSE + Fast Polling)
    // =========================================================================
    function initTelemetryStream() {
        // SSE Real-Time Event Listener
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
            console.warn('[Master Radar] Fallback la polling...');
        }

        // Fast Polling Backup (every 1.5s for seamless multi-device catchup)
        const pollTelemetry = async () => {
            try {
                const res = await fetch('/api/collections/messages/records?filter=' + encodeURIComponent("(scope='radar_telemetry')") + '&sort=-timestamp&perPage=15', { cache: 'no-store' });
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
        pollIntervalId = setInterval(pollTelemetry, 1500);
    }

    // =========================================================================
    // 7. Interactive Camera Controls (Orbit, Zoom, Pan)
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
    // 8. Bucla de Randare (60 FPS)
    // =========================================================================
    function animate() {
        animFrameId = requestAnimationFrame(animate);

        // Sweep Line Rotation
        if (radarSweepMesh) radarSweepMesh.rotation.y += 0.035;

        // Ripple Rings Animation
        rippleRings.forEach(r => {
            r.userData.radius += r.userData.speed;
            if (r.userData.radius > r.userData.maxRadius) r.userData.radius = 0.2;
            const s = r.userData.radius;
            r.scale.set(s, s, s);
            r.material.opacity = Math.max(0, 0.75 * (1 - (s / r.userData.maxRadius)));
        });

        // Remote Nodes Smooth Interpolation & Link Beam
        remoteNodes.forEach(node => {
            node.group.position.lerp(node.targetPos, 0.15);

            const rotY = ((360 - node.targetHeading) * Math.PI) / 180;
            node.arrow.rotation.z = rotY;
            node.aura.rotation.y += 0.02;

            // Update RF Beam to Central Beacon
            const beamGeo = node.beamLine.geometry;
            const p1 = new THREE.Vector3(0, 1.9, 0);
            const p2 = node.group.position.clone().add(new THREE.Vector3(0, 0.5, 0));
            beamGeo.setFromPoints([p1, p2]);
            node.beamLine.computeLineDistances();
        });

        // Follow focused node if selected
        if (focusedNodeId && remoteNodes.has(focusedNodeId)) {
            const fNode = remoteNodes.get(focusedNodeId);
            cameraTarget.lerp(fNode.group.position, 0.1);
            updateCameraPosition();
        }

        renderer.render(scene, camera);
    }

    // =========================================================================
    // 9. Master HUD Update
    // =========================================================================
    function updateMasterHud() {
        const elNodes = document.getElementById('masterHudActiveNodes');
        const elPoints = document.getElementById('masterHudTotalPoints');
        const elArea = document.getElementById('masterHudArea');
        const elList = document.getElementById('masterNodesList');

        const totalActive = remoteNodes.size + 1; // +1 Moto G86
        if (elNodes) elNodes.textContent = totalActive + ' Noduri Active';
        if (elPoints) elPoints.textContent = masterPointCount.toLocaleString() + ' puncte 3D';

        // Area estimate based on point bounding box
        if (elArea) {
            const areaM2 = Math.round(Math.max(25, masterPointCount * 0.08) * 10) / 10;
            elArea.textContent = '~' + areaM2 + ' m² sintetizați';
        }

        if (elList) {
            let html = '';
            remoteNodes.forEach(node => {
                const dist = Math.round(Math.hypot(node.targetPos.x, node.targetPos.z) * 10) / 10;
                const clrHex = '#' + new THREE.Color(node.color).getHexString();
                html += `
                    <div class="master-node-item">
                        <span class="master-node-bullet" style="background-color: ${clrHex}; box-shadow: 0 0 6px ${clrHex};"></span>
                        <div class="master-node-meta">
                            <strong>${escapeHtml(node.device || 'Nod')}</strong>
                            <span>${escapeHtml(node.userName || node.peerId)} &bull; ${dist}m &bull; ${node.steps} pași &bull; ${node.rtt}ms</span>
                        </div>
                        <button type="button" class="btn-focus-node" onclick="MasterRadarEngine.focusNode('${node.peerId}')">🎯 Urmărește</button>
                    </div>
                `;
            });
            elList.innerHTML = html || '<div class="empty-state">Așteptare conectare utilizatori...</div>';
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // =========================================================================
    // 10. Controale Publice UI
    // =========================================================================
    function setCameraView(mode) {
        focusedNodeId = null;
        if (mode === 'top') {
            cameraPhi = 0.01;
            cameraRadius = 45;
            cameraTarget.set(0, 0, 0);
        } else {
            cameraPhi = Math.PI / 3.4;
            cameraRadius = 38;
            cameraTarget.set(0, 0, 0);
        }
        updateCameraPosition();
    }

    function resetCamera() {
        focusedNodeId = null;
        cameraTheta = Math.PI / 4;
        cameraPhi = Math.PI / 3.4;
        cameraRadius = 38;
        cameraTarget.set(0, 0, 0);
        updateCameraPosition();
    }

    function focusNode(peerId) {
        if (remoteNodes.has(peerId)) {
            focusedNodeId = peerId;
            cameraRadius = 22;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 300);
    });

    return {
        init: init,
        setCameraView: setCameraView,
        resetCamera: resetCamera,
        focusNode: focusNode
    };
})();
