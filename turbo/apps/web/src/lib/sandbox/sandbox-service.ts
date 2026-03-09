import { killSandbox as killE2bSandbox } from "../e2b/e2b-service";
import { logger } from "../logger";

const log = logger("sandbox-service");

/**
 * Kill a sandbox by its ID.
 */
export async function killSandbox(sandboxId: string): Promise<void> {
  log.debug(`Killing E2B sandbox ${sandboxId}...`);
  await killE2bSandbox(sandboxId);
}
