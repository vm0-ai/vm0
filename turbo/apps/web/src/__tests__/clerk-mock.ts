import { vi } from "vitest";
import { auth } from "@clerk/nextjs/server";

/**
 * Mock Clerk auth for testing
 *
 * @example
 * ```typescript
 * import { mockClerk, clearClerkMock } from '@/__tests__/clerk-mock';
 *
 * beforeEach(() => {
 *   mockClerk({ userId: 'test-user-123' });
 * });
 *
 * afterEach(() => {
 *   clearClerkMock();
 * });
 *
 * it('should reject unauthenticated request', () => {
 *   mockClerk({ userId: null });
 *   // ...
 * });
 * ```
 */

const mockAuth = vi.mocked(auth);

/**
 * Configure Clerk auth mock
 * @param options - Auth configuration
 * @param options.userId - User ID to return, or null for unauthenticated
 */
export function mockClerk(options: { userId: string | null }) {
  mockAuth.mockResolvedValue({
    userId: options.userId,
  } as Awaited<ReturnType<typeof auth>>);
}

/**
 * Clear all Clerk mock calls and reset to default state
 */
export function clearClerkMock() {
  mockAuth.mockClear();
}
