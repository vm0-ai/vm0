import type { ScheduleResponse } from "@vm0/api-contracts/contracts/zero-schedules";

// Shared in-memory store for the schedule and automation mock handlers. Both
// surfaces are backed by the same service in production, so the mocks share one
// store too: a schedule created through `/api/zero/schedules` is visible through
// `/api/automations` and vice versa.
let mockSchedules: ScheduleResponse[] = [];

export function getMockSchedules(): ScheduleResponse[] {
  return mockSchedules;
}

export function setMockSchedules(schedules: ScheduleResponse[]): void {
  mockSchedules = schedules;
}

export function resetMockSchedules(): void {
  mockSchedules = [];
}
