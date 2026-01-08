/**
 * Proxy module for runner-level network security
 *
 * This module provides:
 * - VM Registry: Tracks VM IP → RunId mappings
 * - Proxy Manager: Manages mitmproxy lifecycle
 */

export {
  VMRegistry,
  type VMRegistration,
  getVMRegistry,
  initVMRegistry,
  DEFAULT_REGISTRY_PATH,
} from "./vm-registry";

export {
  ProxyManager,
  type ProxyConfig,
  getProxyManager,
  initProxyManager,
  DEFAULT_PROXY_CONFIG,
} from "./proxy-manager";

export { RUNNER_MITM_ADDON_SCRIPT } from "./mitm-addon-script";
