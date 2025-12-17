/**
 * Proxy setup script for mitmproxy transparent proxy (Python)
 * Installs and configures mitmproxy to intercept HTTPS traffic
 */
export const PROXY_SETUP_SCRIPT = `#!/usr/bin/env python3
"""
Proxy setup for VM0 network security mode.
This script:
1. Installs mitmproxy and dependencies
2. Generates and installs CA certificate
3. Configures nftables for transparent proxying
4. Starts mitmproxy with the VM0 addon
"""
import os
import sys
import subprocess
import time

# Add lib to path for imports
sys.path.insert(0, "/usr/local/bin/vm0-agent/lib")

from log import log_info, log_error, log_warn

# Proxy configuration
MITM_PORT = 8080
MITM_CA_DIR = "/root/.mitmproxy"  # Proxy setup runs as root
MITM_CA_CERT = f"{MITM_CA_DIR}/mitmproxy-ca-cert.pem"
ADDON_PATH = "/usr/local/bin/vm0-agent/lib/mitm_addon.py"


def run_cmd(cmd: list, check: bool = True) -> subprocess.CompletedProcess:
    """Run a command and log output."""
    log_info(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.stdout:
        log_info(f"stdout: {result.stdout.strip()}")
    if result.stderr:
        log_warn(f"stderr: {result.stderr.strip()}")
    if check and result.returncode != 0:
        raise RuntimeError(f"Command failed with code {result.returncode}")
    return result


def install_dependencies():
    """Install required packages (must run as root)."""
    log_info("Installing dependencies...")

    # Update apt cache
    run_cmd(["apt-get", "update", "-qq"])

    # Install required packages
    run_cmd([
        "apt-get", "install", "-y", "-qq",
        "python3-pip",
        "nftables",
        "ca-certificates"
    ])

    # Install mitmproxy system-wide
    log_info("Installing mitmproxy (this may take a minute)...")
    run_cmd([
        "pip3", "install", "mitmproxy",
        "--break-system-packages",
        "--quiet"
    ])

    log_info("Dependencies installed successfully")


def setup_ca_certificate():
    """Generate and install mitmproxy CA certificate."""
    log_info("Setting up CA certificate...")

    # Create mitmproxy config directory
    os.makedirs(MITM_CA_DIR, exist_ok=True)

    # Generate CA certificate by running mitmproxy briefly
    # This creates the CA cert if it doesn't exist
    log_info("Generating mitmproxy CA certificate...")
    proc = subprocess.Popen(
        ["mitmdump", "--set", "confdir=" + MITM_CA_DIR],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    time.sleep(3)  # Wait for cert generation
    proc.terminate()
    proc.wait()

    # Verify cert was created
    if not os.path.exists(MITM_CA_CERT):
        raise RuntimeError("Failed to generate CA certificate")

    # Install CA certificate system-wide
    log_info("Installing CA certificate system-wide...")

    # Copy to system CA directory
    run_cmd([
        "cp", MITM_CA_CERT,
        "/usr/local/share/ca-certificates/mitmproxy-ca.crt"
    ])

    # Update CA certificates
    run_cmd(["update-ca-certificates"])

    # Set environment for Python requests library
    os.environ["REQUESTS_CA_BUNDLE"] = "/etc/ssl/certs/ca-certificates.crt"
    os.environ["SSL_CERT_FILE"] = "/etc/ssl/certs/ca-certificates.crt"

    log_info("CA certificate installed successfully")


def configure_nftables():
    """Configure nftables for transparent proxying."""
    log_info("Configuring nftables for transparent proxy...")

    # nftables rules for transparent proxy
    # - Skip traffic from root (UID 0) - mitmproxy runs as root
    # - Redirect all other TCP traffic to mitmproxy
    # NOTE: We use UID-based filtering because mitmproxy doesn't support SO_MARK
    nft_rules = f"""
flush ruleset

table ip nat {{
    chain prerouting {{
        type nat hook prerouting priority -100;
    }}

    chain output {{
        type nat hook output priority -100;

        # Skip traffic from root (UID 0) - mitmproxy runs as root
        # This prevents redirect loop: mitmproxy -> nftables -> mitmproxy
        meta skuid 0 return

        # Skip traffic to localhost
        ip daddr 127.0.0.0/8 return

        # Skip traffic to private networks (internal communication)
        ip daddr 10.0.0.0/8 return
        ip daddr 172.16.0.0/12 return
        ip daddr 192.168.0.0/16 return

        # Redirect HTTP traffic (port 80)
        tcp dport 80 redirect to :{MITM_PORT}

        # Redirect HTTPS traffic (port 443)
        tcp dport 443 redirect to :{MITM_PORT}
    }}
}}
"""

    # Write rules to file
    nft_file = "/tmp/vm0-proxy-rules.nft"
    with open(nft_file, "w") as f:
        f.write(nft_rules)

    # Apply rules
    run_cmd(["nft", "-f", nft_file])

    log_info("nftables configured successfully")


def start_mitmproxy():
    """Start mitmproxy with the VM0 addon in background."""
    log_info("Starting mitmproxy...")

    # Verify addon exists
    if not os.path.exists(ADDON_PATH):
        raise RuntimeError(f"Addon not found: {ADDON_PATH}")

    # Start mitmproxy in transparent mode with addon
    # NOTE: mitmproxy runs as root, and nftables skips root's traffic (meta skuid 0)
    # to avoid redirect loop
    cmd = [
        "mitmdump",
        "--mode", "transparent",
        "--listen-port", str(MITM_PORT),
        "--set", f"confdir={MITM_CA_DIR}",
        "--scripts", ADDON_PATH,
        "--quiet"  # Reduce log noise
    ]

    log_info(f"mitmproxy command: {' '.join(cmd)}")

    # Start in background
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True
    )

    # Wait briefly and check if it's running
    time.sleep(2)
    if proc.poll() is not None:
        raise RuntimeError("mitmproxy failed to start")

    log_info(f"mitmproxy started (PID: {proc.pid})")

    # Save PID for later cleanup if needed
    with open("/tmp/vm0-mitmproxy.pid", "w") as f:
        f.write(str(proc.pid))


def setup_proxy():
    """Main setup function."""
    log_info("=== VM0 Proxy Setup Starting ===")
    start_time = time.time()

    try:
        install_dependencies()
        setup_ca_certificate()
        configure_nftables()
        start_mitmproxy()

        elapsed = time.time() - start_time
        log_info(f"=== Proxy Setup Complete ({elapsed:.1f}s) ===")
        return True

    except Exception as e:
        log_error(f"Proxy setup failed: {e}")
        return False


if __name__ == "__main__":
    success = setup_proxy()
    sys.exit(0 if success else 1)
`;
