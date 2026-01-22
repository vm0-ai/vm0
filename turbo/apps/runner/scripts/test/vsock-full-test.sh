#!/bin/bash
#
# Firecracker Vsock Full Test Script
# For testing on metal devices (bare-metal instances with KVM support)
#
# Supported platforms: x86_64, aarch64
#
# Requirements:
#   - Metal instance (e.g., AWS i3.metal, c6g.metal)
#   - KVM support (/dev/kvm)
#   - Root privileges
#
# Tests bidirectional vsock communication:
#   - Guest runs a vsock echo server on port 5000
#   - Host connects and sends a message
#   - Guest echoes back the message
#
# Usage:
#   scp vsock-full-test.sh user@metal-host:~/
#   ssh user@metal-host "chmod +x ~/vsock-full-test.sh && sudo ~/vsock-full-test.sh"
#

set -e

ARCH=$(uname -m)
WORKDIR=~/fc-vsock-test
FC_VERSION="v1.14.1"
VSOCK_PORT=5000

echo "=============================================="
echo "Firecracker Vsock Full Test"
echo "Platform: $ARCH"
echo "Firecracker: $FC_VERSION"
echo "Date: $(date)"
echo "=============================================="
echo ""

# Cleanup any existing firecracker
sudo pkill -9 firecracker 2>/dev/null || true
sleep 1

mkdir -p $WORKDIR
cd $WORKDIR

echo "[1/7] Downloading Firecracker $FC_VERSION..."
if [ ! -f firecracker ]; then
    curl -sSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz" | tar -xz
    mv release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH} firecracker
    rm -rf release-${FC_VERSION}-${ARCH}
fi
./firecracker --version 2>&1 | head -1

echo ""
echo "[2/7] Downloading kernel (PCI-enabled, v1.14-def)..."
if [ ! -f vmlinux ]; then
    curl -sSL -o vmlinux "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14-def/${ARCH}/vmlinux-6.1.150"
fi
ls -lh vmlinux

echo ""
echo "[3/7] Downloading and preparing rootfs..."
if [ ! -f rootfs.squashfs ]; then
    curl -sSL -o rootfs.squashfs "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14-def/${ARCH}/ubuntu-24.04.squashfs"
fi

# Always recreate ext4 to ensure clean state
echo "Converting squashfs to ext4..."
sudo rm -f rootfs.ext4
sudo apt-get install -y squashfs-tools > /dev/null 2>&1 || true
sudo mkdir -p /tmp/sq_mount /tmp/ext_mount
sudo umount /tmp/sq_mount 2>/dev/null || true
sudo umount /tmp/ext_mount 2>/dev/null || true
sudo mount -t squashfs rootfs.squashfs /tmp/sq_mount
dd if=/dev/zero of=rootfs.ext4 bs=1M count=2048 status=none
mkfs.ext4 -F rootfs.ext4 > /dev/null 2>&1
sudo mount rootfs.ext4 /tmp/ext_mount
sudo cp -a /tmp/sq_mount/* /tmp/ext_mount/

echo ""
echo "[4/7] Setting up vsock echo server in guest..."

# Create vsock echo server script
sudo tee /tmp/ext_mount/usr/local/bin/vsock-echo-server.py > /dev/null << 'VSOCK_SERVER_EOF'
#!/usr/bin/env python3
"""
Vsock Echo Server - listens on vsock and echoes back messages
"""
import socket
import sys

VSOCK_PORT = 5000

def main():
    # Create vsock socket
    # AF_VSOCK = 40, SOCK_STREAM = 1
    sock = socket.socket(40, socket.SOCK_STREAM)

    # Bind to any CID (VMADDR_CID_ANY = -1 or 0xFFFFFFFF) on port 5000
    # CID -1 means accept from any CID
    sock.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
    sock.listen(5)

    print(f"Vsock echo server listening on port {VSOCK_PORT}", flush=True)

    while True:
        conn, addr = sock.accept()
        print(f"Connection from CID={addr[0]}, port={addr[1]}", flush=True)

        try:
            while True:
                data = conn.recv(1024)
                if not data:
                    break
                response = f"ECHO: {data.decode().strip()}\n"
                conn.send(response.encode())
                print(f"Echoed: {data.decode().strip()}", flush=True)
        except Exception as e:
            print(f"Error: {e}", flush=True)
        finally:
            conn.close()
            print("Connection closed", flush=True)

if __name__ == "__main__":
    main()
VSOCK_SERVER_EOF

sudo chmod +x /tmp/ext_mount/usr/local/bin/vsock-echo-server.py

# Create systemd service for vsock echo server
sudo tee /tmp/ext_mount/etc/systemd/system/vsock-echo.service > /dev/null << 'VSOCK_SERVICE_EOF'
[Unit]
Description=Vsock Echo Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/bin/vsock-echo-server.py
Restart=always
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
VSOCK_SERVICE_EOF

# Enable the service
sudo ln -sf /etc/systemd/system/vsock-echo.service /tmp/ext_mount/etc/systemd/system/multi-user.target.wants/vsock-echo.service

# Add vsock check to .profile
sudo tee -a /tmp/ext_mount/root/.profile > /dev/null << 'PROFILE_EOF'

# === Vsock Status Check ===
echo ""
echo "########## VSOCK STATUS ##########"
echo "Checking /dev/vsock..."
ls -la /dev/vsock 2>&1 || echo "/dev/vsock: NOT FOUND"
echo ""
echo "Vsock echo server status:"
systemctl status vsock-echo --no-pager 2>&1 | head -5 || echo "Service not running"
echo "##################################"
echo ""
PROFILE_EOF

sudo umount /tmp/ext_mount
sudo umount /tmp/sq_mount
ls -lh rootfs.ext4

echo ""
echo "[5/7] Starting Firecracker with --enable-pci..."
sudo rm -f /tmp/firecracker.socket /tmp/v.sock

sudo ./firecracker --api-sock /tmp/firecracker.socket --enable-pci > /tmp/fc-boot.log 2>&1 &
FC_PID=$!
sleep 1
echo "Firecracker PID: $FC_PID"

echo ""
echo "[6/7] Configuring VM..."

# Boot source
curl -s --unix-socket /tmp/firecracker.socket -X PUT "http://localhost/boot-source" \
    -H "Content-Type: application/json" \
    -d "{
        \"kernel_image_path\": \"$WORKDIR/vmlinux\",
        \"boot_args\": \"console=ttyS0 reboot=k panic=1\"
    }"
echo "- Boot source configured"

# Root drive
curl -s --unix-socket /tmp/firecracker.socket -X PUT "http://localhost/drives/rootfs" \
    -H "Content-Type: application/json" \
    -d "{
        \"drive_id\": \"rootfs\",
        \"path_on_host\": \"$WORKDIR/rootfs.ext4\",
        \"is_root_device\": true,
        \"is_read_only\": false
    }"
echo "- Root drive configured"

# Vsock
curl -s --unix-socket /tmp/firecracker.socket -X PUT "http://localhost/vsock" \
    -H "Content-Type: application/json" \
    -d "{
        \"guest_cid\": 3,
        \"uds_path\": \"/tmp/v.sock\"
    }"
echo "- Vsock configured (CID=3, UDS=/tmp/v.sock)"

# Machine config
curl -s --unix-socket /tmp/firecracker.socket -X PUT "http://localhost/machine-config" \
    -H "Content-Type: application/json" \
    -d "{
        \"vcpu_count\": 2,
        \"mem_size_mib\": 1024
    }"
echo "- Machine config: 2 vCPU, 1024 MiB RAM"

# Start VM
curl -s --unix-socket /tmp/firecracker.socket -X PUT "http://localhost/actions" \
    -H "Content-Type: application/json" \
    -d "{\"action_type\": \"InstanceStart\"}"
echo "- VM started"

echo ""
echo "[7/7] Waiting for boot (20 seconds)..."
sleep 20

echo ""
echo "=============================================="
echo "TEST RESULTS"
echo "=============================================="

echo ""
echo ">>> Host: Vsock UDS socket"
ls -la /tmp/v.sock 2>&1 || echo "ERROR: /tmp/v.sock not found!"

echo ""
echo ">>> Guest: Kernel vsock driver (from dmesg)"
grep -E "PF_VSOCK|virtio_vsock" /tmp/fc-boot.log || echo "WARNING: No vsock driver messages"

echo ""
echo ">>> Guest: /dev/vsock status (from .profile output)"
grep -A10 "VSOCK STATUS" /tmp/fc-boot.log || echo "WARNING: Vsock status not found"

echo ""
echo ">>> Host: Bidirectional vsock communication test"
echo "Connecting to guest vsock echo server on port $VSOCK_PORT..."

# Test bidirectional communication using Python (handles the two-phase protocol)
TEST_MSG="Hello from host! Time: $(date +%s)"
echo "Sending: $TEST_MSG"

RESPONSE=$(python3 << PYTEST
import socket
import sys

# Connect to Firecracker vsock UDS
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(5)
sock.connect("/tmp/v.sock")

# Phase 1: Send CONNECT request
sock.send(b"CONNECT ${VSOCK_PORT}\n")

# Phase 2: Wait for OK response
response = b""
while b"\n" not in response:
    data = sock.recv(1024)
    if not data:
        break
    response += data

ok_line = response.decode().strip()
print(f"Connect response: {ok_line}", file=sys.stderr)

if not ok_line.startswith("OK"):
    print(f"ERROR: {ok_line}")
    sys.exit(1)

# Phase 3: Send actual message
sock.send(b"${TEST_MSG}\n")

# Phase 4: Receive echo response
echo_response = sock.recv(1024).decode().strip()
print(echo_response)

sock.close()
PYTEST
2>&1)

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "ECHO:"; then
    echo ""
    echo ">>> BIDIRECTIONAL VSOCK TEST: SUCCESS"
else
    echo ""
    echo ">>> BIDIRECTIONAL VSOCK TEST: FAILED"
    echo "Expected response containing 'ECHO:', got: $RESPONSE"
fi

echo ""
echo ">>> Full boot log (vsock/virtio/PCI lines):"
grep -iE "vsock|virtio|pci" /tmp/fc-boot.log | grep -v "fc_api" | head -15

echo ""
echo ">>> Guest vsock echo server log:"
grep -i "vsock echo server\|Echoed:\|Connection from" /tmp/fc-boot.log | tail -10 || echo "No server logs found"

echo ""
echo "=============================================="
echo "TEST COMPLETE"
echo "=============================================="
