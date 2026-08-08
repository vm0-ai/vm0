import type { TestContext } from "../../../../__tests__/test-context";

interface OrderedCronPassEvent {
  readonly order: number;
  readonly fields: Record<string, unknown>;
}

function cronPassEvents(
  context: TestContext,
  cron: string,
): readonly OrderedCronPassEvent[] {
  // A successful pass is routine (debug) while a failed pass is actionable
  // (warn), so both levels carry `cron_pass` events. Call order restores the
  // single stream Axiom sees.
  const levels = [
    context.mocks.axiomLogging.debug.mock,
    context.mocks.axiomLogging.warn.mock,
  ];
  return levels
    .flatMap((level) => {
      return level.calls.flatMap(([message, fields], index) => {
        if (
          message !== "cron pass" ||
          typeof fields !== "object" ||
          fields === null
        ) {
          return [];
        }
        const event = fields as Record<string, unknown>;
        if (event.type !== "cron_pass" || event.cron !== cron) {
          return [];
        }
        return [
          { order: level.invocationCallOrder[index] ?? 0, fields: event },
        ];
      });
    })
    .sort((left, right) => {
      return left.order - right.order;
    });
}

/**
 * Reads the newest `cron_pass` event a cron emitted for the metric dashboard.
 * The dashboard only ever reads the newest event per cron, so tests assert the
 * same event rather than the whole history.
 */
export function latestCronPassFields(
  context: TestContext,
  cron: string,
): Record<string, unknown> {
  const latest = cronPassEvents(context, cron).at(-1);
  if (latest === undefined) {
    throw new Error(`Expected a cron_pass event for ${cron}`);
  }
  return latest.fields;
}

/** Reads a gauge the dashboard plots, asserting it is a countable value. */
export function cronPassCount(
  event: Record<string, unknown>,
  key: string,
): number {
  const value = event[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Expected ${key} to be a non-negative integer, got ${String(value)}`,
    );
  }
  return value;
}
