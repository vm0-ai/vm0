import { command } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { org$ } from "../org.ts";

interface CreditCapResponse {
  userId: string;
  creditCap: number | null;
  creditEnabled: boolean;
}

/**
 * Command to update a member's credit cap.
 * Admin-only — the server enforces role checks.
 */
export const updateMemberCreditCap$ = command(
  async ({ get }, userId: string, creditCap: number | null) => {
    const org = await get(org$);
    if (!org) {
      throw new Error("No org available");
    }

    const apiFetch = get(fetch$);
    const response = await apiFetch(
      `/api/zero/org/members/credit-cap?org=${encodeURIComponent(org.slug)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, creditCap }),
      },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as Record<string, unknown>).error)
          : `Failed to update credit cap: ${response.status}`;
      throw new Error(message);
    }

    return (await response.json()) as CreditCapResponse;
  },
);
