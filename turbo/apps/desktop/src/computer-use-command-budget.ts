import { ComputerUseNativeHelperError } from "./computer-use-native";
import type { ComputerUseCommand } from "./computer-use-accessibility";
import type { ComputerUseLifecycleTimers } from "./computer-use-lifecycle-deadline";

export interface ComputerUseCommandClock extends ComputerUseLifecycleTimers {
  readonly wallNow: () => number;
  readonly monotonicNow: () => number;
}
export const systemComputerUseCommandClock: ComputerUseCommandClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout: (run, delay) => setTimeout(run, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Server age plus the entire claim round trip bounds age without clock sync. */
export class ComputerUseCommandBudget {
  private readonly deadline: number;
  private readonly reserve: number;
  constructor(
    command: ComputerUseCommand,
    claimStartedAt: number,
    private readonly clock: ComputerUseCommandClock = systemComputerUseCommandClock,
  ) {
    const timeout = command.timeoutMs === null ? 120_000 : command.timeoutMs;
    const created =
      typeof command.createdAt === "string"
        ? Date.parse(command.createdAt)
        : NaN;
    const claimed =
      typeof command.claimedAt === "string"
        ? Date.parse(command.claimedAt)
        : NaN;
    const now = clock.monotonicNow();
    const transport = now - claimStartedAt;
    // Successful claims always stamp claimedAt, even on older APIs. The general
    // read schema is nullable for queued commands, not an execution grant.
    const valid =
      typeof timeout === "number" &&
      Number.isInteger(timeout) &&
      timeout >= 1000 &&
      timeout <= 120_000 &&
      Number.isFinite(created) &&
      Number.isFinite(claimed) &&
      claimed >= created &&
      Number.isFinite(transport) &&
      transport >= 0;
    // claimedAt is sampled before the API transaction. Charging the full local
    // request interval (including JSON consumption) conservatively includes all
    // time since that sample. Never compare server dates with the Mac wall clock.
    const remaining = valid
      ? Math.max(0, timeout - (claimed - created) - transport)
      : 0;
    this.deadline = now + remaining;
    this.reserve = Math.min(1000, remaining / 10);
  }
  remaining(): number {
    return Math.max(
      0,
      this.deadline - this.clock.monotonicNow() - this.reserve,
    );
  }
  async run<T>(operation: () => Promise<T>, expire: () => void): Promise<T> {
    const remaining = this.remaining();
    if (remaining <= 0)
      throw new ComputerUseNativeHelperError(
        "command_timeout",
        "Computer Use command expired before dispatch; no native action was started",
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation().then(
          (value) => {
            if (this.remaining() <= 0) {
              expire();
              throw this.timeout();
            }
            return value;
          },
          (error: unknown) => {
            if (this.remaining() <= 0) expire();
            throw error;
          },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = this.clock.setTimeout(() => {
            expire();
            reject(this.timeout());
          }, remaining);
        }),
      ]);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }
  private timeout(): Error {
    return new ComputerUseNativeHelperError(
      "command_timeout",
      "Computer Use total command budget expired; an action may have been delivered. Do not replay automatically; native retirement remains owned.",
    );
  }
}
