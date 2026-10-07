import { copyChunk } from "../data_manager/indexing.js";

const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const srcShape = [2, 2, 2];

describe("copyChunk", () => {
  it("can copy a chunk into a destination array of equal size", () => {
    const params = { srcShape, destShape: srcShape, offset: [0, 0, 0] };
    const dest = new Uint8Array(8).fill(0);
    const set = vi.spyOn(dest, "set");

    copyChunk(src, dest, params);

    expect(dest).toEqual(src);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("can copy a chunk into an n-dimensional subchunk of a larger array", () => {
    const params = { srcShape, destShape: [4, 4, 4], offset: [2, 2, 2] };
    const dest = new Uint8Array(64).fill(0);
    const set = vi.spyOn(dest, "set");

    copyChunk(src, dest, params);

    // prettier-ignore
    expect(dest).toEqual(new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 3, 4,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 6, 0, 0, 7, 8,
    ]));
    expect(set).toHaveBeenCalledTimes(4);
  });

  it("consolidates dimensions to reduce `set` calls", () => {
    const params = { srcShape, destShape: [4, 4, 2], offset: [2, 0, 0] };
    const dest = new Uint8Array(32).fill(0);
    const set = vi.spyOn(dest, "set");

    copyChunk(src, dest, params);

    // prettier-ignore
    expect(dest).toEqual(new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      1, 2, 3, 4, 0, 0, 0, 0,
      5, 6, 7, 8, 0, 0, 0, 0
    ]));
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("reorders dimensions when copying into a destination array of equal size", () => {
    const params = { srcShape, destShape: srcShape, offset: [0, 0, 0], dimensionOrder: [1, 0, 2] };
    const dest = new Uint8Array(8).fill(0);
    const set = vi.spyOn(dest, "set");

    copyChunk(src, dest, params);

    expect(dest).toEqual(new Uint8Array([1, 2, 5, 6, 3, 4, 7, 8]));
    expect(set).toHaveBeenCalledTimes(4);
  });

  it("reorders dimensions when copying into a subchunk of a larger array", () => {
    const params = { srcShape, destShape: [4, 4, 4], offset: [2, 0, 2], dimensionOrder: [2, 1, 0] };
    const dest = new Uint8Array(64).fill(0);
    const set = vi.spyOn(dest, "set");

    copyChunk(src, dest, params);

    // prettier-ignore
    expect(dest).toEqual(new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 1, 5, 0, 0, 3, 7, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 2, 6, 0, 0, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0,
    ]));
    expect(set).toHaveBeenCalledTimes(8);
  });
});
