import { serializeError } from "serialize-error";

import type { TypedArray, NumberType } from "../../types.js";
import { getBorrowed } from "./borrow_guard.js";
import type { Task, TaskResult, WorkerRequest, WorkerResponse } from "./types.js";

/**
 * Combines a `string` task `id` and a `handler` into a `Task` that can be registered and called with a `TaskPool`.
 *
 * Modules that define tasks that can be run on a worker should export the task handler wrapped in this function:
 *
 * ```
 * // add_task.ts
 * export const addTask = task("add", (a: number, b: number) => a + b);
 * ```
 *
 * To create a task pool and run this task, first create a worker module that passes the task to `initWorker`:
 *
 * ```
 * // worker.ts
 * import { addTask } from "./add_task.js";
 * initWorker([addTask]);
 * ```
 *
 * Passing the url of this module to a new `TaskPool` creates a pool that can recognize and run this task. Main thread
 * code should import *only* the task's type and use it to create a `TaskHandle`, which can be used to run the task:
 *
 * ```
 * // main.ts
 * import type { AddTask } from "./add_task.js";
 * const addTask = taskHandle<AddTask>("add");
 * const pool = new TaskPool(new URL(./worker.ts, import.meta.url));
 * const three = await pool.runTask(addTask, 1, 2);
 * ```
 */
export const task = <Id extends string, In extends unknown[], Out>(
  id: Id,
  handler: (...args: In) => TaskResult<Out>
): Task<Id, In, Out> => {
  const task = handler as Task<Id, In, Out>;
  task.taskId = id;
  return task;
};

export const initWorker = (tasks: Task[]) => {
  const handlers = new Map(tasks.map((task) => [task.taskId, task]));

  const runTask = async ({ id, task, args }: WorkerRequest): Promise<[WorkerResponse, Transferable[]]> => {
    const handler = handlers.get(task);

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
      const { result, transfer } = await handler(...processedArgs);
      return [{ id, task, borrows, result, error: false }, [...borrowedBuffers, ...transfer]];
    } catch (e) {
      const result = serializeError(e);
      return [{ id, task, borrows, result, error: true }, borrowedBuffers];
    }
  };

  self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
    const [result, transfer] = await runTask(data);
    self.postMessage(result, { transfer });
  };

  self.postMessage(null);
};
