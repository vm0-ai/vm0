import { setTimeout } from "node:timers/promises";

export class BackfillInputError extends Error {
  override name = "AttributionBackfillInputError";
}

function retryDelay(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export function clerkReader(
  secret: string,
  delayMs: number,
  signal: AbortSignal,
) {
  return async function read(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await setTimeout(delayMs, undefined, { signal });
      const response = await fetch(`https://api.clerk.com/v1/${path}`, {
        headers: { Authorization: `Bearer ${secret}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (response.ok) return response.json();
      await response.body?.cancel();
      // Never print provider bodies, which may include private metadata.
      if (
        (response.status !== 429 && response.status !== 503) ||
        attempt === 3
      ) {
        throw new BackfillInputError(
          `Clerk read failed with HTTP ${response.status}`,
        );
      }
      const delay =
        Math.max(
          retryDelay(response.headers.get("Retry-After")),
          1000 * 2 ** attempt,
        ) + Math.floor(Math.random() * 250);
      if (delay > 60_000)
        throw new BackfillInputError(
          "Clerk requested a pause longer than 60 seconds; resume the batch later",
        );
      await setTimeout(delay, undefined, { signal });
    }
    throw new BackfillInputError("Clerk retry budget exhausted");
  };
}
