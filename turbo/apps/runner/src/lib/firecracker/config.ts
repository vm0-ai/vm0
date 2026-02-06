/**
 * Firecracker Configuration Types and Builders
 *
 * Shared types and utilities for building Firecracker VM configurations.
 */

import { SNAPSHOT_NETWORK, generateSnapshotNetworkBootArgs } from "./netns.js";

/**
 * Firecracker static configuration format
 * See: https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
 */
export interface FirecrackerConfig {
  "boot-source": {
    kernel_image_path: string;
    boot_args: string;
  };
  drives: Array<{
    drive_id: string;
    path_on_host: string;
    is_root_device: boolean;
    is_read_only: boolean;
  }>;
  "machine-config": {
    vcpu_count: number;
    mem_size_mib: number;
  };
  "network-interfaces": Array<{
    iface_id: string;
    guest_mac: string;
    host_dev_name: string;
  }>;
  vsock: {
    guest_cid: number;
    uds_path: string;
  };
}

/**
 * Parameters for building Firecracker configuration
 */
interface FirecrackerConfigParams {
  kernelPath: string;
  rootfsPath: string;
  overlayPath: string;
  vsockPath: string;
  vcpus: number;
  memoryMb: number;
}

/**
 * Build kernel boot arguments
 *
 * Boot args:
 *   - console=ttyS0: serial console output
 *   - reboot=k: use keyboard controller for reboot
 *   - panic=1: reboot after 1 second on kernel panic
 *   - pci=off: disable PCI bus (not needed in microVM)
 *   - nomodules: skip module loading (not needed in microVM)
 *   - random.trust_cpu=on: trust CPU RNG, skip entropy wait
 *   - quiet loglevel=0: minimize kernel log output
 *   - nokaslr: disable kernel address space randomization
 *   - audit=0: disable kernel auditing
 *   - numa=off: disable NUMA (single node)
 *   - mitigations=off: disable CPU vulnerability mitigations
 *   - noresume: skip hibernation resume check
 *   - init=/sbin/vm-init: use vm-init (Rust binary) for filesystem setup and vsock-guest
 *   - ip=...: network configuration (fixed IPs from SNAPSHOT_NETWORK)
 */
export function buildBootArgs(): string {
  const networkBootArgs = generateSnapshotNetworkBootArgs();
  return `console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on quiet loglevel=0 nokaslr audit=0 numa=off mitigations=off noresume init=/sbin/vm-init ${networkBootArgs}`;
}

/**
 * Build Firecracker configuration
 *
 * Creates the JSON configuration for Firecracker's --config-file option.
 */
export function buildFirecrackerConfig(
  params: FirecrackerConfigParams,
): FirecrackerConfig {
  const bootArgs = buildBootArgs();

  return {
    "boot-source": {
      kernel_image_path: params.kernelPath,
      boot_args: bootArgs,
    },
    drives: [
      // Base drive (squashfs, read-only, shared across VMs)
      // Mounted as /dev/vda inside the VM
      {
        drive_id: "rootfs",
        path_on_host: params.rootfsPath,
        is_root_device: true,
        is_read_only: true,
      },
      // Overlay drive (ext4, read-write, per-VM)
      // Mounted as /dev/vdb inside the VM
      // The vm-init script combines these using overlayfs
      {
        drive_id: "overlay",
        path_on_host: params.overlayPath,
        is_root_device: false,
        is_read_only: false,
      },
    ],
    "machine-config": {
      vcpu_count: params.vcpus,
      mem_size_mib: params.memoryMb,
    },
    "network-interfaces": [
      {
        // Network interface uses fixed config from SNAPSHOT_NETWORK
        // TAP device is inside the namespace, created by netns-pool
        iface_id: "eth0",
        guest_mac: SNAPSHOT_NETWORK.guestMac,
        host_dev_name: SNAPSHOT_NETWORK.tapName,
      },
    ],
    // Guest CID 3 is the standard guest identifier (CID 0=hypervisor, 1=local, 2=host)
    vsock: {
      guest_cid: 3,
      uds_path: params.vsockPath,
    },
  };
}
