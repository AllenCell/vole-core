import { consolidateContiguous, setFromChunk } from "../data_manager/indexing.js";
import type { TypedArray } from "../types.js";

const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const srcShape = [2, 2, 2];

describe("consolidateContiguous", () => {
  it("does not modify params with offsets", () => {
    const testParams = {
      srcShape: [2, 2, 2],
      destShape: [4, 4, 4],
      offset: [2, 2, 2],
    };

    const result = consolidateContiguous(testParams);

    expect(result).toEqual(testParams);
  });

  it("does not modify params with mismatched shapes", () => {
    const testParams = {
      srcShape: [2, 2, 2],
      destShape: [4, 4, 4],
      offset: [0, 0, 0],
    };

    const result = consolidateContiguous(testParams);

    expect(result).toEqual(testParams);
  });

  it("consolidates dimensions that can be set in a single `set` call", () => {
    const testParams = {
      srcShape: [4, 2, 4],
      destShape: [4, 4, 4],
      offset: [0, 0, 0],
    };

    const result = consolidateContiguous(testParams);

    expect(result).toEqual({
      srcShape: [4, 8],
      destShape: [4, 16],
      offset: [0, 0],
    });
  });

  it("does not consolidate the last dimension", () => {
    const testParams = {
      srcShape: [4, 4, 4],
      destShape: [4, 4, 4],
      offset: [0, 0, 0],
    };

    const result = consolidateContiguous(testParams);

    expect(result).toEqual({ srcShape: [64], destShape: [64], offset: [0] });
  });
});

/** Count calls to `set` on this array and any subarrays created from it */
const countSetsRecursive = (arr: TypedArray, counter = { count: 0 }): { count: number } => {
  const originalSubarray = arr.subarray.bind(arr);
  const originalSet = arr.set.bind(arr);

  vi.spyOn(arr, "subarray").mockImplementation(((...args) => {
    const result = originalSubarray(...args);
    countSetsRecursive(result, counter);
    return result;
  }) as typeof originalSubarray);

  vi.spyOn(arr, "set").mockImplementation((...args) => {
    originalSet(...args);
    counter.count += 1;
  });

  return counter;
};

describe("setFromChunk", () => {
  it("can copy a chunk into a destination array of equal size", () => {
    const params = { srcShape, destShape: srcShape, offset: [0, 0, 0] };
    const dest = new Uint8Array(8).fill(0);
    const setCounter = countSetsRecursive(dest);

    setFromChunk(src, dest, params);

    expect(dest).toEqual(src);
    expect(setCounter.count).toEqual(1);
  });

  it("can copy a chunk into an n-dimensional subchunk of a larger array", () => {
    const params = { srcShape, destShape: [4, 4, 4], offset: [2, 2, 2] };
    const dest = new Uint8Array(64).fill(0);
    const setCounter = countSetsRecursive(dest);

    setFromChunk(src, dest, params);

    // prettier-ignore
    expect(dest).toEqual(new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 3, 4,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 6, 0, 0, 7, 8,
    ]));
    expect(setCounter.count).toEqual(4);
  });

  it("consolidates dimensions to reduce `set` calls", () => {
    const params = { srcShape, destShape: [4, 4, 2], offset: [2, 0, 0] };
    const dest = new Uint8Array(32).fill(0);
    const setCounter = countSetsRecursive(dest);

    setFromChunk(src, dest, params);

    // prettier-ignore
    expect(dest).toEqual(new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      1, 2, 3, 4, 0, 0, 0, 0,
      5, 6, 7, 8, 0, 0, 0, 0
    ]));
    expect(setCounter.count).toEqual(2);
  });
});
