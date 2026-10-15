// backend.js - G86 Node Dashboard Controller (PC & Android Hybrid)

let isServerRunning = true;
let knownLogCount = 0;

document.addEventListener('DOMContentLoaded', () => {
    initQrCode();
    initHardwareStats();
    startConnectionsMonitor();
    startLogsMonitor();
    appendLog('[PocketBase] Serviciu pornit pe port 8787 / 8090.', 'success');
});

function toggleDropdown(contentId, arrowId) {
    const content = document.getElementById(contentId);
    const arrow = document.getElementById(arrowId);
    if (!content || !arrow) return;

    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        arrow.textContent = '▲';
    } else {
        content.classList.add('hidden');
        arrow.textContent = '▼';
    }
}

function initQrCode() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas || typeof QRCode === 'undefined') return;

    const url = 'http://192.168.1.137:8080';
    QRCode.toCanvas(canvas, url, {
        width: 160,
        margin: 1,
        color: {
            dark: '#0a0e17',
            light: '#ffffff'
        }
    }, (err) => {
        if (err) console.error('Eroare la generare QR:', err);
    });
}

function initHardwareStats() {
    if (window.Android && window.Android.getBatteryLevel) {
        try {
            const battery = window.Android.getBatteryLevel();
            document.getElementById('valBattery').textContent = battery + '%';
            const ram = window.Android.getRamUsage();
            document.getElementById('valRam').textContent = ram;
            return;
        } catch (e) {
            console.warn('Android bridge error:', e);
        }
    }

    if (navigator.getBattery) {
        navigator.getBattery().then(battery => {
            updateBatteryDisplay(battery);
            battery.addEventListener('levelchange', () => updateBatteryDisplay(battery));
            battery.addEventListener('chargingchange', () => updateBatteryDisplay(battery));
        }).catch(() => {});
    }

    if (navigator.deviceMemory) {
        document.getElementById('valRam').textContent = `${navigator.deviceMemory} GB (Disponibil)`;
    }
}

function updateBatteryDisplay(battery) {
    const pct = Math.round(battery.level * 100);
    const charging = battery.charging ? ' ⚡' : '';
    document.getElementById('valBattery').textContent = `${pct}%${charging}`;
}

function copyText(elemId) {
    const elem = document.getElementById(elemId);
    if (!elem) return;
    const text = elem.textContent.trim();
    navigator.clipboard.writeText(text).then(() => {
        appendLog(`[Clip] Copiat în clipboard: ${text}`, 'info');
    });
}

function clearLogs() {
    const logs = document.getElementById('consoleLogs');
    if (logs) logs.innerHTML = '';
}

function appendLog(msg, type = 'system') {
    const logs = document.getElementById('consoleLogs');
    if (!logs) return;

    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${time}] ${msg}`;
    logs.appendChild(entry);
    logs.scrollTop = logs.scrollHeight;
}

// Manual Refresh for title bar
async function manualRefreshConnections(e) {
    if (e) e.stopPropagation();
    appendLog('[Conexiuni] Reîmprospătare manuală a listei de conexiuni...', 'info');
    await fetchActiveConnections();
}

// Manual Refresh for single connection row
async function refreshClientRow(ip, email, e) {
    if (e) e.stopPropagation();
    const userLabel = email || ip;
    appendLog(`[Conexiuni] Ping verificare pentru: ${userLabel}...`, 'info');
    try {
        await fetch('/api/refresh-client', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, email })
        });
        appendLog(`[Conexiuni] Conexiune confirmată activă: ${userLabel}`, 'success');
        await fetchActiveConnections();
    } catch (err) {
        appendLog(`[Conexiuni] Eroare ping: ${err.message}`, 'warn');
    }
}

// Monitor active connections
let monitorTimer = null;
function startConnectionsMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    fetchActiveConnections();
    monitorTimer = setInterval(fetchActiveConnections, 3000);
}

async function fetchActiveConnections() {
    try {
        // 1. Android Bridge Check
        if (window.Android && window.Android.getActiveClientsJson) {
            try {
                const clientsJson = window.Android.getActiveClientsJson();
                const clients = JSON.parse(clientsJson);
                renderConnections(clients);
                return;
            } catch (ignored) {}
        }

        // 2. Fetch from active clients endpoint
        const res = await fetch('/api/active-clients', { cache: 'no-store' });
        if (res.ok) {
            const clients = await res.json();
            renderConnections(clients);
        }
    } catch (err) {
        // Silent fail
    }
}

function renderConnections(clients) {
    const title = document.getElementById('titleConnections');
    const list = document.getElementById('connectionsList');
    if (!title || !list) return;

    title.textContent = `Conexiuni active (${clients.length})`;

    if (clients.length === 0) {
        list.innerHTML = '<div class="empty-state">Nicio conexiune activă în acest moment</div>';
        return;
    }

    list.innerHTML = '';
    clients.forEach(client => {
        const item = document.createElement('div');
        item.className = 'connection-item';

        const isAuth = client.email && client.email.length > 0;
        const displayUser = isAuth ? client.email : 'Vizitator (Nelogat)';

        item.innerHTML = `
            <div class="conn-details">
                <span class="conn-main ${isAuth ? 'auth' : 'guest'}">${displayUser}  •  ${client.type}  •  ${client.ip}</span>
                <span class="conn-sub ${isAuth ? 'auth' : 'guest'}">${isAuth ? 'Stare: Autentificat & Activ' : 'Stare: Conectat (Neautentificat)'}</span>
            </div>
            <button class="btn-refresh-row" onclick="refreshClientRow('${client.ip}', '${client.email || ''}', event)" title="Verifică această conexiune">
                🔄
            </button>
        `;
        list.appendChild(item);
    });
}

// Server logs stream
let logsTimer = null;
function startLogsMonitor() {
    if (logsTimer) clearInterval(logsTimer);
    fetchServerLogs();
    logsTimer = setInterval(fetchServerLogs, 2500);
}

async function fetchServerLogs() {
    try {
        const res = await fetch('/api/server-logs', { cache: 'no-store' });
        if (!res.ok) return;
        const logs = await res.json();
        if (logs.length > knownLogCount) {
            const newEntries = logs.slice(knownLogCount);
            newEntries.forEach(log => {
                appendLog(log.text, log.type || 'system');
            });
            knownLogCount = logs.length;
        }
    } catch (e) {}
}
