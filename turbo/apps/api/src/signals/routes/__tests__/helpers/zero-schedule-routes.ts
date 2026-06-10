import {
  type ScheduleResponse,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";

export function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

async function listZeroSchedulesThroughApi(
  context: TestContext,
): Promise<readonly ScheduleResponse[]> {
  const client = setupApp({ context })(zeroSchedulesMainContract);
  const response = await accept(
    client.list({
      headers: authHeaders(),
    }),
    [200],
  );
  return response.body.schedules;
}

export async function getZeroScheduleThroughApi(
  context: TestContext,
  name: string,
): Promise<ScheduleResponse | undefined> {
  const schedules = await listZeroSchedulesThroughApi(context);
  return schedules.find((schedule) => {
    return schedule.name === name;
  });
}
