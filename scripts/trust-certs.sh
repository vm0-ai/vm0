#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== VM7 Development Certificate Setup ===${NC}"
echo ""

# Find git root directory
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$GIT_ROOT" ]; then
    echo "Error: Not in a git repository"
    exit 1
fi

# Get mkcert CA root
CAROOT=$(mkcert -CAROOT 2>/dev/null || echo "$HOME/.local/share/mkcert")

if [ ! -f "$CAROOT/rootCA.pem" ]; then
    echo -e "${YELLOW}No mkcert CA found. Generating certificates first...${NC}"
    bash "$GIT_ROOT/scripts/generate-certs.sh"
fi

echo -e "${GREEN}mkcert CA location: $CAROOT${NC}"
echo ""

# Detect OS and provide instructions
OS="$(uname -s)"
case "$OS" in
    Darwin*)
        echo -e "${BLUE}macOS detected${NC}"
        echo ""
        echo "Installing CA to system trust store..."
        mkcert -install
        echo ""
        echo -e "${GREEN}✓ Certificate installed!${NC}"
        echo "Chrome and Firefox will now trust https://www.vm7.ai:8443"
        ;;
    Linux*)
        echo -e "${BLUE}Linux detected${NC}"
        echo ""
        echo "Installing CA to system and browser trust stores..."
        mkcert -install
        echo ""
        echo -e "${GREEN}✓ Certificate installed!${NC}"
        echo "Chrome and Firefox will now trust https://www.vm7.ai:8443"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        echo -e "${BLUE}Windows detected${NC}"
        echo ""
        echo "Installing CA to system and browser trust stores..."
        mkcert -install
        echo ""
        echo -e "${GREEN}✓ Certificate installed!${NC}"
        echo "Chrome and Firefox will now trust https://www.vm7.ai:8443"
        ;;
    *)
        echo -e "${YELLOW}Unknown OS: $OS${NC}"
        echo ""
        echo "Manual installation required:"
        echo "1. Copy the CA certificate:"
        echo "   $CAROOT/rootCA.pem"
        echo ""
        echo "2. Import it to your browser:"
        echo "   - Chrome: Settings → Privacy and security → Security → Manage certificates"
        echo "   - Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import"
        ;;
esac

echo ""
echo -e "${BLUE}=== Development URLs ===${NC}"
echo "  https://www.vm7.ai:8443      - Main web app"
echo "  https://docs.vm7.ai:8443     - Documentation"
echo "  https://platform.vm7.ai:8443 - Platform app"
echo "  https://storybook.vm7.ai:8443 - Storybook"
echo ""
echo -e "${YELLOW}Note: Make sure to add these to your /etc/hosts (or C:\\Windows\\System32\\drivers\\etc\\hosts on Windows):${NC}"
echo "  127.0.0.1 vm7.ai www.vm7.ai docs.vm7.ai platform.vm7.ai storybook.vm7.ai"
