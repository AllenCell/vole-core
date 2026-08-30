import EventDispatcher from "../EventDispatcher.js";

const EVENT_NAME = "test";

class Test extends EventDispatcher<{ test: void }> {
  test() {
    this.dispatchEvent({ type: EVENT_NAME });
  }
}

describe("EventDispatcher", () => {
  it("can add, remove, and dispatch events", () => {
    let count1 = 0;
    let count2 = 0;
    const inc1 = () => (count1 += 1);
    const inc2 = ({ type }) => {
      expect(type).toEqual(EVENT_NAME);
      count2 += 1;
    };
    const test = new Test();

    test.addEventListener(EVENT_NAME, inc1);
    test.test();
    expect(count1).toEqual(1);
    expect(count2).toEqual(0);

    test.addEventListener(EVENT_NAME, inc2);
    test.test();
    expect(count1).toEqual(2);
    expect(count2).toEqual(1);

    test.removeEventListener(EVENT_NAME, inc1);
    test.test();
    expect(count1).toEqual(2);
    expect(count2).toEqual(2);
  });
});
