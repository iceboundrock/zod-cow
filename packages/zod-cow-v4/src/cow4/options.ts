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
   *             undeclared own enumerable symbol key (`Object.getOwnPropertySymbols`), because
   *             stock's rebuild drops such keys. Exact stock semantics; about 36 ns per object.
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
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError(
      `compile options must be a plain object, got ${options === null ? "null" : Array.isArray(options) ? "an array" : typeof options}`,
    );
  }
  const ownSymbolKeys = options.ownSymbolKeys ?? DEFAULT_OPTIONS.ownSymbolKeys;
  if (!OWN_SYMBOL_KEYS.includes(ownSymbolKeys)) {
    throw new TypeError(
      `compile option ownSymbolKeys must be one of ${OWN_SYMBOL_KEYS.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(ownSymbolKeys)}`,
    );
  }
  return ownSymbolKeys === DEFAULT_OPTIONS.ownSymbolKeys ? DEFAULT_OPTIONS : { ownSymbolKeys };
}
