import { vi, afterEach } from "vitest";

const openSpy = vi
  .spyOn(window, "open")
  .mockReturnValue({ closed: true } as Window);

afterEach(() => {
  openSpy.mockClear();
});

export const mockedWindowOpen = openSpy;
