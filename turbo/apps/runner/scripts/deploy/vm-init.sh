#!/bin/sh
#
# vm-init: VM initialization wrapper script
#
# This script is the entry point (PID 1) when the VM boots.
# It simply executes the vm-init Rust binary which handles:
# 1. Filesystem initialization (mounts, overlayfs, pivot_root)
# 2. PID 1 responsibilities (signal handling, zombie reaping)
# 3. vsock-agent for host-guest communication
#
exec /usr/local/bin/vm0-agent/vm-init
