#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Generating SSL certificates for local development...${NC}"

# Check if mkcert is installed
if ! command -v mkcert &> /dev/null; then
    echo -e "${RED}Error: mkcert is not installed${NC}"
    echo "Please install mkcert first:"
    echo "  macOS: brew install mkcert"
    echo "  Linux: See https://github.com/FiloSottile/mkcert#installation"
    exit 1
fi

# Find git root directory
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$GIT_ROOT" ]; then
    echo -e "${RED}Error: Not in a git repository${NC}"
    exit 1
fi

echo -e "${YELLOW}Git root: ${GIT_ROOT}${NC}"

# Install mkcert CA in system trust store
echo -e "${YELLOW}Installing mkcert CA in system trust store...${NC}"
mkcert -install

# Create .certs directory in git root if it doesn't exist
CERTS_DIR="${GIT_ROOT}/.certs"
mkdir -p "$CERTS_DIR"
cd "$CERTS_DIR"

# Generate certificates for each domain
echo -e "${YELLOW}Generating certificates...${NC}"

# Main domain
echo "  - vm7.ai"
mkcert -cert-file vm7.ai.pem -key-file vm7.ai-key.pem \
  "vm7.ai" "localhost" "127.0.0.1" "::1"

# Web app
echo "  - www.vm7.ai"
mkcert -cert-file www.vm7.ai.pem -key-file www.vm7.ai-key.pem \
  "www.vm7.ai" "localhost" "127.0.0.1" "::1"

# Docs app
echo "  - docs.vm7.ai"
mkcert -cert-file docs.vm7.ai.pem -key-file docs.vm7.ai-key.pem \
  "docs.vm7.ai" "localhost" "127.0.0.1" "::1"

echo -e "${GREEN}✓ Certificates generated successfully in ${CERTS_DIR}/${NC}"
echo ""
echo "Generated certificates:"
ls -lh "$CERTS_DIR"/*.pem
echo ""
echo -e "${GREEN}You can now start the development server with HTTPS support.${NC}"
