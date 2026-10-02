import { parseTimeUnit, TimeUnit } from "../constants/time.js";
import { Axis } from "../types.js";

export const DEFAULT_SIG_FIGS = 5;

const SECONDS_IN_MS = 1000;
const MINUTES_IN_MS = SECONDS_IN_MS * 60;
const HOURS_IN_MS = MINUTES_IN_MS * 60;
const DAYS_IN_MS = HOURS_IN_MS * 24;

// Adapted from https://gist.github.com/ArneS/2ecfbe4a9d7072ac56c0.
function digitToUnicodeSupercript(n: number): string {
  const subst = [0x2070, 185, 178, 179, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079];
  return String.fromCharCode(subst[n]);
}

/**
 * Converts a number to scientific notation with the specified number of significant
 * figures, handling negative numbers and rounding.
 * @param input The number to convert.
 * @param significantFigures the number of signficant figures/digits. Must be >= 1.
 * @returns a string, formatted as a number in scientific notation.
 * @example
 * ```
 * numberToSciNotation(1, 3) // "1.00×10⁰"
 * numberToSciNotation(0.99, 2) // "9.9×10⁻¹"
 * numberToSciNotation(0.999, 2) // "1.0×10⁰"
 * numberToSciNotation(-0.05, 1) // "-5×10⁻²"
 * numberToSciNotation(1400, 3) // "1.40×10³"
 * ```
 */
function numberToSciNotation(input: number, sigFigs = DEFAULT_SIG_FIGS): string {
  const nativeExpForm = input.toExponential(sigFigs - 1);
  const [significand, exponent] = nativeExpForm.split("e");
  const expSign = exponent[0] === "-" ? "⁻" : "";
  const expDigits = exponent.slice(1).split("");
  const expSuperscript = expDigits.map((digit) => digitToUnicodeSupercript(Number(digit))).join("");
  return `${significand}×10${expSign}${expSuperscript}`;
}

/**
 * Returns a string-encoded number rounded to a specified decimal precision, without ever formatting in scientific
 * notation like `Number.toPrecision` might do.
 */
function toSigFigs(value: number, sigFigs: number): string {
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  return value.toFixed(Math.max(sigFigs - exponent - 1, 0));
}

/** Trims trailing instances of `char` off the end of `str`. */
// This is not technically a number utility, but it's useful to `formatNumber` below.
function trimTrailing(str: string, char: string): string {
  let i = str.length - 1;
  while (str[i] === char) {
    i--;
  }
  return str.slice(0, i + 1);
}

/**
 * Formats numbers for display as a string with a (hopefully) limited length.
 *
 * - If the number is an integer with 4 or fewer digits, it is returned as a string.
 * - If the number is a decimal, it is rounded to `sigFigs` significant figures. (default 5)
 * - If the number's absolute value is over 10,000 or less than 0.01, it is formatted in scientific notation to
 *   `sciSigFigs` significant figures. (Default `sigFigs - 2`, so 3 if neither are specified. The `- 2` leaves space
 *   for the exponential part. Remember: the purpose of this function is keeping number strings *consistently* short!)
 */
export function formatNumber(value: number, sigFigs = DEFAULT_SIG_FIGS, sciSigFigs = sigFigs - 2): string {
  const valueAbs = Math.abs(value);

  if (Number.isInteger(value)) {
    // Format integers with 5+ digits in scientific notation
    if (valueAbs >= 10_000) {
      return numberToSciNotation(value, sciSigFigs);
    }
    // Just stringify other integers
    return value.toString();
  } else {
    const numStr = toSigFigs(value, sigFigs);
    const numRounded = Math.abs(Number(numStr));
    if (numRounded >= 10_000 || numRounded < 0.01) {
      return numberToSciNotation(value, sciSigFigs);
    }
    const trimmed = trimTrailing(numStr, "0");
    return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  }
}

const timeUnitEnumToMilliseconds = {
  [TimeUnit.MILLISECOND]: 1,
  [TimeUnit.SECOND]: SECONDS_IN_MS,
  [TimeUnit.MINUTE]: MINUTES_IN_MS,
  [TimeUnit.HOUR]: HOURS_IN_MS,
  [TimeUnit.DAY]: DAYS_IN_MS,
};

export function timeToMilliseconds(time: number, unit: TimeUnit): number {
  const timeUnitMultiplier = timeUnitEnumToMilliseconds[unit];
  if (timeUnitMultiplier === undefined) {
    throw new Error("Unrecognized time unit");
  }
  return time * timeUnitMultiplier;
}

/**
 * Pads the `value` with zeroes to the specified `length` if `shouldPad` is true
 * and returns the resulting string. Otherwise, returns the string representation of `value`.
 */
function padConditionally(value: number, length: number, shouldPad: boolean): string {
  return shouldPad ? value.toString().padStart(length, "0") : value.toString();
}

function formatTimestamp(
  timeMs: number,
  options: {
    useMs: boolean;
    useSec: boolean;
    useMin: boolean;
    useHours: boolean;
    useDays: boolean;
  }
): { timestamp: string; units: string } {
  const { useMs, useSec, useMin, useHours, useDays } = options;
  const digits: string[] = [];
  const units: string[] = [];

  if (useDays) {
    const days = Math.floor(timeMs / DAYS_IN_MS);
    digits.push(days.toString());
    units.push("d");
  }
  if (useHours) {
    const hours = Math.floor((timeMs % DAYS_IN_MS) / HOURS_IN_MS);
    // If the previous unit is included, pad the hours to 2 digits so the
    // timestamp is consistent.
    digits.push(padConditionally(hours, 2, useDays));
    units.push("h");
  }
  if (useMin) {
    const minutes = Math.floor((timeMs % HOURS_IN_MS) / MINUTES_IN_MS);
    digits.push(padConditionally(minutes, 2, useHours));
    units.push("m");
  }
  if (useSec) {
    const seconds = Math.floor((timeMs % MINUTES_IN_MS) / SECONDS_IN_MS);
    let secondString = padConditionally(seconds, 2, useMin);
    units.push("s");
    // If using milliseconds, add as a decimal to the seconds string.
    if (useMs) {
      const milliseconds = Math.floor(timeMs % SECONDS_IN_MS);
      secondString += "." + milliseconds.toString().padStart(3, "0");
      // Do not add milliseconds to unit label, since they'll be shown as
      // part of the seconds string.
    }
    digits.push(secondString);
  } else if (useMs) {
    const milliseconds = Math.floor(timeMs % SECONDS_IN_MS);
    digits.push(milliseconds.toString());
    units.push("ms");
  }
  return { timestamp: digits.join(":"), units: units.join(":") };
}

/**
 * Gets a timestamp formatted as `{time} / {total} {unit}`. If `unit` is a recognized
 * time unit, the timestamp will be formatted as a `d:hh:mm:ss.ms` string.
 *
 * @param time Current time, in specified units.
 * @param total Total time, in specified units.
 * @param unit The unit of time.
 * @returns A formatted timestamp string.
 * - If `unit` is not recognized, the timestamp will be formatted as `{time} / {total} {unit}`,
 * where `time` and `total` are formatted with significant digits as needed.
 * - If `unit` is recognized, the timestamp will be formatted as `d:hh:mm:ss.ms`, specifying
 * the most significant unit based on the total time, and the least significant unit with
 * `unit`. See `parseTimeUnit()` for recognized time units.
 */
export function getTimestamp(time: number, total: number, unit: string): string {
  const timeUnit = parseTimeUnit(unit);

  if (timeUnit === undefined) {
    return `${formatNumber(time)} / ${formatNumber(total)} ${unit}`;
  }

  const timeMs = timeToMilliseconds(time, timeUnit);
  const totalMs = timeToMilliseconds(total, timeUnit);

  // Toggle each unit based on the total time and the provided timeUnit.
  // Exploit an enum property where TimeUnit.Milliseconds < TimeUnit.Second < TimeUnit.Minute ... etc.
  const options = {
    useMs: timeUnit == TimeUnit.MILLISECOND,
    useSec: timeUnit == TimeUnit.SECOND || (timeUnit <= TimeUnit.SECOND && totalMs >= SECONDS_IN_MS),
    useMin: timeUnit == TimeUnit.MINUTE || (timeUnit <= TimeUnit.MINUTE && totalMs >= MINUTES_IN_MS),
    useHours: timeUnit == TimeUnit.HOUR || (timeUnit <= TimeUnit.HOUR && totalMs >= HOURS_IN_MS),
    useDays: timeUnit == TimeUnit.DAY || (timeUnit <= TimeUnit.DAY && totalMs >= DAYS_IN_MS),
  };

  const { timestamp, units } = formatTimestamp(timeMs, options);
  const { timestamp: totalTimestamp } = formatTimestamp(totalMs, options);

  return `${timestamp} / ${totalTimestamp} ${units}`;
}

/**
 * Constrains the `src` vector relative to the `target` so it only has freedom along the
 * specified `axis`. Does nothing if `axis = Axis.NONE`.
 *
 * @example
 * ```
 *   const src = [1, 2, 3];
 *   const target = [4, 5, 6];
 *   const constrained = constrainToAxis(src, target, Axis.X);
 *   console.log(constrained); // [1, 5, 6]
 * ```
 */
export function constrainToAxis(
  src: [number, number, number],
  target: [number, number, number],
  axis: Axis
): [number, number, number] {
  switch (axis) {
    case Axis.X:
      return [src[0], target[1], target[2]];
    case Axis.Y:
      return [target[0], src[1], target[2]];
    case Axis.Z:
      return [target[0], target[1], src[2]];
    default:
      return [...src];
  }
}

/**
 * Clamps a slice index to the valid voxel range `[0, axisSize - 1]` for an axis of
 * the given size, flooring fractional inputs. Returns 0 for a degenerate axis (`axisSize <= 1`).
 * @param index The desired slice index (may be fractional or out of range).
 * @param axisSize The number of voxels along the axis.
 */
export function clampSliceIndex(index: number, axisSize: number): number {
  return Math.max(0, Math.min(Math.floor(index), axisSize - 1));
}

export function getDataRange(data: ArrayLike<number>): [number, number] {
  let min = data[0];
  let max = data[0];
  for (let i = 1; i < data.length; i++) {
    const value = data[i];
    if (value < min) {
      min = value;
    } else if (value > max) {
      max = value;
    }
  }
  return [min, max];
}
