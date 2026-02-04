/**
 * Slack BDD Test Helpers
 *
 * This module provides BDD-style helpers for testing Slack integration.
 * Helpers are organized into Given/When/Then patterns for readable tests.
 *
 * @example
 * ```ts
 * import {
 *   givenLinkedSlackUser,
 *   givenUserHasAgent,
 * } from "../../__tests__/helpers";
 *
 * describe("Feature: App Mention Handling", () => {
 *   describe("Scenario: Single agent happy path", () => {
 *     it("should execute agent and post response", async () => {
 *       // Given
 *       const { userLink, installation } = await givenLinkedSlackUser();
 *       const { binding } = await givenUserHasAgent(userLink.id, {
 *         agentName: "my-agent",
 *       });
 *
 *       // When / Then - use handleAppMention directly with MSW for Slack API mocking
 *     });
 *   });
 * });
 * ```
 */

// Given helpers - Setup preconditions
export {
  givenSlackWorkspaceInstalled,
  givenLinkedSlackUser,
  givenUserHasAgent,
  givenUserHasMultipleAgents,
  type WorkspaceInstallationResult,
  type LinkedUserResult,
  type AgentBindingResult,
  type WorkspaceInstallationOptions,
  type LinkedUserOptions,
  type AgentBindingOptions,
} from "./given";
