import { Sandbox } from "@e2b/code-interpreter";
import { logger } from "../logger";

const log = logger("service:e2b");

/**
 * E2B Service
 * Provides sandbox management operations
 */
class E2BService {
  /**
   * Kill a sandbox by its ID
   * Used by the complete API to cleanup sandboxes after run completion
   *
   * @param sandboxId The sandbox ID to kill
   */
  async killSandbox(sandboxId: string): Promise<void> {
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
}

// Export singleton instance
export const e2bService = new E2BService();
