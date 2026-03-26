async function loadNgrok(): Promise<typeof import("@ngrok/ngrok")> {
  try {
    const mod = await import("@ngrok/ngrok");
    return mod.default ?? mod;
  } catch (cause) {
    throw new Error(
      "Failed to load ngrok tunnel module. " +
        "This may be caused by a system library (GLIBC) incompatibility. " +
        "See: https://github.com/vm0-ai/vm0/issues/6825",
      { cause },
    );
  }
}

export async function startNgrokTunnels(
  ngrokToken: string,
  endpointPrefix: string,
  webdavPort: number,
  cdpPort: number,
): Promise<void> {
  const ngrok = await loadNgrok();

  await ngrok.forward({
    addr: `localhost:${webdavPort}`,
    authtoken: ngrokToken,
    domain: `webdav.${endpointPrefix}.internal`,
  });

  await ngrok.forward({
    addr: `localhost:${cdpPort}`,
    authtoken: ngrokToken,
    domain: `chrome.${endpointPrefix}.internal`,
  });
}

export async function stopNgrokTunnels(): Promise<void> {
  const ngrok = await loadNgrok();
  await ngrok.kill();
}
