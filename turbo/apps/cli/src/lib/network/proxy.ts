import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

let configured = false;

function getEnvValue(
  lowercaseKey: string,
  uppercaseKey: string,
): string | null {
  const lowercaseValue = process.env[lowercaseKey]?.trim();
  if (lowercaseValue) {
    return lowercaseValue;
  }

  const uppercaseValue = process.env[uppercaseKey]?.trim();
  if (uppercaseValue) {
    return uppercaseValue;
  }

  return null;
}

function getProxyConfigFromEnv(): ProxyConfig | null {
  const httpProxy = getEnvValue("http_proxy", "HTTP_PROXY");
  const httpsProxy = getEnvValue("https_proxy", "HTTPS_PROXY");

  if (!httpProxy && !httpsProxy) {
    return null;
  }

  const noProxy = getEnvValue("no_proxy", "NO_PROXY");
  const config: ProxyConfig = {};

  if (httpProxy) {
    config.httpProxy = httpProxy;
  }

  if (httpsProxy) {
    config.httpsProxy = httpsProxy;
  }

  if (noProxy) {
    config.noProxy = noProxy;
  }

  return config;
}

export function configureGlobalProxyFromEnv(): void {
  if (configured) {
    return;
  }

  const config = getProxyConfigFromEnv();
  if (!config) {
    return;
  }

  try {
    const dispatcher = new EnvHttpProxyAgent(config);
    setGlobalDispatcher(dispatcher);
    configured = true;
  } catch (error) {
    throw new Error(
      "Invalid proxy configuration. Check HTTP_PROXY/HTTPS_PROXY/NO_PROXY values.",
      {
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
}
