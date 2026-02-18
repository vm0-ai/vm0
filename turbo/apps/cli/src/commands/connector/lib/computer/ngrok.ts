import ngrok from "@ngrok/ngrok";

export async function startNgrokTunnels(
  ngrokToken: string,
  endpointPrefix: string,
  webdavPort: number,
  cdpPort: number,
): Promise<void> {
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
  await ngrok.kill();
}
