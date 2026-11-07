/** Small argument helpers: tools get `unknown` from the model and must reject bad input with a clear message. */
export class ArgumentError extends Error {}

function record(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ArgumentError("Arguments must be an object.");
  return args as Record<string, unknown>;
}

export function requireString(args: unknown, name: string): string {
  const value = record(args)[name];
  if (typeof value !== "string") throw new ArgumentError(`'${name}' must be a string.`);
  return value;
}

export function optionalInteger(args: unknown, name: string, minimum: number): number | undefined {
  const value = record(args)[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new ArgumentError(`'${name}' must be an integer of at least ${minimum}.`);
  }
  return value;
}

export function optionalNumber(args: unknown, name: string, minimumExclusive: number): number | undefined {
  const value = record(args)[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !(value > minimumExclusive)) throw new ArgumentError(`'${name}' must be a number greater than ${minimumExclusive}.`);
  return value;
}

export function optionalBoolean(args: unknown, name: string): boolean | undefined {
  const value = record(args)[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ArgumentError(`'${name}' must be true or false.`);
  return value;
}

export function arrayOf(args: unknown, name: string): unknown[] {
  const value = record(args)[name];
  if (!Array.isArray(value)) throw new ArgumentError(`'${name}' must be an array.`);
  return value;
}

export const rawRecord = record;
