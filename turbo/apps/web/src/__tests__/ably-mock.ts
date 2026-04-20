import { vi } from "vitest";
import type { Mock } from "vitest";

/**
 * Shared Ably mock spy instances for tests.
 *
 * The `vi.mock("ably", ...)` factory in setup.ts wires these into the Ably
 * module mock, so every test file that imports from here gets the same spy
 * instances without repeating the vi.mock block.
 *
 * @example
 * ```typescript
 * import { mockAblyPublish } from "../__tests__/ably-mock";
 *
 * beforeEach(() => {
 *   mockAblyPublish.mockClear();
 * });
 *
 * it("publishes a signal", async () => {
 *   // ... call route handler ...
 *   expect(mockAblyPublish).toHaveBeenCalledWith("invalidate", {});
 * });
 * ```
 *
 * For token route tests, use mockAblyCreateTokenRequest instead:
 * ```typescript
 * import { mockAblyCreateTokenRequest } from "../__tests__/ably-mock";
 *
 * beforeEach(() => {
 *   mockAblyCreateTokenRequest.mockResolvedValue({ keyName: "...", ... });
 * });
 * ```
 */
export const mockAblyPublish: Mock = vi.fn().mockResolvedValue(undefined);
export const mockAblyCreateTokenRequest: Mock = vi.fn();
export const mockAblyChannelsGet: Mock = vi
  .fn()
  .mockReturnValue({ publish: mockAblyPublish });
