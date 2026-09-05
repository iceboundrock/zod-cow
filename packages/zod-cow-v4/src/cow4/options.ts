/**
 * Compile options: the semantic switches a caller can set on `compile(schema, options)`.
 * Resolved once per compile and carried by every `CodeCtx` of the tree, so a sub-skeleton sees
 * the same options as the root.
 */

/** Options accepted by `compile(schema, options)`. Every field is optional; the defaults give stock semantics. */
export interface CompileOptions {
  /**
   * What a strip-mode object skeleton does about own symbol keys of the input (#43).
   *
   *   "probe"   (default) before returning the input by reference, prove that it carries no
   *             undeclared own symbol key (`Object.getOwnPropertySymbols`, which lists non-enumerable
   *             ones too), because stock's rebuild drops such keys. Exact stock semantics; about
   *             36 ns per object.
   *   "ignore"  skip that probe. An input whose declared keys are unchanged and which carries no
   *             undeclared string key is returned by reference even when it carries an own symbol
   *             key, which then survives where stock would drop it. For data known to carry no
   *             symbol keys (JSON input, structured-clone output) the two modes give the same
   *             result. Strict and loose objects never probe (#42); the copy path is unchanged.
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
  // Only an own property counts: a value inherited from `Object.prototype` (prototype pollution)
  // must not turn `compile(schema, {})` into something other than `compile(schema)`. An own
  // `undefined` is an absent property; anything else, `null` included, is checked as a value
  const ownSymbolKeys =
    Object.hasOwn(options, "ownSymbolKeys") && options.ownSymbolKeys !== undefined
      ? options.ownSymbolKeys
      : DEFAULT_OPTIONS.ownSymbolKeys;
  if (!OWN_SYMBOL_KEYS.includes(ownSymbolKeys)) {
    throw new TypeError(
      `compile option ownSymbolKeys must be one of ${OWN_SYMBOL_KEYS.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(ownSymbolKeys)}`,
    );
  }
  return ownSymbolKeys === DEFAULT_OPTIONS.ownSymbolKeys ? DEFAULT_OPTIONS : { ownSymbolKeys };
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

/** Formats the rejected options argument for the `TypeError` message */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value !== "object") return typeof value;
  const name = constructorName(value);
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
function constructorName(value: object): string | undefined {
  const proto = prototypeOf(value);
  if (proto === null || proto === undefined) return undefined;
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
