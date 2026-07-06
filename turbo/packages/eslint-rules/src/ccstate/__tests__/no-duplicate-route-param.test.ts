import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-duplicate-route-param.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-duplicate-route-param", rule, {
  valid: [
    // Same param under same segment — OK
    {
      code: `
        const ROUTES = {
          agentDetail: "/agents/:agentId",
          agentChat: "/agents/:agentId/chat",
          agentIdeas: "/agents/:agentId/ideas",
        };
      `,
    },
    // Different params under different segments — OK
    {
      code: `
        const ROUTES = {
          agentDetail: "/agents/:agentId",
          activityDetail: "/activities/:runId",
          chat: "/chats/:threadId",
        };
      `,
    },
    // Single route with param — OK
    {
      code: `const path = "/users/:userId";`,
    },
    // No params — OK
    {
      code: `const path = "/dashboard";`,
    },
    // Non-route strings — OK
    {
      code: `const msg = "hello world";`,
    },
  ],
  invalid: [
    // Same :id under different segments — BAD
    {
      code: `
        const ROUTES = {
          agentDetail: "/agents/:id",
          activityDetail: "/activities/:id",
        };
      `,
      errors: [
        { messageId: "duplicateRouteParam" },
        { messageId: "duplicateRouteParam" },
      ],
    },
    // Same :id under three different segments — BAD (3 errors)
    {
      code: `
        const ROUTES = {
          agentDetail: "/agents/:id",
          activityDetail: "/activities/:id",
          chat: "/chats/:id",
        };
      `,
      errors: [
        { messageId: "duplicateRouteParam" },
        { messageId: "duplicateRouteParam" },
        { messageId: "duplicateRouteParam" },
      ],
    },
    // Mixed: nested routes with same param under different parent — BAD
    {
      code: `
        const ROUTES = {
          agentChat: "/agents/:id/chat",
          scheduleDetail: "/schedules/:id",
        };
      `,
      errors: [
        { messageId: "duplicateRouteParam" },
        { messageId: "duplicateRouteParam" },
      ],
    },
  ],
});
