import { errors } from "@playwright/test";

/**
 * `page.waitForFunction` reports only that its predicate never became true, so
 * a stalled Clerk bootstrap reaches CI as a bare 30s timeout with no way to
 * tell the failing halves apart. After sign-in the app hard-navigates
 * (`window.location.href`), so the destination document re-runs the whole
 * bootstrap: the clerk-js script may never execute, `Clerk.load()` may stall
 * against FAPI, or the session may never be attached to a loaded client.
 * Recording the observed state at the timeout keeps those causes separable.
 */
export interface ClerkReadinessState {
  readonly bootstrapSkeletonPresent: boolean;
  readonly client: "absent" | "loaded" | "loading";
  readonly organizationId: string | null;
  readonly readyState: string;
  /** Origin and pathname only; the query can carry a Clerk handshake token. */
  readonly route: string;
  readonly sessionPresent: boolean;
}

export type ClerkReadinessReport =
  | { readonly kind: "observed"; readonly state: ClerkReadinessState }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ClerkReadinessPage {
  evaluate(
    pageFunction: () => ClerkReadinessState,
  ): Promise<ClerkReadinessState>;
}

export function describeClerkReadiness(report: ClerkReadinessReport): string {
  if (report.kind === "unavailable") {
    return `unavailable (${report.reason})`;
  }
  const { state } = report;
  return [
    `client=${state.client}`,
    `session=${state.sessionPresent ? "present" : "absent"}`,
    `organization=${state.organizationId ?? "none"}`,
    `bootstrapSkeleton=${state.bootstrapSkeletonPresent ? "present" : "removed"}`,
    `readyState=${state.readyState}`,
    `route=${state.route}`,
  ].join(" ");
}

export async function captureClerkReadiness(
  page: ClerkReadinessPage,
): Promise<ClerkReadinessReport> {
  try {
    const state = await page.evaluate((): ClerkReadinessState => {
      const clerk = window.Clerk;
      return {
        bootstrapSkeletonPresent:
          document.getElementById("app-bootstrap-skeleton") !== null,
        client: clerk ? (clerk.loaded ? "loaded" : "loading") : "absent",
        organizationId: clerk?.organization?.id ?? null,
        readyState: document.readyState,
        route: `${window.location.origin}${window.location.pathname}`,
        sessionPresent: Boolean(clerk?.session),
      };
    });
    return { kind: "observed", state };
  } catch (error: unknown) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Runs a Clerk wait and, when it times out, replaces the bare Playwright
 * timeout with the state the page was actually in. The original timeout stays
 * attached as the cause so its code frame and call log survive.
 */
export async function waitForClerkReadiness<T>(
  page: ClerkReadinessPage,
  expectation: string,
  wait: () => Promise<T>,
): Promise<T> {
  try {
    return await wait();
  } catch (error: unknown) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
    const report = await captureClerkReadiness(page);
    throw new Error(
      `Timed out waiting for ${expectation}. Observed Clerk state: ${describeClerkReadiness(report)}`,
      { cause: error },
    );
  }
}
