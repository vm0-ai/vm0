import { ComputerUseNativeHelperError } from "./computer-use-native";
import type { ComputerUseCommand } from "./computer-use-accessibility";
import type { ComputerUseLifecycleTimers } from "./computer-use-lifecycle-deadline";

export interface ComputerUseCommandClock extends ComputerUseLifecycleTimers {
  readonly wallNow: () => number;
  readonly monotonicNow: () => number;
}
const systemClock: ComputerUseCommandClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout,
  clearTimeout,
};

/** Wire age is converted once; later clock adjustments cannot renew admission. */
export class ComputerUseCommandBudget {
  private readonly deadline: number;
  private readonly reserve: number;
  constructor(
    command: ComputerUseCommand,
    private readonly clock: ComputerUseCommandClock = systemClock,
  ) {
    const timeout = command.timeoutMs === null ? 120_000 : command.timeoutMs;
    const created =
      typeof command.createdAt === "string"
        ? Date.parse(command.createdAt)
        : NaN;
    const claimed =
      command.claimedAt === null
        ? null
        : typeof command.claimedAt === "string"
          ? Date.parse(command.claimedAt)
          : NaN;
    const now = clock.wallNow();
    // Malformed/future dates fail closed; claimedAt never restarts the budget.
    const valid =
      typeof timeout === "number" &&
      Number.isInteger(timeout) &&
      timeout >= 1000 &&
      timeout <= 120_000 &&
      Number.isFinite(created) &&
      created <= now &&
      (claimed === null ||
        (Number.isFinite(claimed) && claimed >= created && claimed <= now));
    const remaining = valid ? Math.max(0, timeout - (now - created)) : 0;
    this.deadline = clock.monotonicNow() + remaining;
    this.reserve = Math.min(1000, remaining / 10);
  }
  remaining(completion = false): number {
    return Math.max(
      0,
      this.deadline -
        this.clock.monotonicNow() -
        (completion ? 0 : this.reserve),
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
        operation().then((value) => {
          if (this.remaining() <= 0) {
            expire();
            throw this.timeout();
          }
          return value;
        }),
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
