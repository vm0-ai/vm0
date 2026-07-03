#!/usr/bin/env bash

set -e

# Install dependencies
sudo apt update
sudo apt install -y ffmpeg fontconfig unzip

# Install VHS
ARCH=$(dpkg --print-architecture)
wget "https://github.com/charmbracelet/vhs/releases/download/v0.10.0/vhs_0.10.0_Linux_${ARCH}.tar.gz" -O /tmp/vhs.tar.gz
tar zxvf /tmp/vhs.tar.gz -C /tmp
mkdir -p ~/.local/bin
mv /tmp/vhs_0.10.0_Linux_${ARCH}/vhs ~/.local/bin/

# Install ttyd 1.7.7 (apt version is too old for VHS)
TTYD_ARCH="arm"
if [ "$ARCH" = "amd64" ]; then
  TTYD_ARCH="x86_64"
fi
wget "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" -O /tmp/ttyd
chmod +x /tmp/ttyd
sudo mv /tmp/ttyd /usr/local/bin/ttyd

echo "VHS installation complete!"
echo "  vhs version: $(~/.local/bin/vhs --version)"
echo "  ttyd version: $(ttyd --version)"
