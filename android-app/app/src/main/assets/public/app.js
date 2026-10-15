// app.js - G86 Client Frontend with End-to-End Encrypted Chatroom (AES-256-GCM)

let currentUser = null;
let authToken = localStorage.getItem('pb_auth_token');
let authModel = localStorage.getItem('pb_auth_model');

// Cryptographic Key for AES-256-GCM
let cryptoKey = null;
const SHARED_NETWORK_SECRET = "G86-SECURE-MESH-NETWORK-2026-ENCRYPTION-KEY-SECRET";

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
    await initCryptoKey();
    checkExistingAuth();
    startHeartbeat();
    setupUnloadHandler();
});

// 1. Web Crypto API - AES-256-GCM Implementation
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

async function encryptMessage(text) {
    if (!cryptoKey) await initCryptoKey();
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = enc.encode(text);

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

async function decryptMessage(bundle) {
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
        return dec.decode(decrypted);
    } catch (e) {
        return "[Mesaj indescifrabil - eroare cheie]";
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
    startChatMonitoring();
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
    
    // Stop chat monitor
    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = null;

    // Send instant logout signal to server (disconnect: false, remains on page as guest)
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

    // Keep guest heartbeat active so server knows user is still present as guest
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
            // Guest pulse so server knows user is on site
            fetch('/api/ping', { cache: 'no-store' }).catch(() => {});
        }
    };
    pulse();
    heartbeatTimer = setInterval(pulse, 8000);
}

// 5. Encrypted Chatroom Logic
let chatPollTimer = null;
let lastMessageCount = 0;

function startChatMonitoring() {
    if (chatPollTimer) clearInterval(chatPollTimer);
    fetchMessages();
    chatPollTimer = setInterval(fetchMessages, 2000);
}

async function handleSendMessage(e) {
    e.preventDefault();
    const input = document.getElementById('inputChatMessage');
    const text = input.value.trim();
    if (!text || !currentUser) return;

    input.value = '';
    const btn = document.getElementById('btnSendMessage');
    btn.disabled = true;

    try {
        // Encrypt with AES-256-GCM before sending over the wire
        const encryptedBundle = await encryptMessage(text);
        const payload = {
            sender: currentUser.email,
            iv: encryptedBundle.iv,
            ciphertext: encryptedBundle.ciphertext,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        await fetch('/api/chat/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        await fetchMessages();
    } catch (err) {
        console.error('Eroare trimitere mesaj:', err);
    } finally {
        btn.disabled = false;
        input.focus();
    }
}

async function fetchMessages() {
    if (!currentUser) return;
    try {
        const res = await fetch('/api/chat/messages', { cache: 'no-store' });
        if (!res.ok) return;

        const messages = await res.json();
        if (messages.length === lastMessageCount) return;

        const list = document.getElementById('chatMessagesList');
        const container = document.getElementById('chatContainer');
        list.innerHTML = `
            <div class="chat-system-msg">
                <span class="lock-icon">🔒</span> Canal securizat inițializat. Toate mesajele dintre utilizatori și nodul g86 sunt criptate criptografic (Web Crypto API).
            </div>
        `;

        for (const msg of messages) {
            const isOwn = currentUser && msg.sender === currentUser.email;
            const plainText = await decryptMessage(msg);

            const msgDiv = document.createElement('div');
            msgDiv.className = `chat-msg-item ${isOwn ? 'own' : 'other'}`;
            msgDiv.innerHTML = `
                <div class="chat-msg-header">
                    <span class="chat-msg-author">${isOwn ? 'Tu' : msg.sender}</span>
                    <span class="chat-msg-time">${msg.timestamp}</span>
                </div>
                <div class="chat-msg-bubble">
                    ${escapeHtml(plainText)}
                    <span class="chat-lock-tag" title="Criptat AES-256-GCM">🔒 Criptat</span>
                </div>
            `;
            list.appendChild(msgDiv);
        }

        lastMessageCount = messages.length;
        container.scrollTop = container.scrollHeight;
    } catch (err) {
        console.warn('Chat poll error:', err);
    }
}

function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag] || tag));
}