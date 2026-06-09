import { computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  automationsMainContract,
  automationsByNameContract,
  automationsEnableContract,
  automationRunContract,
  type AutomationResponse,
} from "@vm0/api-contracts/contracts/automations";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroScheduleRunContract,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type { ZeroClientFactory } from "../api-client.ts";
import type { ScheduleBody } from "./cron.ts";

// ---------------------------------------------------------------------------
// Surface-only gating for the Automations product view.
//
// The Automations API is a cleaned product projection over the very same
// schedule service that backs the legacy `/api/zero/schedules` routes — the two
// surfaces drive the same agent run + chat-thread rendering and share the same
// field set (an `AutomationResponse` IS a `ScheduleResponse`; only the wrapper
// key differs). When the `zeroAutomations` switch is on we talk to the
// Automations endpoints and label the surface "Automations"; when off we stay
// on the schedule endpoints and label it "Schedules". There is no execution
// fork: these helpers only pick which equivalent endpoint the client hits and
// normalize the response back to `ScheduleResponse` so callers are unchanged.
// ---------------------------------------------------------------------------

/** True when the Automations surface is enabled for the current identity. */
export const automationsModeEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ZeroAutomations] ?? false;
});

// `AutomationResponse` and `ScheduleResponse` are the same shape; this keeps the
// dependency direction explicit at the call boundary.
function toSchedule(automation: AutomationResponse): ScheduleResponse {
  return automation;
}

/** List schedules/automations, normalized to `ScheduleResponse[]`. */
export async function listSchedulesVia(
  client: ZeroClientFactory,
  automationsMode: boolean,
  fetchOptions?: RequestInit,
): Promise<ScheduleResponse[]> {
  if (automationsMode) {
    const result = await accept(
      client(automationsMainContract).list({ fetchOptions }),
      [200],
      { toast: false },
    );
    return result.body.automations.map(toSchedule);
  }
  const result = await accept(
    client(zeroSchedulesMainContract).list({ fetchOptions }),
    [200],
    { toast: false },
  );
  return result.body.schedules;
}

/**
 * Upsert a schedule/automation. The legacy schedule surface upserts through a
 * single POST `deploy`; the Automations surface splits create (POST) from
 * update (PUT `:name`), keyed on the schedule name. Returns the resulting id.
 */
export async function deployScheduleVia(
  client: ZeroClientFactory,
  automationsMode: boolean,
  body: ScheduleBody,
  isUpdate: boolean,
): Promise<{ id: string; created: boolean }> {
  if (automationsMode) {
    if (isUpdate) {
      const { name, ...rest } = body;
      const result = await accept(
        client(automationsByNameContract).update({
          params: { name },
          body: rest,
        }),
        [200, 201],
      );
      return {
        id: result.body.automation.id,
        created: result.body.created,
      };
    }
    const result = await accept(
      client(automationsMainContract).create({ body }),
      [200, 201],
    );
    return { id: result.body.automation.id, created: result.body.created };
  }
  const result = await accept(
    client(zeroSchedulesMainContract).deploy({ body }),
    [200, 201],
  );
  return { id: result.body.schedule.id, created: result.body.created };
}

/** Enable or disable a schedule/automation by name. */
export async function setScheduleEnabledVia(
  client: ZeroClientFactory,
  automationsMode: boolean,
  params: { name: string; agentId: string; enabled: boolean },
): Promise<void> {
  const action = params.enabled ? "enable" : "disable";
  const contract = automationsMode
    ? automationsEnableContract
    : zeroSchedulesEnableContract;
  await accept(
    client(contract)[action]({
      params: { name: params.name },
      body: { agentId: params.agentId },
    }),
    [200],
  );
}

/** Delete a schedule/automation by name. */
export async function deleteScheduleVia(
  client: ZeroClientFactory,
  automationsMode: boolean,
  params: { name: string; agentId: string },
): Promise<void> {
  const contract = automationsMode
    ? automationsByNameContract
    : zeroSchedulesByNameContract;
  await accept(
    client(contract).delete({
      params: { name: params.name },
      query: { agentId: params.agentId },
    }),
    [204],
  );
}

/** Execute a schedule/automation immediately; returns the created run id. */
export async function runScheduleNowVia(
  client: ZeroClientFactory,
  automationsMode: boolean,
  id: string,
): Promise<string> {
  if (automationsMode) {
    const result = await accept(
      client(automationRunContract).run({ body: { automationId: id } }),
      [201],
      { toast: false },
    );
    return result.body.runId;
  }
  const result = await accept(
    client(zeroScheduleRunContract).run({ body: { scheduleId: id } }),
    [201],
    { toast: false },
  );
  return result.body.runId;
}
