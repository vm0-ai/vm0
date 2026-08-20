import { mapsContract } from "@okouai/api-contracts/contracts/maps";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  mapsDirections$,
  mapsGeocode$,
  mapsPlacesDetails$,
  mapsPlacesSearch$,
  mapsReverseGeocode$,
} from "../services/maps.service";
import { mapsOsmDownload$, mapsOsmRender$ } from "../services/maps-osm.service";

const geocodeBody$ = bodyResultOf(mapsContract.geocode);
const reverseGeocodeBody$ = bodyResultOf(mapsContract.reverseGeocode);
const directionsBody$ = bodyResultOf(mapsContract.directions);
const placesSearchBody$ = bodyResultOf(mapsContract.placesSearch);
const placesDetailsBody$ = bodyResultOf(mapsContract.placesDetails);
const osmDownloadBody$ = bodyResultOf(mapsContract.osmDownload);
const osmRenderBody$ = bodyResultOf(mapsContract.osmRender);

const geocodeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(geocodeBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(mapsGeocode$, { auth, body: bodyResult.data }, signal);
});

const reverseGeocodeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(reverseGeocodeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      mapsReverseGeocode$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const directionsInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(directionsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(mapsDirections$, { auth, body: bodyResult.data }, signal);
});

const placesSearchInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(placesSearchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      mapsPlacesSearch$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const placesDetailsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(placesDetailsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      mapsPlacesDetails$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const osmDownloadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(osmDownloadBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(mapsOsmDownload$, { auth, body: bodyResult.data }, signal);
});

const osmRenderInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(osmRenderBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(mapsOsmRender$, { auth, body: bodyResult.data }, signal);
});

const mapsAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "maps:read",
} as const;

export const mapsRoutes: readonly RouteEntry[] = [
  {
    route: mapsContract.geocode,
    handler: authRoute(mapsAuth, geocodeInner$),
  },
  {
    route: mapsContract.reverseGeocode,
    handler: authRoute(mapsAuth, reverseGeocodeInner$),
  },
  {
    route: mapsContract.directions,
    handler: authRoute(mapsAuth, directionsInner$),
  },
  {
    route: mapsContract.placesSearch,
    handler: authRoute(mapsAuth, placesSearchInner$),
  },
  {
    route: mapsContract.placesDetails,
    handler: authRoute(mapsAuth, placesDetailsInner$),
  },
  {
    route: mapsContract.osmDownload,
    handler: authRoute(mapsAuth, osmDownloadInner$),
  },
  {
    route: mapsContract.osmRender,
    handler: authRoute(mapsAuth, osmRenderInner$),
  },
];
