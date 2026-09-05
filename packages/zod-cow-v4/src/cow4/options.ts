/**
 * Compile options: the semantic switches a caller can set on `compile(schema, options)`.
 * Resolved once per compile and carried by every `CodeCtx` of the tree, so a sub-skeleton sees
 * the same options as the root.
 */

/** Options accepted by `compile(schema, options)`. Every field is optional; the defaults give stock semantics. */
export interface CompileOptions {
  /**
   * What an object skeleton, in every object mode (strip, strict, loose), does about own symbol
   * keys of the input (#43, #42).
   *
   *   "probe"   (default) before returning the input by reference, prove that it carries no
   *             undeclared own symbol key (`Object.getOwnPropertySymbols`, which lists non-enumerable
   *             ones too), because stock's rebuild drops such keys in every mode. Exact stock
   *             semantics; about 36 ns per object.
   *   "ignore"  skip that probe. An input whose declared keys are unchanged and which carries no
   *             undeclared string key that the mode would strip or reject is returned by reference
   *             even when it carries an own symbol key, which then survives where stock would drop
   *             it. For data known to carry no symbol keys (JSON input, structured-clone output)
   *             the two modes give the same result. The copy path is unchanged.
   */
  ownSymbolKeys?: "probe" | "ignore";
}

/** The resolved form: every field present */
export type CowOptions = Readonly<Required<CompileOptions>>;

export const DEFAULT_OPTIONS: CowOptions = Object.freeze({ ownSymbolKeys: "probe" });

const OWN_SYMBOL_KEYS = ["probe", "ignore"] as const;

/** Fills in the defaults; an unknown value is a programming error and throws (compile-time, not at parse time) */
export function resolveOptions(options: CompileOptions | undefined): CowOptions {
  if (options === undefined) return DEFAULT_OPTIONS;
  if (!isPlainObject(options)) {
    throw new TypeError(`compile options must be a plain object, got ${describe(options)}`);
  }
  // An absent property (undefined) is the default; anything else, `null` included, is a value
  const read = readOption(options, "ownSymbolKeys");
  const ownSymbolKeys = read === undefined ? DEFAULT_OPTIONS.ownSymbolKeys : read;
  if (!OWN_SYMBOL_KEYS.includes(ownSymbolKeys as CowOptions["ownSymbolKeys"])) {
    throw new TypeError(
      `compile option ownSymbolKeys must be one of ${OWN_SYMBOL_KEYS.map((v) => JSON.stringify(v)).join(", ")}, got ${describe(ownSymbolKeys)}`,
    );
  }
  return ownSymbolKeys === DEFAULT_OPTIONS.ownSymbolKeys
    ? DEFAULT_OPTIONS
    : { ownSymbolKeys: ownSymbolKeys as CowOptions["ownSymbolKeys"] };
}

/**
 * The value of one option, `undefined` when absent. Only an own property counts: a value inherited
 * from `Object.prototype` (prototype pollution) must not turn `compile(schema, {})` into something
 * other than `compile(schema)`. An own `undefined` is an absent property; anything else, `null`
 * included, is returned for the value check. The read runs the options object's own code (an
 * accessor, a Proxy trap): a throw there is reported as the promised `TypeError`, with the caller's
 * error as its `cause`
 */
function readOption(options: object, key: keyof CompileOptions): unknown {
  try {
    return Object.hasOwn(options, key) ? (options as Record<string, unknown>)[key] : undefined;
  } catch (cause) {
    throw new TypeError(`compile option ${key} could not be read from the options object`, {
      cause,
    });
  }
}

/** A plain object: `Object.prototype` or a null prototype; any other prototype is rejected rather than searched */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const proto = prototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `Object.getPrototypeOf` that never throws: a Proxy whose `getPrototypeOf` trap throws is reported
 * as "not a plain object" (`undefined`) so that the rejection stays the documented `TypeError`
 */
function prototypeOf(value: object): object | null | undefined {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return undefined;
  }
}

/**
 * Formats a rejected options argument or option value for the `TypeError` message without running
 * the value's own code: no `JSON.stringify` (a `toJSON` method or a Proxy `get` trap would run,
 * and a bigint or a cycle would make JSON throw its own error), no `toString`, no `valueOf`
 */
function describe(value: unknown): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value); // a primitive string has no toJSON to call
    case "number":
    case "boolean":
    case "undefined":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    default:
      return value === null ? "null" : describeObject(value as object);
  }
}

function describeObject(value: object): string {
  try {
    if (Array.isArray(value)) return "an array";
  } catch {
    return "a revoked Proxy"; // the one way `Array.isArray` throws
  }
  const proto = prototypeOf(value);
  if (proto === null) return "a null-prototype object";
  if (proto === Object.prototype) return "a plain object";
  const name = constructorName(proto);
  return name === undefined
    ? "an object whose prototype is neither Object.prototype nor null"
    : `an instance of ${name}`;
}

/**
 * The class name of a rejected object, for the diagnostic only. `constructor` and `name` are read
 * as own data properties through descriptors, never dereferenced: on a user-controlled prototype
 * either can be an accessor, and user code must not run (or throw something other than the
 * promised `TypeError`) inside the formatting of an error message. Anything unusual (an accessor,
 * an inherited `constructor`, a Proxy trap) gives up the name and falls back to the generic text
 */
function constructorName(proto: object | undefined): string | undefined {
  if (proto === undefined) return undefined;
  const ctor = ownDataProperty(proto, "constructor");
  if (typeof ctor !== "function") return undefined;
  const name = ownDataProperty(ctor, "name");
  return typeof name === "string" && name !== "" && name !== "Object" ? name : undefined;
}

/** The value of an own data property; `undefined` for an accessor, a missing property or a throwing Proxy trap */
function ownDataProperty(target: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
