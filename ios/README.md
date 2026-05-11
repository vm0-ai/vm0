# Zero iOS

This is a native-only iOS voice chat client for Zero.

The app intentionally does not include a WebView shell, web session bridge, or
platform page navigation. The only product flow in this target is:

1. Sign in with native Clerk.
2. Enter an agent ID.
3. Start a native OpenAI Realtime voice chat against the existing
   `/api/zero/voice-chat` endpoints.

## Configuration

Set these build settings in Xcode before running on a device:

- `CLERK_PUBLISHABLE_KEY`: Clerk publishable key for the vm0 frontend API.
- `ZERO_API_BASE_URL`: vm0 API origin. Defaults to `https://api.vm0.ai` when
  unset.

The app target uses:

- Bundle identifier: `ai.vm0.zero`
- Minimum iOS version: `17.0`
- Clerk iOS SDK packages: `ClerkKit`, `ClerkKitUI`
- WebRTC Swift package: `https://github.com/stasel/WebRTC.git`

## Scope

This target reuses the existing voice chat backend contract:

- `POST /api/zero/voice-chat`
- `POST /api/zero/voice-chat/token`
- `POST /api/zero/voice-chat/:id/items`
- `POST /api/zero/voice-chat/:id/tasks`
- `GET /api/zero/voice-chat/:id`
- `GET /api/zero/voice-chat/:id/tasks`
- `POST /api/zero/voice-chat/:id/session-started`
- `POST /api/zero/voice-chat/:id/session-ended`
- `POST /api/zero/voice-chat/:id/usage`

Realtime connects directly to OpenAI with the server-minted client secret and
POSTs SDP to `https://api.openai.com/v1/realtime/calls`.
