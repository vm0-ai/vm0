import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const PHONE_HANDLE = "+15555550123";
const AGENT_ID = "agt_provider_identity";
const TIMESTAMP = 1_784_880_000;
const SIGNATURE = "a".repeat(64);
const BRAND_SIGNATURE = "b".repeat(64);

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

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

describe("agentphone connect page", () => {
  it("submits brand-bound connect state without dropping redirect parameters", async () => {
    let observedBody: unknown;
    context.mocks.api(
      integrationsAgentPhoneContract.connectAgentPhone,
      ({ body, respond }) => {
        observedBody = body;
        return respond(200, { phoneHandle: PHONE_HANDLE });
      },
    );

    detachedSetupPage({
      context,
      path: connectPath({
        publicBrand: "okou",
        publicBrandSignature: BRAND_SIGNATURE,
      }),
    });

    click(
      await waitFor(() => {
        return buttonByText("Connect");
      }),
    );
    await expect(
      screen.findByRole("heading", { name: "Phone number connected" }),
    ).resolves.toBeInTheDocument();
    expect(observedBody).toStrictEqual({
      phoneHandle: PHONE_HANDLE,
      agentphoneAgentId: AGENT_ID,
      timestamp: TIMESTAMP,
      signature: SIGNATURE,
      channel: "sms",
      publicBrand: "okou",
      publicBrandSignature: BRAND_SIGNATURE,
    });
  });

  it("keeps pre-rollout brandless links usable by the compatibility API", async () => {
    let observedBody: unknown;
    context.mocks.api(
      integrationsAgentPhoneContract.connectAgentPhone,
      ({ body, respond }) => {
        observedBody = body;
        return respond(200, { phoneHandle: PHONE_HANDLE });
      },
    );

    detachedSetupPage({ context, path: connectPath() });

    click(
      await waitFor(() => {
        return buttonByText("Connect");
      }),
    );
    await expect(
      screen.findByRole("heading", { name: "Phone number connected" }),
    ).resolves.toBeInTheDocument();
    expect(observedBody).toStrictEqual({
      phoneHandle: PHONE_HANDLE,
      agentphoneAgentId: AGENT_ID,
      timestamp: TIMESTAMP,
      signature: SIGNATURE,
      channel: "sms",
    });
  });

  it("rejects incomplete brand-bound state before calling the API", async () => {
    let called = false;
    context.mocks.api(
      integrationsAgentPhoneContract.connectAgentPhone,
      ({ respond }) => {
        called = true;
        return respond(200, { phoneHandle: PHONE_HANDLE });
      },
    );

    detachedSetupPage({
      context,
      path: connectPath({ publicBrand: "okou" }),
    });

    await expect(
      screen.findByText("The signature on this link is not valid."),
    ).resolves.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((candidate) => {
        return candidate.textContent?.replace(/\s+/g, " ").trim() === "Connect";
      }),
    ).toBeFalsy();
    expect(called).toBeFalsy();
  });
});
