import {
  type UserModelPreferenceResponse,
  zeroUserModelPreferenceContract,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

let mockUserModelPreference: UserModelPreferenceResponse = {
  selectedModel: null,
  codexServiceTier: null,
  updatedAt: null,
};

export function resetMockUserModelPreference(): void {
  mockUserModelPreference = {
    selectedModel: null,
    codexServiceTier: null,
    updatedAt: null,
  };
}

export function setMockUserModelPreference(
  preference: Omit<UserModelPreferenceResponse, "codexServiceTier"> & {
    readonly codexServiceTier?: UserModelPreferenceResponse["codexServiceTier"];
  },
): void {
  mockUserModelPreference = {
    ...preference,
    codexServiceTier: preference.codexServiceTier ?? null,
  };
}

export const apiUserModelPreferenceHandlers = [
  mockApi(zeroUserModelPreferenceContract.get, ({ respond }) => {
    return respond(200, mockUserModelPreference);
  }),
  mockApi(zeroUserModelPreferenceContract.update, ({ body, respond }) => {
    mockUserModelPreference = {
      selectedModel: body.selectedModel,
      codexServiceTier: body.codexServiceTier ?? null,
      updatedAt: nowDate().toISOString(),
    };
    return respond(200, mockUserModelPreference);
  }),
];
