```
pnpm install
pnpm --filter api dev
```

```
open http://localhost:3001
```

`GET /` returns the Hono greeting plus the built-in model names backed by
`vm0_api_keys`. It does not return vendors or API key values.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to
export Hono request spans and `pg` query spans.
