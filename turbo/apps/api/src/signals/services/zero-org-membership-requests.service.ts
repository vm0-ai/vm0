import { command } from "ccstate";

import {
  acceptClerkMembershipRequest,
  rejectClerkMembershipRequest,
} from "../external/clerk-membership-requests";

type MembershipRequestResult =
  | { readonly kind: "ok" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "clerk_failed" };

interface MembershipRequestArgs {
  readonly orgId: string;
  readonly role: string | undefined;
  readonly requestId: string;
}

export const acceptMembershipRequest$ = command(
  async (
    _ctx,
    args: MembershipRequestArgs,
    signal: AbortSignal,
  ): Promise<MembershipRequestResult> => {
    if (args.role !== "admin") {
      return { kind: "forbidden" };
    }
    const result = await acceptClerkMembershipRequest({
      orgId: args.orgId,
      requestId: args.requestId,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      return { kind: "clerk_failed" };
    }
    return { kind: "ok" };
  },
);

export const rejectMembershipRequest$ = command(
  async (
    _ctx,
    args: MembershipRequestArgs,
    signal: AbortSignal,
  ): Promise<MembershipRequestResult> => {
    if (args.role !== "admin") {
      return { kind: "forbidden" };
    }
    const result = await rejectClerkMembershipRequest({
      orgId: args.orgId,
      requestId: args.requestId,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      return { kind: "clerk_failed" };
    }
    return { kind: "ok" };
  },
);
