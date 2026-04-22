import { Cron } from "croner";
import { env } from "../../env";
import { getApiUrl } from "../infra/callback/dispatcher";
import { logger } from "../shared/logger";

const log = logger("dev:cron-scheduler");

interface CronEntry {
  path: string;
  schedule: string;
}

interface VercelConfig {
  crons?: CronEntry[];
}

let started = false;

export function startDevCronScheduler(config: VercelConfig): void {
  if (started) return;
  started = true;

  const { CRON_SECRET } = env();
  if (!CRON_SECRET) {
    log.warn("CRON_SECRET not set; dev cron scheduler is a no-op");
    return;
  }

  const baseUrl = getApiUrl();
  const entries = config.crons ?? [];
  for (const entry of entries) {
    new Cron(
      entry.schedule,
      { timezone: "UTC", name: entry.path, protect: true },
      async () => {
        const url = `${baseUrl}${entry.path}`;
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${CRON_SECRET}` },
          });
          if (!res.ok) {
            log.warn(
              `dev cron ${entry.path} returned ${String(res.status)} ${res.statusText}`,
            );
          }
        } catch (err) {
          // Next dev server may not be listening yet on the very first tick,
          // or a request can be cancelled during HMR. Log and move on — the
          // next scheduled tick will cover.
          log.warn(
            `dev cron ${entry.path} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );
  }

  log.info(`dev cron scheduler started with ${String(entries.length)} job(s)`);
}
