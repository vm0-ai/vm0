import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import type { ExecutionEnv } from "./types";

/**
 * Node-backed ExecutionEnv used by the Sandbox side of a handoff. Exposed as a
 * factory returning this package's own {@link ExecutionEnv} so consumers never
 * pull the native class declaration into their type program.
 */
export const createPiNodeExecutionEnv: (options: {
  readonly cwd: string;
  readonly shellPath?: string;
  readonly shellEnv?: NodeJS.ProcessEnv;
}) => ExecutionEnv = (options) => {
  return new NodeExecutionEnv({ ...options });
};
