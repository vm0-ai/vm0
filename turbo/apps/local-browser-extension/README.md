# VM0 Local Browser Extension

This app builds the unpacked Chrome extension used by the Local Browser connector.

```bash
pnpm -F @vm0/local-browser-extension build
```

Load `turbo/apps/local-browser-extension/dist` from `chrome://extensions` with Developer Mode enabled.

The extension pairs from the VM0 connector modal, stores a host token in `chrome.storage.local`, heartbeats the host, claims queued local-browser commands, executes structured tab/page actions, and completes the command through the API.
