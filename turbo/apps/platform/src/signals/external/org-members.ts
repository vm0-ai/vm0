import { computed } from "ccstate";
import { fetch$ } from "../fetch";
import { org$ } from "../org";

export interface OrgMember {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  role: "admin" | "member";
  joinedAt: string;
}

interface OrgMembersResponse {
  slug: string;
  role: "admin" | "member";
  members: OrgMember[];
  createdAt: string;
}

export const orgMembers$ = computed(async (get) => {
  const org = await get(org$);
  if (!org) {
    return [];
  }

  const fetchFn = get(fetch$);
  const resp = await fetchFn(
    `/api/org/members?org=${encodeURIComponent(org.slug)}`,
  );
  if (!resp.ok) {
    return [];
  }

  const data = (await resp.json()) as OrgMembersResponse;
  return data.members;
});
