import { AVATAR_PRESET_COUNT } from "@vm0/core/agent-avatar";

import { getAvatarPresets } from "../zero-avatars.ts";

// The API assigns `preset:N` avatars from AVATAR_PRESET_COUNT without access to
// the render catalog, so the two must stay in sync.
describe("avatar presets", () => {
  it("renders every preset the API can assign", () => {
    expect(getAvatarPresets()).toHaveLength(AVATAR_PRESET_COUNT);
  });
});
