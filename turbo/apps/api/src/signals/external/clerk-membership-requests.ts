import { z } from "zod";

import { env } from "../../lib/env";

const CLERK_API_BASE = "https://api.clerk.com/v1";

const membershipRequestDataSchema = z.object({
  id: z.string(),
  public_user_data: z.object({ user_id: z.string().optional() }).optional(),
  created_at: z.number(),
});

const clerkMembershipRequestsResponseSchema = z.object({
  data: z.array(membershipRequestDataSchema),
});

type ClerkMembershipRequestData = z.infer<typeof membershipRequestDataSchema>;

/**
 * Fetch pending membership requests for an organization.
 *
 * Clerk's backend SDK does not expose a typed method for this endpoint, so we
 * call the REST API directly and validate the response shape with zod.
 *
 * Returns [] when Clerk responds 404 (the membership_requests feature is not
 * enabled for the org). Throws on any other non-OK response.
 */
export async function fetchClerkMembershipRequests(
  orgId: string,
): Promise<readonly ClerkMembershipRequestData[]> {
  const secretKey = env("CLERK_SECRET_KEY");
  const res = await fetch(
    `${CLERK_API_BASE}/organizations/${orgId}/membership_requests?status=pending`,
    {
      headers: { Authorization: `Bearer ${secretKey}` },
    },
  );
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new Error(
      `Failed to fetch membership requests for org ${orgId}: HTTP ${res.status}`,
    );
  }
  const body = clerkMembershipRequestsResponseSchema.parse(await res.json());
  return body.data;
}
