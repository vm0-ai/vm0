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

# Copy root CA to .certs for devcontainer trust
CAROOT=$(mkcert -CAROOT)
if [ -f "$CAROOT/rootCA.pem" ]; then
  cp "$CAROOT/rootCA.pem" "$CERTS_DIR/"
  echo -e "${GREEN}✓ Copied rootCA.pem to ${CERTS_DIR}/${NC}"
fi

cd "$CERTS_DIR"

# Generate certificates for each domain (skip if already exists)
echo -e "${YELLOW}Checking certificates...${NC}"

GENERATED_COUNT=0
SKIPPED_COUNT=0

# Main domain
if [ -f "vm7.ai.pem" ] && [ -f "vm7.ai-key.pem" ]; then
  echo -e "  - vm7.ai ${YELLOW}(skipped - already exists)${NC}"
  SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
else
  echo "  - vm7.ai"
  mkcert -cert-file vm7.ai.pem -key-file vm7.ai-key.pem \
    "vm7.ai" "localhost" "127.0.0.1" "::1"
  GENERATED_COUNT=$((GENERATED_COUNT + 1))
fi

# Web app
if [ -f "www.vm7.ai.pem" ] && [ -f "www.vm7.ai-key.pem" ]; then
  echo -e "  - www.vm7.ai ${YELLOW}(skipped - already exists)${NC}"
  SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
else
  echo "  - www.vm7.ai"
  mkcert -cert-file www.vm7.ai.pem -key-file www.vm7.ai-key.pem \
    "www.vm7.ai" "localhost" "127.0.0.1" "::1"
  GENERATED_COUNT=$((GENERATED_COUNT + 1))
fi

# Docs app
if [ -f "docs.vm7.ai.pem" ] && [ -f "docs.vm7.ai-key.pem" ]; then
  echo -e "  - docs.vm7.ai ${YELLOW}(skipped - already exists)${NC}"
  SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
else
  echo "  - docs.vm7.ai"
  mkcert -cert-file docs.vm7.ai.pem -key-file docs.vm7.ai-key.pem \
    "docs.vm7.ai" "localhost" "127.0.0.1" "::1"
  GENERATED_COUNT=$((GENERATED_COUNT + 1))
fi

# Platform app
if [ -f "platform.vm7.ai.pem" ] && [ -f "platform.vm7.ai-key.pem" ]; then
  echo -e "  - platform.vm7.ai ${YELLOW}(skipped - already exists)${NC}"
  SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
else
  echo "  - platform.vm7.ai"
  mkcert -cert-file platform.vm7.ai.pem -key-file platform.vm7.ai-key.pem \
    "platform.vm7.ai" "localhost" "127.0.0.1" "::1"
  GENERATED_COUNT=$((GENERATED_COUNT + 1))
fi

if [ $GENERATED_COUNT -gt 0 ]; then
  echo -e "${GREEN}✓ Generated ${GENERATED_COUNT} certificate(s) in ${CERTS_DIR}/${NC}"
else
  echo -e "${GREEN}✓ All certificates already exist in ${CERTS_DIR}/${NC}"
fi
if [ $SKIPPED_COUNT -gt 0 ]; then
  echo -e "${YELLOW}  (${SKIPPED_COUNT} certificate(s) skipped)${NC}"
fi
echo ""
echo "Generated certificates:"
ls -lh "$CERTS_DIR"/*.pem
echo ""
echo -e "${GREEN}You can now start the development server with HTTPS support.${NC}"
