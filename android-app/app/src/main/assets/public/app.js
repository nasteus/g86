// app.js - PocketBase Client & Web Worker Orchestrator

let currentUser = null;
let authToken = localStorage.getItem('pb_auth_token');
let authModel = localStorage.getItem('pb_auth_model');

let worker = null;
let isWorkerRunning = false;
let totalMatches = 0;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    checkExistingAuth();
    detectHardware();
});

function detectHardware() {
    const threads = navigator.hardwareConcurrency || 4;
    const threadElem = document.getElementById('metricThreads');
    if (threadElem) threadElem.innerText = threads;
    addLog(`[Client] Hardware detectat: ${threads} thread-uri CPU disponibile pe acest dispozitiv.`, 'info');
}

function switchAuthTab(tab) {
    const tabLogin = document.getElementById('tabLogin');
    const tabRegister = document.getElementById('tabRegister');
    const formLogin = document.getElementById('formLogin');
    const formRegister = document.getElementById('formRegister');
    clearFeedback();

    if (tab === 'login') {
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        formLogin.classList.remove('hidden');
        formRegister.classList.add('hidden');
    } else {
        tabLogin.classList.remove('active');
        tabRegister.classList.add('active');
        formLogin.classList.add('hidden');
        formRegister.classList.remove('hidden');
    }
}

function showFeedback(msg, type = 'error') {
    const fb = document.getElementById('authFeedback');
    fb.className = `feedback-msg ${type}`;
    fb.innerText = msg;
    fb.classList.remove('hidden');
}

function clearFeedback() {
    const fb = document.getElementById('authFeedback');
    fb.classList.add('hidden');
}

// Authentication
async function handleLogin(e) {
    e.preventDefault();
    clearFeedback();
    const identity = document.getElementById('loginIdentity').value.trim();
    const password = document.getElementById('loginPassword').value;

    const btn = document.getElementById('btnLogin');
    btn.disabled = true;
    btn.innerText = "Se autentifică...";

    try {
        const res = await fetch('/api/collections/users/auth-with-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity, password })
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || 'Date de autentificare incorecte.');
        }

        loginSuccess(data.record, data.token);
    } catch (err) {
        showFeedback(err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = "Intră în Cont";
    }
}

async function handleRegister(e) {
    e.preventDefault();
    clearFeedback();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const passwordConfirm = document.getElementById('regPasswordConfirm').value;

    if (password !== passwordConfirm) {
        showFeedback("Parolele introduse nu coincid!", 'error');
        return;
    }

    const btn = document.getElementById('btnRegister');
    btn.disabled = true;
    btn.innerText = "Se creează contul...";

    try {
        const res = await fetch('/api/collections/users/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                password,
                passwordConfirm,
                emailVisibility: true
            })
        });

        const data = await res.json();
        if (!res.ok) {
            const errDetail = data.data ? JSON.stringify(data.data) : (data.message || 'Eroare la creare cont.');
            throw new Error(errDetail);
        }

        // Auto login after registration
        const authRes = await fetch('/api/collections/users/auth-with-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity: email, password })
        });
        const authData = await authRes.json();
        loginSuccess(authData.record, authData.token);
    } catch (err) {
        showFeedback(err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = "Creează Contul";
    }
}

function loginSuccess(record, token) {
    currentUser = record;
    authToken = token;
    localStorage.setItem('pb_auth_token', token);
    localStorage.setItem('pb_auth_model', JSON.stringify(record));

    document.getElementById('authSection').classList.add('hidden');
    document.getElementById('dashboardSection').classList.remove('hidden');

    const email = record.email || record.username || 'Utilizator';
    document.getElementById('userDisplayEmail').innerText = email;
    document.getElementById('userAvatar').innerText = email.charAt(0).toUpperCase();

    addLog(`[Auth] Autentificare reusita pentru: ${email}`, 'success');
}

function checkExistingAuth() {
    if (authToken && authModel) {
        try {
            const record = JSON.parse(authModel);
            loginSuccess(record, authToken);
        } catch (e) {
            handleLogout();
        }
    }
}

function handleLogout() {
    if (isWorkerRunning) stopWorker();
    currentUser = null;
    authToken = null;
    localStorage.removeItem('pb_auth_token');
    localStorage.removeItem('pb_auth_model');

    document.getElementById('authSection').classList.remove('hidden');
    document.getElementById('dashboardSection').classList.add('hidden');
    addLog(`[Auth] Sesiune incheiata.`, 'info');
}

// Web Worker Controller
function toggleWorker() {
    if (isWorkerRunning) {
        stopWorker();
    } else {
        startWorker();
    }
}

function startWorker() {
    if (window.Worker) {
        worker = new Worker('worker.js');
        isWorkerRunning = true;

        updateWorkerUI(true);
        addLog('[Worker] Thread-ul Web Worker a fost instantiat cu succes.', 'success');
        addLog('[Worker] Se ruleaza procesarea paralela pe procesorul telefonului tau...', 'info');

        worker.postMessage({ command: 'START', data: { difficulty: 3 } });

        worker.onmessage = function (e) {
            const data = e.data;
            if (data.type === 'PROGRESS') {
                document.getElementById('metricOps').innerText = data.opsPerSec.toLocaleString();
                document.getElementById('metricTotal').innerText = data.processed.toLocaleString();
            } else if (data.type === 'FOUND_MATCH') {
                totalMatches++;
                document.getElementById('metricMatches').innerText = totalMatches;
                addLog(`[Worker Match] Solutie gasita: ${data.hash} (la iteratia ${data.atTotal})`, 'match');
            } else if (data.type === 'STOPPED') {
                addLog(`[Worker] Oprit. Total iteratii calculate: ${data.total}`, 'info');
            }
        };

        worker.onerror = function (err) {
            addLog(`[Worker Eroare] ${err.message}`, 'error');
            stopWorker();
        };
    } else {
        alert("Browserul tau nu suporta Web Workeri HTML5!");
    }
}

function stopWorker() {
    if (worker) {
        worker.postMessage({ command: 'STOP' });
        worker.terminate();
        worker = null;
    }
    isWorkerRunning = false;
    updateWorkerUI(false);
    document.getElementById('metricOps').innerText = '0';
}

function updateWorkerUI(running) {
    const badge = document.getElementById('workerStatusBadge');
    const btnIcon = document.getElementById('btnWorkerIcon');
    const btnText = document.getElementById('btnWorkerText');
    const btnToggle = document.getElementById('btnToggleWorker');
    const termStatus = document.getElementById('termStatus');

    if (running) {
        badge.className = 'status-pill active';
        badge.innerText = 'Activ & Ruleaza';
        btnIcon.innerText = '⏸';
        btnText.innerText = 'Oprește Worker';
        btnToggle.className = 'btn btn-secondary';
        termStatus.innerText = 'Calcul in curs pe CPU client...';
    } else {
        badge.className = 'status-pill idle';
        badge.innerText = 'Inactiv';
        btnIcon.innerText = '▶';
        btnText.innerText = 'Pornește Web Worker';
        btnToggle.className = 'btn btn-success';
        termStatus.innerText = 'Așteaptă comenzi...';
    }
}

function addLog(msg, type = 'info') {
    const termBody = document.getElementById('termBody');
    if (!termBody) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    const time = new Date().toLocaleTimeString();
    line.innerText = `[${time}] ${msg}`;
    termBody.appendChild(line);
    termBody.scrollTop = termBody.scrollHeight;
}

function clearLogs() {
    const termBody = document.getElementById('termBody');
    if (termBody) termBody.innerHTML = '';
}

// PWA Service Worker Registration & One-Click Install Handler
let deferredPrompt = null;

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('[PWA] Service Worker inregistrat.', reg))
            .catch(err => console.warn('[PWA] Service Worker registration failed', err));
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const banner = document.getElementById('pwaBanner');
    if (banner) {
        banner.classList.remove('hidden');
    }
});

function installPwa() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                const banner = document.getElementById('pwaBanner');
                if (banner) banner.classList.add('hidden');
            }
            deferredPrompt = null;
        });
    } else {
        alert("Pentru a instala aplicatia: apasa pe meniul browserului (3 puncte) si alege 'Adauga pe ecran' sau 'Instaleaza aplicatia'.");
    }
}

window.addEventListener('appinstalled', () => {
    const banner = document.getElementById('pwaBanner');
    if (banner) banner.classList.add('hidden');
    addLog('[PWA] Aplicatia G86 a fost instalata cu succes pe ecran!', 'success');
});