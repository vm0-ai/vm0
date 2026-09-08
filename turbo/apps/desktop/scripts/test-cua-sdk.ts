/** Public SDK test boundary only. No native code, apps, permissions or capture. */
import { cuaBoundary } from "../src/test/cua-boundary";

const { sdk } = cuaBoundary();
export const EmbeddedPermissionMode = { Standard: sdk.standardPermissionMode };
export const EmbeddedDriverHostState = { Stopped: sdk.stoppedState };
export const EmbeddedCuaDriverHost = {
  withOptions: sdk.createHost,
  instanceOf: (value: unknown) => typeof value === "object" && value !== null,
};
export const CuaDriver = {
  connect(socket: string) {
    const client = sdk.connect(socket);
    return {
      ...client,
      async metadata() {
        const value = await client.metadata();
        return {
          driverVersion: value.driverVersion,
          contractVersion: value.contractVersion,
          toolsListSchemaVersion: value.toolsListSchemaVersion,
          capabilityVersion: value.capabilityVersion,
          mcpProtocolVersion: value.mcpProtocolVersion,
          pid: value.pid,
          embedded: value.embedded,
          hostBundleId: value.hostBundleId,
        };
      },
    };
  },
  instanceOf: (value: unknown) => typeof value === "object" && value !== null,
};
