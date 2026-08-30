import type { AbsolutePath, AsyncReadable, AsyncWritable } from "zarrita";
import * as zarr from "zarrita";

import type {
  NumericZarrArray,
  OMEDataset,
  OMEMultiscale,
  OmeroTransitionalMetadata,
  TCZYX,
  ZarrSource,
} from "../loaders/zarr_utils/types.js";
import {
  getDimensionCount,
  getScale,
  getSourceChannelMeta,
  matchSourceScaleLevels,
  orderByDimension,
  orderByTCZYX,
  parseHexColor,
  remapAxesToTCZYX,
} from "../loaders/zarr_utils/utils.js";

/** Contains only the data required to produce a mock `ZarrSourceMeta` which is useful for testing */
type ZarrSourceMockSpec = {
  /** Shape of zarrita arrays corresponding to each scale level. Must be in ascending order of size. */
  shapes: TCZYX<number>[];
  /** Scale transforms per level in OME metadata. Default: array of `[1, 1, 1, 1, 1]` with same length as `shapes`. */
  scales?: TCZYX<number>[];
  /** Paths in OME metadata. Default: array ["0", "1", "2", ...] with same length as `scales`. */
  paths?: string[];
};

const createMockOmeroMetadata = (
  numChannels: number,
  channelNames?: string[],
  colors?: (string | undefined)[]
): OmeroTransitionalMetadata => ({
  id: 0,
  name: "0",
  version: "0.0",
  channels: (channelNames ?? Array.from({ length: numChannels }, (_, i) => `channel ${i}`)).map((label, i) => ({
    label,
    active: true,
    coefficient: 1,
    color: colors && colors[i],
    family: "linear",
    inverted: false,
    window: { end: 1, max: 1, min: 0, start: 0 },
  })),
});

const createMockMultiscaleMetadata = (scales: number[][], paths?: string[]): OMEMultiscale => ({
  name: "0",
  version: "0.0",
  axes: [{ name: "t" }, { name: "c" }, { name: "z" }, { name: "y" }, { name: "x" }],
  datasets: scales.map((scale, idx) => ({
    path: (paths && paths[idx]) ?? `${idx}`,
    coordinateTransformations: [{ type: "scale", scale }],
  })),
});

class MockStore implements AsyncReadable, AsyncWritable {
  async set(_key: AbsolutePath, _value: Uint8Array): Promise<void> {
    return undefined;
  }

  async get(_key: AbsolutePath, _opts?: unknown): Promise<Uint8Array | undefined> {
    return undefined;
  }
}
const MOCK_STORE = new MockStore();

const createMockArrays = (shapes: number[][]): Promise<NumericZarrArray[]> => {
  const promises = shapes.map((shape) => zarr.create(MOCK_STORE, { shape, chunkShape: shape, dtype: "uint8" }));
  return Promise.all(promises);
};

const createOneMockSource = async (
  shapes: TCZYX<number>[],
  scales: TCZYX<number>[],
  channelOffset: number,
  paths?: string[],
  names?: string[],
  colors?: (string | undefined)[]
): Promise<ZarrSource> => ({
  scaleLevels: await createMockArrays(shapes),
  baseUrl: "mock://",
  multiscaleMetadata: createMockMultiscaleMetadata(scales, paths),
  omeroMetadata: createMockOmeroMetadata(shapes[0][1], names, colors),
  axesTCZYX: [0, 1, 2, 3, 4],
  channelOffset,
});

/** For when we only care about the OMERO metadata */
const createOneBasicMockSource = (names?: string[], colors?: (string | undefined)[]): Promise<ZarrSource> => {
  const channels = names?.length ?? colors?.length ?? 1;
  return createOneMockSource([[1, channels, 1, 1, 1]], [[1, 1, 1, 1, 1]], 0, undefined, names, colors);
};

const createMockSources = (specs: ZarrSourceMockSpec[]): Promise<ZarrSource[]> => {
  let channelOffset = 0;
  const sourcePromises = specs.map(({ shapes, scales, paths }) => {
    if (!scales) {
      scales = Array.from({ length: shapes.length }, () => [1, 1, 1, 1, 1]);
    }
    const result = createOneMockSource(shapes, scales, channelOffset, paths);
    channelOffset += shapes[0][1];
    return result;
  });
  return Promise.all(sourcePromises);
};

const createTwoMockSourceArrs = (specs: ZarrSourceMockSpec[]): Promise<[ZarrSource[], ZarrSource[]]> => {
  return Promise.all([createMockSources(specs), createMockSources(specs)]);
};

/** Chai's deep equality doesn't seem to work for zarr arrays */
const expectSourcesEqual = (aArr: ZarrSource[], bArr: ZarrSource[]) => {
  expect(aArr.length).to.equal(bArr.length);
  for (const [idx, a] of aArr.entries()) {
    const b = bArr[idx];
    expect(a.multiscaleMetadata).to.deep.equal(b.multiscaleMetadata);
    expect(a.omeroMetadata).to.deep.equal(b.omeroMetadata);
    expect(a.axesTCZYX).to.deep.equal(b.axesTCZYX);
    expect(a.channelOffset).to.equal(b.channelOffset);

    expect(a.scaleLevels.length).to.equal(b.scaleLevels.length);
    for (const [idx, aLevel] of a.scaleLevels.entries()) {
      const bLevel = b.scaleLevels[idx];
      expect(aLevel.path).to.equal(bLevel.path);
      expect(aLevel.shape).to.deep.equal(bLevel.shape);
      expect(aLevel.chunks).to.deep.equal(bLevel.chunks);
    }
  }
};

describe("zarr_utils", () => {
  describe("parseHexColor", () => {
    it("parses a hex color", () => expect(parseHexColor("abcdef")).to.deep.equal([171, 205, 239]));
    it("handles a leading # sign", () => expect(parseHexColor("#123456")).to.deep.equal([18, 52, 86]));
    it("handles upper case letters", () => expect(parseHexColor("12CDE7")).to.deep.equal([18, 205, 231]));
    it("returns undefined for invalid hex digits", () => expect(parseHexColor("1234x6")).to.be.undefined);
    it("returns undefined for strings that are too long", () => expect(parseHexColor("123456789")).to.be.undefined);
  });
  describe("getSourceChannelMeta", () => {
    it("extracts a list of channel labels from the given source", async () => {
      const names = ["foo", "bar", "baz"];
      const source = await createOneBasicMockSource(names);
      expect(getSourceChannelMeta(source).names).to.deep.equal(names);
    });

    it("does not resolve channel name collisions", async () => {
      const names = ["foo", "bar", "foo"];
      const source = await createOneBasicMockSource(names);
      expect(getSourceChannelMeta(source).names).to.deep.equal(names);
    });

    it('applies default names of the form "Channel N" for missing labels', async () => {
      const names = ["foo", "bar", undefined] as string[];
      const source = await createOneBasicMockSource(names);
      expect(getSourceChannelMeta(source).names).to.deep.equal(["foo", "bar", "Channel 2"]);
    });

    it("applies default names when `omeroMetadata` is missing entirely", async () => {
      const source = await createOneMockSource([[1, 3, 1, 1, 1]], [[1, 1, 1, 1, 1]], 0);
      delete source.omeroMetadata;
      expect(getSourceChannelMeta(source).names).to.deep.equal(["Channel 0", "Channel 1", "Channel 2"]);
    });

    it("applies `channelOffset` to default names", async () => {
      const source = await createOneMockSource([[1, 3, 1, 1, 1]], [[1, 1, 1, 1, 1]], 3);
      delete source.omeroMetadata;
      expect(getSourceChannelMeta(source).names).to.deep.equal(["Channel 3", "Channel 4", "Channel 5"]);
    });

    it("parses colors", async () => {
      const source = await createOneBasicMockSource(undefined, ["eeeeee", "ABCDEF", "#121212"]);
      expect(getSourceChannelMeta(source).colors).to.deep.equal([
        [238, 238, 238],
        [171, 205, 239],
        [18, 18, 18],
      ]);
    });

    it("leaves colors undefined where the color metadata is missing or invalid", async () => {
      const source = await createOneBasicMockSource(undefined, [undefined, "808080", "orange", "ffffffff"]);
      expect(getSourceChannelMeta(source).colors).to.deep.equal([undefined, [128, 128, 128], undefined, undefined]);
    });
  });

  describe("getDimensionCount", () => {
    it("returns 5 when all 5 dimension indices are positive", () => {
      expect(getDimensionCount([1, 1, 1, 1, 1])).to.equal(5);
    });

    it("recognizes when T, C, or Z is missing", () => {
      for (let dim = 0; dim < 3; dim++) {
        const tczyx: TCZYX<number> = [1, 1, 1, 1, 1];
        tczyx[dim] = -1;
        expect(getDimensionCount(tczyx)).to.equal(4);
      }
    });

    it("returns 2 when all of T, C, and Z are missing", () => {
      expect(getDimensionCount([-1, -1, -1, 1, 1])).to.equal(2);
    });
  });

  describe("remapAxesToTCZYX", () => {
    it("produces an array of indices in T, C, Z, Y, X order", () => {
      const axes = [{ name: "t" }, { name: "c" }, { name: "x" }, { name: "y" }, { name: "z" }];
      expect(remapAxesToTCZYX(axes)).to.deep.equal([0, 1, 4, 3, 2]);
    });

    it("defaults to -1 for missing T, C, or Z axes", () => {
      const axes = [{ name: "x" }, { name: "y" }];
      expect(remapAxesToTCZYX(axes)).to.deep.equal([-1, -1, -1, 1, 0]);
    });

    it("throws an error if it encounters an unrecognized (not t, c, z, y, or x) axis name", () => {
      const axes = [{ name: "t" }, { name: "c" }, { name: "x" }, { name: "y" }, { name: "foo" }];
      expect(() => remapAxesToTCZYX(axes)).to.throw("Unrecognized axis");
    });
  });
  // TODO: `pickLevelToLoad`

  const VALS_TCZYX: TCZYX<string> = ["t", "c", "z", "y", "x"];
  describe("orderByDimension", () => {
    it("orders an array in dimension order based on the given indices", () => {
      const order: TCZYX<number> = [3, 1, 4, 0, 2];
      expect(orderByDimension(VALS_TCZYX, order)).to.deep.equal(["y", "c", "x", "t", "z"]);
    });

    it("excludes the T, C, or Z dimension if its index is negative", () => {
      expect(orderByDimension(VALS_TCZYX, [-1, 0, 1, 3, 2])).to.deep.equal(["c", "z", "x", "y"]);
      expect(orderByDimension(VALS_TCZYX, [0, -1, 1, 3, 2])).to.deep.equal(["t", "z", "x", "y"]);
      expect(orderByDimension(VALS_TCZYX, [0, 1, -1, 3, 2])).to.deep.equal(["t", "c", "x", "y"]);
    });

    it("throws an error if an axis index is out of bounds", () => {
      // Out of bounds for full-size array
      expect(() => orderByDimension(VALS_TCZYX, [0, 1, 2, 3, 5])).to.throw("Unexpected axis index");
      // Out of bounds for smaller array
      expect(() => orderByDimension(VALS_TCZYX, [-1, -1, 0, 3, 1])).to.throw("Unexpected axis index");
    });
  });

  const VALS_DIM: TCZYX<number> = [16, 8, 4, 2, 1];
  describe("orderByTCZYX", () => {
    it("orders an array TCZYX based on the given indices", () => {
      const order: TCZYX<number> = [3, 1, 4, 0, 2];
      expect(orderByTCZYX(VALS_DIM, order, 0)).to.deep.equal([2, 8, 1, 16, 4]);
    });

    it("fills in missing dimensions with a default value", () => {
      const order: TCZYX<number> = [3, 1, 4, -1, 2];
      expect(orderByTCZYX(VALS_DIM, order, 3)).to.deep.equal([2, 8, 1, 3, 4]);
    });

    it("throws an error if an axis index is out of bounds", () => {
      // Out of bounds for full-size array
      expect(() => orderByTCZYX(VALS_DIM, [0, 1, 2, 5, 3], 0)).to.throw("Unexpected axis index");
      // Out of bounds for smaller array
      expect(() => orderByTCZYX(VALS_DIM.slice(2), [-1, 0, 1, 3, 2], 0)).to.throw("Unexpected axis index");
    });
  });

  const MOCK_DATASET: Required<OMEDataset> = {
    path: "0",
    coordinateTransformations: [
      { type: "translation", translation: [0, 0, 0, 0, 0] },
      { type: "scale", scale: [1, 2, 3, 4, 5] },
      { type: "identity" },
    ],
  };
  describe("getScale", () => {
    it("returns the scale transformation for a given dataset", () => {
      expect(getScale(MOCK_DATASET, [0, 1, 2, 3, 4])).to.deep.equal([1, 2, 3, 4, 5]);
    });

    it("orders the scale transformation in TCZYX order", () => {
      expect(getScale(MOCK_DATASET, [3, 1, 4, 0, 2])).to.deep.equal([4, 2, 5, 1, 3]);
    });

    it('defaults to `[1, 1, 1, 1, 1]` if no coordinate transformation of type "scale" is found', () => {
      const dataset = {
        ...MOCK_DATASET,
        coordinateTransformations: MOCK_DATASET.coordinateTransformations.slice(0, 1),
      };
      expect(getScale(dataset, [0, 1, 2, 3, 4])).to.deep.equal([1, 1, 1, 1, 1]);
    });

    it("defaults to `[1, 1, 1, 1, 1]` if no coordinate transformations are present at all", () => {
      expect(getScale({ path: "0" }, [0, 1, 2, 3, 4])).to.deep.equal([1, 1, 1, 1, 1]);
    });
  });

  describe("matchSourceScaleLevels", () => {
    it("does nothing if passed only one source scale level", async () => {
      const [testSource, refSource] = await createTwoMockSourceArrs([{ shapes: [[5, 5, 5, 5, 5]] }]);
      matchSourceScaleLevels(testSource);
      expectSourcesEqual(testSource, refSource);
    });

    it("does nothing if all source scale levels are the same", async () => {
      const spec: ZarrSourceMockSpec = {
        shapes: [
          [1, 1, 10, 10, 10],
          [1, 1, 5, 5, 5],
        ],
      };
      const [testSource, refSource] = await createTwoMockSourceArrs([spec, spec]);
      matchSourceScaleLevels(testSource);
      expectSourcesEqual(testSource, refSource);
    });

    it("trims source scale levels which are outside the range of any other sources", async () => {
      const baseSpec: ZarrSourceMockSpec = {
        shapes: [
          [1, 1, 10, 10, 10],
          [1, 1, 5, 5, 5],
        ],
      };

      // Has all the same scale levels as `baseSpec`, plus one smaller
      const specSmaller: ZarrSourceMockSpec = { shapes: [...baseSpec.shapes.slice(), [1, 1, 2, 2, 2]] };
      // Has all the same scale levels as `baseSpec`, plus one larger
      const specLarger: ZarrSourceMockSpec = { shapes: [[1, 1, 20, 20, 20], ...baseSpec.shapes.slice()] };

      const refSourceSmaller = await createMockSources([baseSpec, baseSpec]);
      // The largest source will have path "0", so we have to shift the paths to match
      const refSourceLarger = await createMockSources([baseSpec, { ...baseSpec, paths: ["1", "2"] }]);
      const testSourceSmaller = await createMockSources([baseSpec, specSmaller]);
      const testSourceLarger = await createMockSources([baseSpec, specLarger]);

      matchSourceScaleLevels(testSourceSmaller);
      matchSourceScaleLevels(testSourceLarger);

      expectSourcesEqual(testSourceSmaller, refSourceSmaller);
      expectSourcesEqual(testSourceLarger, refSourceLarger);
    });

    it("handles unmatched scale levels within the range of other sources", async () => {
      // The only level shapes that all three of these sources have in common are [1, 1, 6, 6, 6] and [1, 1, 2, 2, 2]
      const shapes1: TCZYX<number>[] = [
        [1, 1, 6, 6, 6],
        [1, 1, 5, 5, 5],
        [1, 1, 3, 3, 3],
        [1, 1, 2, 2, 2],
      ];
      const shapes2: TCZYX<number>[] = [
        [1, 1, 6, 6, 6],
        [1, 1, 5, 5, 5],
        [1, 1, 4, 4, 4],
        [1, 1, 2, 2, 2],
        [1, 1, 1, 1, 1],
      ];
      const shapes3: TCZYX<number>[] = [
        [1, 1, 7, 7, 7],
        [1, 1, 6, 6, 6],
        [1, 1, 4, 4, 4],
        [1, 1, 2, 2, 2],
      ];

      const testSources = await createMockSources([{ shapes: shapes1 }, { shapes: shapes2 }, { shapes: shapes3 }]);
      matchSourceScaleLevels(testSources);

      const shapes: TCZYX<number>[] = [
        [1, 1, 6, 6, 6],
        [1, 1, 2, 2, 2],
      ];
      const refSources = await createMockSources([
        { shapes, paths: ["0", "3"] },
        { shapes, paths: ["0", "3"] },
        { shapes, paths: ["1", "3"] },
      ]);
      expectSourcesEqual(testSources, refSources);
    });

    it("throws an error if the size of two scale levels are mismatched", async () => {
      const sources = await createMockSources([{ shapes: [[1, 1, 2, 1, 1]] }, { shapes: [[1, 1, 1, 2, 1]] }]);
      expect(() => matchSourceScaleLevels(sources)).to.throw(
        "Incompatible zarr arrays: pixel dimensions are mismatched"
      );
    });

    it("throws an error if sources have no matching scale levels", async () => {
      const sources = await createMockSources([
        {
          shapes: [
            [1, 1, 10, 10, 10],
            [1, 1, 5, 5, 5],
          ],
        },
        {
          shapes: [
            [1, 1, 8, 8, 8],
            [1, 1, 4, 4, 4],
          ],
        },
      ]);

      expect(() => matchSourceScaleLevels(sources)).to.throw(
        "Incompatible zarr arrays: no sets of scale levels found that matched in all sources"
      );
    });

    it("Does not throw an error if two scale levels of the same size have different scale transformations", async () => {
      const sources = await createMockSources([
        { shapes: [[1, 1, 1, 1, 1]], scales: [[1, 1, 2, 2, 2]] },
        { shapes: [[1, 1, 1, 1, 1]], scales: [[1, 1, 1, 1, 1]] },
      ]);
      expect(() => matchSourceScaleLevels(sources)).to.not.throw(
        "Incompatible zarr arrays: scale levels of equal size have different scale transformations"
      );
    });

    it("Does not throw an error if two scale levels of the same size have a different number of timesteps", async () => {
      const sources = await createMockSources([{ shapes: [[1, 1, 1, 1, 1]] }, { shapes: [[2, 1, 1, 1, 1]] }]);
      expect(() => matchSourceScaleLevels(sources)).to.not.throw(
        "Incompatible zarr arrays: different numbers of timesteps"
      );
    });
  });
});
