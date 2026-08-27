import SubscribableRequestQueue from "../utils/SubscribableRequestQueue.js";

const TIMEOUT = 10;
const LONG_TIMEOUT = 20;

/** Returns a promise that resolves after `timeoutMs` milliseconds with value `result`. */
function delay<T>(timeoutMs: number, result: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(result), timeoutMs));
}

/** Returns a promise that rejects after `timeoutMs` milliseconds with reason `reason`. */
function delayReject(timeoutMs: number, reason: unknown): Promise<unknown> {
  return new Promise((_, reject) => setTimeout(() => reject(reason), timeoutMs));
}

/** Determines whether a promise has rejected. */
// From https://gist.github.com/tyru/29360dfa475d2fefaf6c4655a93c2cb0
function isRejected(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    delay(0, false),
    promise.then(
      () => false,
      () => true
    ),
  ]);
}

describe("SubscribableRequestQueue", () => {
  describe("addSubscriber", () => {
    it("adds a subscriber", () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();
      expect(queue.hasSubscriber(id)).to.be.true;
    });

    it("returns unique ids", () => {
      const queue = new SubscribableRequestQueue();
      const id1 = queue.addSubscriber();
      const id2 = queue.addSubscriber();
      expect(id1).to.not.equal(id2);
    });

    it("never reuses ids of removed subscribers", () => {
      const queue = new SubscribableRequestQueue();
      const id1 = queue.addSubscriber();
      const id2 = queue.addSubscriber();
      queue.removeSubscriber(id1);
      const id3 = queue.addSubscriber();
      expect(id1).to.not.equal(id2);
      expect(id3).to.not.equal(id2);
    });
  });

  describe("addRequestToQueue", () => {
    it("queues a request", async () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();
      const promise = queue.addRequest("test", id, () => delay(TIMEOUT, "foo"));
      expect(queue.hasRequest("test")).to.be.true;
      const result = await promise;
      expect(result).to.equal("foo");
    });

    it("does not queue a request if the subscriber id is invalid", () => {
      const queue = new SubscribableRequestQueue();
      expect(() => queue.addRequest("test", -1, () => delay(TIMEOUT, "foo"))).to.throw();
      expect(() => queue.addRequest("test", 0, () => delay(TIMEOUT, "foo"))).to.throw();
    });

    it("does not queue a request if the subscriber has been deleted", () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();
      queue.removeSubscriber(id);
      expect(() => queue.addRequest("test", id, () => delay(TIMEOUT, "foo"))).to.throw();
    });

    it("creates unique promises without duplicating work when two subscribers queue the same key", async () => {
      const queue = new SubscribableRequestQueue();
      const id1 = queue.addSubscriber();
      const id2 = queue.addSubscriber();

      const promise1 = queue.addRequest("test", id1, () => delay(TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test", id2, () => delay(TIMEOUT, "bar"));
      expect(queue.hasRequest("test")).to.be.true;
      expect(promise1).to.not.equal(promise2);

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).to.equal("foo");
      expect(result2).to.equal("foo");
    });

    it("creates different requests when one subscriber queues two keys", async () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();

      const promise1 = queue.addRequest("test1", id, () => delay(TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test2", id, () => delay(TIMEOUT, "bar"));
      expect(queue.hasRequest("test1")).to.be.true;
      expect(queue.hasRequest("test2")).to.be.true;
      expect(promise1).to.not.equal(promise2);

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).to.equal("foo");
      expect(result2).to.equal("bar");
    });

    it("allows a subscriber to queue the same key twice", async () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();

      const promise1 = queue.addRequest("test", id, () => delay(TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test", id, () => delay(TIMEOUT, "bar"));
      expect(queue.hasRequest("test")).to.be.true;
      expect(promise1).to.not.equal(promise2);
      const result2 = await promise2;
      expect(result2).to.equal("foo");
      const result1 = await promise1;
      expect(result1).to.equal("foo");
    });

    it("allows multiple rejections when the same key is queued multiple times by the same subscriber", async () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();

      const promise1 = queue.addRequest("test", id, () => delayReject(TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test", id, () => delayReject(TIMEOUT, "bar"));
      expect(queue.hasRequest("test")).to.be.true;
      expect(promise1).to.not.equal(promise2);
      let promise1RejectReason = "",
        promise2RejectReason = "";
      promise1.catch((reason) => (promise1RejectReason = reason));
      promise2.catch((reason) => (promise2RejectReason = reason));

      await Promise.allSettled([promise1, promise2]);
      expect(promise1RejectReason).to.equal("foo");
      expect(promise2RejectReason).to.equal("foo");
    });

    it("passes request rejections to all subscribers", async () => {
      const queue = new SubscribableRequestQueue();
      const id1 = queue.addSubscriber();
      const id2 = queue.addSubscriber();

      const promise1 = queue.addRequest("test", id1, () => delayReject(TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test", id2, () => delay(TIMEOUT, "bar"));
      expect(queue.hasRequest("test")).to.be.true;
      let promise1RejectReason = "",
        promise2RejectReason = "";
      promise1.catch((reason) => (promise1RejectReason = reason));
      promise2.catch((reason) => (promise2RejectReason = reason));

      await Promise.allSettled([promise1, promise2]);
      expect(promise1RejectReason).to.equal("foo");
      expect(promise2RejectReason).to.equal("foo");
    });

    it("completes requests in order when max requests is set", async () => {
      const queue = new SubscribableRequestQueue(1);
      const id = queue.addSubscriber();

      const promise1 = queue.addRequest("test1", id, () => delay(TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test2", id, () => delay(LONG_TIMEOUT, "bar"));
      expect(queue.hasRequest("test1")).to.be.true;
      expect(queue.hasRequest("test2")).to.be.true;
      expect(queue.requestRunning("test1")).to.be.true;
      expect(queue.requestRunning("test2")).to.be.false;

      const result1 = await promise1;
      expect(result1).to.equal("foo");
      expect(queue.hasRequest("test1")).to.be.false;
      expect(queue.hasRequest("test2")).to.be.true;
      expect(queue.requestRunning("test2")).to.be.true;

      const result2 = await promise2;
      expect(result2).to.equal("bar");
      expect(queue.hasRequest("test2")).to.be.false;
    });
  });

  describe("cancelRequest", () => {
    it("cancels a request subscription", async () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();
      const promise = queue.addRequest("test", id, () => delay(TIMEOUT, "foo"));
      expect(queue.hasRequest("test")).to.be.true;
      expect(queue.isSubscribed(id, "test")).to.be.true;

      const cancelResult = queue.cancelRequest("test", id);
      expect(cancelResult).to.be.true;
      expect(queue.isSubscribed(id, "test")).to.be.false;
      expect(await isRejected(promise)).to.be.true;
      expect(queue.cancelRequest("test", id)).to.be.false;
    });

    it("aborts a request even if it is running", async () => {
      // Arrange
      const queue = new SubscribableRequestQueue();
      const id1 = queue.addSubscriber();
      const id2 = queue.addSubscriber();
      const abort = vi.fn();

      const promise1 = queue.addRequest("test", id1, () => delay(TIMEOUT, "foo"), undefined, undefined, abort);
      expect(queue.hasRequest("test")).to.be.true;
      expect(queue.requestRunning("test")).to.be.true;
      expect(queue.isSubscribed(id1, "test")).to.be.true;
      expect(queue.isSubscribed(id2, "test")).to.be.false;

      // Act
      queue.cancelRequest("test", id1);
      // Assert
      expect(queue.hasRequest("test")).to.be.false;
      expect(queue.isSubscribed(id1, "test")).to.be.false;
      expect(await isRejected(promise1)).to.be.true;
      expect(abort).toHaveBeenCalled();

      // Act
      const promise2 = queue.addRequest("test", id2, () => delay(TIMEOUT, "bar"));
      // Assert
      expect(queue.isSubscribed(id2, "test")).to.be.true;
      const result = await promise2;
      expect(result).to.equal("bar");
    });

    it("does not cancel an underlying request if it has another subscription", async () => {
      const queue = new SubscribableRequestQueue(1);
      const id1 = queue.addSubscriber();
      const id2 = queue.addSubscriber();
      // `block` keeps the queue full, to keep `test` from running
      const block = queue.addRequest("block", id1, () => delay(TIMEOUT, undefined));

      const promise1 = queue.addRequest("test", id1, () => delay(LONG_TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test", id2, () => delay(LONG_TIMEOUT, "bar"));
      expect(queue.hasRequest("test")).to.be.true;
      expect(queue.requestRunning("test")).to.be.false;
      expect(queue.isSubscribed(id1, "test")).to.be.true;
      expect(queue.isSubscribed(id2, "test")).to.be.true;

      queue.cancelRequest("test", id1);
      expect(queue.hasRequest("test")).to.be.true;
      expect(queue.isSubscribed(id1, "test")).to.be.false;
      expect(queue.isSubscribed(id2, "test")).to.be.true;
      expect(await isRejected(promise1)).to.be.true;

      await block;
      expect(queue.requestRunning("test")).to.be.true;
      const result = await promise2;
      expect(result).to.equal("foo");
    });

    it("cancels an underlying request if it is waiting and has no other subscriptions", async () => {
      const queue = new SubscribableRequestQueue(1);
      const id = queue.addSubscriber();
      // `block` keeps the queue full, to keep `test` from running
      queue.addRequest("block", id, () => delay(TIMEOUT, undefined));

      const promise = queue.addRequest("test", id, () => delay(LONG_TIMEOUT, "foo"));
      expect(queue.hasRequest("test")).to.be.true;
      expect(queue.requestRunning("test")).to.be.false;
      expect(queue.isSubscribed(id, "test")).to.be.true;

      queue.cancelRequest("test", id);
      expect(await isRejected(promise)).to.be.true;
      expect(queue.hasRequest("test")).to.be.false;
      expect(queue.isSubscribed(id, "test")).to.be.false;
    });

    it("keeps a reissued request tracked when another request is canceled", async () => {
      // Arrange
      const queue = new SubscribableRequestQueue();
      const firstSubscriber = queue.addSubscriber();
      const controller = new AbortController();

      queue
        .addRequest(
          "same-key",
          firstSubscriber,
          () =>
            new Promise<void>((_, reject) => {
              // Note: in practice, it's possible that a real fetch would take some
              // time between receiving the abort signal and rejecting the promise.
              controller.signal.addEventListener("abort", reject);
            }),
          undefined,
          undefined,
          () => controller.abort()
        )
        .catch(() => undefined);

      // Act
      queue.removeSubscriber(firstSubscriber); // Triggers abort()

      let resolveSecond: () => void = () => undefined;
      const second = queue.addRequest(
        "same-key",
        queue.addSubscriber(),
        () => new Promise<void>((resolve) => (resolveSecond = resolve))
      );
      const handledSecond = second.catch(() => undefined);

      await delay(0, undefined); // Wait for the abort signal to trigger reject()

      try {
        // Assert
        expect(queue.hasRequest("same-key")).to.be.true;
        expect(queue.requestRunning("same-key")).to.be.true;
      } finally {
        // Cleanup
        resolveSecond();
        await handledSecond;
      }
    });
  });

  describe("removeSubscriber", () => {
    it("removes a subscriber", async () => {
      const queue = new SubscribableRequestQueue();
      const id = queue.addSubscriber();
      expect(queue.hasSubscriber(id)).to.be.true;
      queue.removeSubscriber(id);
      expect(queue.hasSubscriber(id)).to.be.false;
    });

    it("cancels all subscriptions from a removed subscriber", async () => {
      const queue = new SubscribableRequestQueue();
      const id1 = queue.addSubscriber();
      const id2 = queue.addSubscriber();

      const promise1 = queue.addRequest("test", id1, () => delay(TIMEOUT, "foo"));
      const promise2 = queue.addRequest("test2", id1, () => delay(TIMEOUT, "bar"));
      const promise3 = queue.addRequest("test", id2, () => delay(TIMEOUT, "foo"));
      expect(queue.hasRequest("test")).to.be.true;
      expect(queue.isSubscribed(id1, "test")).to.be.true;
      expect(queue.isSubscribed(id2, "test")).to.be.true;

      queue.removeSubscriber(id1);
      expect(queue.hasRequest("test")).to.be.true;
      expect(queue.isSubscribed(id1, "test")).to.be.false;
      expect(queue.isSubscribed(id1, "test2")).to.be.false;
      expect(await isRejected(promise1)).to.be.true;
      expect(await isRejected(promise2)).to.be.true;
      expect(await isRejected(promise3)).to.be.false;
    });
  });
});
