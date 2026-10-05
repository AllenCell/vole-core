import type { IDataSubscriber } from "../data_manager/data_manager.js";
import DataManager from "../data_manager/data_manager.js";
import type { DeviceInterface } from "../data_manager/device_interface.js";
import type { ChunkSource } from "../data_manager/sources/ChunkSource.js";
import { type ChunkPriority, ChunkPriorityLevel } from "../data_manager/types.js";
import type { TypedArray, NumberType } from "../types.js";

const mockSource = () => {
  return {
    getDims: vi.fn<ChunkSource["getDims"]>(() => [
      {
        shape: [7, 7, 7, 7, 7],
        spacing: [1, 1, 1, 1, 1],
        chunkShape: [1, 1, 2, 2, 2],
        dataType: "uint8",
        spaceUnit: "micrometer",
        timeUnit: "second",
      },
    ]),
    getKey: vi.fn<ChunkSource["getKey"]>(async (id) => {
      const length = id.tczyx.slice(2).reduce((len, coord) => (coord >= 3 ? len : len * 2), 1);
      const data = new Uint8Array(length).fill(0);
      data.set(id.tczyx);
      return [{ data, dtype: "uint8", id }];
    }),
    getMeta: vi.fn<ChunkSource["getMeta"]>(() => ({
      channelNames: ["one", "two", "three"],
      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    })),
    chunkIdToStorageId: vi.fn<ChunkSource["chunkIdToStorageId"]>((id) => id),
    storageIdToChunkIds: vi.fn<ChunkSource["storageIdToChunkIds"]>((id) => [id]),
  } satisfies ChunkSource;
};

type MockTex = {
  data: TypedArray;
  dtype: NumberType;
  size: [number, number, number];
  id: number;
};

let mockTexCount = 0;

const mockInterface = (): DeviceInterface<void, MockTex> => ({
  isDeviceHandle: (_val): _val is void => true,
  createTexture: vi.fn((data, dtype, size) => {
    const result = { data, dtype, size, id: mockTexCount };
    mockTexCount += 1;
    return result;
  }),
  destroyTexture: vi.fn(),
  finishUpdate: vi.fn(),
});

const mockSubscriber = (): IDataSubscriber<MockTex> => ({
  onChunkLoaded: vi.fn(),
  onChunkOnGpu: vi.fn(),
});

describe("request priority", () => {
  it("orders requests by priority", () => {
    const manager = new DataManager(mockInterface());
    const sourceMock = mockSource();
    const source = manager.addSource(sourceMock);
    const subscriber = mockSubscriber();

    const queue = (x: number, score: number) =>
      manager.addChunkRequest(
        subscriber,
        { source, multiscale: 0, tczyx: [0, 0, 0, 0, x] },
        { level: ChunkPriorityLevel.VISIBLE, score },
        false
      );
    queue(0, 1);
    queue(1, 0);
    queue(2, 2);
    manager.update();

    const getCalls = sourceMock.getKey.mock.calls;
    expect(getCalls[0][0].tczyx[4]).toEqual(2);
    expect(getCalls[1][0].tczyx[4]).toEqual(0);
    expect(getCalls[2][0].tczyx[4]).toEqual(1);
  });

  it("orders `VISIBLE` requests ahead of `PREFETCH` ones", () => {
    const manager = new DataManager(mockInterface());
    const sourceMock = mockSource();
    const source = manager.addSource(sourceMock);
    const subscriber = mockSubscriber();

    const queue = (x: number, priority: ChunkPriority) =>
      manager.addChunkRequest(subscriber, { source, multiscale: 0, tczyx: [0, 0, 0, 0, x] }, priority, false);
    queue(0, { level: ChunkPriorityLevel.PREFETCH, score: 1000 });
    queue(1, { level: ChunkPriorityLevel.VISIBLE, score: 0 });
    manager.update();

    const getCalls = sourceMock.getKey.mock.calls;
    expect(getCalls[0][0].tczyx[4]).toEqual(1);
    expect(getCalls[1][0].tczyx[4]).toEqual(0);
  });

  it("resolves chunk priorities across all subscribers", () => {
    // TODO
  });

  it("handles memory and device priorities separately", () => {
    // TODO
  });
});
