import ngrok from "@ngrok/ngrok";

export async function startNgrokTunnel(
  ngrokToken: string,
  endpointPrefix: string,
): Promise<void> {
  await ngrok.forward({
    addr: "localhost:8888",
    authtoken: ngrokToken,
    domain: `webdav.${endpointPrefix}.internal`,
  });
}

export async function stopNgrokTunnel(): Promise<void> {
  await ngrok.kill();
}
