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

start() {
    if start-stop-daemon --status --pidfile "$PIDFILE_XVFB" 2>/dev/null; then
        echo "VNC stack already running"
        return 0
    fi

    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_XVFB" \
        --chuid "$VNC_USER" --exec /usr/bin/Xvfb -- :99 -screen 0 1344x840x24
    sleep 1

    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_OPENBOX" \
        --chuid "$VNC_USER" --exec /usr/bin/env -- DISPLAY=:99 openbox

    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_X11VNC" \
        --chuid "$VNC_USER" --exec /usr/bin/x11vnc -- -display :99 -nopw -forever -shared -rfbport 5900

    start-stop-daemon --start --background --make-pidfile --pidfile "$PIDFILE_WEBSOCKIFY" \
        --chuid "$VNC_USER" --exec /usr/bin/python3 -- /usr/bin/websockify --web /usr/share/novnc/ 0.0.0.0:6080 localhost:5900

    echo "VNC stack started"
}

stop() {
    start-stop-daemon --stop --pidfile "$PIDFILE_WEBSOCKIFY" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_X11VNC" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_OPENBOX" --oknodo
    start-stop-daemon --stop --pidfile "$PIDFILE_XVFB" --oknodo
    rm -f "$PIDFILE_XVFB" "$PIDFILE_OPENBOX" "$PIDFILE_X11VNC" "$PIDFILE_WEBSOCKIFY"
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
  sudo chmod +x /etc/init.d/vnc
fi

sudo service vnc start
echo "✓ VNC stack started (noVNC at http://localhost:6080/vnc.html)"
