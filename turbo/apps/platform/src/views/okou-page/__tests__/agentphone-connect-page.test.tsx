import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const PHONE_HANDLE = "+15555550123";
const AGENT_ID = "agt_provider_identity";
const TIMESTAMP = 1_784_880_000;
const SIGNATURE = "a".repeat(64);

function connectPath(
  params: {
    readonly publicBrand?: "vm0" | "okou";
    readonly publicBrandSignature?: string;
  } = {},
): string {
  const search = new URLSearchParams({
    handle: PHONE_HANDLE,
    agent: AGENT_ID,
    ts: String(TIMESTAMP),
    sig: SIGNATURE,
    channel: "sms",
  });
  if (params.publicBrand) {
    search.set("publicBrand", params.publicBrand);
  }
  if (params.publicBrandSignature) {
    search.set("brandSig", params.publicBrandSignature);
  }
  return `/agentphone/connect?${search.toString()}`;
}

test("Incomplete AgentPhone brand binding is rejected", async () => {
  let called = false;
  context.mocks.api(
    integrationsAgentPhoneContract.connectAgentPhone,
    ({ respond }) => {
      called = true;
      return respond(200, { phoneHandle: PHONE_HANDLE });
    },
  );
  await setupPage({
    context,
    host: "app.okou.ai",
    path: connectPath({ publicBrand: "okou" }),
  });

  await expect(
    screen.findByText("The signature on this link is not valid."),
  ).resolves.toBeInTheDocument();

  expect(
    queryAllByRoleFast("button").some((candidate) => {
      return candidate.textContent?.replace(/\s+/gu, " ").trim() === "Connect";
    }),
  ).toBeFalsy();
  expect(called).toBeFalsy();
});
