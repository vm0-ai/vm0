#!/bin/bash

# Start VNC stack (Xvfb + openbox + x11vnc + websockify) for headed browser automation
# Runs via postStartCommand so processes persist beyond the lifecycle shell

echo "🖥️ Starting VNC stack..."

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  setsid Xvfb :99 -screen 0 1344x840x24 >/dev/null 2>&1 &
  sleep 1
  setsid env DISPLAY=:99 openbox >/dev/null 2>&1 &
  setsid x11vnc -display :99 -nopw -forever -shared -rfbport 5900 >/dev/null 2>&1 &
  setsid websockify --web /usr/share/novnc/ 0.0.0.0:6080 localhost:5900 >/dev/null 2>&1 &
  echo "✓ VNC stack started (noVNC at http://localhost:6080/vnc.html)"
else
  echo "✓ VNC stack already running"
fi
