import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { testOverride } from "./singleton";

const {
  get: getExternalConnectorCatalogOverride,
  set: setExternalConnectorCatalogOverride,
  clear: clearExternalConnectorCatalogOverride,
} = testOverride<boolean | undefined>(() => {
  return undefined;
});

export function isExternalConnectorCatalogEnabled(): boolean {
  return (
    getExternalConnectorCatalogOverride() ??
    isFeatureEnabled(FeatureSwitchKey.ExternalConnectorCatalog, {})
  );
}

export function mockExternalConnectorCatalogEnabled(enabled: boolean): void {
  setExternalConnectorCatalogOverride(enabled);
}

export function clearMockedExternalConnectorCatalogEnabled(): void {
  clearExternalConnectorCatalogOverride();
}
