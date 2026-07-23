import { randomUUID } from "node:crypto";

import { cronDrainEmailOutboxContract } from "@vm0/api-contracts/contracts/cron";
import { userExportContract } from "@vm0/api-contracts/contracts/user-export";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

const CRON_AUTHORIZATION = "Bearer test-cron-secret";

function emailApp(context: TestContext) {
  return setupApp({ context });
}

function authenticate(context: TestContext, actor: ApiTestUser) {
  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const emailId = `email_${actor.userId}`;
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "BDD",
        lastName: "Email",
      },
    ],
  });
  return { authorization: "Bearer clerk-session" };
}

export function createEmailApi(context: TestContext) {
  return {
    async enqueueDataExportEmail(
      actor: ApiTestUser,
    ): Promise<{ readonly to: string; readonly subject: string }> {
      context.mocks.s3.send.mockResolvedValue({});
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        `https://r2.example.com/${randomUUID()}/data-export.zip`,
      );
      const started = await accept(
        emailApp(context)(userExportContract).post({
          headers: authenticate(context, actor),
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const status = await accept(
        emailApp(context)(userExportContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      if (
        status.body.job?.id !== started.body.jobId ||
        status.body.job.status !== "completed"
      ) {
        throw new Error("Expected the data export email job to complete");
      }
      return { to: actor.email, subject: "Your data export is ready" };
    },

    async drainEmailOutboxCron(validAuth: boolean) {
      return await accept(
        emailApp(context)(cronDrainEmailOutboxContract).drain({
          headers: validAuth ? { authorization: CRON_AUTHORIZATION } : {},
        }),
        [200, 401],
      );
    },
  };
}
