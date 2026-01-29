import { recordOperation } from "./instruments";

/**
 * Wrap an async function with runner operation metrics recording
 */
export async function withRunnerTiming<T>(
  actionType: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  let success = true;

  try {
    return await fn();
  } catch (error) {
    success = false;
    throw error;
  } finally {
    recordOperation({
      actionType,
      durationMs: Date.now() - startTime,
      success,
    });
  }
}

/**
 * Wrap an async function with sandbox operation metrics recording
 */
export async function withSandboxTiming<T>(
  actionType: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  let success = true;

  try {
    return await fn();
  } catch (error) {
    success = false;
    throw error;
  } finally {
    recordOperation({
      actionType,
      durationMs: Date.now() - startTime,
      success,
    });
  }
}
