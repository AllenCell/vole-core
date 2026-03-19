import { PriorityQueue } from "../data_manager/PriorityQueue.js";

describe("PriorityQueue", () => {
  it("pops items in priority order", () => {
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

    priorities.sort((a, b) => b - a);
    for (const priority of priorities) {
      expect(queue.pop()?.[1]).to.equal(entryMap.get(priority));
    }
    expect(queue.pop()).to.equal(undefined);
  });
});
