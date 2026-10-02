/** Object format used when passing multiple requests to RequestQueue at once. */
export type Request<V> = {
  key: string;
  requestAction: () => Promise<V>;
  abort?: () => void;
};

export const DEFAULT_REQUEST_CANCEL_REASON = "request cancelled";

/**
 * Internal object interface used by RequestQueue to store request metadata and callbacks.
 */
interface RequestItem<V> {
  /** Key used to index this queue item. */
  key: string;
  /** Action to be run. */
  action: () => Promise<V>;
  /** Reference to the promise object that will be resolved when the action is complete. */
  promise: Promise<V>;
  /** Callback used to resolve the promise. */
  resolve: (value?: V | PromiseLike<V> | undefined) => void;
  /** Callback used to reject the promise. */
  reject: (reason?: unknown) => void;
  /** Optional, used to track timeouts if the item will be added to the queue later. */
  timeoutId?: ReturnType<typeof setTimeout>;
  /** Callback to cancel the action after it's started */
  abort?: () => void;
}

/**
 * Manages a queue of asynchronous requests with unique string keys, which can be added to or cancelled.
 * If redundant requests with the same key are issued, the request action will only be run once per key
 * while the original request is still in the queue.
 */
export default class RequestQueue {
  /**
   * The maximum number of requests that can be handled concurrently.
   * Once reached, additional requests will be queued up to run once a running request completes.
   */
  private maxActiveRequests: number;

  /**
   * The maximum number of requests that can be handled concurrently if only low-priority requests are waiting. Set
   * lower than `concurrencyLimit` to always leave space for high-priority requests. Cannot be set higher than
   * `concurrencyLimit`.
   */
  private maxLowPriorityRequests: number;

  /** A queue of requests that are ready to be executed, in order of request time. */
  private queue: string[];

  /** A queue of low-priority tasks that are ready to be executed. `queue` must be empty before any of these tasks run. */
  private queueLowPriority: string[];

  /** Stores all requests, even those that are currently active. */
  private allRequests: Map<string, RequestItem<unknown>>;

  /** Stores requests whose actions are currently being run. */
  private activeRequests: Set<string>;

  /**
   * Creates a new RequestQueue.
   * @param maxActiveRequests The maximum number of requests that will be handled concurrently. This is 10 by default.
   * @param maxLowPriorityRequests The maximum number of low-priority requests that will be handled concurrently. Equal
   *    to `maxActiveRequests` by default, but may be set lower to always leave space for new high-priority requests.
   */
  constructor(maxActiveRequests = 10, maxLowPriorityRequests = 5) {
    this.allRequests = new Map();
    this.activeRequests = new Set();
    this.queue = [];
    this.queueLowPriority = [];
    this.maxActiveRequests = maxActiveRequests;
    this.maxLowPriorityRequests = Math.min(maxActiveRequests, maxLowPriorityRequests);
  }

  /**
   * Stores request metadata to the internal map of all pending requests.
   * @param key string identifier of the request.
   * @param requestAction callable function action of the request.
   * @returns a reference to the new, registered RequestItem.
   */
  private registerRequest<T>(key: string, requestAction: () => Promise<T>, abortAction?: () => void): RequestItem<T> {
    // Create a new promise and store the resolve and reject callbacks for later.
    // This lets us perform the actual action at a later point, when the request is at the
    // front of the processing queue.
    let promiseResolve, promiseReject;
    const promise = new Promise<T>((resolve, reject) => {
      promiseResolve = resolve;
      promiseReject = reject;
    });
    // Store the request data.
    const requestItem = {
      key: key,
      action: requestAction,
      abort: abortAction,
      resolve: promiseResolve,
      reject: promiseReject,
      promise,
    };
    this.allRequests.set(key, requestItem);
    return requestItem;
  }

  /**
   * Moves a registered request into the processing queue, clearing any timeouts on the request.
   * @param key string identifier of the request.
   * @param lowPriority Whether this request should be added with low priority. False by default.
   */
  private addRequestToQueue(key: string, lowPriority?: boolean): void {
    // Check that this request is not cancelled.
    if (this.allRequests.has(key)) {
      // Clear the request timeout, if it has one, since it is being added to the queue.
      const requestItem = this.allRequests.get(key);
      if (requestItem && requestItem.timeoutId) {
        clearTimeout(requestItem.timeoutId);
        requestItem.timeoutId = undefined;
      }
      if (!this.queue.includes(key) && !this.queueLowPriority.includes(key)) {
        // Add to queue and check if the request can be processed right away.
        if (lowPriority) {
          this.queueLowPriority.push(key);
        } else {
          this.queue.push(key);
        }
        this.dequeue();
      }
    }
  }

  /**
   * Adds a request with a unique key to the queue, if it doesn't already exist.
   * @param key The key used to track the request.
   * @param requestAction Function that will be called to complete the request. The function
   *  will be run only once per unique key while the request exists, and may be deferred by the
   *  queue at any time.
   * @param lowPriority Whether this request should be added with low priority. False by default.
   * @param delayMs Minimum delay, in milliseconds, before this request should be executed.
   *
   * NOTE: Cancelling a request while the action is running WILL NOT stop the action. If this behavior is desired,
   * actions must be responsible for checking the RequestQueue, determining if the request is still valid (e.g.
   * using `.hasRequest()`), and stopping or returning early.
   *
   * @returns A promise that will resolve on completion of the request, or reject if the request is cancelled.
   *  If multiple requests are issued with the same key, a promise for the first request will be returned
   *  until the request is resolved or cancelled.
   *  Note that the return type of the promise will match that of the first request's instance.
   */
  public addRequest<T>(key: string, requestAction: () => Promise<T>, lowPriority = false, delayMs = 0, abortAction?: () => void): Promise<T> {
    if (!this.allRequests.has(key)) {
      // New request!
      const requestItem = this.registerRequest(key, requestAction, abortAction);
      // If a delay is set, wait to add this to the queue.
      if (delayMs > 0) {
        const timeoutId = setTimeout(() => this.addRequestToQueue(key, lowPriority), delayMs);
        // Save timeout information to request metadata
        requestItem.timeoutId = timeoutId;
      } else {
        // No delay, add immediately
        this.addRequestToQueue(key, lowPriority);
      }
    } else {
      const lowPriorityIndex = this.queueLowPriority.indexOf(key);
      if (lowPriorityIndex > -1 && !lowPriority) {
        // This request is registered and queued, but is now being requested with high priority.
        // Promote it to high priority.
        this.queueLowPriority.splice(lowPriorityIndex, 1);
        this.addRequestToQueue(key);
      } else if (delayMs <= 0) {
        // This request is registered, but is now being requested without a delay.
        // Move into queue immediately if it's not already added, and clear any timeouts it may have.
        this.addRequestToQueue(key, lowPriority);
      }
    }

    const promise = this.allRequests.get(key)?.promise;
    if (!promise) {
      throw new Error("Found no promise to return when getting stored request data.");
    }
    return promise as Promise<T>;
  }

  /**
   * Adds multiple requests to the queue, with an optional delay between each.
   * @param requests An array of RequestItems, which include a key and a request action.
   * @param lowPriority Whether these requests should be added with low priority. False by default.
   * @param delayMs An optional minimum delay in milliseconds to be added between each request.
   *  For example, a delay of 10 ms will cause the second request to be added to the processing queue
   *  after 10 ms, the third to added after 20 ms, and so on. Set to 10 ms by default.
   * @returns An array of promises corresponding to the provided requests. (i.e., the `i`th value
   * of the returned array will be a Promise for the resolution of `requests[i]`). If a request
   *  with a matching key is already pending, returns the promise for the initial request.
   */
  public addRequests<T>(requests: Request<T>[], lowPriority = false, delayMs = 10): Promise<unknown>[] {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < requests.length; i++) {
      const item = requests[i];
      const promise = this.addRequest(item.key, item.requestAction, lowPriority, delayMs * i, item.abort);
      promises.push(promise);
    }
    return promises;
  }

  /**
   * Attempts to remove and run the next queued request item, if resources are available.
   * @returns true if a request was started, or false if there are too many
   * requests already active.
   */
  private async dequeue(): Promise<void> {
    const numRequests = this.activeRequests.size;
    if (
      numRequests >= this.maxActiveRequests ||
      (this.queue.length === 0 && (numRequests >= this.maxLowPriorityRequests || this.queueLowPriority.length === 0))
    ) {
      return;
    }

    const requestKey = this.queue.shift() ?? this.queueLowPriority.shift();
    if (!requestKey) {
      return;
    }
    if (this.activeRequests.has(requestKey)) {
      // This request is already active, try the next one instead. (this shouldn't happen)
      this.dequeue();
      return;
    }

    const requestItem = this.allRequests.get(requestKey);
    if (!requestItem) {
      return;
    }

    const key = requestItem.key;
    // Mark that this request is active
    this.activeRequests.add(key);

    await requestItem.action().then(requestItem.resolve, requestItem.reject);
    // A new request for the same key may have been added during the await
    if (requestItem === this.allRequests.get(requestKey)) {
      this.activeRequests.delete(key);
      this.allRequests.delete(key);
    }
    this.dequeue();
  }

  /**
   * Removes any request matching the provided key from the queue and rejects its promise.
   * @param key The key that should be matched against.
   * @param cancelReason A message or object that will be used as the promise rejection.
   */
  public cancelRequest(key: string, cancelReason: unknown = DEFAULT_REQUEST_CANCEL_REASON): void {
    if (!this.allRequests.has(key)) {
      return;
    }
    const requestItem = this.allRequests.get(key);
    if (requestItem) {
      if (requestItem.timeoutId) {
        // Cancel requests that have not been queued yet.
        clearTimeout(requestItem.timeoutId);
      }
      // Cancel in-progress work
      requestItem.abort?.();
      // Reject the request, then clear from the queue and known requests.
      requestItem.reject(cancelReason);
    }
    const queueIndex = this.queue.indexOf(key);
    if (queueIndex > -1) {
      this.queue.splice(queueIndex, 1);
    } else {
      const lowPriorityIndex = this.queueLowPriority.indexOf(key);
      if (lowPriorityIndex > -1) {
        this.queueLowPriority.splice(lowPriorityIndex, 1);
      }
    }
    this.allRequests.delete(key);
    this.activeRequests.delete(key);
  }

  /**
   * Rejects all request promises and clears the queue.
   * @param cancelReason A message or object that will be used as the promise rejection.
   */
  public cancelAllRequests(cancelReason: unknown = DEFAULT_REQUEST_CANCEL_REASON): void {
    // Clear the queue so we don't do extra work while filtering it
    this.queue = [];
    this.queueLowPriority = [];
    for (const key of this.allRequests.keys()) {
      this.cancelRequest(key, cancelReason);
    }
  }

  /**
   * Returns whether a request with the given key exists in the RequestQueue and is not cancelled.
   * @param key the key to search for.
   * @returns true if the request is in the RequestQueue.
   */
  public hasRequest(key: string): boolean {
    return this.allRequests.has(key);
  }

  /**
   * Returns whether the request with the given key is currently running (not waiting in the queue).
   * @param key the key to search for.
   * @returns true if the request is actively running.
   */
  public requestRunning(key: string): boolean {
    return this.activeRequests.has(key);
  }
}
