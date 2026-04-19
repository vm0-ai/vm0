/**
 * Tasks API Handlers
 *
 * Mock handlers for /api/zero/tasks endpoints.
 * Default behavior: no tasks exist.
 */

import { tasksContract, type TaskItem } from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockTasks: TaskItem[] = [];

export function setMockTasks(tasks: TaskItem[]): void {
  mockTasks = tasks;
}

export function resetMockTasks(): void {
  mockTasks = [];
}

export const apiTasksHandlers = [
  // GET /api/zero/tasks
  mockApi(tasksContract.list, ({ respond }) =>
    respond(200, { tasks: mockTasks }),
  ),

  // POST /api/zero/tasks/archive
  mockApi(tasksContract.archive, ({ respond }) => respond(200, { ok: true })),
];
