import path from "node:path";
import { z } from "zod";
import type { EmbeddedDriverHostState } from "@trycua/cua-driver";
import { CuaProcessOwner } from "./cua-process-owner";
import { recordCuaLaunch, type CuaSdk } from "./cua-runtime-files";
import {
  cuaConnectionSchema,
  cuaExitSchema,
  cuaMetadataSchema,
  cuaSessionEndSchema,
  cuaSessionStartSchema,
  cuaToolResultSchema,
  cuaToolSchema,
} from "./cua-process-protocol";

/** Pure JS proxies. The fixed helper is the only owner of native SDK objects. */
export function createRemoteCuaSdk(
  root: string,
  bundleId: string,
  generation: number,
  onFailure: () => void,
  budget: () => number,
  blockCleanup = false,
): CuaSdk {
  let owner: CuaProcessOwner | undefined;
  let state: EmbeddedDriverHostState = 0;
  let socketPath: string | undefined;
  const processOwner = () => {
    if (!owner) throw new Error("CUA host is not configured");
    return owner;
  };
  return {
    standardPermissionMode: 0,
    stoppedState: 0,
    get processOwner() {
      return owner;
    },
    createHost(options) {
      if (
        owner ||
        !options.socketPath ||
        options.binaryPath !== path.join(root, "cua-driver") ||
        options.hostBundleId !== bundleId ||
        options.permissionMode !== 0 ||
        options.dangerouslyBypassApprovals
      )
        throw new Error("Invalid fixed CUA host configuration");
      socketPath = options.socketPath;
      owner = new CuaProcessOwner(
        root,
        path.dirname(socketPath),
        bundleId,
        generation,
        onFailure,
        blockCleanup,
      );
      owner.setBudget(budget);
      return {
        async start() {
          recordCuaLaunch();
          state = 1;
          const result = await processOwner().request(
            { method: "start", input: {} },
            cuaConnectionSchema,
          );
          state = 2;
          return result;
        },
        async stop() {
          state = await processOwner().request(
            { method: "stop", input: {} },
            z.literal(0),
          );
        },
        state: () => state,
        waitForExit: (generation) =>
          processOwner().request(
            { method: "exit", input: { generation } },
            cuaExitSchema,
          ),
        uniffiDestroy() {
          void processOwner()
            .request({ method: "destroyHost", input: {} }, z.null())
            .catch(onFailure);
        },
      };
    },
    connect(socket) {
      if (socket !== socketPath) throw new Error("Foreign CUA socket");
      return {
        metadata: (options) =>
          processOwner().request(
            { method: "metadata", input: {} },
            cuaMetadataSchema,
            options?.signal,
          ),
        callTool: (name, json, options) =>
          processOwner().request(
            {
              method: "tool",
              input: cuaToolSchema.parse({ name, args: JSON.parse(json) }),
            },
            cuaToolResultSchema,
            options?.signal,
          ),
        startSession: (input, options) =>
          processOwner().request(
            {
              method: "sessionStart",
              input: { session: z.string().parse(input.session) },
            },
            cuaSessionStartSchema,
            options?.signal,
          ),
        endSession: (input, options) =>
          processOwner().request(
            {
              method: "sessionEnd",
              input: { session: z.string().parse(input.session) },
            },
            cuaSessionEndSchema,
            options?.signal,
          ),
        getDesktopState: (input, options) =>
          processOwner().request(
            {
              method: "desktopState",
              input: { session: z.string().parse(input.session) },
            },
            cuaToolResultSchema,
            options?.signal,
          ),
        uniffiDestroy() {
          void processOwner()
            .request({ method: "destroyClient", input: {} }, z.null())
            .catch(onFailure);
        },
      };
    },
  };
}
