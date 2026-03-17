type Entry<P, V> = {
  priority: P;
  value: V;
  heapIndex: number;
};

const entryToTuple = <P, V>(entry?: Entry<P, V>): [P, V] | undefined => entry && [entry.priority, entry.value];

const parentIndexOf = (i: number) => Math.ceil(i / 2) - 1;
const childIndexOf = (i: number) => i * 2 + 1;

export class PriorityQueue<P, V> {
  private contents: (Entry<P, V> | number)[];
  private indexes: Map<V, number>;
  private heap: number[];
  private nextIndex: number;
  private compare: (i: P, j: P) => boolean;

  constructor(compare: (i: P, j: P) => boolean) {
    this.compare = compare;
    this.contents = [];
    this.indexes = new Map();
    this.heap = [];
    this.nextIndex = 0;
  }

  get length() {
    return this.heap.length;
  }

  private siftUp(entry: Entry<P, V>) {
    // TODO
  }

  private siftDown(heapIndex: number) {
    // TODO
  }

  private removeIndex(index: number | undefined): Entry<P, V> | undefined {
    if (index === undefined) {
      return undefined;
    }

    const result = this.contents[index];
    if (typeof result === "number") {
      return undefined;
    }

    this.indexes.delete(result.value);
    this.contents[index] = this.nextIndex;
    this.nextIndex = index;
    this.heap[result.heapIndex] = this.heap.pop() as number;
    this.siftDown(result.heapIndex);

    return result;
  }

  insert(priority: P, value: V) {
    const index = this.nextIndex;
    const entry = { priority, value, heapIndex: this.length };

    if (index < this.contents.length) {
      // reuse an index
      const nextFree = this.contents[this.nextIndex] as number;
      this.contents[this.nextIndex] = entry;
      this.nextIndex = nextFree;
    } else {
      // push onto the end
      this.contents.push(entry);
      this.nextIndex += 1;
    }

    this.indexes.set(value, index);
    this.heap.push(index);
    this.siftUp(entry);
  }

  update(value: V, newPriority: P): boolean {
    const index = this.indexes.get(value);
    if (index === undefined) {
      return false;
    }

    const entry = this.contents[index];
    if (typeof entry === "number") {
      return false;
    }

    const priorityIncreased = this.compare(newPriority, entry.priority);
    entry.priority = newPriority;
    if (priorityIncreased) {
      this.siftUp(entry);
    } else {
      this.siftDown(entry.heapIndex);
    }

    return true;
  }

  // peek(): [P, V] {
  //   return this.contents[this.heap[0]] as [P, V];
  // }

  pop(): [P, V] | undefined {
    const index = this.heap[0];
    return entryToTuple(this.removeIndex(index));
  }

  remove(value: V): P | undefined {
    const index = this.indexes.get(value);
    return this.removeIndex(index)?.priority;
  }
}
