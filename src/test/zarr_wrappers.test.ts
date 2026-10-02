import type { AsyncReadable, AsyncWritable } from "zarrita";
import * as zarr from "zarrita";
import { vi } from "vitest";

import VolumeCache from "../VolumeCache.js";
import { withVoleInstrumentation } from "../loaders/zarr_utils/wrappers.js";

class MockStore implements AsyncReadable, AsyncWritable {
  set = vi.fn();
  get = vi.fn();
}

describe("withVoleInstrumentation", () => {
  it("reads through the low-res cache but inserts misses only into the regular cache", async () => {
    // ARRANGE
    const store = new MockStore();
    // 2 chunk array
    const array = await zarr.create(store, { shape: [2], chunkShape: [1], dtype: "uint8" });
    const cache = new VolumeCache();
    const lowResCache = new VolumeCache();
    const cachedChunk: zarr.Chunk<"uint8"> = {
      data: new Uint8Array([7]),
      shape: [1],
      stride: [1],
    };
    lowResCache.insert("mock://volume/0", cachedChunk);

    // ACT
    const instrumented = withVoleInstrumentation(array, {
      baseUrl: "mock://volume",
      cache,
      lowResCache,
    });
    await instrumented.getChunk([0]); // Cache hit
    await instrumented.getChunk([1]); // Cache miss

    // ASSERT: Chunk 1 is loaded, then saved to the regular cache
    expect(store.get).toHaveBeenCalledOnce();
    expect(cache.get("mock://volume/0")).to.be.undefined;
    expect(cache.get("mock://volume/1")).to.not.be.undefined;
    expect(lowResCache.get("mock://volume/1")).to.be.undefined;
  });
});
