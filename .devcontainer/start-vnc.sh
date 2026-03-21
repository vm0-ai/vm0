#!/bin/bash

# Start VNC stack (Xvfb + openbox + x11vnc + websockify) for headed browser automation
# Installed as /etc/init.d/vnc and managed via `service vnc start`

echo "🖥️ Starting VNC stack..."

# Install init.d service if not present
if [ ! -f /etc/init.d/vnc ]; then
  sudo tee /etc/init.d/vnc >/dev/null <<'INITEOF'
#!/bin/sh
### BEGIN INIT INFO
# Provides:          vnc
# Required-Start:    $local_fs
# Required-Stop:     $local_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: VNC stack for headed browser automation
### END INIT INFO

VNC_USER="vscode"
PIDFILE_XVFB="/var/run/vnc-xvfb.pid"
PIDFILE_OPENBOX="/var/run/vnc-openbox.pid"
PIDFILE_X11VNC="/var/run/vnc-x11vnc.pid"
PIDFILE_WEBSOCKIFY="/var/run/vnc-websockify.pid"
PIDFILE_CADDY="/var/run/vnc-caddy.pid"
PIDFILE_RESIZE="/var/run/vnc-resize.pid"
X11VNC_LOG="/tmp/x11vnc-debug.log"
VNC_TLS_DIR="/etc/vnc-tls"

start() {
    if start-stop-daemon --status --pidfile "$PIDFILE_XVFB" 2>/dev/null; then
        echo "VNC stack already running"
        return 0
    fi

    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_XVFB" \
        --chuid "$VNC_USER" --exec /usr/bin/Xvfb -- :99 -screen 0 3840x2160x24
    sleep 1

    # Add common display modes and set initial resolution
    if command -v xrandr >/dev/null 2>&1; then
        DISPLAY=:99 xrandr --newmode "1344x840" 0 1344 1344 1344 1344 840 840 840 840 2>/dev/null || true
        DISPLAY=:99 xrandr --addmode screen "1344x840" 2>/dev/null || true
        DISPLAY=:99 xrandr -s 1344x840 2>/dev/null || true
    fi

    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_OPENBOX" \
        --chuid "$VNC_USER" --exec /usr/bin/env -- DISPLAY=:99 openbox

    install -o "$VNC_USER" -m 644 /dev/null "$X11VNC_LOG"
    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_X11VNC" \
        --chuid "$VNC_USER" --exec /usr/bin/x11vnc -- -display :99 -nopw -forever -shared -rfbport 5900 -xrandr resize -v -o "$X11VNC_LOG"

    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_WEBSOCKIFY" \
        --chuid "$VNC_USER" --exec /usr/bin/python3 -- /usr/bin/websockify --web /usr/share/novnc/ 127.0.0.1:6081 localhost:5900

    # Caddy HTTPS reverse proxy (localhost.direct self-signed cert)
    if [ -f "$VNC_TLS_DIR/cert.crt" ] && command -v caddy >/dev/null 2>&1; then
        CADDY_CFG="/tmp/vnc-caddyfile"
        cat > "$CADDY_CFG" << CADDYEOF
{
    auto_https off
}

:6080 {
    tls $VNC_TLS_DIR/cert.crt $VNC_TLS_DIR/cert.key
    reverse_proxy 127.0.0.1:6081
}
CADDYEOF
        start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_CADDY" \
            --exec /usr/local/bin/caddy -- run --config "$CADDY_CFG" --adapter caddyfile
    fi

    # Resize helper: watches x11vnc log for client resize requests and applies them via xrandr
    RESIZE_SCRIPT="__WORKSPACE_DIR__/.devcontainer/vnc-resize-helper.sh"
    if [ -f "$RESIZE_SCRIPT" ]; then
        start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_RESIZE" \
            --chuid "$VNC_USER" --exec /bin/bash -- "$RESIZE_SCRIPT" "$X11VNC_LOG"
    fi

    echo "VNC stack started"
}

stop() {
    start-stop-daemon --stop --pidfile "$PIDFILE_RESIZE" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_CADDY" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_WEBSOCKIFY" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_X11VNC" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_OPENBOX" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_XVFB" --oknodo
    rm -f "$PIDFILE_XVFB" "$PIDFILE_OPENBOX" "$PIDFILE_X11VNC" "$PIDFILE_WEBSOCKIFY" "$PIDFILE_CADDY" "$PIDFILE_RESIZE"
    echo "VNC stack stopped"
}

case "$1" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; start ;;
    status)
        if start-stop-daemon --status --pidfile "$PIDFILE_XVFB" 2>/dev/null; then
            echo "VNC stack is running"
        else
            echo "VNC stack is not running"
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
INITEOF
  # Inject actual workspace path into the installed init.d script
  WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  sudo sed -i "s|__WORKSPACE_DIR__|${WORKSPACE_DIR}|g" /etc/init.d/vnc
  sudo chmod +x /etc/init.d/vnc
fi

# Patch noVNC for automatic clipboard sync between browser and VNC session
NOVNC_CLIP_JS="/usr/share/novnc/app/clipboard-sync.js"
if [ ! -f "$NOVNC_CLIP_JS" ]; then
  sudo tee "$NOVNC_CLIP_JS" > /dev/null << 'CLIPEOF'
/* Auto-sync clipboard between browser and VNC session */
import UI from "./ui.js";

var _rfb = null;
Object.defineProperty(UI, "rfb", {
    configurable: true,
    get: function() { return _rfb; },
    set: function(v) {
        _rfb = v;
        if (v) {
            v.addEventListener("clipboard", function(e) {
                if (navigator.clipboard && e.detail && e.detail.text) {
                    navigator.clipboard.writeText(e.detail.text).catch(function() {});
                }
            });
        }
    }
});

window.addEventListener("focus", function() {
    if (navigator.clipboard && navigator.clipboard.readText && UI.rfb) {
        navigator.clipboard.readText().then(function(text) {
            if (text) UI.rfb.clipboardPasteFrom(text);
        }).catch(function() {});
    }
});
CLIPEOF
fi

NOVNC_HTML="/usr/share/novnc/vnc.html"
if ! grep -q "clipboard-sync" "$NOVNC_HTML" 2>/dev/null; then
  sudo sed -i '/src="app\/ui.js"/a \    <script type="module" crossorigin="anonymous" src="app/clipboard-sync.js"></script>' "$NOVNC_HTML"
fi

# Download localhost.direct self-signed TLS certificate for HTTPS
VNC_TLS_DIR="/etc/vnc-tls"
if [ ! -f "$VNC_TLS_DIR/cert.crt" ]; then
  sudo mkdir -p "$VNC_TLS_DIR"
  TMP_ZIP="$(mktemp)"
  if curl -sL -o "$TMP_ZIP" "https://aka.re/localhost-ss" && \
     unzip -o -P localhost "$TMP_ZIP" -d /tmp/vnc-tls-extract >/dev/null 2>&1; then
    sudo cp /tmp/vnc-tls-extract/localhost.direct.SS.crt "$VNC_TLS_DIR/cert.crt"
    sudo cp /tmp/vnc-tls-extract/localhost.direct.SS.key "$VNC_TLS_DIR/cert.key"
    sudo chmod 600 "$VNC_TLS_DIR/cert.key"
    rm -rf /tmp/vnc-tls-extract
  fi
  rm -f "$TMP_ZIP"
fi

sudo service vnc start
echo "✓ VNC stack started (noVNC at https://novnc.localhost.direct:6080/vnc.html)"
