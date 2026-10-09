/** Creates a function that returns a stable and globally unique number for any object passed to it. */
export const defineGlobalId = <T extends object = object>(key: symbol): ((obj: T) => number) => {
  let id = 0;
  return (obj: T): number => {
    if (obj[key] === undefined) {
      obj[key] = id;
      id += 1;
    }
    return obj[key];
  };
};

/** Removes an element from an array by replacing it with the element at the end of the array. */
export const swapRemove = <T>(arr: T[], index: number) => {
  if (index < 0 || index >= arr.length) {
    return;
  }

  const { length } = arr;
  const replace = arr.pop();
  if (replace !== undefined && index < length) {
    arr[index] = replace;
  }
};
