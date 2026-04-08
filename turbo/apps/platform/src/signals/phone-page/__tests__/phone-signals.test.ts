import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
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

const context = testContext();

describe("fetchPhoneStatus$", () => {
  it("should fetch and store phone status", async () => {
    const { store, signal } = context;

    server.use(
      http.get("*/api/zero/phone/status", () => {
        return HttpResponse.json({
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
      http.get("*/api/zero/phone/status", () => {
        return new HttpResponse(null, { status: 500 });
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
      http.post("*/api/zero/phone/link", () => {
        return HttpResponse.json({ success: true });
      }),
      http.get("*/api/zero/phone/status", () => {
        return HttpResponse.json({
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
      http.post("*/api/zero/phone/link", () => {
        return HttpResponse.json(
          { error: "Direct phone linking is not available for this org" },
          { status: 403 },
        );
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
      http.delete("*/api/zero/phone/link", () => {
        return HttpResponse.json({ success: true });
      }),
      http.get("*/api/zero/phone/status", () => {
        return HttpResponse.json({
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
      http.delete("*/api/zero/phone/link", () => {
        return HttpResponse.json(
          { error: "Failed to remove phone number" },
          { status: 500 },
        );
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
      http.post("*/api/zero/phone/setup", () => {
        return HttpResponse.json({
          phoneNumber: "+18001234567",
          agentId: "agent_123",
        });
      }),
      http.get("*/api/zero/phone/status", () => {
        return HttpResponse.json({
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
      http.post("*/api/zero/phone/setup", () => {
        return HttpResponse.json(
          { error: "Phone is only available on the Team plan" },
          { status: 403 },
        );
      }),
    );

    await store.set(requestOrgPhoneSetup$, signal);

    expect(store.get(phoneError$)).toBe(
      "Phone is only available on the Team plan",
    );
  });
});
