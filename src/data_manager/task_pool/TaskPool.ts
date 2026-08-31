import { deserializeError } from "serialize-error";
import SlotMap from "../SlotMap.js";
import type { Task, TaskHandle, WorkerResponse, WorkerRequest, TaskArgs } from "./task.js";
import { BorrowGuard, markBorrowed } from "./task.js";

type StoredPromise = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  borrows: BorrowGuard[];
};

type WaitingTask<In extends unknown[], Out> = {
  promiseId: number;
  taskHandle: TaskHandle<In, Out>;
  args: In;
};

export class TaskPool {
  private workerCount = 0;
  private idleWorkers: Worker[] = [];
  private promises: SlotMap<StoredPromise> = new SlotMap();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: WaitingTask<any[], any>[] = [];

  constructor(public maxWorkers = navigator.hardwareConcurrency ?? 4) {}

  private handleWorkerMessage(message: WorkerResponse<Task<string, unknown[], unknown>>) {
    const promise = this.promises.remove(message.id);
    if (promise === undefined) {
      console.error(
        `TaskPool: received worker response for nonexistent task ID ${message.id} with type "${message.task}"`
      );
      return;
    }

    const borrowsExpected = promise.borrows.length;
    const borrowsReceived = message.borrows.length;
    if (borrowsExpected === borrowsReceived) {
      for (let i = 0; i < borrowsReceived; i++) {
        promise.borrows[i].restore(message.borrows[i]);
      }
    } else {
      console.error(
        `TaskPool: number of borrows returned from task "${message.task}" with ID ${message.id} did not match (expected ${borrowsExpected}, received ${borrowsReceived})`
      );
    }

    if (message.error) {
      promise.reject(deserializeError(message.result));
    } else {
      promise.resolve(message.result);
    }

    this.submitTasks();
    promise.borrows.forEach((borrow) => borrow.afterRestore());
  }

  private addWorker() {
    const worker = new Worker(new URL("./worker", import.meta.url), { type: "module" });
    let ready = false;
    worker.onmessage = (message) => {
      this.idleWorkers.push(worker);
      if (!ready) {
        ready = true;
        this.submitTasks();
      } else {
        this.handleWorkerMessage(message.data);
      }
    };
    this.workerCount += 1;
  }

  private submitTasks() {
    let i = 0;
    while (i < this.queue.length) {
      const task = this.queue[i];
      const borrowedBuffers: ArrayBuffer[] = [];
      const args: unknown[] = [];
      // Handle borrowed buffers
      for (const arg of task.args) {
        if (BorrowGuard.isBorrowGuard(arg)) {
          const array = arg.get();
          // Task is not ready -- some resource it depends on is in use by another task
          if (array === undefined) {
            i++;
            continue;
          }
          args.push(markBorrowed(array));
          borrowedBuffers.push(array.buffer);
        } else {
          args.push(arg);
        }
      }

      const worker = this.idleWorkers.pop();
      if (worker === undefined) {
        // We have a ready task but we're out of workers to run it on
        if (this.workerCount < this.maxWorkers) {
          this.addWorker();
        }
        return;
      }

      this.queue.splice(i, 1);
      const transfer = [...borrowedBuffers, ...(task.taskHandle.transfer?.(...task.args) ?? [])];
      worker.postMessage(
        {
          task: task.taskHandle.id,
          id: task.promiseId,
          args,
        } as WorkerRequest,
        { transfer }
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public runTask<In extends any[], Out>(taskHandle: TaskHandle<In, Out>, ...args: TaskArgs<In>): Promise<Out> {
    const borrows = args.filter(BorrowGuard.isBorrowGuard);
    const promise = new Promise((resolve, reject) => {
      const promiseId = this.promises.insert({ resolve, reject, borrows });
      this.queue.push({ taskHandle, promiseId, args });
    });
    this.submitTasks();
    return promise as Promise<Out>;
  }
}
