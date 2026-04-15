import type { EventConsumerConfig } from "./types";

/**
 * Registry of event consumers.
 *
 * The events webhook dispatches matching events to each consumer via HTTP POST.
 * Consumers are independent — one consumer's failure does not affect others.
 */
export const eventConsumers: EventConsumerConfig[] = [
  {
    name: "axiom",
    path: "/api/internal/event-consumers/axiom",
  },
  {
    name: "credit",
    path: "/api/internal/event-consumers/credit",
  },
  {
    name: "chat-assistant",
    path: "/api/internal/event-consumers/chat-assistant",
    eventTypes: ["assistant"],
  },
];
