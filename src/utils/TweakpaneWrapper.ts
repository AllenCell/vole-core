// Workaround for https://github.com/cocopon/tweakpane/issues/665
export class WrappedTpError extends Error {
  constructor(e: unknown) {
    super();
    Object.assign(this, e);
  }
}

export function wrapTweakpaneCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e: unknown) {
    if (e instanceof Object && "name" in e && e.name === "TpError") {
      throw new WrappedTpError(e);
    }
    throw e;
  }
}
