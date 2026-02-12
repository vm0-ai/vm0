/**
 * Comprehensive mock data for the log-detail page.
 *
 * Covers every event type, tool type, and several edge cases so that
 * developers can visually verify rendering without a real API connection.
 *
 * Usage: set VITE_MOCK_LOG_DETAIL=true in .env.local and navigate to any
 * /logs/<id> URL.
 */

import type { LogDetail, AgentEvent } from "../signals/logs-page/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = new Date("2025-06-15T10:00:00Z");

function t(offsetSeconds: number): string {
  return new Date(BASE_TIME.getTime() + offsetSeconds * 1000).toISOString();
}

let toolIdCounter = 0;
function nextToolId(): string {
  return `toolu_mock_${String(++toolIdCounter).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Mock LogDetail
// ---------------------------------------------------------------------------

export const mockLogDetail: LogDetail = {
  id: "mock-run-001",
  sessionId: "mock-session-001",
  agentName: "claude-code",
  framework: "claude-code",
  status: "completed",
  prompt: [
    "# Slack Thread Context",
    "",
    "---",
    "",
    "- RELATIVE_INDEX: -2",
    "- MSG_ID: 1770813781.383159",
    "- SENDER_ID: UMOCK_SENDER01",
    "",
    "<@UMOCK_MENTION01> 看一下我发给你这个图片的内容，起草一下。博客的大纲",
    "[file]: IMG_8408.png (PNG)",
    "   Dimensions: 1206x2622",
    "   Image URL: https://mock-r2-storage.example.com/slack-images/CMOCK_CHAN01-1770813781.383159/FMOCK_FILE01-IMG_8408.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=FAKE_ACCESS_KEY_ID%2F20260211%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260211T125301Z&X-Amz-Expires=3600&X-Amz-Signature=0000000000000000000000000000000000000000000000000000000000000000&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject",
    "",
    "---",
    "",
    "- RELATIVE_INDEX: -1",
    "- MSG_ID: 1770813804.464419",
    "- SENDER_ID: BOT",
    "",
    "I don't see any image in your current message. Could you please share the image you'd like me to review? You can upload it directly to this conversation, and I'll analyze its content to help you draft a blog post outline.",
    "",
    "---",
    "",
    "# User Prompt",
    "",
    "用 curl 请求一下这张图 然后继续",
  ].join("\n"),
  error: null,
  createdAt: t(0),
  startedAt: t(1),
  completedAt: t(185),
  artifact: {
    name: "auth-module",
    version: "2.1.0",
  },
};

// ---------------------------------------------------------------------------
// Mock AgentEvents
// ---------------------------------------------------------------------------

// #1 — system init
const systemInit: AgentEvent = {
  sequenceNumber: 1,
  eventType: "system",
  eventData: {
    subtype: "init",
    tools: [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "Task",
      "Skill",
      "NotebookEdit",
    ],
    agents: ["Explore", "Plan", "Bash"],
    slash_commands: ["commit", "review-pr", "testing", "help"],
  },
  createdAt: t(1),
};

// #2 — assistant text only (markdown paragraphs)
const assistantText: AgentEvent = {
  sequenceNumber: 2,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "text",
          text: "I'll start by exploring the current authentication module to understand the existing implementation before making changes.\n\nLet me look at the project structure and the auth-related files first.",
        },
      ],
    },
  },
  createdAt: t(3),
};

// #3+4 — Bash tool (success)
const bashToolId = nextToolId();
const bashToolUse: AgentEvent = {
  sequenceNumber: 3,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: bashToolId,
          name: "Bash",
          input: {
            command: "ls -la src/auth/",
          },
        },
      ],
    },
  },
  createdAt: t(5),
};

const bashToolResult: AgentEvent = {
  sequenceNumber: 4,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: bashToolId,
          content:
            "total 48\ndrwxr-xr-x  5 user staff  160 Jun 15 10:00 .\ndrwxr-xr-x 12 user staff  384 Jun 15 09:55 ..\n-rw-r--r--  1 user staff 2048 Jun 15 09:50 auth.ts\n-rw-r--r--  1 user staff 1024 Jun 15 09:50 middleware.ts\n-rw-r--r--  1 user staff  512 Jun 15 09:50 types.ts\n-rw-r--r--  1 user staff  768 Jun 15 09:50 utils.ts",
        },
      ],
    },
    tool_use_result: { durationMs: 45 },
  },
  createdAt: t(6),
};

// #5+6 — Read tool
const readToolId = nextToolId();
const readToolUse: AgentEvent = {
  sequenceNumber: 5,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: readToolId,
          name: "Read",
          input: {
            file_path: "/workspace/src/auth/auth.ts",
          },
        },
      ],
    },
  },
  createdAt: t(8),
};

const readToolResult: AgentEvent = {
  sequenceNumber: 6,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: readToolId,
          content:
            '     1\timport { hash, compare } from "bcrypt";\n     2\timport { sign, verify } from "jsonwebtoken";\n     3\t\n     4\texport interface AuthConfig {\n     5\t  secret: string;\n     6\t  expiresIn: string;\n     7\t}\n     8\t\n     9\texport async function authenticate(username: string, password: string): Promise<string | null> {\n    10\t  const user = await findUser(username);\n    11\t  if (!user) return null;\n    12\t  const valid = await compare(password, user.passwordHash);\n    13\t  if (!valid) return null;\n    14\t  return sign({ sub: user.id, role: user.role }, config.secret, { expiresIn: config.expiresIn });\n    15\t}',
        },
      ],
    },
    tool_use_result: { durationMs: 12, bytes: 523 },
  },
  createdAt: t(9),
};

// #7+8 — 3x consecutive Read tools (collapsed group)
const read2Id = nextToolId();
const read3Id = nextToolId();
const read4Id = nextToolId();

const multiReadUse: AgentEvent = {
  sequenceNumber: 7,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: read2Id,
          name: "Read",
          input: { file_path: "/workspace/src/auth/middleware.ts" },
        },
        {
          type: "tool_use",
          id: read3Id,
          name: "Read",
          input: { file_path: "/workspace/src/auth/types.ts" },
        },
        {
          type: "tool_use",
          id: read4Id,
          name: "Read",
          input: { file_path: "/workspace/src/auth/utils.ts" },
        },
      ],
    },
  },
  createdAt: t(11),
};

const multiReadResult: AgentEvent = {
  sequenceNumber: 8,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: read2Id,
          content:
            '     1\timport { verify } from "jsonwebtoken";\n     2\timport type { Request, Response, NextFunction } from "express";\n     3\t\n     4\texport function authMiddleware(req: Request, res: Response, next: NextFunction) {\n     5\t  const token = req.headers.authorization?.split(" ")[1];\n     6\t  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }\n     7\t  try {\n     8\t    const decoded = verify(token, process.env.JWT_SECRET!);\n     9\t    req.user = decoded;\n    10\t    next();\n    11\t  } catch { res.status(401).json({ error: "Invalid token" }); }\n    12\t}',
        },
        {
          type: "tool_result",
          tool_use_id: read3Id,
          content:
            '     1\texport interface User {\n     2\t  id: string;\n     3\t  username: string;\n     4\t  passwordHash: string;\n     5\t  role: "admin" | "user";\n     6\t  createdAt: Date;\n     7\t}',
        },
        {
          type: "tool_result",
          tool_use_id: read4Id,
          content:
            '     1\timport crypto from "crypto";\n     2\t\n     3\texport function generateRefreshToken(): string {\n     4\t  return crypto.randomBytes(48).toString("hex");\n     5\t}',
        },
      ],
    },
    tool_use_result: { durationMs: 18, bytes: 891 },
  },
  createdAt: t(12),
};

// #9+10 — Write tool
const writeToolId = nextToolId();
const writeToolUse: AgentEvent = {
  sequenceNumber: 9,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "text",
          text: "Now I'll create the new JWT token service with proper refresh token support.",
        },
        {
          type: "tool_use",
          id: writeToolId,
          name: "Write",
          input: {
            file_path: "/workspace/src/auth/token-service.ts",
            content:
              'import { sign, verify, type JwtPayload } from "jsonwebtoken";\nimport crypto from "crypto";\n\nexport interface TokenPair {\n  accessToken: string;\n  refreshToken: string;\n}\n\nexport interface TokenPayload extends JwtPayload {\n  sub: string;\n  role: string;\n}\n\nexport class TokenService {\n  constructor(\n    private readonly secret: string,\n    private readonly accessTokenTtl: string = "15m",\n    private readonly refreshTokenTtl: string = "7d",\n  ) {}\n\n  generateTokenPair(userId: string, role: string): TokenPair {\n    const accessToken = sign({ sub: userId, role }, this.secret, {\n      expiresIn: this.accessTokenTtl,\n    });\n    const refreshToken = crypto.randomBytes(48).toString("hex");\n    return { accessToken, refreshToken };\n  }\n\n  verifyAccessToken(token: string): TokenPayload {\n    return verify(token, this.secret) as TokenPayload;\n  }\n}\n',
          },
        },
      ],
    },
  },
  createdAt: t(20),
};

const writeToolResult: AgentEvent = {
  sequenceNumber: 10,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: writeToolId,
          content: "File written successfully.",
        },
      ],
    },
    tool_use_result: { durationMs: 8, bytes: 743 },
  },
  createdAt: t(21),
};

// #11+12 — Edit tool (diff display)
const editToolId = nextToolId();
const editToolUse: AgentEvent = {
  sequenceNumber: 11,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: editToolId,
          name: "Edit",
          input: {
            file_path: "/workspace/src/auth/middleware.ts",
            old_string:
              '  const token = req.headers.authorization?.split(" ")[1];\n  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }\n  try {\n    const decoded = verify(token, process.env.JWT_SECRET!);\n    req.user = decoded;\n    next();\n  } catch { res.status(401).json({ error: "Invalid token" }); }',
            new_string:
              '  const authHeader = req.headers.authorization;\n  if (!authHeader?.startsWith("Bearer ")) {\n    res.status(401).json({ error: "Missing or malformed Authorization header" });\n    return;\n  }\n\n  const token = authHeader.slice(7);\n  try {\n    const payload = tokenService.verifyAccessToken(token);\n    req.user = { id: payload.sub, role: payload.role };\n    next();\n  } catch {\n    res.status(401).json({ error: "Invalid or expired token" });\n  }',
          },
        },
      ],
    },
  },
  createdAt: t(30),
};

const editToolResult: AgentEvent = {
  sequenceNumber: 12,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: editToolId,
          content: "Edit applied successfully.",
        },
      ],
    },
    tool_use_result: { durationMs: 15 },
  },
  createdAt: t(31),
};

// #13+14 — Glob tool
const globToolId = nextToolId();
const globToolUse: AgentEvent = {
  sequenceNumber: 13,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: globToolId,
          name: "Glob",
          input: {
            pattern: "src/**/*.test.ts",
          },
        },
      ],
    },
  },
  createdAt: t(35),
};

const globToolResult: AgentEvent = {
  sequenceNumber: 14,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: globToolId,
          content:
            "src/auth/__tests__/auth.test.ts\nsrc/auth/__tests__/middleware.test.ts\nsrc/routes/__tests__/users.test.ts\nsrc/routes/__tests__/health.test.ts\nsrc/utils/__tests__/validation.test.ts",
        },
      ],
    },
    tool_use_result: { durationMs: 22 },
  },
  createdAt: t(36),
};

// #15+16 — Grep tool
const grepToolId = nextToolId();
const grepToolUse: AgentEvent = {
  sequenceNumber: 15,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: grepToolId,
          name: "Grep",
          input: {
            pattern: "JWT_SECRET|jsonwebtoken",
            path: "src/",
          },
        },
      ],
    },
  },
  createdAt: t(40),
};

const grepToolResult: AgentEvent = {
  sequenceNumber: 16,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: grepToolId,
          content:
            'src/auth/auth.ts:2:import { sign, verify } from "jsonwebtoken";\nsrc/auth/middleware.ts:1:import { verify } from "jsonwebtoken";\nsrc/auth/middleware.ts:8:    const decoded = verify(token, process.env.JWT_SECRET!);\nsrc/config/env.ts:15:  JWT_SECRET: z.string().min(32),\nsrc/auth/token-service.ts:1:import { sign, verify } from "jsonwebtoken";',
        },
      ],
    },
    tool_use_result: { durationMs: 35 },
  },
  createdAt: t(41),
};

// #17+18 — Bash tool ERROR with long output (tests #2875 overflow fix)
const bashErrId = nextToolId();
const bashErrorUse: AgentEvent = {
  sequenceNumber: 17,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "text",
          text: "Let me run the existing tests to see the current state.",
        },
        {
          type: "tool_use",
          id: bashErrId,
          name: "Bash",
          input: {
            command: "cd /workspace && npm test -- --run src/auth/",
          },
        },
      ],
    },
  },
  createdAt: t(50),
};

const bashErrorResult: AgentEvent = {
  sequenceNumber: 18,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: bashErrId,
          content: [
            "FAIL src/auth/__tests__/auth.test.ts",
            "FAIL src/auth/__tests__/middleware.test.ts",
            "FAIL src/auth/__tests__/token-service.test.ts",
            "FAIL src/auth/__tests__/refresh.test.ts",
            "",
            " FAIL  src/auth/__tests__/auth.test.ts > authenticate > should return JWT token for valid credentials",
            "  Error: Cannot find module '../token-service' from 'src/auth/auth.ts'",
            "",
            "    at Resolver._throwModNotFoundError (node_modules/jest-resolve/build/resolver.js:491:11)",
            "    at Object.<anonymous> (src/auth/auth.ts:3:1)",
            "    at Runtime._execModule (node_modules/jest-runtime/build/index.js:1439:24)",
            "    at Runtime._loadModule (node_modules/jest-runtime/build/index.js:1022:12)",
            "    at Runtime.requireModule (node_modules/jest-runtime/build/index.js:882:12)",
            "    at Runtime.requireModuleOrMock (node_modules/jest-runtime/build/index.js:1048:21)",
            "",
            " FAIL  src/auth/__tests__/middleware.test.ts > authMiddleware > should reject expired tokens",
            "  Error: TokenExpiredError: jwt expired",
            "    at /workspace/node_modules/jsonwebtoken/verify.js:152:21",
            "    at getToken [as verify] (/workspace/node_modules/jsonwebtoken/verify.js:17:12)",
            "    at authMiddleware (/workspace/src/auth/middleware.ts:8:22)",
            "    at Object.<anonymous> (/workspace/src/auth/__tests__/middleware.test.ts:45:5)",
            "",
            " FAIL  src/auth/__tests__/token-service.test.ts > TokenService > generateTokenPair > should return valid access and refresh tokens",
            "  TypeError: Cannot read properties of undefined (reading 'sign')",
            "    at TokenService.generateTokenPair (/workspace/src/auth/token-service.ts:22:28)",
            "    at Object.<anonymous> (/workspace/src/auth/__tests__/token-service.test.ts:18:30)",
            "    at Promise.then.completed (/workspace/node_modules/jest-circus/build/utils.js:298:28)",
            "    at new Promise (<anonymous>)",
            "    at callAsyncCircusFn (/workspace/node_modules/jest-circus/build/utils.js:231:10)",
            "    at _callCircusTest (/workspace/node_modules/jest-circus/build/run.js:316:40)",
            "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
            "",
            " FAIL  src/auth/__tests__/token-service.test.ts > TokenService > verifyAccessToken > should throw on malformed token",
            "  Error: expected [Function] to throw an error matching /Invalid token/ but got 'JsonWebTokenError: jwt malformed'",
            "    at /workspace/node_modules/.pnpm/vitest@2.1.0_@types+node@22.15.29/node_modules/vitest/dist/chunks/vi.CqMi_QSg.js:1842:17",
            "    at /workspace/node_modules/.pnpm/vitest@2.1.0_@types+node@22.15.29/node_modules/vitest/dist/chunks/vi.CqMi_QSg.js:1268:11",
            "",
            " FAIL  src/auth/__tests__/refresh.test.ts > POST /auth/refresh > should rotate refresh token and return new token pair",
            "  Error: connect ECONNREFUSED 127.0.0.1:0",
            "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)",
            "    at TCPConnectWrap.callbackTrampoline (node:internal/async_hooks:130:17)",
            "",
            " FAIL  src/auth/__tests__/refresh.test.ts > POST /auth/refresh > should reject reused refresh token (rotation violation)",
            "  AssertionError: expected 500 to equal 401",
            "    at Object.<anonymous> (/workspace/src/auth/__tests__/refresh.test.ts:72:42)",
            "    at Promise.then.completed (/workspace/node_modules/.pnpm/jest-circus@29.7.0/node_modules/jest-circus/build/utils.js:298:28)",
            "",
            "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
            "",
            "Test Suites: 4 failed, 3 passed, 7 total",
            "Tests:       6 failed, 12 passed, 18 total",
            "Snapshots:   0 total",
            "Time:        8.291s, estimated 10s",
            "",
            "Error: /workspace/node_modules/.pnpm/some-very-long-package-name@1.2.3_typescript@5.7.3/node_modules/another-deeply-nested-dependency/lib/internal/core/helpers/utils/format/stringify.js:142:27 — This is an extremely long path that exercises the horizontal overflow fix from PR #2875. When bash error output contains wide content it should wrap or scroll properly without breaking the layout.",
            "Error: /workspace/node_modules/.pnpm/@auth+core@0.35.3_@simplewebauthn+browser@13.1.0_@simplewebauthn+server@13.1.1_nodemailer@6.10.1/node_modules/@auth/core/lib/actions/callback/oauth/callback.js:258:19 — Another deeply nested node_modules path that commonly appears in real stack traces and can cause horizontal overflow issues.",
            "",
            "Process exited with code 1",
          ].join("\n"),
          is_error: true,
        },
      ],
    },
    tool_use_result: { durationMs: 3847 },
  },
  createdAt: t(54),
};

// #19+20 — WebFetch tool
const webFetchId = nextToolId();
const webFetchUse: AgentEvent = {
  sequenceNumber: 19,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: webFetchId,
          name: "WebFetch",
          input: {
            url: "https://www.npmjs.com/package/jsonwebtoken",
            prompt:
              "What is the latest version and are there any security advisories?",
          },
        },
      ],
    },
  },
  createdAt: t(60),
};

const webFetchResult: AgentEvent = {
  sequenceNumber: 20,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: webFetchId,
          content:
            "The latest version of jsonwebtoken is 9.0.2 (published 2023-09-01). There are no active security advisories for this version. Key features:\n- Supports RS256, RS384, RS512, ES256, ES384, ES512, PS256, PS384, PS512 algorithms\n- Full JWS and JWT compliance\n- The package has 25M+ weekly downloads",
        },
      ],
    },
    tool_use_result: { durationMs: 1250 },
  },
  createdAt: t(62),
};

// #21+22 — WebSearch tool
const webSearchId = nextToolId();
const webSearchUse: AgentEvent = {
  sequenceNumber: 21,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: webSearchId,
          name: "WebSearch",
          input: {
            query: "JWT refresh token rotation best practices 2025",
          },
        },
      ],
    },
  },
  createdAt: t(65),
};

const webSearchResult: AgentEvent = {
  sequenceNumber: 22,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: webSearchId,
          content:
            'Search results for "JWT refresh token rotation best practices 2025":\n\n1. **OWASP JWT Security Cheat Sheet** — Recommends refresh token rotation with reuse detection. Each refresh token should be single-use.\n\n2. **Auth0 Blog: Refresh Token Rotation** — Describes the pattern where issuing a new refresh token invalidates the previous one. Detects token theft via reuse.\n\n3. **RFC 6749 Section 1.5** — OAuth 2.0 specification for refresh token grant type. Defines the standard flow for token refresh.',
        },
      ],
    },
    tool_use_result: { durationMs: 890 },
  },
  createdAt: t(66),
};

// #23+24 — Skill tool
const skillId = nextToolId();
const skillUse: AgentEvent = {
  sequenceNumber: 23,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: skillId,
          name: "Skill",
          input: {
            skill: "testing",
          },
        },
      ],
    },
  },
  createdAt: t(70),
};

const skillResult: AgentEvent = {
  sequenceNumber: 24,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: skillId,
          content:
            "Testing guidelines loaded. Key principles:\n- Integration tests only: test at entry points, not internal functions\n- Use real infrastructure: real DB, MSW for HTTP\n- Only mock external dependencies",
        },
      ],
    },
    tool_use_result: { durationMs: 5 },
  },
  createdAt: t(71),
};

// #25+26 — Task tool (subagent delegation)
const taskId = nextToolId();
const taskUse: AgentEvent = {
  sequenceNumber: 25,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: taskId,
          name: "Task",
          input: {
            description: "Research auth patterns",
            prompt:
              "Find all files that import from the auth module and list how they use the authenticate function. Check if any callers need to be updated for the new TokenService API.",
            subagent_type: "Explore",
          },
        },
      ],
    },
  },
  createdAt: t(75),
};

const taskResult: AgentEvent = {
  sequenceNumber: 26,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: taskId,
          content:
            "Found 3 callers of authenticate():\n\n1. src/routes/login.ts:12 — Direct call, returns token to client. Needs update to use TokenService.generateTokenPair()\n2. src/routes/oauth-callback.ts:28 — Used after OAuth flow. Needs update.\n3. src/middleware/session.ts:5 — Imports authenticate but only uses verify. Can switch to TokenService.verifyAccessToken()\n\nNo other files import from auth module directly.",
        },
      ],
    },
    tool_use_result: { durationMs: 4200 },
  },
  createdAt: t(80),
};

// #27+28 — TodoWrite tool
const todoWriteId = nextToolId();
const todoWriteUse: AgentEvent = {
  sequenceNumber: 27,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "tool_use",
          id: todoWriteId,
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Create TokenService class", status: "completed" },
              {
                content: "Update middleware to use TokenService",
                status: "completed",
              },
              { content: "Update login route", status: "in_progress" },
              { content: "Update OAuth callback route", status: "pending" },
              { content: "Add refresh token endpoint", status: "pending" },
              { content: "Write integration tests", status: "pending" },
            ],
          },
        },
      ],
    },
  },
  createdAt: t(85),
};

const todoWriteResult: AgentEvent = {
  sequenceNumber: 28,
  eventType: "user",
  eventData: {
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: todoWriteId,
          content: "Todos updated.",
        },
      ],
    },
    tool_use_result: { durationMs: 3 },
  },
  createdAt: t(86),
};

// #29 — Rich markdown with headings, lists, code blocks, and a TABLE (tests #2786)
const richMarkdown: AgentEvent = {
  sequenceNumber: 29,
  eventType: "assistant",
  eventData: {
    message: {
      content: [
        {
          type: "text",
          text: [
            "## Summary of Changes",
            "",
            "Here's an overview of the refactoring progress so far:",
            "",
            "### Files Modified",
            "",
            "- `src/auth/token-service.ts` — New `TokenService` class with `generateTokenPair()` and `verifyAccessToken()`",
            "- `src/auth/middleware.ts` — Updated to use `TokenService` instead of raw `jsonwebtoken`",
            "- `src/auth/types.ts` — Added `TokenPair` and `TokenPayload` interfaces",
            "",
            "### Token Comparison",
            "",
            "| Feature | Before | After |",
            "|---------|--------|-------|",
            "| Token type | Single JWT | Access + Refresh pair |",
            "| Access TTL | 24 hours | 15 minutes |",
            "| Refresh mechanism | None | Rotation with reuse detection |",
            "| Token storage | localStorage | httpOnly cookie (access) + DB (refresh) |",
            "| Revocation | Not supported | Immediate via refresh token deletion |",
            "",
            "### Next Steps",
            "",
            "1. Update the login route to return token pairs",
            "2. Add a `/auth/refresh` endpoint",
            "3. Write integration tests for the complete flow",
            "",
            "```typescript",
            "// Example usage of the new TokenService",
            "const tokenService = new TokenService(env.JWT_SECRET);",
            "const { accessToken, refreshToken } = tokenService.generateTokenPair(",
            "  user.id,",
            "  user.role,",
            ");",
            "```",
          ].join("\n"),
        },
      ],
    },
  },
  createdAt: t(100),
};

// #30 — result event
const resultEvent: AgentEvent = {
  sequenceNumber: 30,
  eventType: "result",
  eventData: {
    result: [
      "Successfully refactored the authentication module to use JWT tokens with refresh token rotation.",
      "",
      "**Changes made:**",
      "- Created `TokenService` class with access/refresh token generation",
      "- Updated auth middleware to use `TokenService.verifyAccessToken()`",
      "- Updated login and OAuth callback routes",
      "- Added `/auth/refresh` endpoint with token rotation",
      "- Added integration tests covering all auth flows",
      "",
      "### Test Results",
      "",
      "```bash",
      "$ npm test -- --run src/auth/",
      "",
      " ✓ src/auth/__tests__/token-service.test.ts (6 tests) 42ms",
      " ✓ src/auth/__tests__/auth.test.ts (5 tests) 38ms",
      " ✓ src/auth/__tests__/middleware.test.ts (7 tests) 51ms",
      " ✓ src/auth/__tests__/refresh.test.ts (6 tests) 127ms",
      "",
      " Test Suites: 4 passed, 4 total",
      " Tests:       24 passed, 24 total",
      " Time:        1.832s",
      "```",
      "",
      "### Files Changed",
      "",
      "| File | Action | Lines Changed |",
      "|------|--------|--------------|",
      "| `src/auth/token-service.ts` | Created | +87 |",
      "| `src/auth/middleware.ts` | Modified | +14 / -8 |",
      "| `src/auth/auth.ts` | Modified | +6 / -12 |",
      "| `src/auth/types.ts` | Modified | +18 / -2 |",
      "| `src/routes/login.ts` | Modified | +9 / -5 |",
      "| `src/routes/oauth-callback.ts` | Modified | +11 / -7 |",
      "| `src/auth/__tests__/token-service.test.ts` | Created | +142 |",
      "| `src/auth/__tests__/refresh.test.ts` | Created | +98 |",
      "| **Total** | | **+385 / -34** |",
    ].join("\n"),
    is_error: false,
  },
  createdAt: t(185),
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const mockAgentEvents: AgentEvent[] = [
  systemInit,
  assistantText,
  bashToolUse,
  bashToolResult,
  readToolUse,
  readToolResult,
  multiReadUse,
  multiReadResult,
  writeToolUse,
  writeToolResult,
  editToolUse,
  editToolResult,
  globToolUse,
  globToolResult,
  grepToolUse,
  grepToolResult,
  bashErrorUse,
  bashErrorResult,
  webFetchUse,
  webFetchResult,
  webSearchUse,
  webSearchResult,
  skillUse,
  skillResult,
  taskUse,
  taskResult,
  todoWriteUse,
  todoWriteResult,
  richMarkdown,
  resultEvent,
];
