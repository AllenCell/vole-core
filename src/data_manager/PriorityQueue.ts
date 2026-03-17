type Entry<P, V> = {
  priority: P;
  value: V;
  heapIndex: number;
};

const entryToTuple = <P, V>(entry?: Entry<P, V>): [P, V] | undefined => entry && [entry.priority, entry.value];

const parentIndexOf = (i: number) => Math.ceil(i / 2) - 1;
const childIndexOf = (i: number) => i * 2 + 1;

class IndexMap<T extends Exclude<unknown, number | undefined>> {
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
  private contents: IndexMap<Entry<P, V>>;
  private indexes: Map<V, number>;
  private heap: number[];

  constructor(private compare: (i: P, j: P) => boolean) {
    this.contents = new IndexMap();
    this.indexes = new Map();
    this.heap = [];
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
    const result = this.contents.remove(index);

    if (result === undefined) {
      return undefined;
    }

    this.indexes.delete(result.value);
    this.heap[result.heapIndex] = this.heap.pop() as number;
    this.siftDown(result.heapIndex);

    return result;
  }

  insert(priority: P, value: V) {
    const entry = { priority, value, heapIndex: this.heap.length };
    const index = this.contents.insert(entry);
    this.indexes.set(value, index);
    this.heap.push(index);
    this.siftUp(entry);
  }

  update(value: V, newPriority: P): boolean {
    const index = this.indexes.get(value);
    if (index === undefined) {
      return false;
    }

    const entry = this.contents.get(index);
    if (entry === undefined) {
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
