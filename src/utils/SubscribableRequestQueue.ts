import RequestQueue from "./RequestQueue.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resolver = (value?: any) => void;
type Rejecter = (reason?: unknown) => void;

type RequestSubscription = {
  subscriberId: number;
  resolve: Resolver;
  reject: Rejecter;
};

/**
 * An extension of `RequestQueue` that adds a concept of "subscribers," which may share references to a single request
 * or cancel their subscription without disrupting the request for other subscribers.
 */
export default class SubscribableRequestQueue {
  private queue: RequestQueue;

  /** The next unused subscriber ID. Increments whenever a subscriber is added. */
  private nextSubscriberId: number;
  /**
   * Map of subscribers keyed by ID. Subscribers store a map to all their subscriptions by request key.
   * Subscribers are only useful as handles to cancel subscriptions early, so we only need to store rejecters here.
   */
  private subscribers: Map<number, Map<string, Rejecter[]>>;
  /** Map from "inner" request (managed by `queue`) to "outer" promises generated per-subscriber. */
  private requests: Map<string, RequestSubscription[]>;

  /**
   * Since `SubscribableRequestQueue` wraps `RequestQueue`, its constructor may either take the same arguments as the
   * `RequestQueue` constructor and create a new `RequestQueue`, or it may take an existing `RequestQueue` to wrap.
   */
  constructor(maxActiveRequests?: number, maxLowPriorityRequests?: number);
  constructor(inner: RequestQueue);
  constructor(maxActiveRequests?: number | RequestQueue, maxLowPriorityRequests?: number) {
    if (typeof maxActiveRequests === "number" || maxActiveRequests === undefined) {
      this.queue = new RequestQueue(maxActiveRequests, maxLowPriorityRequests);
    } else {
      this.queue = maxActiveRequests;
    }
    this.nextSubscriberId = 0;
    this.subscribers = new Map();
    this.requests = new Map();
  }

  /** Resolves all subscriptions to request `key` with `value` */
  private resolveAll<T>(key: string, value: T): void {
    const requests = this.requests.get(key);
    if (requests) {
      for (const { resolve, subscriberId } of requests) {
        resolve(value);
        this.subscribers.get(subscriberId)?.delete(key);
      }
      this.requests.delete(key);
    }
  }

  /** Rejects all subscriptions to request `key` with `reason` */
  private rejectAll(key: string, reason: unknown): void {
    const requests = this.requests.get(key);
    if (requests) {
      for (const { reject, subscriberId } of requests) {
        reject(reason);
        this.subscribers.get(subscriberId)?.delete(key);
      }
      this.requests.delete(key);
    }
  }

  /** Adds a new request subscriber. Returns a unique ID to identify this subscriber. */
  addSubscriber(): number {
    const subscriberId = this.nextSubscriberId;
    this.nextSubscriberId++;
    this.subscribers.set(subscriberId, new Map());
    return subscriberId;
  }

  /**
   * Queues a new request, or adds a subscription if the request is already queued/running.
   *
   * If `subscriberId` is already subscribed to the request, this rejects the existing promise and returns a new one.
   */
  addRequest<T>(
    key: string,
    subscriberId: number,
    requestAction: () => Promise<T>,
    lowPriority?: boolean,
    delayMs?: number,
    abortAction?: () => void,
  ): Promise<T> {
    // Create single underlying request if it does not yet exist
    this.queue
      .addRequest(key, requestAction, lowPriority, delayMs, abortAction)
      .then((value) => this.resolveAll(key, value))
      .catch((reason) => this.rejectAll(key, reason));

    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }

    // Validate subscriber
    if (subscriberId >= this.nextSubscriberId || subscriberId < 0) {
      throw new Error(`SubscribableRequestQueue: subscriber id ${subscriberId} has not been registered`);
    }
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) {
      throw new Error(`SubscribableRequestQueue: subscriber id ${subscriberId} has been removed`);
    }

    // Create promise and add to list of requests
    return new Promise<T>((resolve, reject) => {
      this.requests.get(key)?.push({ resolve, reject, subscriberId });
      const subscriber = this.subscribers.get(subscriberId);
      const existingRequest = subscriber?.get(key);
      if (existingRequest) {
        existingRequest.push(reject);
      } else {
        subscriber?.set(key, [reject]);
      }
    });
  }

  /**
   * Rejects a subscription and removes it from the list of subscriptions for a request, then cancels the underlying
   * request if it is no longer subscribed.
   */
  private rejectSubscription(key: string, reject: Rejecter, cancelReason?: unknown): void {
    // Reject the outer "subscription" promise
    reject(cancelReason);

    // Get the list of subscriptions for this request
    const subscriptions = this.requests.get(key);
    if (!subscriptions) {
      // This should never happen
      return;
    }
    // Remove this request subscription by ref equality to `reject`
    const idx = subscriptions.findIndex((sub) => sub.reject === reject);
    if (idx >= 0) {
      subscriptions.splice(idx, 1);
    }

    // Remove the underlying request if there are no more subscribers.
    if (subscriptions.length < 1) {
      this.queue.cancelRequest(key, cancelReason);
      this.requests.delete(key);
    }
  }

  /** Cancels a request subscription, and cancels the underlying request if it is no longer subscribed or running. */
  cancelRequest(key: string, subscriberId: number, cancelReason?: unknown): boolean {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) {
      return false;
    }

    const rejecters = subscriber.get(key);
    if (!rejecters || !rejecters.length) {
      return false;
    }

    for (const reject of rejecters) {
      this.rejectSubscription(key, reject, cancelReason);
    }
    subscriber.delete(key);
    return true;
  }

  /** Removes a subscriber and cancels its remaining subscriptions. */
  removeSubscriber(subscriberId: number, cancelReason?: unknown): void {
    const subscriptions = this.subscribers.get(subscriberId);
    if (subscriptions) {
      for (const [key, rejecters] of subscriptions.entries()) {
        for (const reject of rejecters) {
          this.rejectSubscription(key, reject, cancelReason);
        }
      }
      this.subscribers.delete(subscriberId);
    }
  }

  /** Returns whether a request with the given `key` is running or waiting in the queue */
  hasRequest(key: string): boolean {
    return this.queue.hasRequest(key);
  }

  /** Returns whether a request with the given `key` is running */
  requestRunning(key: string): boolean {
    return this.queue.requestRunning(key);
  }

  /** Returns whether a subscriber with the given `subscriberId` exists */
  hasSubscriber(subscriberId: number): boolean {
    return this.subscribers.has(subscriberId);
  }

  /** Returns whether a subscriber with the given `subscriberId` is subscribed to the request with the given `key` */
  isSubscribed(subscriberId: number, key: string): boolean {
    return this.subscribers.get(subscriberId)?.has(key) ?? false;
  }
}
