import json
import time
import os
import urllib.parse
import re

DATA_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "active_state.json"))

def get_state():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
                if "clients" not in state: state["clients"] = {}
                if "logs" not in state: state["logs"] = []
                if "user_logs" not in state: state["user_logs"] = {}
                if "chat_messages" not in state: state["chat_messages"] = []
                return state
        except Exception:
            pass
    now = time.time()
    init_state = {
        "clients": {},
        "user_logs": {},
        "logs": [
            {"text": f"[{time.strftime('%H:%M:%S')}] [Sistem] Motorul g86 este activ cu canal securizat.", "time": now, "type": "system"}
        ],
        "chat_messages": []
    }
    save_state(init_state)
    return init_state

def save_state(state):
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass

def track_request(method, path, headers, body, client_ip, user_agent=""):
    state = get_state()
    now = time.time()
    time_str = time.strftime("%H:%M:%S")

    display_ip = client_ip
    if display_ip in ["127.0.0.1", "::1", "localhost"]:
        display_ip = "192.168.1.46"

    # Detectare email din query param sau body
    email = None
    m = re.search(r'[?&]email=([^&]+)', path)
    if m:
        try:
            email = urllib.parse.unquote(m.group(1)).strip()
        except Exception:
            pass

    if not email and body and b"identity" in body:
        try:
            b_json = json.loads(body.decode("utf-8", "ignore"))
            if "identity" in b_json:
                email = b_json["identity"]
            elif "email" in b_json:
                email = b_json["email"]
        except Exception:
            pass

    client_key = display_ip
    existing = state["clients"].get(client_key, {
        "ip": display_ip,
        "type": "Rețea Locală (Wi-Fi)",
        "email": None,
        "isAuth": False,
        "first_seen": now,
        "userAgent": user_agent or "Browser Web"
    })

    existing["last_seen"] = now
    if user_agent:
        existing["userAgent"] = user_agent

    if email and "@" in email:
        existing["email"] = email
        existing["isAuth"] = True

    state["clients"][client_key] = existing

    # Initializare log dedicat utilizatorului
    user_id_key = existing.get("email") or display_ip
    if user_id_key not in state["user_logs"]:
        state["user_logs"][user_id_key] = []

    # Construire mesaj log specific utilizatorului
    clean_path = path.split('?')[0]
    log_detail = f"[{time_str}] {method} {clean_path}"
    
    if "auth-with-password" in path and method == "POST":
        log_detail = f"[{time_str}] [Auth] Autentificare reușită pentru contul: {email or user_id_key}"
    elif "auth-refresh" in path:
        log_detail = f"[{time_str}] [Heartbeat] Sesiune securizată reconfirmată (activ)"
    elif "chat" in path:
        log_detail = f"[{time_str}] [Chat] Acces canal securizat mesaje criptate"

    # Nu adaugam spam de ping in logul global sau utilizator daca e doar ping de mentinere conexiune
    if "/api/ping" in path:
        save_state(state)
        return

    # Adaugare in logul personal al utilizatorului
    state["user_logs"][user_id_key].append({
        "time": now,
        "text": log_detail,
        "type": "success" if ("auth" in path or email) else "info"
    })
    state["user_logs"][user_id_key] = state["user_logs"][user_id_key][-100:]

    # Log global de sistem
    global_log = f"[{time_str}] {method} {clean_path} ({display_ip})"
    if email:
        global_log += f" • {email}"
    state["logs"].append({"text": global_log, "time": now, "type": "info"})
    state["logs"] = state["logs"][-60:]

    save_state(state)

def logout_user(client_ip, email=None, disconnect=False):
    state = get_state()
    now = time.time()
    time_str = time.strftime("%H:%M:%S")

    display_ip = client_ip
    if display_ip in ["127.0.0.1", "::1", "localhost"]:
        display_ip = "192.168.1.46"

    client_key = display_ip
    if client_key in state["clients"]:
        user_email = state["clients"][client_key].get("email") or email or "Utilizator"
        user_id_key = user_email
        if user_id_key not in state["user_logs"]:
            state["user_logs"][user_id_key] = []
        
        status_msg = f"[{time_str}] [Deconectare] Utilizatorul a închis sesiunea frontend." if disconnect else f"[{time_str}] [Deconectare] Utilizatorul s-a delogat de pe frontend."
        state["user_logs"][user_id_key].append({
            "time": now,
            "text": status_msg,
            "type": "warn"
        })

        if disconnect:
            del state["clients"][client_key]
        else:
            state["clients"][client_key]["isAuth"] = False
            state["clients"][client_key]["email"] = None
            state["clients"][client_key]["last_seen"] = now

    # Log global
    action_lbl = "Părăsire pagină (Deconectat)" if disconnect else "Delogare cont"
    state["logs"].append({
        "text": f"[{time_str}] [Auth] {action_lbl}: {email or display_ip}",
        "time": now,
        "type": "warn"
    })
    save_state(state)

# In-memory P2P Tracker State (Zero message persistence on server, tracker acts like torrent tracker)
PEERS = {}
SIGNAL_BOXES = {}

def announce_peer(peer_id, email, client_ip, user_agent=""):
    now = time.time()
    display_ip = client_ip
    if display_ip in ["127.0.0.1", "::1", "localhost"]:
        display_ip = "192.168.1.46"

    # Inregistrare client in lista conexiunilor active
    track_request("GET", f"/api/tracker/announce?email={email or ''}", {}, None, display_ip, user_agent)

    # Curatare peers inactivi > 25s
    for pid in list(PEERS.keys()):
        if now - PEERS[pid].get("last_seen", 0) > 25:
            del PEERS[pid]

    PEERS[peer_id] = {
        "peerId": peer_id,
        "email": email,
        "ip": display_ip,
        "last_seen": now
    }

    other_peers = [
        {"peerId": p["peerId"], "email": p["email"], "ip": p["ip"]}
        for pid, p in PEERS.items() if pid != peer_id and (now - p["last_seen"] < 25)
    ]
    return other_peers

def send_peer_signal(from_peer, to_peer, signal_data, client_ip):
    now = time.time()
    time_str = time.strftime("%H:%M:%S")
    if to_peer not in SIGNAL_BOXES:
        SIGNAL_BOXES[to_peer] = []
    
    SIGNAL_BOXES[to_peer].append({
        "from": from_peer,
        "data": signal_data,
        "timestamp": now
    })
    SIGNAL_BOXES[to_peer] = SIGNAL_BOXES[to_peer][-100:]

    sig_type = signal_data.get("type", "P2P_PACKET") if isinstance(signal_data, dict) else "P2P_PACKET"

    state = get_state()
    user_key = from_peer
    if from_peer in PEERS and PEERS[from_peer].get("email"):
        user_key = PEERS[from_peer]["email"]
    
    if user_key not in state["user_logs"]:
        state["user_logs"][user_key] = []
    
    state["user_logs"][user_key].append({
        "time": now,
        "text": f"[{time_str}] [P2P Direct] Transmis pachet către peer ({sig_type})",
        "type": "info"
    })
    state["user_logs"][user_key] = state["user_logs"][user_key][-50:]

    state["logs"].append({
        "text": f"[{time_str}] [P2P Tracker] Semnal {sig_type} ({user_key} ➔ {to_peer[:8]}..)",
        "time": now,
        "type": "info"
    })
    state["logs"] = state["logs"][-60:]
    save_state(state)

def get_peer_signals(peer_id):
    return SIGNAL_BOXES.pop(peer_id, [])

def get_active_clients():
    state = get_state()
    now = time.time()
    active = []

    for k in list(state["clients"].keys()):
        v = state["clients"][k]
        last_seen = v.get("last_seen", 0)
        time_diff = now - last_seen
        
        # Purjare automata dupa 25 secunde de inactivitate
        if time_diff > 25:
            del state["clients"][k]
            continue

        user_key = v.get("email") or v.get("ip")
        user_history = state.get("user_logs", {}).get(user_key, [])
        if not user_history and v.get("ip") in state.get("user_logs", {}):
            user_history = state["user_logs"][v["ip"]]

        client_copy = dict(v)
        client_copy["logs"] = user_history[-40:]
        client_copy["inactiveSeconds"] = max(0, int(time_diff))
        active.append(client_copy)

    save_state(state)
    return active

def get_logs():
    state = get_state()
    return state.get("logs", [])
