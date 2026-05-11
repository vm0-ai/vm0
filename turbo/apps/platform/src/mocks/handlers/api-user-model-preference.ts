import {
  type UserModelPreferenceResponse,
  zeroUserModelPreferenceContract,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { mockApi } from "../msw-contract.ts";

let mockUserModelPreference: UserModelPreferenceResponse = {
  selectedModel: null,
  updatedAt: null,
};

export function resetMockUserModelPreference(): void {
  mockUserModelPreference = {
    selectedModel: null,
    updatedAt: null,
  };
}

export const apiUserModelPreferenceHandlers = [
  mockApi(zeroUserModelPreferenceContract.get, ({ respond }) => {
    return respond(200, mockUserModelPreference);
  }),
  mockApi(zeroUserModelPreferenceContract.update, ({ body, respond }) => {
    mockUserModelPreference = {
      selectedModel: body.selectedModel,
      updatedAt: new Date().toISOString(),
    };
    return respond(200, mockUserModelPreference);
  }),
];
