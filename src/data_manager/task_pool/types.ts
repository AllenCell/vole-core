import type { ErrorObject } from "serialize-error";

import type { TypedArray, NumberType } from "../../types.js";
import type { BorrowGuard } from "./borrow_guard.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Task<Id extends string = string, In extends any[] = any[], Out = any> = {
  taskId: Id;
  (...args: In): { result: Out; transfer: Transferable[] };
};

export type TaskHandle<In extends unknown[], Out> = {
  id: string;
  transfer?: (...args: In) => Transferable[];
  marker?: Out;
};

/**
 * Marker type for a `TypedArray` that has been *borrowed* from the main thread by a task handler.
 *
 * This type is functionally identical to the corresponding `TypedArray`. However, when it is used as an argument to a
 * *task handler*, the task must be invoked from the main thread using a matching `BorrowGuard`:
 *
 * ```typescript
 * // worker code
 * const fooTask = task("foo", (borrow: BorrowedArray<"uint8">) => { ... });
 * export type FooTask = typeof fooTask;
 * registerTask(fooTask);
 *
 * // main thread code
 * const fooTask = taskHandle<FooTask>("foo");
 * const pool = new TaskPool();
 * // Because the handler takes a `BorrowedArray`, the task must be invoked on the main thread with a `BorrowGuard`:
 * const guard = new BorrowGuard(new Uint8Array([1, 2, 3, 4, 5]));
 * const result = await pool.runTask("foo", guard);
 * ```
 *
 * When the task runs, the array inside the `BorrowGuard` is automatically *transferred* to the assigned worker, where
 * it can be safely modified in-place. When the task completes, the array is transferred back into the `BorrowGuard`.
 */
export type BorrowedArray<T extends NumberType = NumberType> = TypedArray<T> & { borrowed: true };

/** Converts all `BorrowedArray`s in a task handler's argument list to the corresponding `BorrowGuard`s */
export type TaskArgs<T> = T extends [infer E, ...infer R]
  ? E extends BorrowedArray<infer A>
    ? [BorrowGuard<TypedArray<A>>, ...TaskArgs<R>]
    : [E, ...TaskArgs<R>]
  : [];

export type WorkerRequest<T extends Task = Task> = {
  id: number;
  task: T["taskId"];
  args: Parameters<T>;
};

export type WorkerResponse<T extends Task = Task> = {
  id: number;
  task: T["taskId"];
  borrows: TypedArray[];
} & (
  | {
      error: false;
      result: ReturnType<T>["result"];
    }
  | {
      error: true;
      result: ErrorObject;
    }
);
