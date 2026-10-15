// app.js - G86 Edge Real-Time Multi-Device Chat & Media Sharing (PocketBase SSE + IndexedDB)

let currentUser = null;
let authToken = localStorage.getItem('pb_auth_token');
let authModel = localStorage.getItem('pb_auth_model');

// Local IndexedDB Database
const DB_NAME = 'G86_LOCAL_STORE';
const DB_VERSION = 2;
let localDb = null;

// Chat & Sync State
let knownMessageIds = new Set();
let currentEditingMsgId = null;
let currentSelectedFile = null;
let activeModalMsgId = null;
let isChatOpen = true;
let sseConnection = null;
let sseClientId = null;
let syncPollingTimer = null;
let heartbeatTimer = null;

// Unique Peer ID for this browser tab/device
let myPeerId = localStorage.getItem('g86_client_peer_id');
if (!myPeerId) {
    myPeerId = 'c_' + Math.random().toString(36).substring(2, 8);
    localStorage.setItem('g86_client_peer_id', myPeerId);
}

// Scope state (Public vs Private)
let currentChatScope = 'public';
let currentRecipient = '';

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
    await initLocalDatabase();
    setupTextareaHandlers();
    checkExistingAuth();
    startHeartbeat();
    await renderAllMessages();
    startRealtimeSync();
});

// =========================================================================
// 1. IndexedDB Local Storage Manager (Zero messages lost, fast offline UI)
// =========================================================================
function initLocalDatabase() {
    return new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('messages')) {
                const store = database.createObjectStore('messages', { keyPath: 'id' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('pbId', 'pbId', { unique: false });
            }
        };
        req.onsuccess = (e) => {
            localDb = e.target.result;
            resolve(localDb);
        };
        req.onerror = (e) => {
            console.error('[IndexedDB] Eroare initializare DB:', e);
            resolve(null);
        };
    });
}

function dbSaveMessage(msg) {
    return new Promise((resolve) => {
        if (!localDb) return resolve(false);
        try {
            const tx = localDb.transaction('messages', 'readwrite');
            const store = tx.objectStore('messages');
            const req = store.put(msg);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        } catch (e) {
            resolve(false);
        }
    });
}

function dbGetAllMessages() {
    return new Promise((resolve) => {
        if (!localDb) return resolve([]);
        try {
            const tx = localDb.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const req = store.getAll();
            req.onsuccess = () => {
                const all = req.result || [];
                const visible = all.filter(m => !m.deletedForMe && !m.deleted);
                visible.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                resolve(visible);
            };
            req.onerror = () => resolve([]);
        } catch (e) {
            resolve([]);
        }
    });
}

function dbGetMessage(id) {
    return new Promise((resolve) => {
        if (!localDb) return resolve(null);
        try {
            const tx = localDb.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

function dbDeleteMessageForMe(id) {
    return new Promise(async (resolve) => {
        const msg = await dbGetMessage(id);
        if (msg) {
            msg.deletedForMe = true;
            await dbSaveMessage(msg);
        }
        resolve(true);
    });
}

function dbDeleteMessageAll(id) {
    return new Promise((resolve) => {
        if (!localDb) return resolve(false);
        try {
            const tx = localDb.transaction('messages', 'readwrite');
            const store = tx.objectStore('messages');
            const req = store.delete(id);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        } catch (e) {
            resolve(false);
        }
    });
}

// =========================================================================
// 2. Authentication UI & Logic (PocketBase Users Collection)
// =========================================================================
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
    if (!fb) return;
    fb.className = 'feedback-msg ' + type;
    fb.innerText = msg;
    fb.classList.remove('hidden');
}

function clearFeedback() {
    const fb = document.getElementById('authFeedback');
    if (fb) fb.classList.add('hidden');
}

async function handleLogin(e) {
    e.preventDefault();
    clearFeedback();
    const identity = document.getElementById('loginIdentity').value.trim();
    const password = document.getElementById('loginPassword').value;

    const btn = document.getElementById('btnLogin');
    btn.disabled = true;
    btn.innerText = 'Se autentifica...';

    try {
        const emailParam = '?email=' + encodeURIComponent(identity);
        const res = await fetch('/api/collections/users/auth-with-password' + emailParam, {
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
        btn.innerText = 'Intra in Cont';
    }
}

async function handleRegister(e) {
    e.preventDefault();
    clearFeedback();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const passwordConfirm = document.getElementById('regPasswordConfirm').value;

    if (password !== passwordConfirm) {
        showFeedback('Parolele introduse nu coincid!', 'error');
        return;
    }

    const btn = document.getElementById('btnRegister');
    btn.disabled = true;
    btn.innerText = 'Se creeaza contul...';

    try {
        const res = await fetch('/api/collections/users/records?email=' + encodeURIComponent(email), {
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

        const authRes = await fetch('/api/collections/users/auth-with-password?email=' + encodeURIComponent(email), {
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
        btn.innerText = 'Creeaza Contul';
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

    startHeartbeat();
    renderAllMessages();
    startRealtimeSync();
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
    currentUser = null;
    authToken = null;
    localStorage.removeItem('pb_auth_token');
    localStorage.removeItem('pb_auth_model');

    document.getElementById('authSection').classList.remove('hidden');
    document.getElementById('dashboardSection').classList.add('hidden');
    clearFeedback();

    startHeartbeat();
}

// =========================================================================
// 3. Heartbeat Pulse (Keeps client active and visible on phone screen)
// =========================================================================
function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const pulse = () => {
        const userEmailOrGuest = currentUser ? (currentUser.email || currentUser.username) : 'Vizitator';
        // Interogare rapida ce lasa o urma clara in jurnalul de conexiuni active
        const url = '/api/collections/messages/records?perPage=1&u=' + encodeURIComponent(userEmailOrGuest) + '&peer=' + encodeURIComponent(myPeerId);
        fetch(url, { cache: 'no-store' }).catch(() => {});
    };
    pulse();
    heartbeatTimer = setInterval(pulse, 6000);
}

// =========================================================================
// 4. Scope Selection (Public vs Private)
// =========================================================================
function setChatScope(scope) {
    currentChatScope = scope;
    const btnPublic = document.getElementById('btnScopePublic');
    const btnPrivate = document.getElementById('btnScopePrivate');
    const inputRec = document.getElementById('inputRecipient');

    if (scope === 'public') {
        if (btnPublic) {
            btnPublic.className = 'btn-scope-pill active';
        }
        if (btnPrivate) {
            btnPrivate.className = 'btn-scope-pill';
        }
        if (inputRec) {
            inputRec.classList.add('hidden');
            currentRecipient = '';
        }
    } else {
        if (btnPublic) {
            btnPublic.className = 'btn-scope-pill';
        }
        if (btnPrivate) {
            btnPrivate.className = 'btn-scope-pill private-active';
        }
        if (inputRec) {
            inputRec.classList.remove('hidden');
            inputRec.focus();
        }
    }
}

// =========================================================================
// 5. Real-Time PocketBase Synchronization (SSE + Short Polling Reconcile)
// =========================================================================
function startRealtimeSync() {
    initSSE();
    syncMessagesFromServer();
    if (syncPollingTimer) clearInterval(syncPollingTimer);
    syncPollingTimer = setInterval(syncMessagesFromServer, 2000);
}

function initSSE() {
    if (sseConnection) {
        try { sseConnection.close(); } catch (e) {}
    }

    try {
        sseConnection = new EventSource('/api/realtime');

        sseConnection.addEventListener('PB_CONNECT', async (e) => {
            try {
                const data = JSON.parse(e.data);
                sseClientId = data.clientId;
                await fetch('/api/realtime', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        clientId: sseClientId,
                        subscriptions: ['messages/*']
                    })
                });
            } catch (err) {
                console.warn('[SSE] Eroare abonare:', err);
            }
        });

        sseConnection.onmessage = async (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data && data.record) {
                    const changed = await processIncomingRecord(data.action, data.record);
                    if (changed) {
                        await renderAllMessages();
                    }
                }
            } catch (err) {}
        };

        sseConnection.onerror = () => {
            if (sseConnection) {
                try { sseConnection.close(); } catch (e) {}
                sseConnection = null;
            }
            setTimeout(initSSE, 5000);
        };
    } catch (e) {
        console.warn('[SSE] Fallback la polling activ:', e);
    }
}

let isSyncing = false;

async function syncMessagesFromServer() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const userEmailOrGuest = currentUser ? (currentUser.email || currentUser.username) : 'Vizitator';
        const localBefore = await dbGetAllMessages();

        // 0. AUTO-BACKFILL / MESH SEED: Daca acest dispozitiv (ex. PC) are mesaje sau fisiere create local care nu au ajuns pe trackerul central G86 (nu au pbId), le impinge automat catre feed-ul central PocketBase!
        for (const unposted of localBefore) {
            if (!unposted.pbId && !unposted.deleted) {
                try {
                    const postRes = await fetch('/api/collections/messages/records', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            msgId: unposted.id,
                            sender: unposted.sender || 'Anonim',
                            text: unposted.text || '',
                            file: unposted.file || null,
                            timeStr: unposted.timeStr || '',
                            timestamp: unposted.timestamp || Date.now(),
                            scope: unposted.scope || 'public',
                            recipient: unposted.recipient || '',
                            edited: !!unposted.edited,
                            deleted: false
                        })
                    });
                    if (postRes.ok) {
                        const sRecord = await postRes.json();
                        if (sRecord && sRecord.id) {
                            unposted.pbId = sRecord.id;
                            await dbSaveMessage(unposted);
                        }
                    }
                } catch (err) {}
            }
        }

        // Determinam markerul de checkpoint temporal (cel mai recent mesaj detinut local)
        const highestLocalTimestamp = localBefore.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
        let hasChanges = false;

        // =========================================================================
        // VALUL 1: Intervalul Offline (Time-Window Catch-up bazat pe Marker)
        // - Trimite markerul temporal catre tracker si descarca DOAR ce a aparut in perioada offline
        // =========================================================================
        if (highestLocalTimestamp > 0) {
            const deltaUrl = '/api/collections/messages/records?filter=' + encodeURIComponent("(timestamp > " + highestLocalTimestamp + ")") +
                             '&sort=timestamp&perPage=200&u=' + encodeURIComponent(userEmailOrGuest) + '&peer=' + encodeURIComponent(myPeerId);
            const deltaRes = await fetch(deltaUrl, { cache: 'no-store' });
            if (deltaRes.ok) {
                const deltaData = await deltaRes.json();
                const deltaItems = deltaData.items || [];
                for (const item of deltaItems) {
                    const ch = await processIncomingRecord('sync', item);
                    if (ch) hasChanges = true;
                }
            }
        }

        // =========================================================================
        // VALUL 2: Reconciliere Bitfield / Audit Ledger de Evenimente
        // - Verifica starea generala din feed-ul central (identifica stergeri, editari, piese lipsa)
        // =========================================================================
        const fullUrl = '/api/collections/messages/records?sort=timestamp&perPage=200&u=' + encodeURIComponent(userEmailOrGuest) + '&peer=' + encodeURIComponent(myPeerId);
        const fullRes = await fetch(fullUrl, { cache: 'no-store' });
        if (fullRes.ok) {
            const fullData = await fullRes.json();
            const serverRecords = fullData.items || [];

            const serverPbIds = new Set(serverRecords.map(r => r.id));
            const serverMsgIds = new Set(serverRecords.map(r => r.msgId || ('msg_' + r.id)));

            // 2A. Curatare mesaje sterse de la distanta de alti utilizatori cat timp am fost offline
            const currentLocal = await dbGetAllMessages();
            for (const locMsg of currentLocal) {
                if (locMsg.pbId && !serverPbIds.has(locMsg.pbId) && !serverMsgIds.has(locMsg.id)) {
                    await dbDeleteMessageAll(locMsg.id);
                    knownMessageIds.delete(locMsg.id);
                    hasChanges = true;
                }
            }

            // 2B. Asimilare noutati sau editari din registrul central
            for (const rec of serverRecords) {
                const ch = await processIncomingRecord('sync', rec);
                if (ch) hasChanges = true;
            }
        }

        if (hasChanges) {
            await renderAllMessages();
        }
    } catch (e) {
        // Dispozitiv offline
    } finally {
        isSyncing = false;
    }
}

async function processIncomingRecord(action, record) {
    if (!record) return false;
    const recId = record.msgId || ('msg_' + record.id);
    const pbId = record.id;

    if (action === 'delete' || record.deleted) {
        const existing = await dbGetMessage(recId);
        if (existing) {
            await dbDeleteMessageAll(recId);
            knownMessageIds.delete(recId);
            return true;
        }
        return false;
    }

    const existing = await dbGetMessage(recId);
    if (!existing) {
        const newMsg = {
            id: recId,
            pbId: pbId,
            sender: record.sender || 'Anonim',
            text: record.text || '',
            file: record.file || null,
            timeStr: record.timeStr || '',
            timestamp: record.timestamp || Date.now(),
            scope: record.scope || (record.file && record.file.scope) || 'public',
            recipient: record.recipient || (record.file && record.file.targetUser) || '',
            edited: !!record.edited,
            deleted: false,
            deletedForMe: false
        };
        await dbSaveMessage(newMsg);
        knownMessageIds.add(recId);
        return true;
    } else {
        let modified = false;
        if (!existing.pbId && pbId) {
            existing.pbId = pbId;
            modified = true;
        }
        if (existing.text !== record.text) {
            existing.text = record.text;
            modified = true;
        }
        if (existing.edited !== !!record.edited) {
            existing.edited = !!record.edited;
            modified = true;
        }
        if (record.scope && existing.scope !== record.scope) {
            existing.scope = record.scope;
            modified = true;
        }
        if (record.recipient && existing.recipient !== record.recipient) {
            existing.recipient = record.recipient;
            modified = true;
        }
        if (modified) {
            await dbSaveMessage(existing);
            return true;
        }
    }
    return false;
}

// =========================================================================
// 6. Chat Messages Rendering (With Unique File IDs & Privacy Scopes)
// =========================================================================
async function renderAllMessages() {
    const messages = await dbGetAllMessages();
    messages.forEach(m => knownMessageIds.add(m.id));

    const list = document.getElementById('chatMessagesList');
    const container = document.getElementById('chatContainer');
    if (!list || !container) return;

    list.innerHTML = '';

    if (messages.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-chat-hint';
        emptyDiv.style.cssText = 'color:#64748b; font-size:0.82rem; text-align:center; padding:30px 10px; font-style:italic;';
        emptyDiv.textContent = 'Niciun mesaj inca. Fii primul care incepe o conversatie!';
        list.appendChild(emptyDiv);
        return;
    }

    const myEmail = currentUser ? (currentUser.email || currentUser.username) : '';

    messages.forEach(msg => {
        const isOwn = !!myEmail && (msg.sender === myEmail);
        const isPrivate = (msg.scope === 'private') || (msg.file && msg.file.scope === 'private') || (msg.recipient && msg.recipient.trim() !== '');

        // Filtrare Confidentialitate: daca mesajul e privat, il vad doar expeditorul si destinatarul
        if (isPrivate) {
            const isRecipient = !!myEmail && (msg.recipient === myEmail);
            if (!isOwn && !isRecipient) {
                return; // Nu se afiseaza utilizatorilor neautorizati
            }
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg-item ' + (isOwn ? 'own' : 'other');
        msgDiv.id = 'msg-el-' + msg.id;

        // Badge-uri de destinatie (Public / Privat)
        let scopeBadgeHtml = '';
        if (isPrivate) {
            const targetLabel = isOwn ? ('catre ' + (msg.recipient || 'Utilizator')) : 'de la ' + msg.sender;
            scopeBadgeHtml = '<span class="msg-scope-badge private">🔒 Privat (' + escapeHtml(targetLabel) + ')</span>';
        } else {
            scopeBadgeHtml = '<span class="msg-scope-badge public">🌐 Public</span>';
        }

        // Continut Media si Identificator Unic
        let mediaHtml = '';
        if (msg.file && msg.file.dataUrl) {
            const mime = msg.file.type || '';
            const fileId = msg.file.fileId || ('G86-F-' + (msg.pbId || msg.id).substring(0, 8).toUpperCase());

            const fileIdBadge = '<div class="chat-file-id-tag">' +
                '<span>🆔 ' + escapeHtml(fileId) + '</span>' +
                '<button type="button" class="chat-file-id-copy" onclick="copyFileId(\'' + escapeHtml(fileId) + '\')" title="Copiaza ID unic">📋 Copiaza</button>' +
            '</div>';

            if (mime.startsWith('image/')) {
                mediaHtml = '<img src="' + msg.file.dataUrl + '" alt="' + escapeHtml(msg.file.name) + '" class="chat-media-preview-img" onclick="openMediaPreview(\'' + msg.file.dataUrl + '\')">' + fileIdBadge;
            } else if (mime.startsWith('video/')) {
                mediaHtml = '<video src="' + msg.file.dataUrl + '" controls class="chat-media-video"></video>' + fileIdBadge;
            } else if (mime.startsWith('audio/')) {
                mediaHtml = '<audio src="' + msg.file.dataUrl + '" controls style="margin-top:6px; max-width:100%;"></audio>' + fileIdBadge;
            } else {
                mediaHtml = '<a href="' + msg.file.dataUrl + '" download="' + escapeHtml(msg.file.name) + '" class="chat-media-doc">' +
                    '<span style="font-size:1.4rem;">📄</span>' +
                    '<div class="chat-doc-info">' +
                        '<span class="chat-doc-name">' + escapeHtml(msg.file.name) + '</span>' +
                        '<span class="chat-doc-size">' + (msg.file.size || '') + ' • Click pentru descarcare</span>' +
                    '</div></a>' + fileIdBadge;
            }
        }

        const textHtml = msg.text ? '<div class="chat-text">' + escapeHtml(msg.text).replace(/\n/g, '<br>') + '</div>' : '';
        const editedTag = msg.edited ? '<span class="edited-badge">(editat)</span>' : '';

        msgDiv.innerHTML = '<div class="chat-msg-header">' +
                '<span class="chat-msg-author">' + (isOwn ? 'Tu' : escapeHtml(msg.sender)) + '</span>' +
                scopeBadgeHtml +
                '<span class="chat-msg-time">' + (msg.timeStr || '') + editedTag + '</span>' +
            '</div>' +
            '<div class="chat-msg-bubble" title="Apasa lung sau click pentru optiuni (editare/stergere)">' +
                textHtml +
                mediaHtml +
            '</div>';

        const bubble = msgDiv.querySelector('.chat-msg-bubble');
        if (bubble) {
            setupMessageActionTriggers(bubble, msg.id, isOwn);
        }

        list.appendChild(msgDiv);
    });

    container.scrollTop = container.scrollHeight;
}

// =========================================================================
// 7. Send, Edit & Delete Message Logic
// =========================================================================
async function handleSendMessage(e) {
    if (e) e.preventDefault();
    const textarea = document.getElementById('inputChatMessage');
    const text = textarea ? textarea.value.trim() : '';
    const inputRec = document.getElementById('inputRecipient');
    const recipient = inputRec ? inputRec.value.trim() : '';

    if (!text && !currentSelectedFile) return;

    if (currentChatScope === 'private' && !recipient) {
        alert('Te rugam sa introduci adresa de email a destinatarului pentru mesajul privat.');
        if (inputRec) inputRec.focus();
        return;
    }

    if (currentEditingMsgId) {
        await saveEditedMessage(currentEditingMsgId, text);
        return;
    }

    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const sender = currentUser ? (currentUser.email || currentUser.username) : 'Anonim';
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timestamp = Date.now();

    // Daca exista fisier atasat, asigura-i un identificator unic si scopul selectat
    let filePayload = null;
    if (currentSelectedFile) {
        const fileUniqueId = 'G86-F-' + Math.random().toString(36).substring(2, 6).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
        filePayload = {
            fileId: fileUniqueId,
            name: currentSelectedFile.name,
            type: currentSelectedFile.type,
            size: currentSelectedFile.size,
            dataUrl: currentSelectedFile.dataUrl,
            scope: currentChatScope,
            targetUser: (currentChatScope === 'private') ? recipient : null
        };
    }

    const newMsg = {
        id: msgId,
        pbId: null,
        sender: sender,
        text: text,
        file: filePayload,
        timestamp: timestamp,
        timeStr: timeStr,
        scope: currentChatScope,
        recipient: (currentChatScope === 'private') ? recipient : '',
        edited: false,
        deleted: false,
        deletedForMe: false
    };

    // 1. Salvare locala imediata in IndexedDB (offline-first UI)
    await dbSaveMessage(newMsg);
    knownMessageIds.add(msgId);

    // 2. Reset input si preview
    if (textarea) {
        textarea.value = '';
        autoResizeTextarea();
    }
    clearSelectedFile();

    // 3. Randare instanta
    await renderAllMessages();

    // 4. Trimitere la server PocketBase
    try {
        const res = await fetch('/api/collections/messages/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                msgId: newMsg.id,
                sender: newMsg.sender,
                text: newMsg.text,
                file: newMsg.file,
                timeStr: newMsg.timeStr,
                timestamp: newMsg.timestamp,
                scope: newMsg.scope,
                recipient: newMsg.recipient,
                edited: false,
                deleted: false
            })
        });

        if (res.ok) {
            const serverRecord = await res.json();
            if (serverRecord && serverRecord.id) {
                newMsg.pbId = serverRecord.id;
                await dbSaveMessage(newMsg);
            }
        }
    } catch (err) {
        console.warn('[Chat] Eroare la trimiterea mesajului catre PocketBase:', err);
    }
}

async function saveEditedMessage(msgId, newText) {
    const msg = await dbGetMessage(msgId);
    if (!msg) return;

    msg.text = newText;
    msg.edited = true;
    await dbSaveMessage(msg);

    cancelEditingMessage();
    await renderAllMessages();

    try {
        let pbRecordId = msg.pbId;
        if (!pbRecordId) {
            const queryRes = await fetch('/api/collections/messages/records?filter=' + encodeURIComponent("msgId='" + msgId + "'"));
            if (queryRes.ok) {
                const queryData = await queryRes.json();
                if (queryData.items && queryData.items.length > 0) {
                    pbRecordId = queryData.items[0].id;
                    msg.pbId = pbRecordId;
                    await dbSaveMessage(msg);
                }
            }
        }

        if (pbRecordId) {
            await fetch('/api/collections/messages/records/' + pbRecordId, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: newText,
                    edited: true
                })
            });
        }
    } catch (err) {
        console.warn('[Chat] Eroare sincronizare editare:', err);
    }
}

function startEditingMessage(msgId) {
    dbGetMessage(msgId).then(msg => {
        if (!msg) return;
        currentEditingMsgId = msgId;
        const textarea = document.getElementById('inputChatMessage');
        const editBar = document.getElementById('chatEditingBar');
        if (textarea) {
            textarea.value = msg.text || '';
            autoResizeTextarea();
            textarea.focus();
        }
        if (editBar) editBar.classList.remove('hidden');
    });
}

function cancelEditingMessage() {
    currentEditingMsgId = null;
    const textarea = document.getElementById('inputChatMessage');
    const editBar = document.getElementById('chatEditingBar');
    if (textarea) {
        textarea.value = '';
        autoResizeTextarea();
    }
    if (editBar) editBar.classList.add('hidden');
}

async function deleteMessageForAll(msgId) {
    const msg = await dbGetMessage(msgId);
    let pbRecordId = msg ? msg.pbId : null;

    // 1. Stergere PRIORITARA de pe server PocketBase
    try {
        if (!pbRecordId) {
            const queryRes = await fetch('/api/collections/messages/records?filter=' + encodeURIComponent("msgId='" + msgId + "'"));
            if (queryRes.ok) {
                const queryData = await queryRes.json();
                if (queryData.items && queryData.items.length > 0) {
                    pbRecordId = queryData.items[0].id;
                }
            }
        }

        if (pbRecordId) {
            await fetch('/api/collections/messages/records/' + pbRecordId, {
                method: 'DELETE'
            });
        }
    } catch (err) {
        console.warn('[Chat] Eroare stergere de pe server:', err);
    }

    // 2. Stergere din memoria locala (IndexedDB)
    await dbDeleteMessageAll(msgId);
    knownMessageIds.delete(msgId);
    await renderAllMessages();
}

async function deleteMessageForMe(msgId) {
    await dbDeleteMessageForMe(msgId);
    await renderAllMessages();
}

// =========================================================================
// 8. Auto-Expanding Textarea & Enter to Send
// =========================================================================
function setupTextareaHandlers() {
    const textarea = document.getElementById('inputChatMessage');
    if (!textarea) return;

    textarea.addEventListener('input', autoResizeTextarea);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
}

function autoResizeTextarea() {
    const textarea = document.getElementById('inputChatMessage');
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px';
}

// =========================================================================
// 9. Dropdown Toggle for Public Chat
// =========================================================================
function toggleChatDropdown() {
    const body = document.getElementById('chatDropdownBody');
    const arrow = document.getElementById('chatDropdownArrow');
    if (!body || !arrow) return;

    isChatOpen = !isChatOpen;
    if (isChatOpen) {
        body.classList.remove('hidden');
        arrow.classList.remove('open');
        arrow.textContent = '▼';
    } else {
        body.classList.add('hidden');
        arrow.classList.add('open');
        arrow.textContent = '▲';
    }
}

// =========================================================================
// 10. File & Media Attachment (Smart Compression for Photos & Unique ID)
// =========================================================================
function triggerFileInput() {
    const input = document.getElementById('chatFileInput');
    if (input) input.click();
}

function handleFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 25 * 1024 * 1024) {
        alert('Fisierul depaseste limita de 25MB.');
        e.target.value = '';
        return;
    }

    if (file.type.startsWith('image/')) {
        compressImageFile(file, (compressedDataUrl) => {
            currentSelectedFile = {
                name: file.name,
                type: file.type,
                size: formatFileSize(compressedDataUrl.length * 0.75),
                dataUrl: compressedDataUrl
            };
            showFilePreview(currentSelectedFile);
        });
    } else {
        const reader = new FileReader();
        reader.onload = function(evt) {
            currentSelectedFile = {
                name: file.name,
                type: file.type,
                size: formatFileSize(file.size),
                dataUrl: evt.target.result
            };
            showFilePreview(currentSelectedFile);
        };
        reader.readAsDataURL(file);
    }
}

function compressImageFile(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            const maxDim = 1280;

            if (width > maxDim || height > maxDim) {
                if (width > height) {
                    height = Math.round((height * maxDim) / width);
                    width = maxDim;
                } else {
                    width = Math.round((width * maxDim) / height);
                    height = maxDim;
                }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
            callback(compressedDataUrl);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function showFilePreview(file) {
    const bar = document.getElementById('filePreviewBar');
    const nameEl = document.getElementById('previewFileName');
    const sizeEl = document.getElementById('previewFileSize');
    const iconEl = document.getElementById('previewFileIcon');
    if (!bar) return;

    nameEl.textContent = file.name;
    sizeEl.textContent = '(' + file.size + ')';

    if (file.type.startsWith('image/')) iconEl.textContent = '🖼️';
    else if (file.type.startsWith('video/')) iconEl.textContent = '🎬';
    else if (file.type.startsWith('audio/')) iconEl.textContent = '🎵';
    else iconEl.innerHTML = '<svg viewBox="0 0 24 24" class="paperclip-svg-icon-sm" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

    bar.classList.remove('hidden');
}

function clearSelectedFile() {
    currentSelectedFile = null;
    const input = document.getElementById('chatFileInput');
    if (input) input.value = '';
    const bar = document.getElementById('filePreviewBar');
    if (bar) bar.classList.add('hidden');
}

function copyFileId(fileId) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(fileId);
        alert('Identificator fisier copiat in clipboard: ' + fileId);
    } else {
        prompt('Copiaza ID-ul:', fileId);
    }
}

function formatFileSize(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    else return (bytes / 1048576).toFixed(1) + ' MB';
}

function openMediaPreview(dataUrl) {
    const win = window.open();
    if (win) {
        win.document.write('<body style="margin:0; background:#0a0e17; display:flex; justify-content:center; align-items:center; min-height:100vh;"><img src="' + dataUrl + '" style="max-width:95vw; max-height:95vh; object-fit:contain; border-radius:8px;"></body>');
    }
}

// =========================================================================
// 11. Modal Sheet for Message Options (Long Press / Click)
// =========================================================================
function setupMessageActionTriggers(element, msgId, isOwn) {
    let pressTimer = null;

    const startPress = () => {
        pressTimer = setTimeout(() => {
            openMessageModal(msgId, isOwn);
        }, 450);
    };

    const cancelPress = () => {
        if (pressTimer) clearTimeout(pressTimer);
    };

    element.addEventListener('touchstart', startPress, { passive: true });
    element.addEventListener('touchend', cancelPress);
    element.addEventListener('touchmove', cancelPress);

    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMessageModal(msgId, isOwn);
    });

    element.addEventListener('click', (e) => {
        if (e.target.tagName === 'A' || e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO' || e.target.tagName === 'BUTTON') return;
        openMessageModal(msgId, isOwn);
    });
}

function openMessageModal(msgId, isOwn) {
    activeModalMsgId = msgId;
    const modal = document.getElementById('messageActionModal');
    const container = document.getElementById('modalActionsContainer');
    const title = document.getElementById('modalMsgTitle');
    if (!modal || !container) return;

    container.innerHTML = '';
    title.textContent = isOwn ? 'Optiuni Mesaj Propriu' : 'Optiuni Mesaj Primit';

    if (isOwn) {
        container.innerHTML = '<button type="button" class="modal-action-btn" onclick="triggerEditAction(\'' + msgId + '\')">' +
                '<span>✏️</span> Editeaza Mesajul' +
            '</button>' +
            '<button type="button" class="modal-action-btn danger" onclick="triggerDeleteAllAction(\'' + msgId + '\')">' +
                '<span>🗑️</span> Sterge pentru Toti' +
            '</button>';
    } else {
        container.innerHTML = '<button type="button" class="modal-action-btn danger" onclick="triggerDeleteForMeAction(\'' + msgId + '\')">' +
                '<span>🗑️</span> Sterge pentru Mine (Dispare de pe acest dispozitiv)' +
            '</button>';
    }

    modal.classList.remove('hidden');
}

function closeMessageModal() {
    const modal = document.getElementById('messageActionModal');
    if (modal) modal.classList.add('hidden');
    activeModalMsgId = null;
}

function triggerEditAction(msgId) {
    closeMessageModal();
    startEditingMessage(msgId);
}

async function triggerDeleteAllAction(msgId) {
    closeMessageModal();
    if (confirm('Sigur doresti sa stergi acest mesaj pentru toti participantii?')) {
        await deleteMessageForAll(msgId);
    }
}

async function triggerDeleteForMeAction(msgId) {
    closeMessageModal();
    await deleteMessageForMe(msgId);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag] || tag));
}