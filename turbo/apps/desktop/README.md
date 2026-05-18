# Zero Desktop

Electron POC for launching the hosted Zero platform app.

This first pass is macOS-only. Windows packaging, native push, tray behavior,
auto-update, and computer-use controls are intentionally out of scope.

## Development

By default the app opens production:

```bash
pnpm -F @vm0/desktop dev
```

Point it at a local or staging platform URL with:

```bash
VM0_DESKTOP_PLATFORM_URL=https://staging-app.vm6.ai pnpm -F @vm0/desktop dev
VM0_DESKTOP_PLATFORM_URL=https://app.vm7.ai pnpm -F @vm0/desktop dev
VM0_DESKTOP_PLATFORM_URL=http://localhost:3002 pnpm -F @vm0/desktop dev
```

The desktop app does not start platform/web/api/proxy services itself. Start the
target platform surface separately, then pass its URL through
`VM0_DESKTOP_PLATFORM_URL`.
