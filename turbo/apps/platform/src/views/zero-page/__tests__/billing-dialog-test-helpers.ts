/**
 * All default API state (chat-threads, team, org/logo) is covered by the
 * global MSW handlers in api-agents.ts and api-org.ts. No additional setup
 * is needed for billing page tests.
 */
export function mockBillingPageAPIs(): void {
  // No-op: all required endpoints are covered by global default handlers.
}
