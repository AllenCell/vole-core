import type { NumberType, TypedArray } from "../../types.js";
import EventDispatcher from "../../EventDispatcher.js";
import { BorrowedArray } from "./types.js";

const guardMarker = Symbol.for("TaskPool.borrowGuard");

type BorrowGuardEvents = { restored: void };

/**
 * Wraps a `TypedArray` that may be temporarily transferred to a worker for processing.
 *
 * A `TypedArray` guarded by this class must be accessed through the `get` method, which returns `undefined` when the
 * buffer is on a worker. The guard will trigger the `"restored"` event when it is returned to the main thread.
 */
export class BorrowGuard<T extends TypedArray = TypedArray> extends EventDispatcher<BorrowGuardEvents> {
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

  getAsync(): Promise<T> {
    if (this.borrowed) {
      return new Promise((resolve) => {
        const listener = () => {
          if (!this.borrowed) {
            resolve(this.array);
          }
          this.removeEventListener("restored", listener);
        };
        this.addEventListener("restored", listener);
      });
    }
    return Promise.resolve(this.array);
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
