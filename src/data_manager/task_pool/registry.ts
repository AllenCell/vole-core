import { Task } from "./task.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TASK_HANDLERS = new Map<string, Task<string, any[], any>>();

/**
 * Combines a `string` task `id` and a `handler` into a `Task` that can be registered and called with a `TaskPool`.
 *
 * Modules that define tasks that can be run on a worker should wrap the task handler in this function, then export the
 * resulting `Task`'s type while passing its value to `registerTask`:
 *
 * ```typescript
 * const addTask = task("add", (a: number, b: number) => a + b);
 * export type AddTask = typeof addTask;
 * registerTask(addTask);
 * ```
 *
 * Main thread code can then import the task's type to create a `TaskHandle`:
 *
 * ```typescript
 * import type { AddTask } from "./add_task.js";
 * const addTask = taskHandle<AddTask>("add");
 * const pool = new TaskPool();
 * const three = await pool.runTask(addTask, 1, 2);
 * ```
 */
export const task = <Id extends string, In extends unknown[], Out>(
  id: Id,
  handler: (...args: In) => { result: Out; transfer: Transferable[] }
): Task<Id, In, Out> => {
  const task = handler as Task<Id, In, Out>;
  task.taskId = id;
  return task;
};

export const registerTask = <Id extends string, In extends unknown[], Out>(task: Task<Id, In, Out>) => {
  TASK_HANDLERS.set(task.taskId, task);
};
