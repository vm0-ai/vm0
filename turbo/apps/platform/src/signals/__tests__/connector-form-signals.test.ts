import { describe, expect, it } from "vitest";

import {
  connectorOAuthDeviceAuthStartOptionValuesFor$,
  manualGrantFormValuesFor$,
  setConnectorOAuthDeviceAuthStartOptionValue$,
  setManualGrantFormValue$,
} from "../zero-page/settings/connectors.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

describe("connector form signals", () => {
  it("selects reactive form values while keeping connector keys isolated", () => {
    const initialManualGrantFormValuesFor = context.store.get(
      manualGrantFormValuesFor$,
    );
    expect(initialManualGrantFormValuesFor("connector-a")).toStrictEqual({});

    context.store.set(
      setManualGrantFormValue$,
      "connector-a",
      "token",
      "manual-token",
    );
    const manualGrantFormValuesFor = context.store.get(
      manualGrantFormValuesFor$,
    );
    expect(manualGrantFormValuesFor("connector-a")).toStrictEqual({
      token: "manual-token",
    });
    expect(manualGrantFormValuesFor("connector-b")).toStrictEqual({});

    const initialConnectorOAuthDeviceAuthStartOptionValuesFor =
      context.store.get(connectorOAuthDeviceAuthStartOptionValuesFor$);
    expect(
      initialConnectorOAuthDeviceAuthStartOptionValuesFor(
        "connector-a",
        "device-auth-a",
      ),
    ).toStrictEqual({});

    context.store.set(setConnectorOAuthDeviceAuthStartOptionValue$, {
      connectorSlug: "connector-a",
      authMethod: "device-auth-a",
      name: "region",
      value: "us-west",
    });
    const connectorOAuthDeviceAuthStartOptionValuesFor = context.store.get(
      connectorOAuthDeviceAuthStartOptionValuesFor$,
    );
    expect(
      connectorOAuthDeviceAuthStartOptionValuesFor(
        "connector-a",
        "device-auth-a",
      ),
    ).toStrictEqual({
      region: "us-west",
    });
    expect(
      connectorOAuthDeviceAuthStartOptionValuesFor(
        "connector-a",
        "device-auth-b",
      ),
    ).toStrictEqual({});
  });
});
