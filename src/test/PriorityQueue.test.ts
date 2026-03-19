import { PriorityQueue } from "../data_manager/PriorityQueue.js";

const setup = (): [PriorityQueue<number, string>, Map<number, string>, number[]] => {
  const queue = new PriorityQueue<number, string>((i, j) => i > j);
  const entryMap = new Map<number, string>();
  const priorities: number[] = [];

  for (let i = 0; i < 100; i++) {
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
    const [queue, entryMap, priorities] = setup();

    const removed = priorities.slice(0, 5);
    const rest = priorities.slice(5);

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
});
