import { describe, expect, it } from "vitest";

import { clampSliceIndex, constrainToAxis, formatNumber, getTimestamp } from "../utils/num_utils.js";
import { Axis } from "../types.js";

describe("num_utils", () => {
  describe("formatNumber", () => {
    it("stringifies integers with 4 or fewer digits", () => {
      expect(formatNumber(4)).to.equal("4");
      expect(formatNumber(-876)).to.equal("-876");
      expect(formatNumber(1234)).to.equal("1234");
      expect(formatNumber(9999)).to.equal("9999");
      expect(formatNumber(-9999)).to.equal("-9999");
    });

    it("rounds decimals to 5 significant figures", () => {
      expect(formatNumber(123.4567)).to.equal("123.46");
      expect(formatNumber(-0.123456)).to.equal("-0.12346");
    });

    it("formats integers with 5 or more digits in scientific notation", () => {
      expect(formatNumber(10000)).to.equal("1.00×10⁴");
      expect(formatNumber(12345)).to.equal("1.23×10⁴");
      expect(formatNumber(99999)).to.equal("1.00×10⁵");
      expect(formatNumber(-12345)).to.equal("-1.23×10⁴");
      expect(formatNumber(123456789012345)).to.equal("1.23×10¹⁴");
    });

    it("formats decimals below hundredths in scientific notation", () => {
      expect(formatNumber(0.01)).to.equal("0.01");
      expect(formatNumber(0.001)).to.equal("1.00×10⁻³");
      expect(formatNumber(0.0009876)).to.equal("9.88×10⁻⁴");
      expect(formatNumber(0.00000000000000123456789012345)).to.equal("1.23×10⁻¹⁵");
    });

    it("does not format zero in scientific notation", () => {
      expect(formatNumber(0)).to.equal("0");
    });

    it("formats numbers which would round to 10000 in scientific notation", () => {
      expect(formatNumber(9999.9)).to.equal("9999.9");
      expect(formatNumber(9999.99)).to.equal("1.00×10⁴");
    });

    it("does not account for numbers which round up to 0.01 in scientific notation", () => {
      expect(formatNumber(0.00999)).to.equal("9.99×10⁻³");
      expect(formatNumber(0.009999)).to.equal("1.00×10⁻²"); // aw shucks
    });

    it("rounds off decimals to the specified number of significant figures", () => {
      expect(formatNumber(123.4567, 3)).to.equal("123");
      expect(formatNumber(123.4567, 4)).to.equal("123.5");
      expect(formatNumber(123.4567, 6)).to.equal("123.457");
      expect(formatNumber(123.4567, 2)).to.equal("123"); // oh well
    });

    it("rounds numbers in scientific notation to the specified number of significant figures", () => {
      expect(formatNumber(12345, 3, 3)).to.equal("1.23×10⁴");
      expect(formatNumber(12345, 4, 4)).to.equal("1.235×10⁴");
      expect(formatNumber(12345, 6, 6)).to.equal("1.23450×10⁴");
    });

    it("rounds numbers in scientific notation to two fewer significant figures than decimals if unspecified", () => {
      expect(formatNumber(12345, 5)).to.equal("1.23×10⁴");
      expect(formatNumber(12345, 6)).to.equal("1.235×10⁴");
      expect(formatNumber(12345, 8)).to.equal("1.23450×10⁴");
    });
  });

  describe("getTimestamp", () => {
    it("shows only milliseconds if total time units < 1000 ms", () => {
      expect(getTimestamp(0, 999, "ms")).to.equal("0 / 999 ms");
      expect(getTimestamp(41, 999, "ms")).to.equal("41 / 999 ms");
      expect(getTimestamp(-50, 999, "ms")).to.equal("-50 / 999 ms");
      expect(getTimestamp(999, 999, "ms")).to.equal("999 / 999 ms");
    });

    it("ignores decimal places in milliseconds", () => {
      expect(getTimestamp(0.4, 100, "ms")).to.equal("0 / 100 ms");
      expect(getTimestamp(9.9, 100, "ms")).to.equal("9 / 100 ms");
    });

    it("does not convert unrecognized time units", () => {
      expect(getTimestamp(0, 999, "foo")).to.equal("0 / 999 foo");
      expect(getTimestamp(41, 999, "bar")).to.equal("41 / 999 bar");
      expect(getTimestamp(999, 999, "baz")).to.equal("999 / 999 baz");
    });

    it("shows seconds if total time is > 1000 ms", () => {
      expect(getTimestamp(0, 1000, "ms")).to.equal("0.000 / 1.000 s");
      expect(getTimestamp(999, 1000, "ms")).to.equal("0.999 / 1.000 s");
      expect(getTimestamp(1, 4500, "ms")).to.equal("0.001 / 4.500 s");
    });

    it("does not show past three decimals for seconds", () => {
      expect(getTimestamp(9.9, 1000, "ms")).to.equal("0.009 / 1.000 s");
    });

    it("ignores milliseconds when unit is seconds", () => {
      expect(getTimestamp(0, 59, "s")).to.equal("0 / 59 s");
      expect(getTimestamp(0.54, 59, "s")).to.equal("0 / 59 s");
      expect(getTimestamp(12, 59, "s")).to.equal("12 / 59 s");
    });

    it("converts from seconds to minutes", () => {
      expect(getTimestamp(0, 60, "s")).to.equal("0:00 / 1:00 m:s");
    });

    it("converts from seconds to other units", () => {
      const minutesInSec = 60;
      const hoursInSec = 60 * minutesInSec;
      const daysInSec = 24 * hoursInSec;

      let time = 1 * hoursInSec + 23 * minutesInSec + 45;
      let total = 2 * hoursInSec + 30 * minutesInSec + 0;
      expect(getTimestamp(time, total, "s")).to.equal("1:23:45 / 2:30:00 h:m:s");

      time = 15 * hoursInSec + 0 * minutesInSec + 1;
      total = 17 * hoursInSec + 0 * minutesInSec + 0;
      expect(getTimestamp(time, total, "s")).to.equal("15:00:01 / 17:00:00 h:m:s");

      time = 0;
      total = 23 * hoursInSec + 59 * minutesInSec + 59;
      expect(getTimestamp(time, total, "s")).to.equal("0:00:00 / 23:59:59 h:m:s");

      time = 1 * daysInSec + 0 * hoursInSec + 0 * minutesInSec + 0;
      total = 2 * daysInSec + 0 * hoursInSec + 0 * minutesInSec + 0;
      expect(getTimestamp(time, total, "s")).to.equal("1:00:00:00 / 2:00:00:00 d:h:m:s");

      time = 1 * daysInSec + 23 * hoursInSec + 59 * minutesInSec + 59;
      total = 2 * daysInSec + 0 * hoursInSec + 0 * minutesInSec + 0;
      expect(getTimestamp(time, total, "s")).to.equal("1:23:59:59 / 2:00:00:00 d:h:m:s");
    });

    it("can show full d:hh:mm:ss.sss timestamps", () => {
      const secondsInMs = 1000;
      const minutesInMs = 60 * secondsInMs;
      const hoursInMs = 60 * minutesInMs;
      const daysInMs = 24 * hoursInMs;

      const time = 1 * daysInMs + 17 * hoursInMs + 23 * minutesInMs + 45 * secondsInMs + 678;
      const total = 2 * daysInMs;
      expect(getTimestamp(time, total, "ms")).to.equal("1:17:23:45.678 / 2:00:00:00.000 d:h:m:s");
    });

    it("ignores smaller units when time defined in hours", () => {
      expect(getTimestamp(0, 123 * 24, "h")).to.equal("0:00 / 123:00 d:h");
      expect(getTimestamp(23, 123 * 24, "h")).to.equal("0:23 / 123:00 d:h");
      expect(getTimestamp(24 + 5, 123 * 24, "h")).to.equal("1:05 / 123:00 d:h");
    });
  });

  describe("constrainToAxis", () => {
    type Number3 = [number, number, number];

    it("constrains to the X, Y, Z axis", () => {
      const src: Number3 = [1, 2, 3];
      const target: Number3 = [4, 5, 6];
      expect(constrainToAxis(src, target, Axis.X)).to.eql([1, 5, 6]);
      expect(constrainToAxis(src, target, Axis.Y)).to.eql([4, 2, 6]);
      expect(constrainToAxis(src, target, Axis.Z)).to.eql([4, 5, 3]);
    });

    it("does nothing if Axis.None is specified", () => {
      const src: Number3 = [1, 2, 3];
      const target: Number3 = [4, 5, 6];
      expect(constrainToAxis(src, target, Axis.NONE)).to.eql([1, 2, 3]);
    });
  });

  describe("clampSliceIndex", () => {
    it("passes through an in-range integer index", () => {
      expect(clampSliceIndex(3, 10)).to.equal(3);
      expect(clampSliceIndex(0, 10)).to.equal(0);
    });

    it("clamps below 0 to 0", () => {
      expect(clampSliceIndex(-5, 10)).to.equal(0);
    });

    it("clamps at or above the axis size to the last voxel (size - 1)", () => {
      expect(clampSliceIndex(10, 10)).to.equal(9);
      expect(clampSliceIndex(999, 10)).to.equal(9);
    });

    it("floors fractional indices", () => {
      expect(clampSliceIndex(3.7, 10)).to.equal(3);
      expect(clampSliceIndex(9.99, 10)).to.equal(9);
    });

    it("returns 0 for a degenerate axis (size <= 1)", () => {
      expect(clampSliceIndex(0, 1)).to.equal(0);
      expect(clampSliceIndex(5, 1)).to.equal(0);
      expect(clampSliceIndex(3, 0)).to.equal(0);
    });
  });
});
