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
 *   whenUserMentionsBot,
 *   thenSlackShouldReceiveMessage,
 *   createMockSlackClient,
 * } from "../helpers";
 *
 * describe("Feature: App Mention Handling", () => {
 *   describe("Scenario: Single agent happy path", () => {
 *     it("should execute agent and post response", async () => {
 *       // Given
 *       const { userLink, installation } = await givenLinkedSlackUser();
 *       const { binding } = await givenUserHasAgent(userLink.id, {
 *         agentName: "my-agent",
 *       });
 *       const mockClient = createMockSlackClient();
 *
 *       // When
 *       await whenUserMentionsBot({
 *         workspaceId: installation.slackWorkspaceId,
 *         userId: userLink.slackUserId,
 *         channelId: "C123",
 *         messageText: "<@BOT123> help me",
 *         messageTs: "1234567890.123456",
 *       });
 *
 *       // Then
 *       thenSlackShouldReceiveMessage(mockClient, {
 *         channel: "C123",
 *       });
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
  givenExistingThreadSession,
  givenOrphanedBindings,
  givenAgentRunCompleted,
  givenAgentRunFailed,
  type WorkspaceInstallationResult,
  type LinkedUserResult,
  type AgentBindingResult,
  type WorkspaceInstallationOptions,
  type LinkedUserOptions,
  type AgentBindingOptions,
} from "./given";

// When helpers - Execute actions
export {
  whenUserMentionsBot,
  whenRunAgentForSlack,
  whenUserLinksAccount,
  whenCheckLinkStatus,
  type MentionContext,
} from "./when";

// Then helpers - Verify outcomes
export {
  thenSlackShouldReceiveMessage,
  thenSlackShouldUpdateMessage,
  thenReactionShouldBeAdded,
  thenReactionShouldBeRemoved,
  thenThreadSessionShouldExist,
  thenThreadSessionShouldNotExist,
  thenBindingShouldExist,
  thenUserLinkShouldExist,
  thenUserLinkShouldNotExist,
  thenOrphanedBindingsShouldExist,
  thenBindingsShouldBeRestored,
  thenSlackShouldNotReceiveMessage,
  thenSlackShouldReceiveNMessages,
  getSlackCalls,
} from "./then";

// Mock utilities
export {
  createMockSlackClient,
  createMockRunAgentForSlack,
  setupMockThreadContext,
  setupMockChannelContext,
  setupMockSlackApiError,
  type MockSlackClient,
  type SlackApiCall,
  type MockAgentResult,
} from "./mocks";
