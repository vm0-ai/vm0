# Independent Website template registry

The built-in Website template registry can be generated and published without
republishing the report, poster, dashboard, mobile-app, and docs registries.

## Generate only the Website registry

From `turbo/`:

```bash
pnpm html-resource-index:build \
  --output-dir /tmp/website-resource-index \
  --target website
```

The command writes `website.json` and a `manifest.json` containing only the
Website entry. Publish both files under a new content-addressed directory whose
name is the `website.json` SHA-256 recorded by the manifest.

Omitting `--target` preserves the existing behavior and generates all six HTML
resource registries plus their shared manifest. This is the compatibility path
for existing publication jobs.

## Migration compatibility

- Existing registry URLs are immutable and remain available to released
  clients.
- A new Website registry must be added at a new versioned, content-addressed
  path; never overwrite or remove an existing path.
- Non-Website consumers continue using the shared registry directory.
- Switch the Website consumer only after every resource referenced by the new
  registry is available and its server-side pins have deployed.
- Keep the previous Website registry and template resource versions available
  for the full client migration window.

## Verification

Verify both generator modes before publishing:

1. Run the command above and confirm the output directory contains only
   `website.json` and `manifest.json`.
2. Confirm the manifest has exactly one file entry with `target: "website"`,
   and that its byte size and SHA-256 match `website.json`.
3. Run the command without `--target` into a separate directory and confirm it
   still contains all six target registries plus `manifest.json`.
4. Confirm no existing static-file path is modified or removed by the
   publication PR.
