import {
  type UserModelPreferenceResponse,
  zeroUserModelPreferenceContract,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

let mockUserModelPreference: UserModelPreferenceResponse = {
  selectedModel: null,
  serviceTier: null,
  selectedVideoModel: null,
  updatedAt: null,
};

export function resetMockUserModelPreference(): void {
  mockUserModelPreference = {
    selectedModel: null,
    serviceTier: null,
    selectedVideoModel: null,
    updatedAt: null,
  };
}

export function setMockUserModelPreference(
  preference: UserModelPreferenceResponse,
): void {
  mockUserModelPreference = preference;
}

export const apiUserModelPreferenceHandlers = [
  mockApi(zeroUserModelPreferenceContract.get, ({ respond }) => {
    return respond(200, mockUserModelPreference);
  }),
  mockApi(zeroUserModelPreferenceContract.update, ({ body, respond }) => {
    mockUserModelPreference = {
      selectedModel: body.selectedModel,
      serviceTier: body.serviceTier,
      // Omitted by an older bundle: keep the stored default rather than clear it.
      selectedVideoModel:
        "selectedVideoModel" in body
          ? (body.selectedVideoModel ?? null)
          : mockUserModelPreference.selectedVideoModel,
      updatedAt: nowDate().toISOString(),
    };
    return respond(200, mockUserModelPreference);
  }),
];
