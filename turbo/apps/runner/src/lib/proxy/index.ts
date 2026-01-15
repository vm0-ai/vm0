/**
 * Proxy module for runner-level network security
 *
 * This module provides:
 * - VM Registry: Tracks VM IP → RunId mappings
 * - Proxy Manager: Manages mitmproxy lifecycle
 */

export { getVMRegistry, initVMRegistry } from "./vm-registry";

export { getProxyManager, initProxyManager } from "./proxy-manager";
