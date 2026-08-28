import type { AsyncReadable, AsyncWritable, NumberDataType } from "zarrita";
import * as zarr from "zarrita";
import { vi } from "vitest";

import planLowResPrefetch from "../loaders/zarr_utils/planLowResPrefetch.js";
import type { ZarrSource } from "../loaders/zarr_utils/types.js";

class MockStore implements AsyncReadable, AsyncWritable {
  set = vi.fn();
  get = vi.fn();
}

async function createSource(dtype: NumberDataType): Promise<ZarrSource> {
  const level = await zarr.create(new MockStore(), {
    shape: [1, 1, 1, 1, 72],
    chunkShape: [1, 1, 1, 1, 18],
    dtype,
  });

  return {
    scaleLevels: [level],
    baseUrl: `mock://volume-${dtype}`,
    axesTCZYX: [0, 1, 2, 3, 4],
    multiscaleMetadata: {
      axes: ["t", "c", "z", "y", "x"].map((name) => ({ name })),
      datasets: [{ path: "0" }],
    },
    channelOffset: 0,
  };
}

describe("planLowResPrefetch", () => {
  it("skips an oversized low-res source and prefetches a smaller subsequent source", async () => {
    // ARRANGE
    // Source 0 has 72 * 2 = 144 bytes
    // Source 1 has 72 bytes
    const sources = await Promise.all([createSource("uint16"), createSource("uint8")]);

    // ACT
    const { plan } = planLowResPrefetch(sources, 100, 0.7);

    // ASSERT
    // Source 0 not prefetched because 144 * 0.7 = 100.8 > 100
    // Source 1 is prefetched because 72 <= 100
    expect(plan).toHaveLength(4);
    expect(plan.every(({ sourceIndex }) => sourceIndex === 1)).to.be.true;
  });
});
