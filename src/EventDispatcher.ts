// An event dispatcher's *event map* maps event type names to event payloads.
type EventMap = Record<string, object | void>;
// An event is an object containing the event payload plus its type name (or just the name for events with no payload).
export type Event<M extends EventMap, E extends keyof M> = M[E] extends void ? { type: E } : M[E] & { type: E };
// A listener is a function that receives an event of a specific type.
export type Listener<M extends EventMap, E extends keyof M> = (event: Event<M, E>) => void;

export default class EventDispatcher<M extends EventMap> {
  private listeners: { [E in keyof M]?: Listener<M, E>[] } = {};

  public addEventListener<E extends keyof M>(event: E, listener: Listener<M, E>): void {
    if (this.listeners[event] === undefined) {
      this.listeners[event] = [];
    }
    if (this.listeners[event].indexOf(listener) === -1) {
      this.listeners[event].push(listener);
    }
  }

  public removeEventListener<E extends keyof M>(event: E, listener: Listener<M, E>): void {
    const listeners = this.listeners[event];
    if (listeners !== undefined) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  protected dispatchEvent<E extends keyof M>(event: Event<M, E>): void {
    const listeners = this.listeners[event.type];
    if (listeners !== undefined) {
      // Iterate over a shallow copy of `listeners`, in case a listener is added/removed during iteration
      for (const listener of listeners.slice()) {
        listener(event);
      }
    }
  }
}
