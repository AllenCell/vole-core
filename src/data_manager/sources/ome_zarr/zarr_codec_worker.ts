import { CodecPipelineError, registry, UnknownCodecError, type CodecMetadata } from "zarrita";
import { task } from "../../task_pool/index.js";

type Codec = {
  encode: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  decode: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
};

// hack the private `ChunkMetadata` type out of zarrita
type CodecEntry = typeof registry extends Map<string, () => Promise<infer V>> ? V : never;
type ChunkMetadata = Parameters<CodecEntry["fromConfig"]>[1];

type CodecDescriptor = {
  id: number;
  codecs: CodecMetadata[];
  meta: ChunkMetadata;
};

const codecs = new Map<number, Codec>();

const joinCodecs = (codecs: { codec: Codec; name: string }[]): Codec => {
  // Simplified version of zarrita's `createCodecPipeline`
  const runStep = async <T>(direction: "encode" | "decode", codec: string, fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (cause) {
      throw new CodecPipelineError({ direction, codec, cause });
    }
  };
  const codecsReversed = codecs.toReversed();

  return {
    encode: async (data: Uint8Array): Promise<Uint8Array> => {
      for (const { name, codec } of codecs) {
        data = await runStep("encode", name, () => codec.encode(data));
      }
      return data;
    },
    decode: async (data: Uint8Array): Promise<Uint8Array> => {
      for (const { name, codec } of codecsReversed) {
        data = await runStep("decode", name, () => codec.decode(data));
      }
      return data;
    },
  };
};

const loadCodec = async (descriptor: CodecDescriptor): Promise<Codec> => {
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

const getCodec = async (descriptor: CodecDescriptor): Promise<Codec> => {
  const savedCodec = codecs.get(descriptor.id);
  if (savedCodec !== undefined) {
    return savedCodec;
  }

  const newCodec = await loadCodec(descriptor);
  codecs.set(descriptor.id, newCodec);
  return newCodec;
};

export const encodeTask = task("zarrEncode", async (data: Uint8Array, descriptor: CodecDescriptor) => {
  const codec = await getCodec(descriptor);
  const result = await codec.encode(data);
  return { result, transfer: [result.buffer] };
});

export const decodeTask = task("zarrDecode", async (data: Uint8Array, descriptor: CodecDescriptor) => {
  const codec = await getCodec(descriptor);
  const result = await codec.decode(data);
  return { result, transfer: [result.buffer] };
});
