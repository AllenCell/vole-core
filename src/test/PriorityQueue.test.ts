import { PriorityQueue } from "../data_manager/PriorityQueue.js";

const ENTRY_COUNT = 100;

const setup = (): [PriorityQueue<number, string>, Map<number, string>, number[]] => {
  const queue = new PriorityQueue<number, string>((i, j) => i > j);
  const entryMap = new Map<number, string>();
  const priorities: number[] = [];

  for (let i = 0; i < ENTRY_COUNT; i++) {
    const priority = Math.random();
    const key = i.toString();
    queue.insert(priority, key);
    entryMap.set(priority, key);
    priorities.push(priority);
  }

  return [queue, entryMap, priorities];
};

const sort = (priorities: number[]) => priorities.sort((a, b) => b - a);

describe("PriorityQueue", () => {
  it("pops items in priority order", () => {
    const [queue, entryMap, priorities] = setup();
    sort(priorities);

    for (const priority of priorities) {
      expect(queue.pop()?.[1]).to.equal(entryMap.get(priority));
    }
    expect(queue.pop()).to.equal(undefined);
  });

  it("keeps items in order after some have been removed", () => {
    const REMOVE_COUNT = 10;
    const [queue, entryMap, priorities] = setup();

    const removed = priorities.slice(0, REMOVE_COUNT);
    const rest = priorities.slice(REMOVE_COUNT);

    for (const p of removed) {
      const key = entryMap.get(p) as string;
      const removedPriority = queue.remove(key);
      expect(removedPriority).to.equal(p);
    }

    sort(rest);
    for (const p of rest) {
      expect(queue.pop()?.[1]).to.equal(entryMap.get(p));
    }
    expect(queue.pop()).to.equal(undefined);
  });

  it("sorts items correctly when their priorities change", () => {
    const [queue, entryMap, priorities] = setup();

    const newPriorities = priorities.map((_, i) => {
      const key = i.toString();
      const newPriority = Math.random();
      queue.update(key, newPriority);
      entryMap.set(newPriority, key);
      return newPriority;
    });

    sort(newPriorities);
    for (const p of newPriorities) {
      expect(queue.pop()?.[1]).to.equal(entryMap.get(p));
    }
    expect(queue.pop()).to.equal(undefined);
  });
});
