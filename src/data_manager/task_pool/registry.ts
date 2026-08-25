import { Task } from "./task.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TASK_HANDLERS = new Map<string, Task<string, any[], any>>();

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
