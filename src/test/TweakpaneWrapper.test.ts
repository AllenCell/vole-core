import { Pane } from "tweakpane";
import { wrapTweakpaneCall } from "../utils/TweakpaneWrapper.js";

describe("TweakpaneWrapper", () => {
  it("Replaces TpError with instance of Error", () => {
    let error: unknown;
    try {
      wrapTweakpaneCall(() => (new Pane()).addInput({ foo: undefined }, 'foo'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
  })
})
