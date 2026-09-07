import type { ComputerUseDriverController } from "./computer-use-driver";
import {
  createComputerUsePermissions,
  type ComputerUsePermissionProvider,
} from "./computer-use-permissions";
import type { ComputerUseDriverId } from "./computer-use-types";

export function createDesktopComputerUsePermissions(options: {
  readonly driver: ComputerUseDriverController;
  readonly requestedDriver: () => ComputerUseDriverId;
  readonly transitioning: () => boolean;
  readonly host: ComputerUsePermissionProvider;
}) {
  const permissions = createComputerUsePermissions((read) => {
    if (
      options.requestedDriver() === "cua" ||
      options.driver.selectedDriver.id === "cua" ||
      options.transitioning()
    )
      return read(options.host);
    return options.driver.withPermissionProvider(read);
  });
  return {
    ...permissions,
    /** Called only inside the authorized runtime start/replacement intent. */
    prepareNative: async () => {
      const result = await options.driver.withPermissionProvider((provider) =>
        provider.getPermissions(),
      );
      if (!result) throw new Error("Native driver readiness was superseded");
      return result;
    },
    refreshReady: async () => {
      if (options.driver.getCapabilities().length > 0) {
        try {
          const fresh = await options.driver.withPermissionProvider(
            (provider) => provider.getPermissions(),
          );
          if (fresh) return fresh;
        } catch {
          // Driver ownership already withdrew admission and retained cleanup.
          return { accessibility: false, screenRecording: false };
        }
      }
      return permissions.getComputerUsePermissionState();
    },
  };
}
