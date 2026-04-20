import type { Mock } from "vitest";

/**
 * Type for the set of Stripe mock functions used across billing tests.
 *
 * Each test file creates these via `vi.hoisted()` and wires them into
 * an inline `vi.mock("stripe", ...)` factory. This interface documents
 * the expected shape and enables typed access to the mocks.
 *
 * @example
 * ```typescript
 * import type { StripeMockFns } from "../__tests__/stripe-mock";
 *
 * const stripeMocks = vi.hoisted<StripeMockFns>(() => ({
 *   subscriptionsRetrieve: vi.fn(),
 *   subscriptionsUpdate: vi.fn(),
 *   subscriptionsCancel: vi.fn(),
 *   invoicesRetrieve: vi.fn(),
 *   invoicesList: vi.fn(),
 *   customersCreate: vi.fn(),
 *   checkoutSessionsCreate: vi.fn(),
 *   billingPortalSessionsCreate: vi.fn(),
 *   constructEvent: vi.fn(),
 * }));
 *
 * vi.mock("stripe", () => ({
 *   default: function MockStripe() {
 *     return {
 *       subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve, update: stripeMocks.subscriptionsUpdate, cancel: stripeMocks.subscriptionsCancel },
 *       invoices: { retrieve: stripeMocks.invoicesRetrieve, list: stripeMocks.invoicesList },
 *       customers: { create: stripeMocks.customersCreate },
 *       checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
 *       billingPortal: { sessions: { create: stripeMocks.billingPortalSessionsCreate } },
 *       webhooks: { constructEvent: stripeMocks.constructEvent },
 *     };
 *   },
 * }));
 * ```
 */
export interface StripeMockFns {
  subscriptionsRetrieve: Mock;
  subscriptionsUpdate: Mock;
  subscriptionsCancel: Mock;
  invoicesRetrieve: Mock;
  invoicesList: Mock;
  customersCreate: Mock;
  checkoutSessionsCreate: Mock;
  billingPortalSessionsCreate: Mock;
  constructEvent: Mock;
}
