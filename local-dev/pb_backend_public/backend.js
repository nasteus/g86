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

// State for open dropdown panels per client
const openUserLogs = new Set();
const openUserData = new Set();
let cachedClients = [];

function toggleUserLogs(clientKey, e) {
    if (e) e.stopPropagation();
    if (openUserLogs.has(clientKey)) {
        openUserLogs.delete(clientKey);
    } else {
        openUserLogs.add(clientKey);
    }
    renderConnections(cachedClients);
}

function toggleUserData(clientKey, e) {
    if (e) e.stopPropagation();
    if (openUserData.has(clientKey)) {
        openUserData.delete(clientKey);
    } else {
        openUserData.add(clientKey);
    }
    renderConnections(cachedClients);
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Monitor active connections
let monitorTimer = null;
function startConnectionsMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    fetchActiveConnections();
    monitorTimer = setInterval(fetchActiveConnections, 2000);
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
    cachedClients = clients || [];
    const title = document.getElementById('titleConnections');
    const list = document.getElementById('connectionsList');
    if (!title || !list) return;

    title.textContent = `Conexiuni active (${cachedClients.length})`;

    if (cachedClients.length === 0) {
        list.innerHTML = '<div class="empty-state">Nicio conexiune activă în acest moment</div>';
        return;
    }

    list.innerHTML = '';
    cachedClients.forEach(client => {
        const clientKey = client.ip;
        const isAuth = client.email && client.email.length > 0;
        const displayUser = isAuth ? client.email : 'Vizitator (Nelogat)';
        const isLogsOpen = openUserLogs.has(clientKey);
        const isDataOpen = openUserData.has(clientKey);

        const card = document.createElement('div');
        card.className = 'connection-card';
        card.id = `card-${clientKey.replace(/[^a-zA-Z0-9]/g, '_')}`;

        // Logs HTML
        const userLogs = client.logs || [];
        let logsHtml = '';
        if (userLogs.length === 0) {
            logsHtml = '<div class="log-entry system">[Sistem] Așteptare evenimente de la acest utilizator...</div>';
        } else {
            logsHtml = userLogs.map(l => {
                const entryType = l.type || 'info';
                return `<div class="log-entry ${entryType}">${escapeHtml(l.text)}</div>`;
            }).join('');
        }

        card.innerHTML = `
            <div class="conn-row">
                <div class="conn-main-info" onclick="toggleUserLogs('${clientKey}', event)" title="Click pentru a extinde/restrânge consola live cu loguri">
                    <span class="conn-chevron ${isLogsOpen ? 'open' : ''}">▼</span>
                    <div class="conn-details">
                        <span class="conn-main ${isAuth ? 'auth' : 'guest'}">
                            ${escapeHtml(displayUser)}  •  ${escapeHtml(client.type || 'Wi-Fi')}  •  ${escapeHtml(client.ip)}
                        </span>
                        <span class="conn-sub ${isAuth ? 'auth' : 'guest'}">
                            <span class="pulse-dot ${isAuth ? 'auth' : 'guest'}"></span>
                            ${isAuth ? 'Stare: Autentificat & Activ' : 'Stare: Conectat (Neautentificat)'}
                            ${client.inactiveSeconds > 0 ? ` • ${client.inactiveSeconds}s în urmă` : ' • Activ acum'}
                        </span>
                    </div>
                </div>
                <div class="conn-actions">
                    <button class="btn-refresh-row" onclick="refreshClientRow('${client.ip}', '${client.email || ''}', event)" title="Verifică această conexiune">
                        🔄
                    </button>
                    <button class="btn-user-data ${isDataOpen ? 'active' : ''}" onclick="toggleUserData('${clientKey}', event)" title="Afișează datele utilizatorului">
                        👤 Date
                    </button>
                </div>
            </div>

            <!-- Dropdown 1: Live User Activity Log Console -->
            <div class="user-logs-panel ${isLogsOpen ? '' : 'hidden'}" id="logs-${clientKey.replace(/[^a-zA-Z0-9]/g, '_')}">
                <div class="user-logs-header">
                    <span>CONSOLE LOG LIVE: ${escapeHtml(displayUser)}</span>
                    <span class="badge-live">LIVE</span>
                </div>
                <div class="user-logs-terminal" id="terminal-${clientKey.replace(/[^a-zA-Z0-9]/g, '_')}">
                    ${logsHtml}
                </div>
            </div>

            <!-- Dropdown 2: User Data Profile Card -->
            <div class="user-data-panel ${isDataOpen ? '' : 'hidden'}" id="data-${clientKey.replace(/[^a-zA-Z0-9]/g, '_')}">
                <div class="user-data-title">Date profil &amp; detalii sesiune</div>
                <div class="data-grid">
                    <div class="data-row">
                        <span class="data-label">Email / Cont:</span>
                        <span class="data-val ${isAuth ? 'auth' : 'guest'}">${escapeHtml(client.email || 'Neautentificat (Vizitator)')}</span>
                    </div>
                    <div class="data-row">
                        <span class="data-label">Stare Autentificare:</span>
                        <span class="data-val ${isAuth ? 'auth' : 'guest'}">${isAuth ? 'Autentificat (Sesiune activă)' : 'Sesiune oaspete'}</span>
                    </div>
                    <div class="data-row">
                        <span class="data-label">IP &amp; Tip Rețea:</span>
                        <span class="data-val">${escapeHtml(client.ip)} (${escapeHtml(client.type || 'Wi-Fi')})</span>
                    </div>
                    <div class="data-row">
                        <span class="data-label">Securitate Canal:</span>
                        <span class="data-val secure">🔒 AES-256-GCM / PBKDF2</span>
                    </div>
                    <div class="data-row">
                        <span class="data-label">Browser / User-Agent:</span>
                        <span class="data-val" title="${escapeHtml(client.userAgent || 'Necunoscut')}">${escapeHtml(client.userAgent || 'Necunoscut')}</span>
                    </div>
                    <div class="data-row">
                        <span class="data-label">Ultimul semnal primit:</span>
                        <span class="data-val">${client.inactiveSeconds}s în urmă</span>
                    </div>
                </div>
            </div>
        `;

        list.appendChild(card);

        if (isLogsOpen) {
            const terminal = card.querySelector('.user-logs-terminal');
            if (terminal) terminal.scrollTop = terminal.scrollHeight;
        }
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
