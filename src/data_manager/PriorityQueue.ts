type Entry<P, V> = {
  priority: P;
  value: V;
  heapIndex: number;
};

type ComparisonFn<P> = (i: P, j: P) => boolean;

const entryToTuple = <P, V>(entry?: Entry<P, V>): [P, V] | undefined => entry && [entry.priority, entry.value];

const parentIndexOf = (i: number) => Math.ceil(i / 2) - 1;
const childIndexOf = (i: number) => i * 2 + 1;

class IndexMap<T> {
  private contents: (T | number)[] = [];
  private nextIndex = 0;

  insert(value: T): number {
    if (this.nextIndex < this.contents.length) {
      // reuse an index
      const index = this.nextIndex;
      this.nextIndex = this.contents[this.nextIndex] as number;
      this.contents[index] = value;
      return index;
    } else {
      // push onto the end
      const index = this.contents.length;
      this.contents.push(value);
      this.nextIndex += 1;
      return index;
    }
  }

  get(index: number | undefined): T | undefined {
    if (index === undefined) {
      return undefined;
    }

    const result = this.contents[index];

    if (result === undefined || typeof result === "number") {
      return undefined;
    }

    return result;
  }

  remove(index: number | undefined): T | undefined {
    const entry = this.get(index);

    if (entry === undefined) {
      return undefined;
    }

    // `get` asserts that `index` is a number
    this.contents[index as number] = this.nextIndex;
    this.nextIndex = index as number;
    return entry;
  }
}

export class PriorityQueue<P, V> {
  private contents: IndexMap<Entry<P, V>> = new IndexMap();
  private indexes: Map<V, number> = new Map();
  private heap: number[] = [];

  private gt: ComparisonFn<P>;
  private lt: ComparisonFn<P>;

  constructor(greaterThan: ComparisonFn<P>) {
    this.gt = greaterThan;
    this.lt = (i, j) => greaterThan(j, i);
  }

  get length() {
    return this.heap.length;
  }

  private trySwap(entry: Entry<P, V>, swapIndex: number, swapEntry?: Entry<P, V>, shouldSwap = this.gt): boolean {
    if (swapEntry !== undefined && shouldSwap(entry.priority, swapEntry.priority)) {
      this.heap[entry.heapIndex] = swapIndex;
      const newHeapIndex = swapEntry.heapIndex;
      swapEntry.heapIndex = entry.heapIndex;
      entry.heapIndex = newHeapIndex;
      return true;
    }

    return false;
  }

  private siftUp(index: number, entry: Entry<P, V>) {
    let parentIndex: number;
    let parentEntry: Entry<P, V> | undefined;

    do {
      const parentHeapIndex = parentIndexOf(entry.heapIndex);
      parentIndex = this.heap[parentHeapIndex];
      parentEntry = this.contents.get(parentIndex);
    } while (this.trySwap(entry, parentIndex, parentEntry));

    this.heap[entry.heapIndex] = index;
  }

  private siftDown(index: number, entry: Entry<P, V>) {
    let childIndex: number;
    let childEntry: Entry<P, V> | undefined;

    do {
      const childHeapIndex = childIndexOf(entry.heapIndex);
      const cIndex1 = this.heap[childHeapIndex];
      const cIndex2 = this.heap[childHeapIndex + 1];
      const cEntry1 = this.contents.get(cIndex1);
      const cEntry2 = this.contents.get(cIndex2);

      if (cEntry1 !== undefined && cEntry2 !== undefined && this.gt(cEntry2.priority, cEntry1.priority)) {
        childIndex = cIndex2;
        childEntry = cEntry2;
      } else {
        childIndex = cIndex1;
        childEntry = cEntry1;
      }
    } while (this.trySwap(entry, childIndex, childEntry, this.lt));

    this.heap[entry.heapIndex] = index;
  }

  private removeIndex(index: number | undefined): Entry<P, V> | undefined {
    const result = this.contents.remove(index);

    if (result === undefined) {
      return undefined;
    }

    this.indexes.delete(result.value);

    // Replace the removed entry with the last in the heap, then sift it back down
    const siftIndex = this.heap.pop() as number;
    this.heap[result.heapIndex] = siftIndex;
    const siftedEntry = this.contents.get(siftIndex);
    if (siftedEntry !== undefined) {
      // TODO don't like this. rework?
      siftedEntry.heapIndex = result.heapIndex;
      this.siftDown(siftIndex, siftedEntry);
    }

    return result;
  }

  insert(priority: P, value: V) {
    const entry = { priority, value, heapIndex: this.heap.length };
    const index = this.contents.insert(entry);
    this.indexes.set(value, index);
    this.heap.push(index);
    this.siftUp(index, entry);
  }

  update(value: V, newPriority: P): boolean {
    const index = this.indexes.get(value);
    const entry = this.contents.get(index);
    if (entry === undefined || index === undefined) {
      return false;
    }

    const priorityIncreased = this.gt(newPriority, entry.priority);
    entry.priority = newPriority;
    if (priorityIncreased) {
      this.siftUp(index, entry);
    } else {
      this.siftDown(index, entry);
    }

    return true;
  }

  peek(): [P, V] | undefined {
    const entry = this.contents.get(this.heap[0]);
    if (entry === undefined) {
      return undefined;
    }

    return entryToTuple(entry);
  }

  pop(): [P, V] | undefined {
    return entryToTuple(this.removeIndex(this.heap[0]));
  }

  remove(value: V): P | undefined {
    const index = this.indexes.get(value);
    return this.removeIndex(index)?.priority;
  }
}
