import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { zeroIntegrationsWhatsAppContract } from "@vm0/api-contracts/contracts/zero-integrations-whatsapp";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { parseWhatsAppConnectParams } from "../../../signals/zero-page/whatsapp-connect-params.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const context = testContext();
const mockApi = createMockApi(context);

const VALID_PATH =
  "/whatsapp/connect?handle=%2B17022452623&ts=1777200000&sig=" + "a".repeat(64);

function buttonWithText(text: string): HTMLButtonElement {
  const button = screen.getAllByRole("button").find((element) => {
    return element.textContent === text;
  });
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("zero whatsapp connect page", () => {
  it("rejects missing params before rendering the confirmation flow", () => {
    const parsed = parseWhatsAppConnectParams(
      new URLSearchParams({
        handle: "+17022452623",
      }),
    );

    expect(parsed.ok).toBeFalsy();
    if (!parsed.ok) {
      expect(parsed.error.title).toBe("Connect link is incomplete");
    }
  });

  it("rejects malformed signatures before calling the link route", () => {
    const parsed = parseWhatsAppConnectParams(
      new URLSearchParams({
        handle: "+17022452623",
        ts: "1777200000",
        sig: "not-a-signature",
      }),
    );

    expect(parsed.ok).toBeFalsy();
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("signature");
    }
  });

  it("requires sign-in before confirmation", async () => {
    let called = false;
    mockedClerk.redirectToSignIn.mockClear();
    server.use(
      mockApi(
        zeroIntegrationsWhatsAppContract.connectWhatsApp,
        ({ respond }) => {
          called = true;
          return respond(200, { phoneHandle: "+17022452623" });
        },
      ),
    );

    detachedSetupPage({
      context,
      path: VALID_PATH,
      user: null,
      session: null,
    });

    await waitFor(() => {
      expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
    });
    expect(called).toBeFalsy();
  });

  it("posts signed phone handle params on confirmation", async () => {
    let requestBody: unknown;
    let authorizationHeader: string | null = null;
    server.use(
      mockApi(
        zeroIntegrationsWhatsAppContract.connectWhatsApp,
        ({ body, request, respond }) => {
          authorizationHeader = request.headers.get("Authorization");
          requestBody = body;
          return respond(200, { phoneHandle: "+17022452623" });
        },
      ),
    );

    detachedSetupPage({
      context,
      path: VALID_PATH,
      session: { token: "clerk-token" },
    });

    await waitFor(() => {
      expect(screen.getByText("Connect WhatsApp")).toBeInTheDocument();
    });
    expect(screen.getByTestId("whatsapp-connect-icon")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Link this WhatsApp number to your VM0 account so you can interact with Zero from WhatsApp.",
      ),
    ).toBeInTheDocument();
    click(buttonWithText("Connect"));

    await waitFor(() => {
      expect(authorizationHeader).toBe("Bearer clerk-token");
    });
    expect(requestBody).toStrictEqual({
      phoneHandle: "+17022452623",
      timestamp: 1_777_200_000,
      signature: "a".repeat(64),
    });
    await expect(
      screen.findByText("WhatsApp number connected"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("+17022452623")).toBeInTheDocument();
  });

  it("surfaces invalid or expired signature errors from the backend", async () => {
    server.use(
      mockApi(
        zeroIntegrationsWhatsAppContract.connectWhatsApp,
        ({ respond }) => {
          return respond(400, {
            error: {
              message:
                "Invalid or expired connection link. Send /connect again.",
              code: "BAD_REQUEST",
            },
          });
        },
      ),
    );

    detachedSetupPage({
      context,
      path: VALID_PATH,
      session: { token: "clerk-token" },
    });

    await waitFor(() => {
      expect(screen.getByText("Connect WhatsApp")).toBeInTheDocument();
    });
    click(buttonWithText("Connect"));

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Invalid or expired connection link",
    );
  });
});
