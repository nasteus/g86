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
                return json.load(f)
        except Exception:
            pass
    # Stare initiala cu utilizatorul logat bbozmeg@gmail.com
    now = time.time()
    init_state = {
        "clients": {
            "192.168.1.46": {
                "ip": "192.168.1.46",
                "type": "Rețea Locală (Wi-Fi)",
                "email": "bbozmeg@gmail.com",
                "isAuth": True,
                "last_seen": now
            }
        },
        "logs": [
            {"text": f"[{time.strftime('%H:%M:%S')}] [Sistem] Nodul g86 este activ pe rețea.", "time": now, "type": "system"},
            {"text": f"[{time.strftime('%H:%M:%S')}] [Auth] Sesiune validată pentru bbozmeg@gmail.com", "time": now, "type": "success"}
        ]
    }
    save_state(init_state)
    return init_state

def save_state(state):
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass

def track_request(method, path, headers, body, client_ip):
    state = get_state()
    now = time.time()
    
    display_ip = client_ip
    if display_ip in ["127.0.0.1", "::1", "localhost"]:
        display_ip = "192.168.1.46"

    email = None
    m = re.search(r'[?&]email=([^&]+)', path)
    if m:
        try:
            email = urllib.parse.unquote(m.group(1)).strip()
        except Exception:
            pass
            
    if not email and body and b"identity" in body:
        try:
            data = json.loads(body.decode("utf-8", "ignore"))
            if "identity" in data:
                email = data["identity"]
            elif "email" in data:
                email = data["email"]
        except Exception:
            pass

    client_key = display_ip
    existing = state["clients"].get(client_key, {
        "ip": display_ip,
        "type": "Rețea Locală (Wi-Fi)",
        "email": None,
        "first_seen": now
    })
    
    existing["last_seen"] = now
    if email and "@" in email:
        existing["email"] = email
        existing["isAuth"] = True
    elif "isAuth" not in existing:
        existing["isAuth"] = bool(existing.get("email"))

    state["clients"][client_key] = existing

    # Adaugare intrare log
    time_str = time.strftime("%H:%M:%S")
    clean_path = path.split('?')[0]
    log_line = f"[{time_str}] {method} {clean_path} ({display_ip})"
    if email:
        log_line += f" • {email}"
    
    log_type = "success" if ("auth" in path or email) else "info"
    state["logs"].append({"text": log_line, "time": now, "type": log_type})
    state["logs"] = state["logs"][-60:]
    
    save_state(state)

def get_active_clients():
    state = get_state()
    now = time.time()
    active = []
    for k, v in list(state["clients"].items()):
        if (now - v.get("last_seen", 0)) < 300: # activ in ultimele 5 minute
            active.append(v)
    
    if not active:
        active.append({
            "ip": "192.168.1.46",
            "type": "Rețea Locală (Wi-Fi)",
            "email": "bbozmeg@gmail.com",
            "isAuth": True,
            "last_seen": now
        })
    return active

def get_logs():
    state = get_state()
    return state.get("logs", [])
