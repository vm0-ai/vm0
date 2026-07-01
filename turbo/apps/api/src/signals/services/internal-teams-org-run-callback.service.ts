import { command } from "ccstate";

import type { Db } from "../external/db";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";

export const handleTeamsOrgInternalCallback$ = command(
  (
    _getters,
    _callback: InternalRunCallbackEnvelope,
    _signal: AbortSignal,
  ): InternalRunCallbackDispatchResult => {
    return { success: true, skipped: true };
  },
);

export function handleTeamsOrgInternalCallbackWithoutCcstate(
  _db: Db,
  _callback: InternalRunCallbackEnvelope,
  _signal?: AbortSignal,
): InternalRunCallbackDispatchResult {
  return { success: true, skipped: true };
}
