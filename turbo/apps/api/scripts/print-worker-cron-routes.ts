import { WORKER_CRON_ROUTES } from "../src/worker-crons";

const routes = new Set(Object.values(WORKER_CRON_ROUTES).flat());
for (const route of routes) {
  process.stdout.write(`${route}\n`);
}
