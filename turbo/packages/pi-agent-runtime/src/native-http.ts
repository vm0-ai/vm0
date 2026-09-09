import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, ProxyAgent } from "undici";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import { validateBaseUrlHostPolicy } from "@okouai/connectors/firewall-types";

/** Validate the addresses actually used by the socket, avoiding DNS rebinding. */
export const nativePublicLookup: LookupFunction = (
  hostname,
  options,
  callback,
) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    try {
      if (addresses.length === 0)
        throw new Error("Pi native destination has no public address");
      for (const { address, family } of addresses) {
        validateBaseUrlHostPolicy({
          base: `https://${family === 6 ? `[${address}]` : address}`,
          serviceName: "pi-native",
          hostPolicy: { kind: "publicDestination" },
        });
      }
    } catch {
      callback(
        new Error("Pi native destination resolved to a non-public address"),
        "",
        0,
      );
      return;
    }
    const candidates =
      options.family === 4 || options.family === 6
        ? addresses.filter((address) => {
            return address.family === options.family;
          })
        : addresses;
    if (options.all) callback(null, candidates);
    else {
      const address = candidates[0];
      if (!address) {
        callback(new Error("Pi native destination is unavailable"), "", 0);
        return;
      }
      callback(null, address.address, address.family);
    }
  });
};

/** Streaming native API fetch; redirects cannot move a credential to another target. */
export const nativePublicFetch: typeof globalThis.fetch = async (
  input,
  init,
) => {
  const target = input instanceof Request ? input.url : input.toString();
  const proxy = resolveHttpProxyUrlForTarget(target);
  // Runner owns public-destination validation when connecting through its MITM.
  const dispatcher = proxy
    ? new ProxyAgent(proxy.toString())
    : new Agent({ connect: { lookup: nativePublicLookup } });
  try {
    const options: RequestInit = { ...init, redirect: "error" };
    // Node's fetch accepts the installed Undici dispatcher at this boundary;
    // its bundled declaration uses a separately versioned undici-types package.
    Object.assign(options, { dispatcher });
    const response = await globalThis.fetch(input, options);
    if (!response.body) {
      await dispatcher.close();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            await dispatcher.close();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          await dispatcher.destroy();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await dispatcher.destroy();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
};
