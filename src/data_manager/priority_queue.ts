type Entry<P, V> = {
  priority: P;
  value: V;
  heapIndex: number;
};

const entryToTuple = <P, V>(entry?: Entry<P, V>): [P, V] | undefined => entry && [entry.priority, entry.value];

const parentIndexOf = (i: number) => Math.ceil(i / 2) - 1;
const childIndexOf = (i: number) => i * 2 + 1;

export class PriorityQueue<P, V> {
  private keys: Map<V, Entry<P, V>> = new Map();
  private heap: Entry<P, V>[] = [];

  constructor(private compare: (a: P, b: P) => number) {}

  get length() {
    return this.heap.length;
  }

  /** Useful common primitive for `siftUp` and `siftDown`: compares two entries and swaps them if out of order. */
  private trySwap(entry: Entry<P, V>, swapEntry?: Entry<P, V>, mul = 1): boolean {
    if (swapEntry !== undefined && this.compare(entry.priority, swapEntry.priority) * mul < 0) {
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
      const cEnt1 = this.heap[childHeapIndex];
      const cEnt2 = this.heap[childHeapIndex + 1];
      const use2 = cEnt1 !== undefined && cEnt2 !== undefined && this.compare(cEnt2.priority, cEnt1.priority) < 0;
      childEntry = use2 ? cEnt2 : cEnt1;
    } while (this.trySwap(entry, childEntry, -1));

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
      if (this.compare(entry.priority, siftEntry.priority) < 0) {
        this.siftDown(siftEntry);
      } else {
        this.siftUp(siftEntry);
      }
    }
  }

  /** Updates the priority of value `value` to `newPriority`, or returns `false` if no such value is in the queue. */
  update(value: V, newPriority: P): boolean {
    const entry = this.keys.get(value);
    if (entry === undefined) {
      return false;
    }

    const priorityIncreased = this.compare(newPriority, entry.priority) < 0;
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
