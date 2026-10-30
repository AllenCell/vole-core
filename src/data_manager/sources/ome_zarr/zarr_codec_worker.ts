import { type Chunk, CodecPipelineError, registry, UnknownCodecError, type CodecMetadata } from "zarrita";
import { task } from "../../task_pool/index.js";
import type { NumberType } from "../../../types.js";

type Codec<In, Out> = {
  encode: (data: In) => Out | Promise<Out>;
  decode: (data: Out) => In | Promise<In>;
};
type ArrayToArrayCodec = Codec<Chunk<NumberType>, Chunk<NumberType>>;
type ArrayToBytesCodec = Codec<Chunk<NumberType>, Uint8Array>;
type BytesToBytesCodec = Codec<Uint8Array, Uint8Array>;
type AnyCodec = ArrayToArrayCodec | ArrayToBytesCodec | BytesToBytesCodec;

// hack the private `ChunkMetadata` type out of zarrita
type CodecEntry = typeof registry extends Map<string, () => Promise<infer V>> ? V : never;
type ChunkMetadata = Parameters<CodecEntry["fromConfig"]>[1];

type CodecDescriptor = {
  id: number;
  codecs: CodecMetadata[];
  meta: ChunkMetadata;
};

const codecs = new Map<number, ArrayToBytesCodec>();

const joinCodecs = (codecs: { codec: AnyCodec; name: string }[]): ArrayToBytesCodec => {
  // Simplified version of zarrita's `createCodecPipeline`
  const runStep = async <T>(direction: "encode" | "decode", codec: string, fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (cause) {
      throw new CodecPipelineError({ direction, codec, cause });
    }
  };
  // Put codecs in bytes -> array order to prioritize decoding over encoding
  codecs.reverse();

  return {
    decode: async (data: Uint8Array): Promise<Chunk<NumberType>> => {
      let result: Uint8Array | Chunk<NumberType> = data;
      for (const { name, codec } of codecs) {
        // evil cast
        result = await runStep("decode", name, () => codec.decode(result as Chunk<NumberType> & Uint8Array));
      }
      return result as Chunk<NumberType>;
    },
    encode: async (data: Chunk<NumberType>): Promise<Uint8Array> => {
      let result: Uint8Array | Chunk<NumberType> = data;
      for (const { name, codec } of codecs.toReversed()) {
        // evil cast pt. 2
        result = await runStep("encode", name, () => codec.encode(result as Chunk<NumberType> & Uint8Array));
      }
      return result as Uint8Array;
    },
  };
};

const loadCodec = async (descriptor: CodecDescriptor): Promise<ArrayToBytesCodec> => {
  const codecPromises = descriptor.codecs.map(async ({ name, configuration }) => {
    const entry = await registry.get(name)?.();
    if (entry === undefined) {
      throw new UnknownCodecError(name);
    }
    const codec = entry.fromConfig(configuration, descriptor.meta);
    return { codec, name };
  });

  const codecs = await Promise.all(codecPromises);

  if (codecs.length === 1) {
    return codecs[0].codec;
  }
  return joinCodecs(codecs);
};

const getCodec = async (descriptor: CodecDescriptor): Promise<ArrayToBytesCodec> => {
  const savedCodec = codecs.get(descriptor.id);
  if (savedCodec !== undefined) {
    return savedCodec;
  }

  const newCodec = await loadCodec(descriptor);
  codecs.set(descriptor.id, newCodec);
  return newCodec;
};

export const encodeTask = task("zarrEncode", async (chunk: Chunk<NumberType>, descriptor: CodecDescriptor) => {
  const codec = await getCodec(descriptor);
  const result = await codec.encode(chunk);
  return { result, transfer: [result.buffer] };
});

export const decodeTask = task("zarrDecode", async (data: Uint8Array, descriptor: CodecDescriptor) => {
  const codec = await getCodec(descriptor);
  const result = await codec.decode(data);
  return { result, transfer: [result.data.buffer] };
});
