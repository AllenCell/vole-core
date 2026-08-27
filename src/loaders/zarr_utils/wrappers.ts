import { defineArrayExtension } from "zarrita";

import VolumeCache, { isChunk } from "../../VolumeCache.js";
import SubscribableRequestQueue from "../../utils/SubscribableRequestQueue.js";
import type { SubscriberId } from "./types.js";

export type VoleInstrumentationOpts = {
  baseUrl: string;
  cache?: VolumeCache;
  queue?: SubscribableRequestQueue;
  subscriber?: SubscriberId;
  reportChunk?: (coords: number[], subscriber: SubscriberId) => void;
  isPrefetch?: boolean;
};

/**
 * Per-request array extension. Intercepts `getChunk` to:
 *   - fire `reportChunk(coords, subscriber)` (best-effort instrumentation hook),
 *   - short-circuit to `VolumeCache` on hit,
 *   - otherwise dedup the underlying fetch through `SubscribableRequestQueue`
 *     when a subscriber is supplied, and insert the decoded chunk into cache.
 *
 * Wrap a fresh instance around a base array per `zarr.get` / `getChunk` call so
 * the closure captures the caller's `subscriber` and `reportChunk`. In zarrita
 * 0.7 there's no mechanism to thread store-specific options through `zarr.get`
 * any more; carrying the context on the extension itself replaces the old
 * `{ opts: { subscriber, reportChunk } }` pass-through.
 */
export const withVoleInstrumentation = defineArrayExtension((array, opts: VoleInstrumentationOpts) => {
  const baseUrl = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl;
  const keyBase = baseUrl + array.path + (array.path.endsWith("/") ? "" : "/");

  return {
    async getChunk(coords, options, inner) {
      if (opts.subscriber !== undefined && opts.reportChunk) {
        opts.reportChunk(coords, opts.subscriber);
      }

      const fullKey = keyBase + coords.join(",");
      const cached = opts.cache?.get(fullKey);
      if (cached && isChunk(cached)) {
        return cached;
      }

      const controller = new AbortController();
      // Abort the chunk if either abort signal is triggered
      const signal = AbortSignal.any([options?.signal, controller.signal].filter(s => s !== undefined));
      const fetchChunk = () => array.getChunk(coords, { ...options, signal }, inner);
      const abort = controller.abort.bind(controller);
      const result =
        opts.queue && opts.subscriber !== undefined
          ? await opts.queue.addRequest(fullKey, opts.subscriber, fetchChunk, opts.isPrefetch, undefined, abort)
          : await fetchChunk();

      opts.cache?.insert(fullKey, result);
      return result;
    },
  };
});

/**
 * `fetch` handler for `FetchStore` that remaps 403 responses to 404, so they're
 * surfaced as "missing key" instead of throwing. S3 and other backends return
 * 403 (not 404) for missing keys on private buckets.
 *
 * Based on the "Handle S3 403 as missing key" example in zarrita's
 * `FetchStore` docs.
 */
export async function relaxedFetch(request: Request): Promise<Response> {
  const response = await fetch(request);
  if (response.status === 403) {
    return new Response(null, { status: 404 });
  }
  return response;
}
