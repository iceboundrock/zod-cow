/**
 * 内部协议 — CoW 编译层的公共约定。
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 核心思想：每个编译后的节点是一个同步函数                                   │
 * │                                                                         │
 * │   (data, ctx) => value | FAILED                                         │
 * │                                                                         │
 * │  · 成功 → 返回解析后的值。该值可能 === data（未修改，零拷贝），             │
 * │          也可能是新引用（default 注入 / transform / strip 多余键 …）       │
 * │  · 失败 → 返回 FAILED 哨兵，issue 追加到 ctx.issues                      │
 * │                                                                         │
 * │ “值是否被修改过”不用任何标志位 —— 直接用 outVal !== inVal 判定：           │
 * │  · 原始类型（string/number/…）按值比较，校验通过永远“没变”；               │
 * │  · 对象/数组按引用比较，子节点透传原引用 → 父层无需拷贝；                   │
 * │  · 变换类节点（transform/default/coerce/catch）返回新值 →                 │
 * │    “脏”信号沿引用比较自然向上传播，父层在第一个变化点做一次浅拷贝            │
 * │    （copy-on-write / path-copying），其余兄弟子树全部共享。                │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

export const FAILED: unique symbol = Symbol("zc.FAILED");

export type PathSegment = string | number;

export interface Issue {
  code: string;
  path: PathSegment[];
  message: string;
  expected?: string;
  received?: string;
  /** unrecognized_keys 专用 */
  keys?: string[];
  /** 扩展字段（minimum / maximum / validation / multipleOf …），与 stock zod 的 issue params 对齐 */
  [param: string]: unknown;
}

export interface Ctx {
  issues: Issue[];
  /**
   * 惰性 path：整个 parse 过程复用一个可变数组，push/pop 进出子节点，
   * 只有真正产生 issue 时才 slice() 物化一份快照。
   * stock zod 则为每个节点新建 path 数组 —— 这是每节点分配的来源之一。
   */
  path: PathSegment[];
}

export type Validator = (data: any, ctx: Ctx) => any;

export class ZcNotSupportedError extends Error {
  constructor(feature: string) {
    super(`zc: schema feature not supported by the sync CoW compiler: ${feature}`);
    this.name = "ZcNotSupportedError";
  }
}

export class ZcError extends Error {
  constructor(public readonly issues: Issue[]) {
    super(
      issues.length === 0
        ? "Invalid input."
        : issues.map((i) => `[${i.code}] ${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
    );
    this.name = "ZcError";
  }
}

/* ────────────────────────── issue 辅助 ────────────────────────── */

export function pushIssue(ctx: Ctx, code: string, message: string, extra?: Partial<Issue>): void {
  ctx.issues.push({ code, path: ctx.path.slice(), message, ...extra });
}

/** 在显式路径上追加 issue（如 discriminated union 的 discriminator 键） */
export function pushIssueAt(
  ctx: Ctx,
  path: PathSegment[],
  code: string,
  message: string,
  extra?: Partial<Issue>,
): void {
  ctx.issues.push({ code, path: path.slice(), message, ...extra });
}

export function pushInvalidType(ctx: Ctx, expected: string, received: string): void {
  pushIssue(ctx, "invalid_type", `Expected ${expected}, received ${received}`, {
    expected,
    received,
  });
}

/**
 * 近似 stock zod 的 getParsedType —— 只用于 issue 的 received 字段。
 * 未覆盖的类型一律回退 'object' / typeof，不影响成败判定。
 */
export function parsedType(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "object") {
    if (Array.isArray(v)) return "array";
    if (v instanceof Map) return "map";
    if (v instanceof Set) return "set";
    if (v instanceof Date) return "date";
    return "object";
  }
  if (t === "number") return Number.isNaN(v) ? "nan" : "number";
  return t;
}

/**
 * 原型污染安全的写键。`JSON.parse('{"__proto__": …}')` 会产生名为 __proto__ 的
 * own property，直接 `out[k] = v` 会改原型而不是写属性。
 */
export function safeSet(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/** 零分配检测对象自身是否含有 shape 之外的键（供 strip/strict 使用） */
export function findExtraKey(data: object, keySet: Set<string>): string | null {
  for (const k in data) {
    if (Object.hasOwn(data, k) && !keySet.has(k)) return k;
  }
  return null;
}

export function allExtraKeys(data: object, keySet: Set<string>): string[] {
  const out: string[] = [];
  for (const k in data) {
    if (Object.hasOwn(data, k) && !keySet.has(k)) out.push(k);
  }
  return out;
}
