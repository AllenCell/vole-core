type Entry<P, V> = {
  priority: P;
  value: V;
  heapIndex: number;
};

type ComparisonFn<P> = (i: P, j: P) => boolean;

const entryToTuple = <P, V>(entry?: Entry<P, V>): [P, V] | undefined => entry && [entry.priority, entry.value];

const parentIndexOf = (i: number) => Math.ceil(i / 2) - 1;
const childIndexOf = (i: number) => i * 2 + 1;

// class IndexMap<T> {
//   private contents: (T | number)[] = [];
//   private nextIndex = 0;

//   insert(value: T): number {
//     if (this.nextIndex < this.contents.length) {
//       // reuse an index
//       const index = this.nextIndex;
//       this.nextIndex = this.contents[this.nextIndex] as number;
//       this.contents[index] = value;
//       return index;
//     } else {
//       // push onto the end
//       const index = this.contents.length;
//       this.contents.push(value);
//       this.nextIndex += 1;
//       return index;
//     }
//   }

//   get(index: number | undefined): T | undefined {
//     if (index === undefined) {
//       return undefined;
//     }

//     const result = this.contents[index];

//     if (result === undefined || typeof result === "number") {
//       return undefined;
//     }

//     return result;
//   }

//   remove(index: number | undefined): T | undefined {
//     const entry = this.get(index);

//     if (entry === undefined) {
//       return undefined;
//     }

//     // `get` asserts that `index` is a number
//     this.contents[index as number] = this.nextIndex;
//     this.nextIndex = index as number;
//     return entry;
//   }
// }

export class PriorityQueue<P, V> {
  // private contents: IndexMap<Entry<P, V>> = new IndexMap();
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

  private siftUp(entry: Entry<P, V>) {
    let parentEntry: Entry<P, V> | undefined;

    do {
      parentEntry = this.heap[parentIndexOf(entry.heapIndex)];
    } while (this.trySwap(entry, parentEntry));

    this.heap[entry.heapIndex] = entry;
  }

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

  insert(priority: P, value: V) {
    const entry = { priority, value, heapIndex: this.heap.length };
    this.keys.set(value, entry);
    this.heap.push(entry);
    this.siftUp(entry);
  }

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

  peek(): [P, V] | undefined {
    return entryToTuple(this.heap[0]);
  }

  pop(): [P, V] | undefined {
    const entry = this.heap[0];
    this.removeEntry(entry);
    return entryToTuple(entry);
  }

  remove(value: V): P | undefined {
    const entry = this.keys.get(value);
    this.removeEntry(entry);
    return entry?.priority;
  }
}
