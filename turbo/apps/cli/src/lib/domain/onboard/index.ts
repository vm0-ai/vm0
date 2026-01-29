export { isAuthenticated, runAuthFlow } from "./auth.js";

export {
  checkModelProviderStatus,
  getProviderChoices,
  setupModelProvider,
} from "./model-provider.js";

export {
  installVm0Plugin,
  handlePluginError,
  PRIMARY_SKILL_NAME,
  type PluginScope,
} from "./claude-setup.js";
