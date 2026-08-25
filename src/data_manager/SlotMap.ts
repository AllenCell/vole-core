const NEXT_FREE = Symbol("SlotMap.nextFree");

type Slot<T> = T | { [NEXT_FREE]: number };

const isFreeSlot = <T>(slot: Slot<T>): slot is { [NEXT_FREE]: number } => {
  return slot !== undefined && slot !== null && Object.hasOwn(slot, NEXT_FREE);
};

export default class SlotMap<T> {
  private slots: Slot<T>[] = [];
  private head = 0;

  public insert(value: T): number {
    if (this.head < this.slots.length) {
      const freeSlot = this.slots[this.head];
      if (!isFreeSlot(freeSlot)) {
        // should never happen
        throw new Error(`SlotMap: free list head (${this.head}) points to occupied slot`);
      }

      const index = this.head;
      this.head = freeSlot[NEXT_FREE];
      this.slots[index] = value;
      return index;
    }

    const index = this.slots.length;
    this.slots.push(value);
    this.head = this.slots.length;
    return index;
  }

  public get(index: number): T | undefined {
    if (index >= this.slots.length) {
      return undefined;
    }
    const slot = this.slots[index];
    if (isFreeSlot(slot)) {
      return undefined;
    }
    return slot;
  }

  public remove(index: number): T | undefined {
    const value = this.get(index);
    if (value === undefined) {
      return undefined;
    }
    this.slots[index] = { [NEXT_FREE]: this.head };
    this.head = index;
    return value;
  }
}
