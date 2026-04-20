// Dynamic import is intentional: @ngrok/ngrok contains native binaries that
// crash on systems with GLIBC version mismatches. Lazy-loading ensures the
// crash only affects the command that needs ngrok, not the entire CLI.
// See: https://github.com/vm0-ai/vm0/issues/6825
async function loadNgrok(): Promise<typeof import("@ngrok/ngrok")> {
  try {
    const mod = await import("@ngrok/ngrok");
    return mod.default;
  } catch (cause) {
    throw new Error(
      "Failed to load ngrok tunnel module. " +
        "This may be caused by a system library (GLIBC) incompatibility. " +
        "See: https://github.com/vm0-ai/vm0/issues/6825",
      { cause },
    );
  }
}

export async function startDesktopTunnel(
  ngrokToken: string,
  endpointPrefix: string,
  port: number,
): Promise<void> {
  const ngrok = await loadNgrok();

  await ngrok.forward({
    addr: `localhost:${port}`,
    authtoken: ngrokToken,
    domain: `desktop.${endpointPrefix}.internal`,
  });
}

export async function stopDesktopTunnel(): Promise<void> {
  const ngrok = await loadNgrok();
  await ngrok.kill();
}
