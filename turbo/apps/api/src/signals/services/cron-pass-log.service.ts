import { serializeError } from "@vm0/core/log-utils";

import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { settle } from "../utils";

const L = logger("api:cron-pass");

export type CronPassFields = Readonly<
  Record<string, number | boolean | Readonly<Record<string, number>>>
>;

/**
 * Emits one `cron_pass` event per catch-up cron pass. The metric dashboard
 * reads only the newest event of each cron, so `fields` must describe absolute
 * state measured after the work (how much there is to catch up, how far the
 * cron got, how large the source table is) while per-pass counters carry a
 * `pass` prefix. A failed pass reports `ok: false` without state, so the newest
 * event can never show a stale success while the cron is broken.
 */
export async function withCronPassLog<T>(
  cron: string,
  pass: () => Promise<{
    readonly result: T;
    readonly fields: CronPassFields;
  }>,
): Promise<T> {
  const startedAt = now();
  const settled = await settle(pass());
  if (!settled.ok) {
    L.warn("cron pass", {
      type: "cron_pass",
      cron,
      ok: false,
      passDurationMs: now() - startedAt,
      error: serializeError(settled.error),
    });
    throw settled.error;
  }
  L.debug("cron pass", {
    type: "cron_pass",
    cron,
    ok: true,
    passDurationMs: now() - startedAt,
    ...settled.value.fields,
  });
  return settled.value.result;
}
