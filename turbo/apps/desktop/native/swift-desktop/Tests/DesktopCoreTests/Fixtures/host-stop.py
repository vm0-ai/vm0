import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer


release_command = threading.Event()
lock = threading.Lock()
events = []
issued = set()
registrations = 0
stopped = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.endswith("/release-command"):
            release_command.set()
        elif self.path.endswith("/wait-late"):
            time.sleep(1.5)
        with lock:
            result = {"events": events.copy(), "registrations": registrations}
        self.respond(result)

    def do_POST(self):
        global registrations, stopped
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        token = self.headers.get("Authorization")
        if self.path.endswith("/hosts/start"):
            with lock:
                registrations += 1
                number = registrations
                events.append(f"start-{number}")
            self.respond({"hostId": f"host-{number}", "hostToken": f"token-{number}"})
        elif self.path.endswith("/commands/next"):
            with lock:
                claim = token not in issued
                issued.add(token)
            if claim:
                number = token.rsplit("-", 1)[1]
                self.respond({"status": "command", "command": {
                    "id": f"command-{number}", "kind": "apps.list", "payload": {}}})
            else:
                self.respond({"status": "idle"})
        elif self.path.endswith("/complete"):
            body = json.loads(raw or b"{}")
            with lock:
                if stopped:
                    events.append("late-complete-1")
                    late = True
                else:
                    code = body.get("error", {}).get("code")
                    events.append(f"complete-1:{body.get('status')}:{code}")
                    late = False
            self.respond({}, 401 if late else 200)
        elif self.path.endswith("/host/stop"):
            with lock:
                stopped = True
                events.append("stop-1")
            self.respond({})
        else:
            self.respond({})


class Server(ThreadingHTTPServer):
    def server_bind(self):
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


server = Server(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()


def request(message):
    if message["kind"] == "server.start":
        result = {"port": server.server_port}
    elif message["kind"] == "permissions.state":
        result = {"accessibility": True, "screenRecording": True}
    elif message["kind"] == "apps.list":
        release_command.wait(10)
        result = {"apps": [{"name": "Notes", "bundleId": "com.apple.Notes"}]}
    else:
        raise ValueError(message["kind"])
    with lock:
        print(json.dumps({"id": message["id"], "status": "succeeded", "result": result}), flush=True)


for line in sys.stdin:
    threading.Thread(target=request, args=(json.loads(line),), daemon=True).start()
