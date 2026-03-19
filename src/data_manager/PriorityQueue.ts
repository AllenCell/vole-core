type Entry<P, V> = {
  priority: P;
  value: V;
  heapIndex: number;
};

type ComparisonFn<P> = (i: P, j: P) => boolean;

const entryToTuple = <P, V>(entry?: Entry<P, V>): [P, V] | undefined => entry && [entry.priority, entry.value];

const parentIndexOf = (i: number) => Math.ceil(i / 2) - 1;
const childIndexOf = (i: number) => i * 2 + 1;

export class PriorityQueue<P, V> {
  private keys: Map<V, Entry<P, V>> = new Map();
  private heap: Entry<P, V>[] = [];

  private gt: ComparisonFn<P>;
  private lt: ComparisonFn<P>;

  constructor(greaterThan: ComparisonFn<P>) {
    this.gt = greaterThan;
    this.lt = (i, j) => greaterThan(j, i);
  }

  get length() {
    return this.heap.length;
  }

  /** Useful common primitive for `siftUp` and `siftDown`: compares two entries and swaps them if out of order. */
  private trySwap(entry: Entry<P, V>, swapEntry?: Entry<P, V>, shouldSwap = this.gt): boolean {
    if (swapEntry !== undefined && shouldSwap(entry.priority, swapEntry.priority)) {
      this.heap[entry.heapIndex] = swapEntry;
      const newHeapIndex = swapEntry.heapIndex;
      swapEntry.heapIndex = entry.heapIndex;
      entry.heapIndex = newHeapIndex;
      return true;
    }

    return false;
  }

  /** Moves `entry` *up* to the correct position within the heap. */
  private siftUp(entry: Entry<P, V>) {
    let parentEntry: Entry<P, V> | undefined;

    do {
      parentEntry = this.heap[parentIndexOf(entry.heapIndex)];
    } while (this.trySwap(entry, parentEntry));

    this.heap[entry.heapIndex] = entry;
  }

  /** Moves `entry` *down* to the correct position within the heap. */
  private siftDown(entry: Entry<P, V>) {
    let childEntry: Entry<P, V> | undefined;

    do {
      const childHeapIndex = childIndexOf(entry.heapIndex);
      const cEntry1 = this.heap[childHeapIndex];
      const cEntry2 = this.heap[childHeapIndex + 1];
      const use2 = cEntry1 !== undefined && cEntry2 !== undefined && this.gt(cEntry2.priority, cEntry1.priority);
      childEntry = use2 ? cEntry2 : cEntry1;
    } while (this.trySwap(entry, childEntry, this.lt));

    this.heap[entry.heapIndex] = entry;
  }

  private removeEntry(entry?: Entry<P, V>) {
    if (entry === undefined) {
      return;
    }

    this.keys.delete(entry.value);
    const siftEntry = this.heap.pop();

    if (siftEntry !== undefined && siftEntry !== entry) {
      this.heap[entry.heapIndex] = siftEntry;
      siftEntry.heapIndex = entry.heapIndex;
      this.siftDown(siftEntry);
    }
  }

  /** Updates the priority of value `value` to `newPriority`, or returns `false` if no such value is in the queue. */
  update(value: V, newPriority: P): boolean {
    const entry = this.keys.get(value);
    if (entry === undefined) {
      return false;
    }

    const priorityIncreased = this.gt(newPriority, entry.priority);
    entry.priority = newPriority;
    if (priorityIncreased) {
      this.siftUp(entry);
    } else {
      this.siftDown(entry);
    }

    return true;
  }

  /** Adds a new `value` to the queue with the given `priority`. */
  insert(value: V, priority: P) {
    if (this.update(value, priority)) {
      return;
    }

    const entry = { priority, value, heapIndex: this.heap.length };
    this.keys.set(value, entry);
    this.heap.push(entry);
    this.siftUp(entry);
  }

  /** Returns the highest-priority item in the queue, without removing it. */
  peek(): [P, V] | undefined {
    return entryToTuple(this.heap[0]);
  }

  /** Removes and returns the highest-priority item in the queue. */
  pop(): [P, V] | undefined {
    const entry = this.heap[0];
    this.removeEntry(entry);
    return entryToTuple(entry);
  }

  /** Removes the item with value `value` from the queue. */
  remove(value: V): P | undefined {
    const entry = this.keys.get(value);
    this.removeEntry(entry);
    return entry?.priority;
  }
}
