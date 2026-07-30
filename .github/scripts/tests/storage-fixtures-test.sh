#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TEST_TMP_DIR="$(mktemp -d)"
FIXTURE_DIR="$TEST_TMP_DIR/fixture"
SERVER_PID=""
SERVER_URL=""
REQUEST_LOG=""
FIXTURE_STATUS=0
FIXTURE_OUTPUT=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$message: expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local value="$1"
  local expected="$2"
  local message="$3"
  if [[ "$value" != *"$expected"* ]]; then
    fail "$message: expected output to contain '$expected', got: $value"
  fi
}

stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

start_server() {
  local scenario="$1"
  local scenario_dir="$TEST_TMP_DIR/$scenario"
  local port_file="$scenario_dir/port"

  mkdir -p "$scenario_dir"
  REQUEST_LOG="$scenario_dir/requests.log"

  python3 - "$scenario" "$port_file" "$REQUEST_LOG" <<'PY' &
import json
import sys
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

scenario = sys.argv[1]
port_file = Path(sys.argv[2])
request_log = Path(sys.argv[3])
counts: Counter[str] = Counter()
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def record(self) -> int:
        key = f"{self.command} {self.path}"
        with lock:
            counts[key] += 1
            with request_log.open("a", encoding="utf-8") as output:
                output.write(f"{key}\n")
            return counts[key]

    def discard_body(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)

    def respond(self, status: int, body: bytes = b"") -> None:
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        if body:
            self.send_header("Content-Type", "application/json")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self) -> None:
        self.discard_body()
        self.record()
        if self.path == "/api/test/storage-fixture/prepare":
            port = self.server.server_address[1]
            body = json.dumps(
                {
                    "versionId": "fixture-version",
                    "existing": False,
                    "uploads": {
                        "archive": {
                            "presignedUrl": f"http://127.0.0.1:{port}/archive"
                        },
                        "manifest": {
                            "presignedUrl": f"http://127.0.0.1:{port}/manifest"
                        },
                    },
                }
            ).encode()
            self.respond(200, body)
            return
        if self.path == "/api/test/storage-fixture/commit":
            body = json.dumps(
                {
                    "success": True,
                    "versionId": "fixture-version",
                    "headVersionId": "fixture-version",
                }
            ).encode()
            self.respond(200, body)
            return
        self.respond(404)

    def do_PUT(self) -> None:
        self.discard_body()
        attempt = self.record()
        if self.path == "/archive":
            if scenario == "retry-success" and attempt == 1:
                self.respond(500)
                return
            if scenario == "archive-exhausted":
                self.respond(500)
                return
            self.respond(200)
            return
        if self.path == "/manifest":
            self.respond(400 if scenario == "manifest-400" else 200)
            return
        self.respond(404)

    def log_message(self, format: str, *args: object) -> None:
        pass


with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    port_file.write_text(str(server.server_address[1]), encoding="utf-8")
    server.serve_forever()
PY
  SERVER_PID=$!

  local _attempt
  for _attempt in {1..100}; do
    if [[ -s "$port_file" ]]; then
      SERVER_URL="http://127.0.0.1:$(<"$port_file")"
      return
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      fail "fixture HTTP server exited before becoming ready"
    fi
    sleep 0.01
  done
  fail "fixture HTTP server did not become ready"
}

request_count() {
  local method="$1"
  local path="$2"
  awk -v method="$method" -v path="$path" '
    $1 == method && $2 == path { count += 1 }
    END { print count + 0 }
  ' "$REQUEST_LOG"
}

e2e_api_curl() {
  local path="$1"
  shift
  curl -fsS \
    -H "Authorization: Bearer test-token" \
    -H "Content-Type: application/json" \
    "$@" \
    "$SERVER_URL$path"
}

# shellcheck source=e2e/helpers/storage-fixtures.bash
source "$REPO_ROOT/e2e/helpers/storage-fixtures.bash"

run_fixture() {
  if FIXTURE_OUTPUT="$(seed_storage_fixture artifact test-artifact "$FIXTURE_DIR" 2>&1)"; then
    FIXTURE_STATUS=0
  else
    FIXTURE_STATUS=$?
  fi
}

mkdir -p "$FIXTURE_DIR"
printf 'fixture data\n' > "$FIXTURE_DIR/data.txt"

start_server retry-success
run_fixture
stop_server
assert_equal 0 "$FIXTURE_STATUS" "transient upload should recover"
assert_contains "$FIXTURE_OUTPUT" "fixture-version" "successful fixture should return its version"
assert_equal 2 "$(request_count PUT /archive)" "archive should retry once"
assert_equal 1 "$(request_count PUT /manifest)" "manifest should upload once"
assert_equal 1 "$(request_count POST /api/test/storage-fixture/commit)" "fixture should commit once"

start_server manifest-400
run_fixture
stop_server
if [[ "$FIXTURE_STATUS" -eq 0 ]]; then
  fail "manifest HTTP 400 should fail"
fi
assert_contains "$FIXTURE_OUTPUT" "# Storage fixture manifest upload failed" "manifest failure should identify its stage"
assert_equal 1 "$(request_count PUT /archive)" "archive should upload once"
assert_equal 1 "$(request_count PUT /manifest)" "manifest HTTP 400 should not retry"
assert_equal 0 "$(request_count POST /api/test/storage-fixture/commit)" "failed manifest should prevent commit"

start_server archive-exhausted
run_fixture
stop_server
if [[ "$FIXTURE_STATUS" -eq 0 ]]; then
  fail "persistent archive HTTP 500 should fail"
fi
assert_contains "$FIXTURE_OUTPUT" "# Storage fixture archive upload failed" "archive failure should identify its stage"
assert_equal 3 "$(request_count PUT /archive)" "archive should stop after three attempts"
assert_equal 0 "$(request_count PUT /manifest)" "failed archive should prevent manifest upload"
assert_equal 0 "$(request_count POST /api/test/storage-fixture/commit)" "failed archive should prevent commit"

echo "storage-fixtures-test: ok"
