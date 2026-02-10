import { killSandbox as killE2bSandbox } from "../e2b/e2b-service";
import { killDockerSandbox } from "../docker/docker-sandbox";
import { logger } from "../logger";

const log = logger("sandbox-service");

/**
 * Kill a sandbox by its ID, routing to the correct backend (E2B or Docker).
 *
 * When E2B_API_KEY is set, the sandbox is assumed to be an E2B sandbox.
 * Otherwise, it is treated as a Docker container.
 */
export async function killSandbox(sandboxId: string): Promise<void> {
  if (process.env.E2B_API_KEY) {
    log.debug(`Killing E2B sandbox ${sandboxId}...`);
    await killE2bSandbox(sandboxId);
  } else {
    log.debug(`Killing Docker sandbox ${sandboxId}...`);
    await killDockerSandbox(sandboxId);
  }
}
