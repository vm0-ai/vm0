import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface ComputerUseAuthorizationDescriptor {
  requestToken: string;
  originalUrl: string;
  href: string;
}

export type ComputerUseAuthorizationSignals =
  ComputerUseAuthorizationDescriptor;

type ComputerUseAuthorizationCardSignalsRegistry = CardSignalsRegistry<
  ComputerUseAuthorizationDescriptor,
  ComputerUseAuthorizationSignals
>;

export function parseComputerUseAuthorizationUrl(
  value: string,
): ComputerUseAuthorizationDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (!url) {
    return null;
  }

  const match = url.pathname.match(/^\/computer-use\/authorize\/([^/]+)$/);
  const requestToken = match?.[1];
  if (!requestToken) {
    return null;
  }

  const href = `/computer-use/authorize/${encodeURIComponent(requestToken)}`;
  return {
    requestToken,
    originalUrl: value,
    href,
  };
}

function createComputerUseAuthorizationSignals(
  descriptor: ComputerUseAuthorizationDescriptor,
): ComputerUseAuthorizationSignals {
  return descriptor;
}

export function createComputerUseAuthorizationCardSignalsRegistry(): ComputerUseAuthorizationCardSignalsRegistry {
  return createCardSignalsRegistry(
    (descriptor: ComputerUseAuthorizationDescriptor) => {
      return descriptor.href;
    },
    createComputerUseAuthorizationSignals,
  );
}
