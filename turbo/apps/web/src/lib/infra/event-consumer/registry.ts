import type { EventConsumerConfig } from "./types";

/**
 * Registry of event consumers.
 *
 * The events webhook dispatches matching events to each consumer via HTTP POST.
 * Optional consumers are isolated; required consumers make dispatch fail.
 */
export const eventConsumers: EventConsumerConfig[] = [
  {
    name: "axiom",
    path: "/api/internal/event-consumers/axiom",
    required: true,
  },
  {
    name: "chat-assistant",
    path: "/api/internal/event-consumers/chat-assistant",
    eventTypes: ["assistant", "item.completed"],
  },
  {
    name: "voice-chat",
    path: "/api/internal/event-consumers/voice-chat",
    eventTypes: ["assistant"],
  },
];
