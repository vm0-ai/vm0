import { command, computed, state, type Command, type Computed } from "ccstate";

export const IMAGE_LIGHTBOX_MIN_ZOOM = 0.1;
export const IMAGE_LIGHTBOX_MAX_ZOOM = 3;

export type ZoomableImageCanvasGeometry = {
  readonly fitWidth: number;
  readonly maxZoom: number;
};

export interface ZoomableImageCanvasSignals {
  readonly geometry$: Computed<ZoomableImageCanvasGeometry | null>;
  readonly zoom$: Computed<number>;
  readonly loaded$: Command<void, [ZoomableImageCanvasGeometry | null]>;
  readonly reset$: Command<void, []>;
  readonly setZoom$: Command<void, [number]>;
}

function clampImageZoom(zoom: number, maxZoom: number): number {
  return Math.min(maxZoom, Math.max(IMAGE_LIGHTBOX_MIN_ZOOM, zoom));
}

function roundImageZoom(zoom: number, maxZoom: number): number {
  return Math.round(clampImageZoom(zoom, maxZoom) * 10_000) / 10_000;
}

/**
 * One canvas owner creates one signal group. The state lasts only for that
 * owner's current preview session; URLs are never retained as state keys.
 */
export function createZoomableImageCanvasSignals(): ZoomableImageCanvasSignals {
  const internalGeometry$ = state<ZoomableImageCanvasGeometry | null>(null);
  const internalZoom$ = state(1);

  const reset$ = command(({ set }) => {
    set(internalGeometry$, null);
    set(internalZoom$, 1);
  });

  return {
    geometry$: computed((get) => {
      return get(internalGeometry$);
    }),
    zoom$: computed((get) => {
      return get(internalZoom$);
    }),
    loaded$: command(
      ({ set }, geometry: ZoomableImageCanvasGeometry | null) => {
        set(internalZoom$, 1);
        if (
          geometry === null ||
          !Number.isFinite(geometry.fitWidth) ||
          geometry.fitWidth <= 0 ||
          !Number.isFinite(geometry.maxZoom) ||
          geometry.maxZoom < IMAGE_LIGHTBOX_MAX_ZOOM
        ) {
          set(internalGeometry$, null);
          return;
        }

        set(internalGeometry$, {
          fitWidth: Math.round(geometry.fitWidth),
          maxZoom: Math.round(geometry.maxZoom * 10_000) / 10_000,
        });
      },
    ),
    reset$,
    setZoom$: command(({ get, set }, zoom: number) => {
      const maxZoom =
        get(internalGeometry$)?.maxZoom ?? IMAGE_LIGHTBOX_MAX_ZOOM;
      set(internalZoom$, roundImageZoom(zoom, maxZoom));
    }),
  };
}
