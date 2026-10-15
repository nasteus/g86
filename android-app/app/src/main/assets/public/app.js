// app.js - G86 Client Frontend with P2P Torrent-Style Mesh Chat & Media Sharing (AES-256-GCM E2E)

let currentUser = null;
let authToken = localStorage.getItem('pb_auth_token');
let authModel = localStorage.getItem('pb_auth_model');

// Cryptographic Key for AES-256-GCM
let cryptoKey = null;
const SHARED_NETWORK_SECRET = "G86-SECURE-MESH-NETWORK-2026-ENCRYPTION-KEY-SECRET";

// Local IndexedDB Database
const DB_NAME = 'G86_P2P_LOCAL_STORE';
const DB_VERSION = 1;
let localDb = null;

// P2P Tracker State
let myPeerId = localStorage.getItem('g86_p2p_peer_id');
if (!myPeerId) {
    myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
    localStorage.setItem('g86_p2p_peer_id', myPeerId);
}
let activePeers = [];
let trackerTimer = null;
let knownMessageIds = new Set();
let currentEditingMsgId = null;
let currentSelectedFile = null;
let activeModalMsgId = null;
let isChatOpen = true;

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
    await initCryptoKey();
    await initLocalDatabase();
    setupTextareaHandlers();
    checkExistingAuth();
    startHeartbeat();
    setupUnloadHandler();
    await renderAllMessages();
    startP2PTracker();
});

// 1. IndexedDB Local Storage Manager (Zero messages lost, persistent on device)
function initLocalDatabase() {
    return new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('messages')) {
                const store = database.createObjectStore('messages', { keyPath: 'id' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
        req.onsuccess = (e) => {
            localDb = e.target.result;
            resolve(localDb);
        };
        req.onerror = (e) => {
            console.error('[IndexedDB] Eroare inițializare DB:', e);
            resolve(null);
        };
    });
}

function dbSaveMessage(msg) {
    return new Promise((resolve) => {
        if (!localDb) return resolve(false);
        const tx = localDb.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const req = store.put(msg);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
}

function dbGetAllMessages() {
    return new Promise((resolve) => {
        if (!localDb) return resolve([]);
        const tx = localDb.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const req = store.getAll();
        req.onsuccess = () => {
            const all = req.result || [];
            const visible = all.filter(m => !m.deletedForMe);
            visible.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            resolve(visible);
        };
        req.onerror = () => resolve([]);
    });
}

function dbGetMessage(id) {
    return new Promise((resolve) => {
        if (!localDb) return resolve(null);
        const tx = localDb.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
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
        const tx = localDb.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
}

// 2. Web Crypto API - AES-256-GCM Implementation
async function initCryptoKey() {
    try {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw",
            enc.encode(SHARED_NETWORK_SECRET),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );

        cryptoKey = await window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: enc.encode("g86-node-salt-unique-security"),
                iterations: 100000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
        console.log("[Crypto] Cheie de criptare AES-256-GCM derivată cu succes.");
    } catch (e) {
        console.error("[Crypto] Eroare la inițializarea cheii:", e);
    }
}

async function encryptPayload(dataObj) {
    if (!cryptoKey) await initCryptoKey();
    const enc = new TextEncoder();
    const jsonStr = JSON.stringify(dataObj);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = enc.encode(jsonStr);

    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        encoded
    );

    return {
        iv: btoa(String.fromCharCode(...iv)),
        ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
    };
}

async function decryptPayload(bundle) {
    if (!cryptoKey) await initCryptoKey();
    try {
        const iv = Uint8Array.from(atob(bundle.iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(bundle.ciphertext), c => c.charCodeAt(0));

        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            cryptoKey,
            ciphertext
        );

        const dec = new TextDecoder();
        return JSON.parse(dec.decode(decrypted));
    } catch (e) {
        return null;
    }
}

// 2. Authentication UI & Logic
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

async function handleLogin(e) {
    e.preventDefault();
    clearFeedback();
    const identity = document.getElementById('loginIdentity').value.trim();
    const password = document.getElementById('loginPassword').value;

    const btn = document.getElementById('btnLogin');
    btn.disabled = true;
    btn.innerText = "Se autentifică...";

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

        // Auto login
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

    startHeartbeat();
    renderAllMessages();
    startP2PTracker();
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

// 3. Instant Logout & Disconnect Handlers
async function handleLogout() {
    const emailToLog = currentUser ? currentUser.email : null;
    
    // Stop P2P tracker
    if (trackerTimer) clearInterval(trackerTimer);
    trackerTimer = null;

    // Send instant logout signal to server
    try {
        await fetch('/api/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailToLog, disconnect: false })
        });
    } catch (ignored) {}

    currentUser = null;
    authToken = null;
    localStorage.removeItem('pb_auth_token');
    localStorage.removeItem('pb_auth_model');

    document.getElementById('authSection').classList.remove('hidden');
    document.getElementById('dashboardSection').classList.add('hidden');
    clearFeedback();

    startHeartbeat();
}

function setupUnloadHandler() {
    const sendDisconnect = () => {
        const payload = JSON.stringify({
            email: currentUser ? currentUser.email : null,
            disconnect: true
        });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/logout', blob);
    };

    window.addEventListener('pagehide', sendDisconnect);
    window.addEventListener('beforeunload', sendDisconnect);
}

// 4. Heartbeat Pulse
let heartbeatTimer = null;
function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const pulse = () => {
        if (authToken && currentUser) {
            const emailParam = '?email=' + encodeURIComponent(currentUser.email || '');
            fetch('/api/collections/users/auth-refresh' + emailParam, {
                method: 'POST',
                headers: { 'Authorization': authToken }
            }).catch(() => {});
        } else {
            fetch('/api/ping', { cache: 'no-store' }).catch(() => {});
        }
    };
    pulse();
    heartbeatTimer = setInterval(pulse, 8000);
}

// 5. P2P BitTorrent-Style Tracker & Mesh Synchronization (Zero Server Payload Storage)
function startP2PTracker() {
    if (trackerTimer) clearInterval(trackerTimer);
    p2pTrackerCycle();
    trackerTimer = setInterval(p2pTrackerCycle, 2500);
}

async function p2pTrackerCycle() {
    await announceToTracker();
    await checkIncomingSignals();
}

async function announceToTracker() {
    const email = currentUser ? currentUser.email : '';
    try {
        const res = await fetch(`/api/tracker/announce?peerId=${encodeURIComponent(myPeerId)}&email=${encodeURIComponent(email)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const latestPeers = data.peers || [];

        // Detect new peers to initiate P2P history synchronization
        latestPeers.forEach(peer => {
            const isKnown = activePeers.some(p => p.peerId === peer.peerId);
            if (!isKnown) {
                // Request sync from newly discovered peer
                sendP2PSignal(peer.peerId, {
                    type: 'SYNC_REQUEST',
                    knownIds: Array.from(knownMessageIds)
                });
            }
        });

        activePeers = latestPeers;
    } catch (e) {
        // Silent fail
    }
}

async function sendP2PSignal(toPeerId, dataPayload) {
    try {
        await fetch('/api/tracker/signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: myPeerId,
                to: toPeerId,
                data: dataPayload
            })
        });
    } catch (e) {
        console.warn('[P2P] Eroare semnalizare către peer:', e);
    }
}

function broadcastP2P(dataPayload) {
    activePeers.forEach(peer => {
        sendP2PSignal(peer.peerId, dataPayload);
    });
}

async function checkIncomingSignals() {
    try {
        const res = await fetch(`/api/tracker/signals?peerId=${encodeURIComponent(myPeerId)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const result = await res.json();
        const signals = result.signals || [];

        for (const sig of signals) {
            await handleP2PSignal(sig);
        }
    } catch (e) {
        // Silent fail
    }
}

async function handleP2PSignal(sig) {
    const fromPeer = sig.from;
    const packet = sig.data;
    if (!packet || !packet.type) return;

    if (packet.type === 'SYNC_REQUEST') {
        // A peer wants to sync: compare known message IDs and send missing ones from local IndexedDB
        const remoteKnown = new Set(packet.knownIds || []);
        const myLocalMsgs = await dbGetAllMessages();
        for (const msg of myLocalMsgs) {
            if (!remoteKnown.has(msg.id)) {
                const encrypted = await encryptPayload(msg);
                sendP2PSignal(fromPeer, {
                    type: 'SYNC_RESPONSE',
                    bundle: encrypted
                });
            }
        }
    } else if (packet.type === 'SYNC_RESPONSE' || packet.type === 'NEW_MESSAGE') {
        const decryptedMsg = await decryptPayload(packet.bundle);
        if (decryptedMsg && decryptedMsg.id && !knownMessageIds.has(decryptedMsg.id)) {
            await dbSaveMessage(decryptedMsg);
            knownMessageIds.add(decryptedMsg.id);
            await renderAllMessages();
        }
    } else if (packet.type === 'EDIT_MESSAGE') {
        const msg = await dbGetMessage(packet.msgId);
        if (msg) {
            msg.text = packet.newText;
            msg.edited = true;
            await dbSaveMessage(msg);
            await renderAllMessages();
        }
    } else if (packet.type === 'DELETE_MESSAGE_ALL') {
        await dbDeleteMessageAll(packet.msgId);
        knownMessageIds.delete(packet.msgId);
        await renderAllMessages();
    }
}

// 6. Chat Messages Rendering (From Device Local Storage)
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
        emptyDiv.textContent = 'Niciun mesaj încă. Fii primul care începe o conversație privată!';
        list.appendChild(emptyDiv);
        return;
    }

    messages.forEach(msg => {
        const isOwn = currentUser && msg.sender === currentUser.email;
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-msg-item ${isOwn ? 'own' : 'other'}`;
        msgDiv.id = `msg-el-${msg.id}`;

        let mediaHtml = '';
        if (msg.file && msg.file.dataUrl) {
            const mime = msg.file.type || '';
            if (mime.startsWith('image/')) {
                mediaHtml = `<img src="${msg.file.dataUrl}" alt="${escapeHtml(msg.file.name)}" class="chat-media-preview-img" onclick="openMediaPreview('${msg.file.dataUrl}')">`;
            } else if (mime.startsWith('video/')) {
                mediaHtml = `<video src="${msg.file.dataUrl}" controls class="chat-media-video"></video>`;
            } else if (mime.startsWith('audio/')) {
                mediaHtml = `<audio src="${msg.file.dataUrl}" controls style="margin-top:6px; max-width:100%;"></audio>`;
            } else {
                mediaHtml = `
                    <a href="${msg.file.dataUrl}" download="${escapeHtml(msg.file.name)}" class="chat-media-doc">
                        <span style="font-size:1.4rem;">📄</span>
                        <div class="chat-doc-info">
                            <span class="chat-doc-name">${escapeHtml(msg.file.name)}</span>
                            <span class="chat-doc-size">${msg.file.size || ''} • Click pentru descărcare</span>
                        </div>
                    </a>
                `;
            }
        }

        const textHtml = msg.text ? `<div class="chat-text">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div>` : '';
        const editedTag = msg.edited ? `<span class="edited-badge">(editat)</span>` : '';

        msgDiv.innerHTML = `
            <div class="chat-msg-header">
                <span class="chat-msg-author">${isOwn ? 'Tu' : escapeHtml(msg.sender)}</span>
                <span class="chat-msg-time">${msg.timeStr || ''}${editedTag}</span>
            </div>
            <div class="chat-msg-bubble" title="Apasă lung sau click pentru opțiuni (editare/ștergere)">
                ${textHtml}
                ${mediaHtml}
            </div>
        `;

        const bubble = msgDiv.querySelector('.chat-msg-bubble');
        if (bubble) {
            setupMessageActionTriggers(bubble, msg.id, isOwn);
        }

        list.appendChild(msgDiv);
    });

    container.scrollTop = container.scrollHeight;
}

// 7. Send, Edit & Delete Message Logic
async function handleSendMessage(e) {
    if (e) e.preventDefault();
    const textarea = document.getElementById('inputChatMessage');
    const text = textarea ? textarea.value.trim() : '';

    if (!text && !currentSelectedFile) return;

    if (currentEditingMsgId) {
        await saveEditedMessage(currentEditingMsgId, text);
        return;
    }

    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const newMsg = {
        id: msgId,
        sender: currentUser ? currentUser.email : 'Anonim',
        text: text,
        file: currentSelectedFile ? {
            name: currentSelectedFile.name,
            type: currentSelectedFile.type,
            size: currentSelectedFile.size,
            dataUrl: currentSelectedFile.dataUrl
        } : null,
        timestamp: Date.now(),
        timeStr: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        edited: false,
        deletedForMe: false
    };

    // 1. Salvare în memoria locală (IndexedDB) pe dispozitiv (nu se pierde niciodată)
    await dbSaveMessage(newMsg);
    knownMessageIds.add(msgId);

    // 2. Reset căsuță și fișier
    if (textarea) {
        textarea.value = '';
        autoResizeTextarea();
    }
    clearSelectedFile();

    // 3. Randare instantanee local
    await renderAllMessages();

    // 4. Propagare P2P direct către ceilalți participanți conectați
    const encryptedBundle = await encryptPayload(newMsg);
    broadcastP2P({
        type: 'NEW_MESSAGE',
        bundle: encryptedBundle
    });
}

async function saveEditedMessage(msgId, newText) {
    const msg = await dbGetMessage(msgId);
    if (!msg) return;

    msg.text = newText;
    msg.edited = true;
    await dbSaveMessage(msg);

    cancelEditingMessage();
    await renderAllMessages();

    // Propagare modificare către ceilalți participanți
    broadcastP2P({
        type: 'EDIT_MESSAGE',
        msgId: msgId,
        newText: newText
    });
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
    await dbDeleteMessageAll(msgId);
    knownMessageIds.delete(msgId);
    await renderAllMessages();

    // Propagare ștergere P2P
    broadcastP2P({
        type: 'DELETE_MESSAGE_ALL',
        msgId: msgId
    });
}

async function deleteMessageForMe(msgId) {
    await dbDeleteMessageForMe(msgId);
    await renderAllMessages();
}

// 8. Auto-Expanding Textarea & Enter to Send
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

// 9. Dropdown Toggle for Public Chat
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

// 10. File & Media Attachment
function triggerFileInput() {
    const input = document.getElementById('chatFileInput');
    if (input) input.click();
}

function handleFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
        alert("Fișierul depășește limita de 50MB pentru transfer direct P2P.");
        e.target.value = '';
        return;
    }

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

function showFilePreview(file) {
    const bar = document.getElementById('filePreviewBar');
    const nameEl = document.getElementById('previewFileName');
    const sizeEl = document.getElementById('previewFileSize');
    const iconEl = document.getElementById('previewFileIcon');
    if (!bar) return;

    nameEl.textContent = file.name;
    sizeEl.textContent = `(${file.size})`;

    if (file.type.startsWith('image/')) iconEl.textContent = '🖼️';
    else if (file.type.startsWith('video/')) iconEl.textContent = '🎬';
    else if (file.type.startsWith('audio/')) iconEl.textContent = '🎵';
    else iconEl.innerHTML = `<svg viewBox="0 0 24 24" class="paperclip-svg-icon-sm" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

    bar.classList.remove('hidden');
}

function clearSelectedFile() {
    currentSelectedFile = null;
    const input = document.getElementById('chatFileInput');
    if (input) input.value = '';
    const bar = document.getElementById('filePreviewBar');
    if (bar) bar.classList.add('hidden');
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    else return (bytes / 1048576).toFixed(1) + ' MB';
}

function openMediaPreview(dataUrl) {
    const win = window.open();
    if (win) {
        win.document.write(`<body style="margin:0; background:#0a0e17; display:flex; justify-content:center; align-items:center; min-height:100vh;"><img src="${dataUrl}" style="max-width:95vw; max-height:95vh; object-fit:contain; border-radius:8px;"></body>`);
    }
}

// 11. Modal Sheet for Message Options (Long Press / Click)
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
        if (e.target.tagName === 'A' || e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') return;
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
    title.textContent = isOwn ? 'Opțiuni Mesaj Propriu' : 'Opțiuni Mesaj Primit';

    if (isOwn) {
        container.innerHTML = `
            <button type="button" class="modal-action-btn" onclick="triggerEditAction('${msgId}')">
                <span>✏️</span> Editează Mesajul
            </button>
            <button type="button" class="modal-action-btn danger" onclick="triggerDeleteAllAction('${msgId}')">
                <span>🗑️</span> Șterge pentru Toți
            </button>
        `;
    } else {
        container.innerHTML = `
            <button type="button" class="modal-action-btn danger" onclick="triggerDeleteForMeAction('${msgId}')">
                <span>🗑️</span> Șterge pentru Mine (Dispare de pe acest dispozitiv)
            </button>
        `;
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
    if (confirm("Sigur dorești să ștergi acest mesaj pentru toți participanții?")) {
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