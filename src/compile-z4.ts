/**
 * CoW 编译器 — zod4 前端。
 *
 * 与 zod3 前端 (compile.ts) 共享 internal.ts 的核心协议：
 *   (data, ctx) => value | FAILED，引用比较即脏信号，CoW 路径拷贝。
 *
 * zod4 的差异点（全部经 src/probe-z4.ts 实测锚定，zod 4.5.4）：
 *   1. checks 是扁平数组挂在类型 def 上（z3 是包装类型）；check 条目可能是
 *      实例（c._zod.def）或裸 def（z.email()/z.iso.* 直接存 def）→ 统一归一化；
 *   2. 对象输出 = 空 {} 逐键重建：缺席 optional 键不物化、present-undefined
 *      保留、缺席必填键报 nonoptional —— 由 child._zod.optin/optout 驱动；
 *   3. strict/loose = catchall never/unknown（z3 是 unknownKeys 标志）；
 *   4. .transform() = pipe(in, transform)；transform fn(value, payload{issues,addIssue})；
 *   5. default 短路（默认值不再过内层校验，与 z3 相反）；
 *   6. catch 不再吞异常（z3 会吞）；
 *   7. refine = def.checks 里的 custom check；所有 check 实例都有惰性编译的
 *      _zod.check(payload) —— 作为未手写 kind 的通用通道；
 *   8. string_format 检查自带 pattern 正则（email/uuid/datetime…全部内联化）；
 *   9. .int() = number_format "safeint"（isInteger + 2^53 范围）。
 */
import {
  type Ctx,
  FAILED,
  type Validator,
  ZcNotSupportedError,
  parsedType,
  pushInvalidType,
  pushIssue,
  safeSet,
} from "./internal.js";

/* ────────────────────────── 基础工具 ────────────────────────── */

const getDef = (s: any): any => s?._zod?.def ?? s?.def;

const hasOwn = (o: object, k: string): boolean => Object.hasOwn(o, k);

/** check 条目归一化：实例（c._zod.def）或裸 def 直接返回 */
const checkDef = (c: any): any => c?._zod?.def ?? c;

/**
 * def.checks 归一化：z4 里 z.email()/z.iso.datetime()/z.int() 把 format check
 * 直接挂在 def 本身（def.check = "string_format"…，无 checks 数组）。
 * 返回 checks 数组（含 def 自身作为隐式 check）。
 */
function defChecks(def: any): any[] {
  const arr: any[] = def.checks ? [...def.checks] : [];
  if (def.check) arr.push(def);
  return arr;
}

/* ────────────────────────── 通用 check 通道 ────────────────────────── */

/**
 * 未手写内联的 check kind 走这条通道：调用 zod4 自己编译好的 check 函数，
 * 语义与 stock 逐字一致（refine 布尔、.check(ctx)、superRefine、starts_with…全兼容）。
 * 代价是每次调用一个小 payload 对象 —— 只用于非热路径 kind。
 */
function genericCheck(chk: any): (v: any, ctx: Ctx) => any {
  const fn = chk?._zod?.check;
  const kind = checkDef(chk)?.check ?? "?";
  if (typeof fn !== "function") {
    throw new ZcNotSupportedError(`zod4 check kind "${kind}"（无通用通道）`);
  }
  return (v, ctx) => {
    const payload = { value: v, issues: [] as any[] };
    const r = fn(payload);
    if (r instanceof Promise) {
      throw new ZcNotSupportedError("async check（同步编译器只接受同步校验）");
    }
    if (payload.issues.length) {
      for (const iss of payload.issues) {
        const out: any = {
          code: iss.code ?? "custom",
          message: iss.message ?? `Invalid input (${iss.code ?? "custom"}).`,
          path: [...ctx.path, ...((iss as any).path ?? [])],
        };
        for (const k of [
          "minimum",
          "maximum",
          "multipleOf",
          "keys",
          "expected",
          "received",
          "format",
          "validation",
        ]) {
          if (iss[k] !== undefined) out[k] = iss[k];
        }
        ctx.issues.push(out);
      }
      return FAILED;
    }
    return payload.value;
  };
}

/* ────────────────────────── string ────────────────────────── */

type StrStep = (v: string, ctx: Ctx) => string | typeof FAILED;

function stringStep(chk: any): StrStep {
  const c = checkDef(chk);
  switch (c.check) {
    case "min_length": {
      const n: number = c.minimum;
      return (v, ctx) => {
        if (v.length < n) {
          pushIssue(ctx, "too_small", `Too small: expected string to have >=${n} characters`, {
            minimum: n,
            origin: "string",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    case "max_length": {
      const n: number = c.maximum;
      return (v, ctx) => {
        if (v.length > n) {
          pushIssue(ctx, "too_big", `Too big: expected string to have <=${n} characters`, {
            maximum: n,
            origin: "string",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    case "length_equals": {
      const n: number = c.length;
      return (v, ctx) => {
        if (v.length !== n) {
          pushIssue(
            ctx,
            v.length < n ? "too_small" : "too_big",
            `Invalid input: expected string to have exactly ${n} character(s)`,
            { minimum: n, maximum: n, origin: "string", inclusive: true },
          );
          return FAILED;
        }
        return v;
      };
    }
    case "regex": {
      const re: RegExp | undefined = c.regex ?? c.pattern;
      if (!(re instanceof RegExp)) return genericCheck(chk);
      return (v, ctx) => {
        if (!re.test(v)) {
          pushIssue(ctx, "invalid_string", c.message ?? "Invalid input: failed regex", {
            validation: "regex",
          });
          return FAILED;
        }
        return v;
      };
    }
    case "string_format": {
      // email/uuid/datetime/ipv4… 全部自带 pattern 正则 → 内联
      const re: RegExp | undefined = c.pattern;
      if (!(re instanceof RegExp)) {
        // 无 pattern 的 format（如 url 用 URL 构造器判定）→ 通用通道兜不住时抛错
        return genericCheck(chk);
      }
      const fmt: string = c.format ?? "format";
      return (v, ctx) => {
        if (!re.test(v)) {
          pushIssue(ctx, "invalid_format", `Invalid input: expected ${fmt}`, { format: fmt });
          return FAILED;
        }
        return v;
      };
    }
    case "overwrite": {
      // trim / toLowerCase / toUpperCase：返回新字符串，父层引用比较自动判脏
      const tx: (v: string) => string = c.tx;
      return (v) => tx(v);
    }
    default:
      // custom（refine / .check()）、starts_with、ends_with、includes… → 通用通道
      return genericCheck(chk) as unknown as StrStep;
  }
}

function makeString(def: any): Validator {
  const steps: StrStep[] = defChecks(def).map(stringStep);
  const coerce = def.coerce === true;
  return (data, ctx) => {
    if (coerce && typeof data !== "string") {
      try {
        data = String(data);
      } catch {
        /* keep */
      }
    }
    if (typeof data !== "string") {
      pushInvalidType(ctx, "string", parsedType(data));
      return FAILED;
    }
    let v: string | typeof FAILED = data;
    for (let i = 0; i < steps.length; i++) {
      v = steps[i]!(v, ctx);
      if (v === FAILED) return FAILED;
    }
    return v;
  };
}

/* ────────────────────────── number ────────────────────────── */

type NumStep = (v: number, ctx: Ctx) => number | typeof FAILED;

function numberStep(chk: any): NumStep {
  const c = checkDef(chk);
  switch (c.check) {
    case "greater_than": {
      const n = c.value;
      const inc = c.inclusive !== false;
      return (v, ctx) => {
        if (inc ? v < n : v <= n) {
          pushIssue(
            ctx,
            "too_small",
            inc
              ? `Too small: expected number to be >=${n}`
              : `Too small: expected number to be >${n}`,
            { minimum: n, origin: "number", inclusive: inc },
          );
          return FAILED;
        }
        return v;
      };
    }
    case "less_than": {
      const n = c.value;
      const inc = c.inclusive !== false;
      return (v, ctx) => {
        if (inc ? v > n : v >= n) {
          pushIssue(
            ctx,
            "too_big",
            inc ? `Too big: expected number to be <=${n}` : `Too big: expected number to be <${n}`,
            { maximum: n, origin: "number", inclusive: inc },
          );
          return FAILED;
        }
        return v;
      };
    }
    case "number_format": {
      // z.number().int() 与 z.int() 都是 format "safeint"
      if (c.format === "safeint" || c.format === "int") {
        return (v, ctx) => {
          if (!Number.isInteger(v)) {
            pushIssue(ctx, "invalid_type", `Invalid input: expected int, received number`, {
              expected: "int",
              received: "number",
            });
            return FAILED;
          }
          if (v > Number.MAX_SAFE_INTEGER || v < Number.MIN_SAFE_INTEGER) {
            pushIssue(
              ctx,
              "too_big",
              `Too big: expected number to be <=${Number.MAX_SAFE_INTEGER}`,
              {
                maximum: Number.MAX_SAFE_INTEGER,
                origin: "number",
                inclusive: true,
              },
            );
            return FAILED;
          }
          return v;
        };
      }
      return genericCheck(chk) as unknown as NumStep;
    }
    case "multiple_of": {
      const n = c.value;
      return (v, ctx) => {
        if (v % n !== 0) {
          pushIssue(ctx, "not_multiple_of", `Invalid input: expected ${n}n%N === 0`, {
            multiple: n,
            origin: "number",
          });
          return FAILED;
        }
        return v;
      };
    }
    default:
      return genericCheck(chk) as unknown as NumStep;
  }
}

function makeNumber(def: any): Validator {
  const steps: NumStep[] = defChecks(def).map(numberStep);
  const coerce = def.coerce === true;
  return (data, ctx) => {
    if (coerce && typeof data !== "number") {
      try {
        data = Number(data);
      } catch {
        /* keep */
      }
    }
    if (typeof data !== "number") {
      pushInvalidType(ctx, "number", parsedType(data));
      return FAILED;
    }
    if (Number.isNaN(data)) {
      // z4 语义：z.number() 拒绝 NaN（received: nan → invalid_type）
      pushInvalidType(ctx, "number", "nan");
      return FAILED;
    }
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]!(data, ctx) === FAILED) return FAILED;
    }
    return data; // 原始值：返回即透传
  };
}

/* ────────────────────────── 其余叶子 ────────────────────────── */

function makeDate(def: any): Validator {
  const steps = defChecks(def).map((chk) => {
    const c = checkDef(chk);
    if (c.check === "greater_than" || c.check === "less_than") {
      const n: Date = c.value;
      const inc = c.inclusive !== false;
      const isMin = c.check === "greater_than";
      const t = n instanceof Date ? n.getTime() : Number(n);
      return (v: Date, ctx: Ctx): Date | typeof FAILED => {
        const cur = v.getTime();
        if (isMin ? (inc ? cur < t : cur <= t) : inc ? cur > t : cur >= t) {
          pushIssue(ctx, isMin ? "too_small" : "too_big", `Invalid Date`, {
            [isMin ? "minimum" : "maximum"]: t,
            origin: "date",
            inclusive: inc,
          });
          return FAILED;
        }
        return v;
      };
    }
    return genericCheck(chk);
  });
  const coerce = def.coerce === true;
  return (data, ctx) => {
    if (coerce && !(data instanceof Date)) {
      const d = new Date(data as any);
      if (Number.isNaN(d.getTime())) {
        pushIssue(ctx, "invalid_date", "Invalid input: invalid Date");
        return FAILED;
      }
      data = d;
    }
    if (!(data instanceof Date)) {
      pushInvalidType(ctx, "date", parsedType(data));
      return FAILED;
    }
    if (Number.isNaN(data.getTime())) {
      pushIssue(ctx, "invalid_date", "Invalid input: invalid Date");
      return FAILED;
    }
    for (const s of steps) {
      if (s(data, ctx) === FAILED) return FAILED;
    }
    return data; // Date 对象：原引用透传（CoW 友好）
  };
}

function makeLiteral(def: any): Validator {
  const values: unknown[] = def.values ?? [];
  const set = new Set<unknown>(values);
  const hasNaN = values.some((v) => typeof v === "number" && Number.isNaN(v));
  const expected = values
    .map((v) => (typeof v === "bigint" ? `${v}n` : (JSON.stringify(v) ?? String(v))))
    .join(" | ");
  return (data, ctx) => {
    if (set.has(data) || (hasNaN && Number.isNaN(data))) return data;
    pushIssue(
      ctx,
      "invalid_value",
      `Invalid input: expected ${expected}, received ${parsedType(data)}`,
      {
        expected: String(values[0]),
        received: parsedType(data),
      },
    );
    return FAILED;
  };
}

function makeEnum(def: any): Validator {
  const set = new Set<unknown>(Object.values(def.entries ?? {}));
  const expected = [...set].map((v) => JSON.stringify(v)).join(" | ");
  return (data, ctx) => {
    if (set.has(data)) return data;
    pushIssue(
      ctx,
      "invalid_value",
      `Invalid input: expected ${expected}, received ${typeof data === "string" ? JSON.stringify(data) : parsedType(data)}`,
      {
        received: String(data),
      },
    );
    return FAILED;
  };
}

/* ────────────────────────── object（CoW 核心，z4 语义） ────────────────────────── */

function makeObject(def: any): Validator {
  const shape: Record<string, any> = def.shape;
  if (!shape || typeof shape !== "object") throw new ZcNotSupportedError("object def.shape");

  const keys = Object.keys(shape);
  // shape 键是编译期已知的：除非包含危险键名，主循环可直接赋值（免 safeSet 开销）
  let needsSafeSet = false;
  for (const k of keys) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      needsSafeSet = true;
      break;
    }
  }
  const children: Validator[] = new Array(keys.length);
  const optin: (string | undefined)[] = new Array(keys.length);
  const optout: (string | undefined)[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const child = shape[keys[i]!];
    children[i] = go(child);
    optin[i] = child._zod?.optin;
    optout[i] = child._zod?.optout;
  }
  const keySet = new Set(keys);

  const catchall = def.catchall;
  let mode: 0 | 1 | 2 | 3 = 0;
  let catchallV: Validator | null = null;
  if (catchall) {
    const ct = getDef(catchall)?.type;
    if (ct === "never") mode = 1;
    else if (ct === "unknown" || ct === "any") mode = 2;
    else {
      mode = 3;
      catchallV = go(catchall);
    }
  }

  return (data, ctx): any => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      pushInvalidType(ctx, "object", parsedType(data));
      return FAILED;
    }

    let out: any = data; // 乐观假设：直接用原对象
    let dirty = false;
    let anyFailed = false;

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      // 与 stock 对齐：`key in input`（含原型链）而非 hasOwn —— 且更快
      const isPresent = k in data;
      const inVal = data[k];

      // 缺席 + optional-in/out：零工作跳过（stock 不物化该键）
      if (!isPresent && optout[i] === "optional" && optin[i] === "optional") continue;

      ctx.path.push(k);
      const outVal = children[i]!(inVal, ctx);
      if (outVal === FAILED) {
        ctx.path.pop();
        anyFailed = true; // 继续收集其余字段的 issue（与 stock 一致）
        continue;
      }
      if (!isPresent && optin[i] === undefined) {
        // 缺席必填键：即使子校验器接受 undefined（如 union 带 undefined 分支）也报 nonoptional
        pushIssue(ctx, "invalid_type", "Invalid input: expected nonoptional, received undefined", {
          expected: "nonoptional",
          received: "undefined",
        });
        ctx.path.pop();
        anyFailed = true;
        continue;
      }
      ctx.path.pop();

      // 引用比较即脏信号：present-undefined 保留（undefined === undefined 不写）、
      // 缺席键产出 undefined 不物化（undefined === undefined 不写）——全部涌现
      if (outVal !== inVal && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = { ...data };
        }
        if (needsSafeSet) safeSet(out, k, outVal);
        else out[k] = outVal;
      }
    }
    if (anyFailed) return FAILED;

    // 多余键处理
    if (mode === 0) {
      // strip：只需知道“有没有”多余键（零分配 for-in，首见即停）
      let hasExtra = false;
      for (const k in data) {
        if (keySet.has(k)) continue;
        hasExtra = true;
        break;
      }
      if (hasExtra) {
        // strip：绝不原地删 —— 需要一份干净副本
        if (!dirty) {
          out = {};
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i]!;
            // z4 语义：present 键保留（含 undefined）；缺席键不物化（与 stock 同用 in）
            if (k in data) out[k] = data[k];
          }
        } else {
          for (const k in data) {
            if (!keySet.has(k)) delete out[k];
          }
        }
      }
    } else if (mode === 1) {
      // strict：收集全部多余键报错
      const extras: string[] = [];
      for (const k in data) {
        if (keySet.has(k)) continue;
        extras.push(k);
      }
      if (extras.length > 0) {
        pushIssue(
          ctx,
          "unrecognized_keys",
          `Unrecognized key(s) in object: ${extras.map((k) => `'${k}'`).join(", ")}`,
          {
            keys: extras,
          },
        );
        return FAILED;
      }
    } else if (mode === 3) {
      // 真实 catchall：对多余键跑 catchall 校验器
      for (const k in data) {
        if (k === "__proto__") continue; // stock：永不拷贝未声明 __proto__
        if (keySet.has(k)) continue;
        const inVal = data[k];
        ctx.path.push(k);
        const outVal = catchallV!(inVal, ctx);
        ctx.path.pop();
        if (outVal === FAILED) return FAILED;
        if (outVal !== inVal) {
          if (!dirty) {
            dirty = true;
            out = { ...data };
          }
          safeSet(out, k, outVal);
        }
      }
    }

    if (mode === 2 && hasOwn(data, "__proto__")) {
      // loose 模式：stock 永不把未声明 __proto__ 拷进输出
      out = {};
      for (const k in data) {
        if (k === "__proto__") continue;
        out[k] = data[k];
      }
      for (const s of Object.getOwnPropertySymbols(data)) (out as any)[s] = (data as any)[s];
    }

    return out; // 纯场景：=== data，原引用直达
  };
}

/* ────────────────────────── array / tuple ────────────────────────── */

type ArrStep = (v: unknown[], ctx: Ctx) => unknown[] | typeof FAILED;

function arrayStep(chk: any): ArrStep {
  const c = checkDef(chk);
  switch (c.check) {
    case "min_length": {
      const n: number = c.minimum;
      return (v, ctx) => {
        if (v.length < n) {
          pushIssue(ctx, "too_small", `Too small: expected array to have >=${n} items`, {
            minimum: n,
            origin: "array",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    case "max_length": {
      const n: number = c.maximum;
      return (v, ctx) => {
        if (v.length > n) {
          pushIssue(ctx, "too_big", `Too big: expected array to have <=${n} items`, {
            maximum: n,
            origin: "array",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    case "length_equals": {
      const n: number = c.length;
      return (v, ctx) => {
        if (v.length !== n) {
          pushIssue(
            ctx,
            v.length < n ? "too_small" : "too_big",
            `Invalid input: expected array to have exactly ${n} item(s)`,
            {
              minimum: n,
              maximum: n,
              origin: "array",
              inclusive: true,
            },
          );
          return FAILED;
        }
        return v;
      };
    }
    default:
      return genericCheck(chk) as unknown as ArrStep;
  }
}

function makeArray(def: any): Validator {
  const el = go(def.element);
  const steps: ArrStep[] = (def.checks ?? []).map(arrayStep);
  return (data, ctx): any => {
    if (!Array.isArray(data)) {
      pushInvalidType(ctx, "array", parsedType(data));
      return FAILED;
    }
    for (const s of steps) {
      if (s(data, ctx) === FAILED) return FAILED;
    }
    let out: any[] = data;
    let dirty = false;
    let anyFailed = false;
    for (let i = 0; i < data.length; i++) {
      ctx.path.push(i);
      const outVal = el(data[i], ctx);
      ctx.path.pop();
      if (outVal === FAILED) {
        anyFailed = true; // 继续收集其余元素的 issue（与 stock 一致）
        continue;
      }
      if (outVal !== data[i] && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = data.slice(); // 第一次“被迫”才 slice —— 其余元素持续共享
        }
        out[i] = outVal;
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

function makeTuple(def: any): Validator {
  const items: Validator[] = (def.items ?? []).map(go);
  const rest = def.rest ? go(def.rest) : null;
  return (data, ctx): any => {
    if (!Array.isArray(data)) {
      pushInvalidType(ctx, "array", parsedType(data));
      return FAILED;
    }
    if (data.length < items.length || (!rest && data.length > items.length)) {
      pushIssue(
        ctx,
        data.length < items.length ? "too_small" : "too_big",
        `Invalid input: expected tuple of ${items.length} item(s)`,
        { minimum: items.length, maximum: items.length, origin: "array", inclusive: true },
      );
      return FAILED;
    }
    let out: any[] = data;
    let dirty = false;
    let anyFailed = false;
    const n = rest ? data.length : items.length;
    for (let i = 0; i < n; i++) {
      const v = i < items.length ? items[i]! : rest!;
      ctx.path.push(i);
      const outVal = v(data[i], ctx);
      ctx.path.pop();
      if (outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if (outVal !== data[i] && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = data.slice();
        }
        out[i] = outVal;
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

/* ────────────────────────── record / map / set ────────────────────────── */

function makeRecord(def: any): Validator {
  const keyV = go(def.keyType);
  const valV = go(def.valueType);
  if (def.partial) throw new ZcNotSupportedError("partial record");

  // 声明键驱动（stock 语义）：keyType 有已知 values（enum/literal）时，
  // 声明键全部必填（缺键 → valueType(undefined) 的 issue），多余键 → unrecognized_keys
  const keyValues: Set<unknown> | undefined = def.keyType?._zod?.values;
  if (keyValues && keyValues.size > 0) {
    const declared: string[] = [];
    for (const kv of keyValues) {
      if (typeof kv === "string") declared.push(kv);
      else if (typeof kv === "number") declared.push(String(kv));
    }
    if (declared.length !== keyValues.size) {
      // 含 symbol/其他类型声明键 —— 原型不覆盖，回退报错
      throw new ZcNotSupportedError("record with non-string/number enum keys");
    }
    const declaredSet = new Set(declared);
    return (data, ctx): any => {
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        pushInvalidType(ctx, "record", parsedType(data));
        return FAILED;
      }
      let out: any = data;
      let dirty = false;
      let anyFailed = false;
      for (const k of declared) {
        const isPresent = hasOwn(data, k);
        const inVal = data[k];
        ctx.path.push(k);
        const keyRes = keyV(k, ctx); // stock 会对声明键值跑一遍 keyType
        let failed = keyRes === FAILED;
        let outVal: unknown;
        if (!failed) {
          outVal = valV(inVal, ctx);
          failed = outVal === FAILED;
        }
        ctx.path.pop();
        if (failed) {
          anyFailed = true;
          continue;
        }
        if (outVal !== inVal && !anyFailed) {
          if (outVal === undefined && !isPresent) continue;
          if (!dirty) {
            dirty = true;
            out = { ...data };
          }
          safeSet(out, k, outVal);
        }
      }
      if (anyFailed) return FAILED;
      const extras: string[] = [];
      for (const k in data) {
        if (hasOwn(data, k) && !declaredSet.has(k)) extras.push(k);
      }
      if (extras.length > 0) {
        pushIssue(
          ctx,
          "unrecognized_keys",
          `Unrecognized key(s) in record: ${extras.map((k) => `'${k}'`).join(", ")}`,
          {
            keys: extras,
          },
        );
        return FAILED;
      }
      return out;
    };
  }

  // 输入键驱动（string/number 键）
  return (data, ctx): any => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      pushInvalidType(ctx, "record", parsedType(data));
      return FAILED;
    }
    let out: any = data;
    let dirty = false;
    let anyFailed = false;
    for (const k of Reflect.ownKeys(data)) {
      if (k === "__proto__") continue; // 与 stock 一致：永不处理/拷贝 __proto__
      if (!Object.prototype.propertyIsEnumerable.call(data, k)) continue;
      const inVal = (data as any)[k];

      let outKey: unknown = k;
      let keyFailed = false;
      if (typeof k !== "symbol") {
        const base = ctx.issues.length;
        ctx.path.push(k);
        let keyRes = keyV(k, ctx);
        if (keyRes === FAILED) {
          // 数值字符串回退（与 stock 一致）：先按字符串校验，失败再试 Number(key)
          const n = Number(k);
          if (k.trim() !== "" && !Number.isNaN(n)) {
            ctx.issues.length = base;
            keyRes = keyV(n, ctx);
          }
        }
        ctx.path.pop();
        if (keyRes === FAILED) keyFailed = true;
        else outKey = keyRes;
      } else {
        ctx.path.push(k as any);
        const keyRes = keyV(k, ctx);
        ctx.path.pop();
        if (keyRes === FAILED) keyFailed = true;
        else outKey = keyRes;
      }

      if (keyFailed) {
        anyFailed = true; // 键/值互不影响，继续收集（与 stock 一致）
        continue;
      }

      ctx.path.push(k as any);
      const outVal = valV(inVal, ctx);
      ctx.path.pop();
      if (outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if ((outKey !== k || outVal !== inVal) && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = { ...data };
        }
        if (outKey !== k) delete out[k as any];
        if (typeof outKey === "symbol") (out as any)[outKey] = outVal;
        else safeSet(out, outKey as string, outVal);
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

function makeMap(def: any): Validator {
  const keyV = go(def.keyType);
  const valV = go(def.valueType);
  const steps = (def.checks ?? []).map((chk: any) => {
    const c = checkDef(chk);
    if (c.check === "min_size" || c.check === "min_length") {
      const n = c.size ?? c.minimum;
      return (v: Map<any, any>, ctx: Ctx) => {
        if (v.size < n) {
          pushIssue(ctx, "too_small", `Too small: expected map to have >=${n} entries`, {
            minimum: n,
            origin: "map",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    if (c.check === "max_size" || c.check === "max_length") {
      const n = c.size ?? c.maximum;
      return (v: Map<any, any>, ctx: Ctx) => {
        if (v.size > n) {
          pushIssue(ctx, "too_big", `Too big: expected map to have <=${n} entries`, {
            maximum: n,
            origin: "map",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    return genericCheck(chk);
  });
  return (data, ctx): any => {
    if (!(data instanceof Map)) {
      pushInvalidType(ctx, "map", parsedType(data));
      return FAILED;
    }
    for (const s of steps) {
      if (s(data, ctx) === FAILED) return FAILED;
    }
    let out: Map<any, any> = data;
    let dirty = false;
    let anyFailed = false;
    for (const [k, v] of data) {
      ctx.path.push(k as any);
      const outKey = keyV(k, ctx);
      const outVal = outKey === FAILED ? FAILED : valV(v, ctx);
      ctx.path.pop();
      if (outKey === FAILED || outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if ((outKey !== k || outVal !== v) && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = new Map(data);
        }
        if (outKey !== k) out.delete(k);
        out.set(outKey, outVal);
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

function makeSet(def: any): Validator {
  const valV = go(def.valueType);
  const steps = (def.checks ?? []).map((chk: any) => {
    const c = checkDef(chk);
    if (c.check === "min_size" || c.check === "min_length") {
      const n = c.size ?? c.minimum;
      return (v: Set<any>, ctx: Ctx) => {
        if (v.size < n) {
          pushIssue(ctx, "too_small", `Too small: expected set to have >=${n} entries`, {
            minimum: n,
            origin: "set",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    if (c.check === "max_size" || c.check === "max_length") {
      const n = c.size ?? c.maximum;
      return (v: Set<any>, ctx: Ctx) => {
        if (v.size > n) {
          pushIssue(ctx, "too_big", `Too big: expected set to have <=${n} entries`, {
            maximum: n,
            origin: "set",
            inclusive: true,
          });
          return FAILED;
        }
        return v;
      };
    }
    if (c.check === "size_equals" || c.check === "length_equals") {
      const n = c.size ?? c.length;
      return (v: Set<any>, ctx: Ctx) => {
        if (v.size !== n) {
          pushIssue(
            ctx,
            v.size < n ? "too_small" : "too_big",
            `Invalid input: expected set to have exactly ${n} entries`,
            { minimum: n, maximum: n, origin: "set", inclusive: true },
          );
          return FAILED;
        }
        return v;
      };
    }
    return genericCheck(chk);
  });
  return (data, ctx): any => {
    if (!(data instanceof Set)) {
      pushInvalidType(ctx, "set", parsedType(data));
      return FAILED;
    }
    for (const s of steps) {
      if (s(data, ctx) === FAILED) return FAILED;
    }
    let out: Set<any> = data;
    let dirty = false;
    let anyFailed = false;
    for (const item of data) {
      const outVal = valV(item, ctx);
      if (outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if (outVal !== item && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = new Set(data);
        }
        out.delete(item);
        out.add(outVal);
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

/* ────────────────────────── union ────────────────────────── */

function makeUnion(def: any): Validator {
  const opts: Validator[] = def.options.map(go);
  return (data, ctx): any => {
    const base = ctx.issues.length;
    for (let i = 0; i < opts.length; i++) {
      const r = opts[i]!(data, ctx);
      if (r !== FAILED) return r;
      ctx.issues.length = base; // 截断该分支产生的 issue
    }
    pushIssue(ctx, "invalid_union", "Invalid input");
    return FAILED;
  };
}

/* ────────────────────────── 包装类节点 ────────────────────────── */

function makeTransform(def: any): Validator {
  const tx: (v: any, payload: any) => any = def.transform;
  return (data, ctx) => {
    const payload = { value: data, issues: [] as any[] };
    const shim = {
      ...payload,
      addIssue: (arg: any) => {
        const issue: any =
          typeof arg === "string"
            ? { code: "custom", message: arg }
            : { code: arg?.code ?? "custom", message: arg?.message ?? "Invalid input.", ...arg };
        ctx.issues.push({ ...issue, path: [...ctx.path, ...(issue.path ?? [])] });
      },
    };
    const out = tx(data, shim);
    if (out instanceof Promise) {
      throw new ZcNotSupportedError("async transform（同步编译器只接受同步变换）");
    }
    if (payload.issues.length) return FAILED;
    return out; // 返回新值 → 父层引用比较自动判脏
  };
}

function makePipe(def: any): Validator {
  const a = go(def.in);
  const b = go(def.out);
  return (data, ctx) => {
    const r = a(data, ctx);
    if (r === FAILED) return FAILED;
    return b(r, ctx); // 脏标记沿链自然传播
  };
}

function makeDefault(def: any): Validator {
  const inner = go(def.innerType);
  const dv = def.defaultValue;
  return (data, ctx) => {
    if (data === undefined) {
      // z4 语义：default 短路 —— 默认值不再过内层校验（与 z3 相反，探针 P9）
      return typeof dv === "function" ? dv() : dv; // 新值 → 父层自动判脏
    }
    const r = inner(data, ctx);
    if (r === FAILED) return FAILED;
    // handleDefaultResult：内层成功但产出 undefined（如 transform→undefined）→ 替换为默认值
    if (r === undefined) return typeof dv === "function" ? dv() : dv;
    return r;
  };
}

function makePrefault(def: any): Validator {
  const inner = go(def.innerType);
  const dv = def.defaultValue;
  return (data, ctx) => {
    // prefault：默认值作为输入“过一遍” schema（与 default 的区别）
    if (data === undefined) return inner(typeof dv === "function" ? dv() : dv, ctx);
    return inner(data, ctx);
  };
}

function makeCatch(def: any): Validator {
  const inner = go(def.innerType);
  const cv = def.catchValue;
  return (data, ctx) => {
    const base = ctx.issues.length;
    // z4 语义：异常向上传播，catch 只接校验失败（探针 P12c）
    const r = inner(data, ctx);
    if (r !== FAILED) return r;
    const innerIssues = ctx.issues.slice(base);
    ctx.issues.length = base; // 丢弃内部 issue（stock 用独立 payload，同样不透出）
    const args = { value: data, issues: innerIssues, error: undefined, input: data };
    return typeof cv === "function" ? cv(args) : cv;
  };
}

function makeReadonly(def: any): Validator {
  const inner = go(def.innerType);
  return (data, ctx) => {
    const r = inner(data, ctx);
    if (r === FAILED) return FAILED;
    // 与 stock 一致：浅冻结（handleReadonlyResult）
    if (r !== null && (typeof r === "object" || typeof r === "function")) Object.freeze(r);
    return r;
  };
}

/* ────────────────────────── 编译缓存与分发器 ────────────────────────── */

const cache = new WeakMap<object, Validator>();

/**
 * 编译入口：schema 树 → 特化校验闭包。
 * “先占位、后替换”处理 z.lazy 递归：占位闭包在真实编译器就绪前转发。
 */
export function go(schema: any): Validator {
  const hit = cache.get(schema);
  if (hit) return hit;

  let real: Validator | undefined;
  const placeholder: Validator = (data, ctx) => real!(data, ctx);
  cache.set(schema, placeholder);

  const def = getDef(schema);
  if (!def) throw new ZcNotSupportedError("非 zod schema（无 _zod.def）");
  real = build(schema, def);
  cache.set(schema, real);
  return real;
}

function build(schema: any, def: any): Validator {
  switch (def.type) {
    case "string":
      return makeString(def);
    case "number":
      return makeNumber(def);
    case "boolean":
      return (data, ctx) => {
        if (def.coerce === true && typeof data !== "boolean") data = Boolean(data);
        if (typeof data !== "boolean") {
          pushInvalidType(ctx, "boolean", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "bigint": {
      const bigSteps = defChecks(def).map((chk: any) => {
        const c = checkDef(chk);
        if (c.check === "greater_than" || c.check === "less_than") {
          const n = c.value;
          const inc = c.inclusive !== false;
          const isMin = c.check === "greater_than";
          if (typeof n !== "bigint") return genericCheck(chk);
          return (v: bigint, ctx: Ctx): bigint | typeof FAILED => {
            if (isMin ? (inc ? v < n : v <= n) : inc ? v > n : v >= n) {
              pushIssue(ctx, isMin ? "too_small" : "too_big", `Invalid input: expected bigint`, {
                [isMin ? "minimum" : "maximum"]: String(n),
                origin: "bigint",
                inclusive: inc,
              });
              return FAILED;
            }
            return v;
          };
        }
        return genericCheck(chk);
      });
      return (data, ctx) => {
        if (typeof data !== "bigint") {
          pushInvalidType(ctx, "bigint", parsedType(data));
          return FAILED;
        }
        for (const s of bigSteps) {
          if (s(data, ctx) === FAILED) return FAILED;
        }
        return data;
      };
    }
    case "symbol":
      return (data, ctx) => {
        if (typeof data !== "symbol") {
          pushInvalidType(ctx, "symbol", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "null":
      return (data, ctx) => {
        if (data !== null) {
          pushInvalidType(ctx, "null", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "undefined":
    case "void":
      return (data, ctx) => {
        if (data !== undefined) {
          pushInvalidType(ctx, def.type, parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "any":
    case "unknown":
      return (data) => data; // 全接受，纯透传
    case "never":
      return (data, ctx) => {
        pushInvalidType(ctx, "never", parsedType(data));
        return FAILED;
      };
    case "nan":
      return (data, ctx) => {
        if (typeof data !== "number" || !Number.isNaN(data)) {
          pushInvalidType(ctx, "nan", parsedType(data));
          return FAILED;
        }
        return data; // NaN !== NaN 恒真 → 父层永远判脏（输出仍正确，仅多拷贝一次）
      };
    case "date":
      return makeDate(def);
    case "literal":
      return makeLiteral(def);
    case "enum":
      return makeEnum(def);
    case "object":
      return makeObject(def);
    case "array":
      return makeArray(def);
    case "tuple":
      return makeTuple(def);
    case "record":
      return makeRecord(def);
    case "map":
      return makeMap(def);
    case "set":
      return makeSet(def);
    case "union":
      return makeUnion(def);
    case "optional": {
      // z4：inner 为 defaulted（default/prefault）时，optional 把 undefined 交给内层
      // 让 default 在此点火；否则缺席语义保持透传（stock $ZodOptional.parse）
      const innerSchema = def.innerType;
      const inner = go(innerSchema);
      const innerOptin: string | undefined = innerSchema._zod?.optin;
      return (data, ctx) => {
        if (data === undefined) {
          if (innerOptin !== "defaulted") return data;
          return inner(data, ctx);
        }
        return inner(data, ctx);
      };
    }
    case "nullable": {
      const inner = go(def.innerType);
      return (data, ctx) => (data === null ? data : inner(data, ctx));
    }
    case "default":
      return makeDefault(def);
    case "prefault":
      return makePrefault(def);
    case "catch":
      return makeCatch(def);
    case "readonly":
      return makeReadonly(def);
    case "pipe":
      return makePipe(def);
    case "transform":
      return makeTransform(def);
    case "lazy": {
      const getter: () => any = def.getter;
      let inner: Validator | null = null;
      return (data, ctx) => {
        if (inner === null) inner = go(getter()); // 首次 parse 时解析，命中 cache 完成递归
        return inner(data, ctx);
      };
    }
    case "custom":
      // z.custom(fn)：它本身就是一个 custom check-schema 混合体
      return genericCheck(schema);
    default:
      throw new ZcNotSupportedError(`zod4 def.type "${def.type}"`);
  }
}

/* ────────────────────────── 静态纯度分析 ────────────────────────── */

/**
 * 静态纯度：该 schema 是否“永远不可能产生新值”。
 * 纯 schema 的 parse 恒等返回输入引用（strip 模式假定输入不含多余键）。
 * 用于文档化与测试断言，不参与运行时逻辑（运行时以引用比较为准）。
 */
export function isStaticPure(schema: any, seen: Set<object> = new Set()): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (seen.has(schema)) return true; // z.lazy 环：环上节点视为纯
  seen.add(schema);
  const def = getDef(schema);
  if (!def) return false;
  const checksPure = (def.checks ?? []).every((c: any) => checkDef(c).check !== "overwrite");
  switch (def.type) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "null":
    case "undefined":
    case "void":
    case "any":
    case "unknown":
    case "never":
    case "nan":
    case "date":
    case "literal":
    case "enum":
    case "custom":
      return checksPure;
    case "object": {
      if (!checksPure) return false;
      for (const k of Object.keys(def.shape)) {
        if (!isStaticPure(def.shape[k], seen)) return false;
      }
      if (
        def.catchall &&
        getDef(def.catchall)?.type !== "never" &&
        getDef(def.catchall)?.type !== "unknown"
      ) {
        return isStaticPure(def.catchall, seen);
      }
      return true;
    }
    case "array":
      return checksPure && isStaticPure(def.element, seen);
    case "tuple":
      return (
        (def.items ?? []).every((it: any) => isStaticPure(it, seen)) &&
        (!def.rest || isStaticPure(def.rest, seen))
      );
    case "record":
    case "map":
      return isStaticPure(def.keyType, seen) && isStaticPure(def.valueType, seen);
    case "set":
      return isStaticPure(def.valueType, seen);
    case "union":
      return def.options.every((o: any) => isStaticPure(o, seen));
    case "optional":
    case "nullable":
    case "readonly":
      return isStaticPure(def.innerType, seen);
    case "pipe":
      return isStaticPure(def.in, seen) && isStaticPure(def.out, seen);
    case "lazy":
      return isStaticPure(def.getter(), seen);
    default:
      // default/prefault/catch/transform/intersection 等：可能产生新值
      return false;
  }
}
