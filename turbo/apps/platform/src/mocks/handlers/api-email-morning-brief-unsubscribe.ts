import { emailMorningBriefUnsubscribeContract } from "@vm0/api-contracts/contracts/email-morning-brief-unsubscribe";
import { mockApi } from "../msw-contract.ts";

/** Token accepted by the mock one-click unsubscribe endpoint. */
export const MOCK_MORNING_BRIEF_UNSUBSCRIBE_TOKEN = "valid-token";

export const apiEmailMorningBriefUnsubscribeHandlers = [
  mockApi(
    emailMorningBriefUnsubscribeContract.unsubscribe,
    ({ query, respond }) => {
      if (query.token === MOCK_MORNING_BRIEF_UNSUBSCRIBE_TOKEN) {
        return respond(200, { unsubscribed: true });
      }
      return respond(400, { error: "Invalid token" });
    },
  ),
];
