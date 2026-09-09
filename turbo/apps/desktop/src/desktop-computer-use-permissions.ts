import type { ComputerUseDriverController } from "./computer-use-driver";
import {
  createComputerUsePermissions,
  type ComputerUsePermissionProvider,
  type ComputerUsePermissionQuery,
} from "./computer-use-permissions";
import type {
  ComputerUseDriverId,
  ComputerUsePermissionState,
} from "./computer-use-types";

export function createDesktopComputerUsePermissions(options: {
  readonly driver: ComputerUseDriverController;
  readonly requestedDriver: () => ComputerUseDriverId;
  readonly transitioning: () => boolean;
  readonly host: ComputerUsePermissionProvider;
  readonly refreshNative: (
    query?: ComputerUsePermissionQuery,
  ) => Promise<ComputerUsePermissionState | null>;
}) {
  const useHostPermissions = () =>
    options.requestedDriver() === "cua" ||
    options.driver.selectedDriver.id === "cua" ||
    options.transitioning();
  const permissions = createComputerUsePermissions(
    (read) => {
      if (useHostPermissions()) return read(options.host);
      return options.driver.withPermissionProvider(read);
    },
    (query) =>
      useHostPermissions()
        ? options.host.getPermissions()
        : options.refreshNative(query),
  );
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
    refreshReady: async (query?: ComputerUsePermissionQuery) => {
      if (
        options.driver.getCapabilities().length > 0 ||
        options.transitioning()
      ) {
        try {
          const fresh = await options.refreshNative(query);
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
