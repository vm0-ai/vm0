import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockPhoneStatus } from "../../../mocks/handlers/api-phone.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroPhoneSetupContract,
  zeroPhoneLinkContract,
  type PhoneStatusResponse,
} from "@vm0/core";

const context = testContext();

function mockPhoneStatusAPI(overrides: Partial<PhoneStatusResponse> = {}) {
  setMockPhoneStatus(overrides);
}

function renderPhonePage() {
  detachedSetupPage({
    context,
    path: "/phone",
    featureSwitches: { phoneIntegration: true },
  });
}

describe("phone page - page renders after status loads", () => {
  it("should render page content after status API responds", async () => {
    mockPhoneStatusAPI();
    await renderPhonePage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Phone" }),
      ).toBeInTheDocument();
    });
  });
});

describe("phone page - org phone not configured", () => {
  it("should show phone page title", async () => {
    mockPhoneStatusAPI();
    await renderPhonePage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Phone" }),
      ).toBeInTheDocument();
    });
  });

  it("should show message when org phone is not configured", async () => {
    mockPhoneStatusAPI({ orgPhone: null });
    await renderPhonePage();

    await waitFor(() => {
      expect(
        screen.getByText("Phone is not configured for this organization."),
      ).toBeInTheDocument();
    });
  });

  it("should show request phone number button when org has no phone", async () => {
    mockPhoneStatusAPI({ orgPhone: null });
    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByText("Request Org Phone Number")).toBeInTheDocument();
    });
  });

  it("should call setup API when request button is clicked", async () => {
    const user = userEvent.setup();
    let setupCalled = false;

    mockPhoneStatusAPI({ orgPhone: null });
    server.use(
      mockApi(zeroPhoneSetupContract.setup, ({ respond }) => {
        setupCalled = true;
        return respond(200, {
          phoneNumber: "+18001234567",
          agentId: "agent_123",
        });
      }),
    );

    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByText("Request Org Phone Number")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Request Org Phone Number"));

    await waitFor(() => {
      expect(setupCalled).toBeTruthy();
    });
  });
});

describe("phone page - org phone configured", () => {
  it("should display the org phone number when configured", async () => {
    mockPhoneStatusAPI({ orgPhone: "+18001234567" });
    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByText("+18001234567")).toBeInTheDocument();
    });
  });

  it("should not show request button when org phone is configured", async () => {
    mockPhoneStatusAPI({ orgPhone: "+18001234567" });
    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByText("+18001234567")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Request Org Phone Number"),
    ).not.toBeInTheDocument();
  });
});

describe("phone page - user phone not linked", () => {
  it("should show phone input field when user has no linked phone", async () => {
    mockPhoneStatusAPI({ orgPhone: "+18001234567", userPhone: null });
    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("+14155551234")).toBeInTheDocument();
    });
  });

  it("should show Save button when user has no linked phone", async () => {
    mockPhoneStatusAPI({ orgPhone: "+18001234567", userPhone: null });
    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
  });

  it("should show E.164 format hint", async () => {
    mockPhoneStatusAPI({ orgPhone: "+18001234567", userPhone: null });
    await renderPhonePage();

    await waitFor(() => {
      expect(
        screen.getByText("Enter your phone number in E.164 format"),
      ).toBeInTheDocument();
    });
  });

  it("should call link API when Save is clicked with phone input", async () => {
    const user = userEvent.setup();
    let linkCalled = false;

    mockPhoneStatusAPI({ orgPhone: "+18001234567", userPhone: null });
    server.use(
      mockApi(zeroPhoneLinkContract.link, ({ respond }) => {
        linkCalled = true;
        return respond(200, { success: true });
      }),
    );

    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("+14155551234")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("+14155551234"),
      "+14155559999",
    );
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(linkCalled).toBeTruthy();
    });
  });
});

describe("phone page - user phone linked", () => {
  it("should display linked phone number", async () => {
    mockPhoneStatusAPI({
      orgPhone: "+18001234567",
      userPhone: "+14155551234",
    });
    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByText("+14155551234")).toBeInTheDocument();
    });
  });

  it("should not show phone input when user has linked phone", async () => {
    mockPhoneStatusAPI({
      orgPhone: "+18001234567",
      userPhone: "+14155551234",
    });
    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByText("+14155551234")).toBeInTheDocument();
    });

    expect(
      screen.queryByPlaceholderText("+14155551234"),
    ).not.toBeInTheDocument();
  });
});

describe("phone page - error display", () => {
  it("should show error message when link fails", async () => {
    const user = userEvent.setup();

    mockPhoneStatusAPI({ orgPhone: "+18001234567", userPhone: null });
    server.use(
      mockApi(zeroPhoneLinkContract.link, ({ respond }) => {
        return respond(403, {
          error: "Direct phone linking is not available for this org",
        });
      }),
    );

    await renderPhonePage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("+14155551234")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("+14155551234"),
      "+14155559999",
    );
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(
        screen.getByText("Direct phone linking is not available for this org"),
      ).toBeInTheDocument();
    });
  });
});
