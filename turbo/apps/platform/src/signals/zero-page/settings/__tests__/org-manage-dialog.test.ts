import { describe, expect, it } from "vitest";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";
import { inviteMember$ } from "../org-manage-tabs-state.ts";
import { zeroOrgInviteContract } from "@vm0/api-contracts/contracts/zero-org-members";
import { createMockApi } from "../../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("inviteMember$", () => {
  it("should throw ApiError with API message on invite failure", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    server.use(
      mockApi(zeroOrgInviteContract.invite, ({ respond }) => {
        return respond(400, {
          error: {
            message: "Already a member",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }),
    );

    await expect(
      context.store.set(
        inviteMember$,
        "already@example.com",
        "member",
        context.signal,
      ),
    ).rejects.toThrow("Already a member");
  });
});
