import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface ComputerUseAuthorizationDescriptor {
  requestToken: string;
  originalUrl: string;
  href: string;
}

export type ComputerUseAuthorizationSignals =
  ComputerUseAuthorizationDescriptor;

export interface ComputerUseAuthorizationCardSignalsRegistry {
  register(
    descriptor: ComputerUseAuthorizationDescriptor,
  ): ComputerUseAuthorizationSignals;
  resolve(resourceKey: string): ComputerUseAuthorizationSignals;
}

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

export function createComputerUseAuthorizationSignals(
  descriptor: ComputerUseAuthorizationDescriptor,
): ComputerUseAuthorizationSignals {
  return descriptor;
}

export function createComputerUseAuthorizationCardSignalsRegistry(): ComputerUseAuthorizationCardSignalsRegistry {
  const signalsByResourceKey = new Map<
    string,
    ComputerUseAuthorizationSignals
  >();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.href,
        () => {
          return createComputerUseAuthorizationSignals(descriptor);
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
  };
}
