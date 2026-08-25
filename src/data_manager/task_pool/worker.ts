import { serializeError } from "serialize-error";

import { TASK_HANDLERS } from "./registry.js";
import { getBorrowed, type WorkerRequest, type WorkerResponse } from "./task.js";
import type { TypedArray, NumberType } from "../../types.js";

import "./test_task.js";

const runTask = ({ id, task, args }: WorkerRequest): [WorkerResponse, Transferable[]] => {
  const handler = TASK_HANDLERS.get(task);

  // Extract borrowed `TypedArray`s, which must be returned to the main thread on completion
  const borrows: TypedArray<NumberType>[] = [];
  const borrowedBuffers: ArrayBuffer[] = [];
  const processedArgs = args.map((arg) => {
    const borrowed = getBorrowed(arg);
    if (borrowed !== undefined) {
      borrows.push(borrowed);
      borrowedBuffers.push(borrowed.buffer);
      return borrowed;
    }
    return arg;
  });

  if (handler === undefined) {
    const result = serializeError(new Error(`TaskPool: tried to run nonexistent task ${task}`));
    return [{ id, task, borrows, result, error: true }, borrowedBuffers];
  }

  try {
    const { result, transfer } = handler(...processedArgs);
    return [{ id, task, borrows, result, error: false }, [...borrowedBuffers, ...transfer]];
  } catch (e) {
    const result = serializeError(e);
    return [{ id, task, borrows, result, error: true }, borrowedBuffers];
  }
};

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const [result, transfer] = runTask(data);
  self.postMessage(result, { transfer });
};

self.postMessage(null);
