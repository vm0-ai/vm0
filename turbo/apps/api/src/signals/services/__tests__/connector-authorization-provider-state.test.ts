import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  parseConnectorExternalCodeProviderState,
  parseConnectorOauthDeviceProviderState,
  serializeConnectorExternalCodeProviderState,
  serializeConnectorOauthDeviceProviderState,
} from "../connector-authorization-provider-state";

const connectorSlug = "slack";
const authMethod = "oauth";

describe("connector OAuth device provider state", () => {
  it("parses canonical state and preserves poll state", () => {
    expect(
      parseConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({
          connectorSlug,
          deviceCode: "device-code",
          pollState: "poll-state",
          unrelatedProperty: "ignored",
        }),
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: "poll-state",
    });
  });

  it("preserves an absent poll state", () => {
    expect(
      parseConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({
          connectorSlug,
          deviceCode: "device-code",
        }),
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: undefined,
    });
  });

  it("rejects state without a connector slug", () => {
    expect(() => {
      parseConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({ deviceCode: "device-code" }),
        connectorSlug,
      });
    }).toThrow(ZodError);
  });

  it("rejects a connector mismatch", () => {
    expect(() => {
      parseConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({
          connectorSlug: "github",
          deviceCode: "device-code",
        }),
        connectorSlug,
      });
    }).toThrow("OAuth device provider state connector slug mismatch");
  });

  it("serializes and parses the exact canonical-only state with poll state", () => {
    const serializedState = serializeConnectorOauthDeviceProviderState({
      connectorSlug,
      deviceCode: "device-code",
      pollState: "poll-state",
    });

    expect(serializedState).toBe(
      '{"connectorSlug":"slack","deviceCode":"device-code","pollState":"poll-state"}',
    );
    expect(
      parseConnectorOauthDeviceProviderState({
        serializedState,
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: "poll-state",
    });
  });

  it("omits absent poll state from the canonical-only state", () => {
    const serializedState = serializeConnectorOauthDeviceProviderState({
      connectorSlug,
      deviceCode: "device-code",
      pollState: undefined,
    });

    expect(serializedState).toBe(
      '{"connectorSlug":"slack","deviceCode":"device-code"}',
    );
    expect(
      parseConnectorOauthDeviceProviderState({
        serializedState,
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: undefined,
    });
  });
});

describe("connector external-code provider state", () => {
  it("parses canonical state and preserves provider state", () => {
    expect(
      parseConnectorExternalCodeProviderState({
        serializedState: JSON.stringify({
          connectorSlug,
          authMethod,
          providerState: "provider-state",
          unrelatedProperty: "ignored",
        }),
        connectorSlug,
        authMethod,
      }),
    ).toStrictEqual({
      connectorSlug,
      authMethod,
      providerState: "provider-state",
    });
  });

  it("rejects state without a connector slug", () => {
    expect(() => {
      parseConnectorExternalCodeProviderState({
        serializedState: JSON.stringify({
          authMethod,
          providerState: "provider-state",
        }),
        connectorSlug,
        authMethod,
      });
    }).toThrow(ZodError);
  });

  it.each([
    {
      mismatch: "connector",
      serializedState: JSON.stringify({
        connectorSlug: "github",
        authMethod,
        providerState: "provider-state",
      }),
    },
    {
      mismatch: "auth method",
      serializedState: JSON.stringify({
        connectorSlug,
        authMethod: "api-key",
        providerState: "provider-state",
      }),
    },
  ])("rejects an external-code $mismatch mismatch", ({ serializedState }) => {
    expect(() => {
      parseConnectorExternalCodeProviderState({
        serializedState,
        connectorSlug,
        authMethod,
      });
    }).toThrow("External-code provider state connector method mismatch");
  });

  it("serializes and parses the exact canonical-only state", () => {
    const serializedState = serializeConnectorExternalCodeProviderState({
      connectorSlug,
      authMethod,
      providerState: "provider-state",
    });

    expect(serializedState).toBe(
      '{"connectorSlug":"slack","authMethod":"oauth","providerState":"provider-state"}',
    );
    expect(
      parseConnectorExternalCodeProviderState({
        serializedState,
        connectorSlug,
        authMethod,
      }),
    ).toStrictEqual({
      connectorSlug,
      authMethod,
      providerState: "provider-state",
    });
  });
});
