import { Sandbox } from "@e2b/code-interpreter";
import { logger } from "../logger";

const log = logger("e2b");

/**
 * Kill a sandbox by its ID
 * Used by the complete API to cleanup sandboxes after run completion
 *
 * @param sandboxId The sandbox ID to kill
 */
export async function killSandbox(sandboxId: string): Promise<void> {
  try {
    log.debug(`Killing sandbox ${sandboxId}...`);
    const sandbox = await Sandbox.connect(sandboxId);
    await sandbox.kill();
    log.debug(`Sandbox ${sandboxId} killed successfully`);
  } catch (error) {
    // Log but don't throw - sandbox may already be terminated
    log.error(`Failed to kill sandbox ${sandboxId}:`, error);
  }
}
