#!/usr/bin/env python3
import http.server
import socketserver
import urllib.request
import urllib.error
import os
import sys
import json
import tracker

PORT = 8787
PB_API_URL = "http://127.0.0.1:8090"
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "pb_backend_public"))

class BackendHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/_"):
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return

        if self.path == "/api/active-clients":
            clients = tracker.get_active_clients()
            body = json.dumps(clients).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/api/server-logs":
            logs = tracker.get_logs()
            body = json.dumps(logs).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/api/chat/messages":
            messages = tracker.get_chat_messages()
            body = json.dumps(messages).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path.startswith("/api/"):
            self.proxy_request("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/logout"):
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else b""
            email = None
            disconnect = False
            if body:
                try:
                    data = json.loads(body.decode("utf-8", "ignore"))
                    email = data.get("email")
                    disconnect = bool(data.get("disconnect", False))
                except Exception:
                    pass
            tracker.logout_user(self.client_address[0], email, disconnect=disconnect)
            res = json.dumps({"status": "ok", "message": "Logged out"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(res)))
            self.end_headers()
            self.wfile.write(res)
            return

        if self.path == "/api/chat/messages":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else b""
            try:
                msg_bundle = json.loads(body.decode("utf-8", "ignore"))
                tracker.add_chat_message(msg_bundle, self.client_address[0])
                res = json.dumps({"status": "ok", "message": "Message saved"}).encode("utf-8")
            except Exception as e:
                res = json.dumps({"status": "error", "message": str(e)}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(res)))
            self.end_headers()
            self.wfile.write(res)
            return

        if self.path == "/api/refresh-client":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else b""
            tracker.track_request("POST", "/api/refresh-client", self.headers, body, self.client_address[0], self.headers.get("User-Agent", ""))
            res = json.dumps({"status": "ok", "message": "Client refreshed"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(res)))
            self.end_headers()
            self.wfile.write(res)
            return

        if self.path.startswith("/api/"):
            self.proxy_request("POST")
        else:
            self.send_error(405, "Method Not Allowed")

    def proxy_request(self, method):
        target_url = PB_API_URL + self.path
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        ua = self.headers.get("User-Agent", "")
        tracker.track_request(method, self.path, self.headers, body, self.client_address[0], ua)

        headers = {}
        for key, val in self.headers.items():
            if key.lower() not in ["host", "content-length"]:
                headers[key] = val

        req = urllib.request.Request(target_url, data=body, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req) as response:
                self.send_response(response.status)
                for header, val in response.getheaders():
                    if header.lower() not in ["transfer-encoding", "content-length"]:
                        self.send_header(header, val)
                content = response.read()
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for header, val in e.headers.items():
                if header.lower() not in ["transfer-encoding", "content-length"]:
                    self.send_header(header, val)
            err_content = e.read()
            self.send_header("Content-Length", str(len(err_content)))
            self.end_headers()
            self.wfile.write(err_content)
        except Exception as e:
            self.send_error(502, f"Bad Gateway: {str(e)}")

class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True

if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass
    print("=======================================================")
    print(f">> G86 PHONE BACKEND CONTROL: http://localhost:{PORT}")
    print(f">> POCKETBASE API PROXY:      {PB_API_URL}")
    print(f">> UI DIR:                    {STATIC_DIR}")
    print("=======================================================")
    with ThreadingTCPServer(("0.0.0.0", PORT), BackendHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nOprit backend server.")
