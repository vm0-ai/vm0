#!/bin/bash

# Simple setup script for dev container (based on vm0 setup)
set -e

echo "🚀 Setting up dev container..."

# Setup PostgreSQL (handled by postgresql feature)
sudo chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || true
sudo service postgresql start 2>/dev/null || true

# Generate locale for UTF-8 support
echo "🌐 Setting up locale..."
sudo locale-gen en_US.UTF-8 2>/dev/null || true
sudo update-locale LANG=en_US.UTF-8 2>/dev/null || true
echo "✓ Locale configured"

# Setup directories - fix ownership for all mounted volumes
# Note: NSS database is created in /workspaces/vm01/.mozilla (not ~/.pki)
# to avoid BTRFS + nodatacow compatibility issues
sudo mkdir -p /home/vscode/.local/bin /home/vscode/.pki
sudo chown -R vscode:vscode /home/vscode/.config /home/vscode/.cache /home/vscode/.local /home/vscode/.pki

# Add local development domains to /etc/hosts
echo "📝 Adding local domains to /etc/hosts..."
if ! grep -q "vm7.ai" /etc/hosts; then
  echo "127.0.0.1 vm7.ai www.vm7.ai docs.vm7.ai platform.vm7.ai storybook.vm7.ai" | sudo tee -a /etc/hosts > /dev/null
  echo "✓ Added vm7.ai domains to /etc/hosts"
else
  echo "✓ vm7.ai domains already in /etc/hosts"
fi

# Create NSS database in project directory (uses host filesystem, not BTRFS volume)
# This avoids BTRFS + nodatacow compatibility issues with SQLite
NSS_DIR="/workspaces/vm01/.mozilla/firefox/mkcert.default"
if [ ! -d "$NSS_DIR" ] || [ ! -f "$NSS_DIR/cert9.db" ]; then
  echo "🔧 Creating NSS database for browser certificate trust..."
  mkdir -p "$NSS_DIR"

  # Create NSS database with empty password
  PWFILE=$(mktemp)
  echo "" > "$PWFILE"
  certutil -N -d sql:"$NSS_DIR" -f "$PWFILE"
  rm -f "$PWFILE"

  # Create Firefox profiles.ini
  cat > "/workspaces/vm01/.mozilla/firefox/profiles.ini" << 'EOF'
[General]
StartWithLastProfile=1

[Profile0]
Name=mkcert
IsRelative=1
Path=mkcert.default
Default=1
EOF

  echo "✓ NSS database created"
fi

# Create symlink from ~/.mozilla to project directory for easy access
if [ ! -L "$HOME/.mozilla" ]; then
  rm -rf "$HOME/.mozilla"
  ln -s "/workspaces/vm01/.mozilla" "$HOME/.mozilla"
  echo "✓ Linked ~/.mozilla to project directory"
fi

# Install mkcert CA if certificates exist
if [ -d "/workspaces/vm01/.certs" ] && [ "$(ls -A /workspaces/vm01/.certs 2>/dev/null)" ]; then
  echo "🔐 Installing mkcert CA..."

  if command -v mkcert &> /dev/null; then
    CAROOT=$(mkcert -CAROOT)

    # Install to system trust store (for curl, Node.js, etc.)
    TRUST_STORES=system mkcert -install
    echo "✓ mkcert CA installed to system trust store"

    # Install to NSS for browsers (Chrome/Firefox)
    # Use certutil directly since mkcert doesn't handle symlinks well
    if [ -f "$CAROOT/rootCA.pem" ] && [ -f "$NSS_DIR/cert9.db" ]; then
      PWFILE=$(mktemp)
      echo "" > "$PWFILE"
      certutil -d sql:"$NSS_DIR" -A -t "C,," -n "mkcert" -i "$CAROOT/rootCA.pem" -f "$PWFILE"
      rm -f "$PWFILE"
      echo "✓ mkcert CA installed to NSS database"
    fi
  fi
else
  echo "ℹ️  No certificates found. Run 'npm run generate-certs' to create them."
fi

echo "✅ Dev container setup complete!"
