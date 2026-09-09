/** Public SDK test boundary only. No native code, apps, permissions or capture. */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { cuaBoundary } from "../src/test/cua-boundary";

const { sdk } = cuaBoundary();
const cursorFailure = new URL("../../../../../cursor-failure", import.meta.url);
const cursorEntered = new URL("../../../../../cursor-entered", import.meta.url);
const appLaunched = new URL("../../../../../app-launched", import.meta.url);
export const EmbeddedPermissionMode = { Standard: sdk.standardPermissionMode };
export const EmbeddedDriverHostState = { Stopped: sdk.stoppedState };
export const EmbeddedCuaDriverHost = {
  withOptions: sdk.createHost,
  instanceOf: (value: unknown) => typeof value === "object" && value !== null,
};
export const CuaDriver = {
  connect(socket: string) {
    const client = sdk.connect(socket);
    const hiddenSessions = new Set<string>();
    return {
      ...client,
      async startSession(input: { session: string }) {
        hiddenSessions.delete(input.session);
        return client.startSession(input);
      },
      async setAgentCursorEnabled(
        input: { session: string; enabled: boolean },
        options?: { signal?: AbortSignal },
      ) {
        if (input.enabled) throw new Error("Session cursor must stay hidden");
        const failure = existsSync(cursorFailure)
          ? readFileSync(cursorFailure, "utf8")
          : null;
        if (failure === "abort") {
          await writeFile(cursorEntered, "waiting for cancellation\n");
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new Error("Cursor suppression aborted"));
            if (options?.signal?.aborted) abort();
            else
              options?.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        if (failure === "rejected")
          return {
            text: "Cursor suppression refused",
            images: [],
            isError: true,
            degraded: false,
            rawJson: "{}",
            errorCode: "cursor_unavailable",
          };
        if (failure !== "mismatch") hiddenSessions.add(input.session);
        return {
          text: "",
          images: [],
          isError: false,
          degraded: false,
          rawJson: "{}",
          structuredJson: JSON.stringify({
            ...input,
            enabled: failure === "mismatch",
          }),
        };
      },
      async callTool(name: string, json: string) {
        const args: Record<string, unknown> = JSON.parse(json);
        if (name === "launch_app") await writeFile(appLaunched, "launched\n");
        if (
          typeof args.session === "string" &&
          !hiddenSessions.has(args.session)
        )
          throw new Error("Session was admitted before cursor suppression");
        return client.callTool(name, json);
      },
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
