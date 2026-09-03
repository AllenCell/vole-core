import { registry, UnknownCodecError } from "zarrita";
import { registerTask, task } from "./task_pool/registry.js";

type Codec = {
  encode: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  decode: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
};

// hack the private `ChunkMetadata` type out of zarrita
type CodecEntry = typeof registry extends Map<string, () => Promise<infer V>> ? V : never;
type ChunkMetadata = Parameters<CodecEntry["fromConfig"]>[1];

type CodecDescriptor = {
  id: number;
  name: string;
  config: unknown;
  meta: ChunkMetadata;
};

const codecs: Map<number, Codec> = new Map();

const getCodec = async (descriptor: CodecDescriptor): Promise<Codec> => {
  const savedCodec = codecs.get(descriptor.id);
  if (savedCodec !== undefined) {
    return savedCodec;
  }

  const entry = await registry.get(descriptor.name)?.();
  if (entry === undefined) {
    throw new UnknownCodecError(descriptor.name);
  }

  const newCodec = entry.fromConfig(descriptor.config, descriptor.meta);
  codecs.set(descriptor.id, newCodec);
  return newCodec;
};

const encodeTask = task("zarrEncode", async (data: Uint8Array, descriptor: CodecDescriptor) => {
  const codec = await getCodec(descriptor);
  const result = await codec.encode(data);
  return { result, transfer: [result.buffer] };
});

const decodeTask = task("zarrDecode", async (data: Uint8Array, descriptor: CodecDescriptor) => {
  const codec = await getCodec(descriptor);
  const result = await codec.decode(data);
  return { result, transfer: [result.buffer] };
});

export type ZarrEncodeTask = typeof encodeTask;
export type ZarrDecodeTask = typeof decodeTask;

registerTask(encodeTask);
registerTask(decodeTask);
