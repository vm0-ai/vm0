import { describe, expect, it } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  phoneStatus$,
  phoneError$,
  phoneInput$,
  setPhoneInput$,
  fetchPhoneStatus$,
  savePhoneLink$,
  removePhoneLink$,
  requestOrgPhoneSetup$,
} from "../phone-signals.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroPhoneStatusContract,
  zeroPhoneLinkContract,
  zeroPhoneSetupContract,
} from "@vm0/core/contracts/zero-phone";

const context = testContext();
const mockApi = createMockApi(context);

describe("fetchPhoneStatus$", () => {
  it("should fetch and store phone status", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          userPhone: "+14155551234",
          userPhonePending: null,
          orgPhone: "+18001234567",
        });
      }),
    );

    await store.set(fetchPhoneStatus$, signal);

    expect(store.get(phoneStatus$)).toStrictEqual({
      userPhone: "+14155551234",
      userPhonePending: null,
      orgPhone: "+18001234567",
    });
  });

  it("should not update status when fetch fails", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneStatusContract.getStatus, ({ respond }) => {
        return respond(401, { error: "unauthorized" });
      }),
    );

    await store.set(fetchPhoneStatus$, signal);

    // Status should remain null when fetch fails
    expect(store.get(phoneStatus$)).toBeNull();
  });
});

describe("setPhoneInput$", () => {
  it("should update phone input value", () => {
    const { store } = context;

    store.set(setPhoneInput$, "+14155559999");

    expect(store.get(phoneInput$)).toBe("+14155559999");
  });
});

describe("savePhoneLink$", () => {
  it("should clear input and refresh status on success", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneLinkContract.link, ({ respond }) => {
        return respond(200, { success: true });
      }),
      mockApi(zeroPhoneStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          userPhone: "+14155551234",
          userPhonePending: null,
          orgPhone: "+18001234567",
        });
      }),
    );

    store.set(setPhoneInput$, "+14155551234");
    await store.set(savePhoneLink$, "+14155551234", signal);

    expect(store.get(phoneInput$)).toBe("");
    expect(store.get(phoneError$)).toBeNull();
    expect(store.get(phoneStatus$)?.userPhone).toBe("+14155551234");
  });

  it("should set error when link fails", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneLinkContract.link, ({ respond }) => {
        return respond(403, {
          error: "Direct phone linking is not available for this org",
        });
      }),
    );

    await store.set(savePhoneLink$, "+14155551234", signal);

    expect(store.get(phoneError$)).toBe(
      "Direct phone linking is not available for this org",
    );
  });
});

describe("removePhoneLink$", () => {
  it("should refresh status on successful removal", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneLinkContract.unlink, ({ respond }) => {
        return respond(200, { success: true });
      }),
      mockApi(zeroPhoneStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          userPhone: null,
          userPhonePending: null,
          orgPhone: "+18001234567",
        });
      }),
    );

    await store.set(removePhoneLink$, signal);

    expect(store.get(phoneError$)).toBeNull();
    expect(store.get(phoneStatus$)?.userPhone).toBeNull();
  });

  it("should set error when removal fails", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneLinkContract.unlink, ({ respond }) => {
        return respond(401, { error: "Failed to remove phone number" });
      }),
    );

    await store.set(removePhoneLink$, signal);

    expect(store.get(phoneError$)).toBe("Failed to remove phone number");
  });
});

describe("requestOrgPhoneSetup$", () => {
  it("should refresh status on successful setup", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneSetupContract.setup, ({ respond }) => {
        return respond(200, {
          phoneNumber: "+18001234567",
          agentId: "agent_123",
        });
      }),
      mockApi(zeroPhoneStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          userPhone: null,
          userPhonePending: null,
          orgPhone: "+18001234567",
        });
      }),
    );

    await store.set(requestOrgPhoneSetup$, signal);

    expect(store.get(phoneError$)).toBeNull();
    expect(store.get(phoneStatus$)?.orgPhone).toBe("+18001234567");
  });

  it("should set error when setup fails", async () => {
    const { store, signal } = context;

    server.use(
      mockApi(zeroPhoneSetupContract.setup, ({ respond }) => {
        return respond(403, {
          error: "Phone is only available on the Team plan",
        });
      }),
    );

    await store.set(requestOrgPhoneSetup$, signal);

    expect(store.get(phoneError$)).toBe(
      "Phone is only available on the Team plan",
    );
  });
});
