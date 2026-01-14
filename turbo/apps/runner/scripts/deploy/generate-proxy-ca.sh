#!/bin/bash
#
# Generate mitmproxy CA certificate for VM0 runner proxy
#
# This script generates a CA certificate and private key that will be:
# 1. Dynamically installed to VMs at runtime (via executor.ts)
# 2. Used by mitmproxy on the runner host (for HTTPS interception)
#
# The certificate is generated in mitmproxy-compatible format.
#
# Usage: ./generate-proxy-ca.sh [output_dir]
#
# Arguments:
#   output_dir  Directory for output files (default: ./proxy-ca)
#
# Output files:
#   - mitmproxy-ca-cert.pem  CA certificate (installed to VMs dynamically)
#   - mitmproxy-ca.pem       CA certificate + private key (for mitmproxy)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/proxy-ca}"

echo "=== VM0 Proxy CA Generator ==="
echo "Output directory: ${OUTPUT_DIR}"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Check if certificates already exist
if [ -f "$OUTPUT_DIR/mitmproxy-ca-cert.pem" ] && [ -f "$OUTPUT_DIR/mitmproxy-ca.pem" ]; then
    echo "[INFO] CA certificates already exist in ${OUTPUT_DIR}"
    echo "[INFO] To regenerate, delete the existing files first"
    exit 0
fi

echo "[GENERATE] Creating CA certificate..."

# Generate CA private key
openssl genrsa -out "$OUTPUT_DIR/mitmproxy-ca-key.pem" 4096

# Generate CA certificate
# The certificate is valid for 10 years and uses the same format as mitmproxy
openssl req -new -x509 -days 3650 \
    -key "$OUTPUT_DIR/mitmproxy-ca-key.pem" \
    -out "$OUTPUT_DIR/mitmproxy-ca-cert.pem" \
    -subj "/CN=mitmproxy/O=mitmproxy" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

# Create combined PEM file (cert + key) for mitmproxy
# mitmproxy expects the CA in this format
cat "$OUTPUT_DIR/mitmproxy-ca-cert.pem" "$OUTPUT_DIR/mitmproxy-ca-key.pem" > "$OUTPUT_DIR/mitmproxy-ca.pem"

# Set permissions
chmod 644 "$OUTPUT_DIR/mitmproxy-ca-cert.pem"
chmod 600 "$OUTPUT_DIR/mitmproxy-ca.pem"
chmod 600 "$OUTPUT_DIR/mitmproxy-ca-key.pem"

echo ""
echo "=== CA Certificate Generated ==="
echo ""
echo "Files created:"
echo "  - ${OUTPUT_DIR}/mitmproxy-ca-cert.pem  (CA certificate - for VM installation)"
echo "  - ${OUTPUT_DIR}/mitmproxy-ca.pem       (CA cert + key - for mitmproxy)"
echo "  - ${OUTPUT_DIR}/mitmproxy-ca-key.pem   (CA private key)"
echo ""
echo "Next steps:"
echo "  Copy CA files to runner host: /opt/vm0-runner/proxy/"
echo "  - mitmproxy-ca.pem (for mitmproxy)"
echo "  - mitmproxy-ca-cert.pem (for VM installation)"
echo ""
