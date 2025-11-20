#!/bin/bash

# Simple setup script for dev container (based on uspark setup)
set -e

echo "🚀 Setting up dev container..."

# Setup PostgreSQL (handled by postgresql feature)
sudo chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || true
sudo service postgresql start 2>/dev/null || true

# Setup directories - fix ownership for all mounted volumes
# This is the key difference - uspark fixes all directories at once
sudo mkdir -p /home/vscode/.local/bin
sudo chown -R vscode:vscode /home/vscode/.config /home/vscode/.cache /home/vscode/.local

# Install cloudflared for local webhook tunnel support
echo "🌐 Installing cloudflared..."
if ! command -v cloudflared &> /dev/null; then
  ARCH=$(dpkg --print-architecture)
  if [ "$ARCH" = "arm64" ]; then
    CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb"
  else
    CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
  fi

  echo "  Downloading cloudflared for $ARCH..."
  curl -sL "$CLOUDFLARED_URL" -o /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
  echo "✓ cloudflared installed ($(cloudflared --version | head -n 1))"
else
  echo "✓ cloudflared already installed ($(cloudflared --version | head -n 1))"
fi

# Add local development domains to /etc/hosts
echo "📝 Adding local domains to /etc/hosts..."
if ! grep -q "vm0.dev" /etc/hosts; then
  echo "127.0.0.1 vm0.dev www.vm0.dev docs.vm0.dev" | sudo tee -a /etc/hosts > /dev/null
  echo "✓ Added vm0.dev domains to /etc/hosts"
else
  echo "✓ vm0.dev domains already in /etc/hosts"
fi

# Install mkcert CA if certificates exist
if [ -d "/workspaces/vm01/.certs" ] && [ "$(ls -A /workspaces/vm01/.certs 2>/dev/null)" ]; then
  echo "🔐 Installing mkcert CA..."

  # Install CA to system trust store
  if command -v mkcert &> /dev/null; then
    mkcert -install 2>/dev/null || true
    echo "✓ mkcert CA installed"
  fi

  # Install CA to NSS database for Chrome/Firefox
  if command -v certutil &> /dev/null; then
    CAROOT="$(mkcert -CAROOT 2>/dev/null || echo "$HOME/.local/share/mkcert")"
    if [ -f "$CAROOT/rootCA.pem" ]; then
      # Create NSS database if it doesn't exist
      mkdir -p "$HOME/.pki/nssdb"
      certutil -d sql:"$HOME/.pki/nssdb" -N --empty-password 2>/dev/null || true

      # Add CA to NSS database
      certutil -d sql:"$HOME/.pki/nssdb" -A -t "C,," -n "mkcert" -i "$CAROOT/rootCA.pem" 2>/dev/null || true
      echo "✓ CA installed to NSS database"
    fi
  fi
else
  echo "ℹ️  No certificates found. Run 'npm run generate-certs' to create them."
fi

echo "✅ Dev container setup complete!"
