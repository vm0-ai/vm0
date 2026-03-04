import { beforeEach, describe, expect, it, vi } from "vitest";

const { envHttpProxyAgentMock, setGlobalDispatcherMock } = vi.hoisted(() => ({
  envHttpProxyAgentMock: vi.fn(),
  setGlobalDispatcherMock: vi.fn(),
}));

vi.mock("undici", () => ({
  EnvHttpProxyAgent: envHttpProxyAgentMock,
  setGlobalDispatcher: setGlobalDispatcherMock,
}));

import {
  configureGlobalProxyFromEnv,
  resetProxyBootstrapForTests,
} from "../proxy";

describe("configureGlobalProxyFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProxyBootstrapForTests();

    vi.stubEnv("http_proxy", undefined);
    vi.stubEnv("HTTP_PROXY", undefined);
    vi.stubEnv("https_proxy", undefined);
    vi.stubEnv("HTTPS_PROXY", undefined);
    vi.stubEnv("no_proxy", undefined);
    vi.stubEnv("NO_PROXY", undefined);
  });

  it.each([
    ["no http_proxy or https_proxy is set", {}],
    ["only no_proxy is set", { no_proxy: "localhost,127.0.0.1" }],
  ])("no-ops when %s", (_, envOverrides) => {
    for (const [key, value] of Object.entries(envOverrides)) {
      vi.stubEnv(key, value);
    }
    configureGlobalProxyFromEnv();
    expect(envHttpProxyAgentMock).not.toHaveBeenCalled();
    expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
  });

  it("uses lowercase proxy env vars when present", () => {
    vi.stubEnv("http_proxy", "http://lower-http-proxy:8080");
    vi.stubEnv("https_proxy", "http://lower-https-proxy:8081");
    vi.stubEnv("no_proxy", "localhost,127.0.0.1");

    configureGlobalProxyFromEnv();

    expect(envHttpProxyAgentMock).toHaveBeenCalledWith({
      httpProxy: "http://lower-http-proxy:8080",
      httpsProxy: "http://lower-https-proxy:8081",
      noProxy: "localhost,127.0.0.1",
    });
    expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to uppercase proxy env vars", () => {
    vi.stubEnv("HTTP_PROXY", "http://upper-http-proxy:3128");
    vi.stubEnv("NO_PROXY", "example.com");

    configureGlobalProxyFromEnv();

    expect(envHttpProxyAgentMock).toHaveBeenCalledWith({
      httpProxy: "http://upper-http-proxy:3128",
      noProxy: "example.com",
    });
    expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it("prefers lowercase env vars when both lowercase and uppercase are set", () => {
    vi.stubEnv("http_proxy", "http://lower-http-proxy:8080");
    vi.stubEnv("HTTP_PROXY", "http://upper-http-proxy:3128");

    configureGlobalProxyFromEnv();

    expect(envHttpProxyAgentMock).toHaveBeenCalledWith({
      httpProxy: "http://lower-http-proxy:8080",
    });
  });

  it("configures proxy only once", () => {
    vi.stubEnv("http_proxy", "http://lower-http-proxy:8080");

    configureGlobalProxyFromEnv();
    configureGlobalProxyFromEnv();

    expect(envHttpProxyAgentMock).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows with clear message when EnvHttpProxyAgent constructor throws", () => {
    vi.stubEnv("http_proxy", "http://proxy:8080");
    envHttpProxyAgentMock.mockImplementationOnce(
      function throwingConstructor() {
        throw new TypeError("Invalid URL");
      },
    );

    expect(() => configureGlobalProxyFromEnv()).toThrow(
      "Invalid proxy configuration",
    );
    expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
  });
});
