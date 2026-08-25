import type { NumberType, TypedArray } from "../../types.js";
import EventDispatcher from "../../EventDispatcher.js";

const guardMarker = Symbol.for("TaskPool.borrowGuard");

type BorrowGuardEvents = { restored: void };

/**
 * Wraps a `TypedArray` that may be temporarily transferred to a worker for processing.
 *
 * A `TypedArray` guarded by this class must be accessed through the `get` method, which returns `undefined` when the
 * buffer is on a worker. The guard will trigger the `"restored"` event when it is returned to the main thread.
 */
export class BorrowGuard<
  T extends TypedArray<NumberType> = TypedArray<NumberType>,
> extends EventDispatcher<BorrowGuardEvents> {
  private [guardMarker] = true as const;
  private restored = false;

  constructor(private array: T) {
    super();
  }

  get borrowed(): boolean {
    return this.array.buffer.detached;
  }

  get(): T | undefined {
    if (this.borrowed) {
      return undefined;
    }
    return this.array;
  }

  restore(array: T) {
    this.array = array;
    this.restored = true;
  }

  afterRestore() {
    if (!this.borrowed && this.restored) {
      this.restored = false;
      this.dispatchEvent({ type: "restored" });
    }
  }

  static isBorrowGuard(value: unknown): value is BorrowGuard {
    return typeof value === "object" && value !== null && value[guardMarker];
  }
}

const borrowedMarker = "TaskPool.borrowedArray";

export type BorrowedArray<T extends NumberType> = TypedArray<T> & { [borrowedMarker]: true };

export const isBorrowedArray = (value: unknown): value is BorrowedArray<NumberType> => {
  return ArrayBuffer.isView(value) && value[borrowedMarker];
};

export const markBorrowed = <T extends TypedArray<NumberType>>(value: T): { [borrowedMarker]: T } => ({
  [borrowedMarker]: value,
});

export const getBorrowed = (value: unknown): BorrowedArray<NumberType> | undefined => {
  if (typeof value === "object" && value !== null && Object.hasOwn(value, borrowedMarker)) {
    const result = value[borrowedMarker];
    if (ArrayBuffer.isView(result)) {
      return result as BorrowedArray<NumberType>;
    }
  }
  return undefined;
};

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

/** Converts all `BorrowedArray`s in an argument list to the corresponding `BorrowGuard`s */
export type TaskArgs<T> = T extends [infer E, ...infer R]
  ? E extends BorrowedArray<infer A>
    ? [BorrowGuard<TypedArray<A>>, ...TaskArgs<R>]
    : [E, ...TaskArgs<R>]
  : [];

export const taskHandle = <T extends Task>(
  id: T["taskId"] & {},
  transfer?: (...args: Parameters<T>) => Transferable[]
): TaskHandle<Parameters<T>, ReturnType<T>["result"]> => {
  return { id, transfer };
};

export type WorkerRequest<T extends Task = Task> = {
  id: number;
  task: T["taskId"];
  args: Parameters<T>;
};

export type WorkerResponse<T extends Task = Task> = {
  id: number;
  task: T["taskId"];
  borrows: TypedArray<NumberType>[];
} & (
  | {
      error: false;
      result: ReturnType<T>["result"];
    }
  | {
      error: true;
      result: unknown;
    }
);
