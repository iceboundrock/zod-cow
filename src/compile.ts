/**
 * CoW 编译器 — 把 stock zod 的 schema 树编译成特化校验闭包。
 *
 * 与 stock zod（解释器）的区别：
 *   1. 不再有 { status, value } 包装对象 / ParseStatus 合并 —— 返回值直达；
 *   2. 不再为每个节点新建 ParseContext 与 path 数组 —— 单一可变 ctx + 惰性 path；
 *   3. 不再重建输出树 —— CoW：全部子值未变时返回原引用，第一个变化点才浅拷贝
 *      （path-copying：改一个叶子只拷贝它到根的一条路径，兄弟子树全部共享）；
 *   4. shape() / keys / checks / options 只在编译期解析一次（stock 每次 parse 重取）。
 *
 * 编译期缓存：全局 WeakMap<schema, validator>，同一 schema 实例只编译一次；
 * z.lazy 的 getter 推迟到首次 parse 时解析，配合“先占位后编译”即可支持递归 schema。
 */
import { z } from "zod";
import {
  type Ctx,
  FAILED,
  type Issue,
  type PathSegment,
  type Validator,
  ZcNotSupportedError,
  parsedType,
  pushInvalidType,
  pushIssue,
  safeSet,
} from "./internal.js";
import { PROBE } from "./probe.js";
import {
  BASE64_REGEX,
  BASE64URL_REGEX,
  CUID2_REGEX,
  CUID_REGEX,
  DATE_REGEX,
  DURATION_REGEX,
  EMAIL_REGEX,
  IPV4_CIDR_REGEX,
  IPV4_REGEX,
  IPV6_CIDR_REGEX,
  IPV6_REGEX,
  JWT_REGEX,
  NANOID_REGEX,
  ULID_REGEX,
  UUID_REGEX,
  datetimeRegex,
  timeRegex,
} from "./regexes.js";

/** 格式类 string check 的编译：kind → 判定函数（正则来自 regexes.ts，与 stock 逐字一致） */
function formatStringStep(c: any): StringStep {
  const kind: string = c.kind;
  const message = (): string => c.message ?? `Invalid ${kind === "email" ? "email" : kind}`;
  const re = (() => {
    switch (kind) {
      case "email":
        return EMAIL_REGEX;
      case "uuid":
        return UUID_REGEX;
      case "cuid":
        return CUID_REGEX;
      case "cuid2":
        return CUID2_REGEX;
      case "ulid":
        return ULID_REGEX;
      case "nanoid":
        return NANOID_REGEX;
      case "jwt":
        return JWT_REGEX;
      case "duration":
        return DURATION_REGEX;
      case "date":
        return DATE_REGEX;
      case "time":
        return timeRegex(c.precision ?? null);
      case "datetime":
        return datetimeRegex({
          precision: c.precision ?? null,
          offset: !!c.offset,
          local: !!c.local,
        });
      case "base64":
        return BASE64_REGEX;
      case "base64url":
        return BASE64URL_REGEX;
      default:
        return null;
    }
  })();

  if (re !== null) {
    return (v, ctx) => {
      if (!re.test(v)) {
        pushIssue(ctx, "invalid_string", message(), { validation: kind });
        return FAILED;
      }
      return v;
    };
  }

  // 非正则判定（与 stock 的判定函数一致）
  switch (kind) {
    case "url": {
      return (v, ctx) => {
        try {
          new URL(v);
        } catch {
          pushIssue(ctx, "invalid_string", message(), { validation: "url" });
          return FAILED;
        }
        return v;
      };
    }
    case "emoji": {
      // zod 惰性构建：^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$（u flag）
      const emojiRe = /^(\p{Extended_Pictographic}|\p{Emoji_Component})+$/u;
      return (v, ctx) => {
        if (!emojiRe.test(v)) {
          pushIssue(ctx, "invalid_string", message(), { validation: "emoji" });
          return FAILED;
        }
        return v;
      };
    }
    case "ip": {
      const version: string | undefined = c.version;
      return (v, ctx) => {
        const ok =
          (version === "v4" || !version) && IPV4_REGEX.test(v)
            ? true
            : (version === "v6" || !version) && IPV6_REGEX.test(v);
        if (!ok) {
          pushIssue(ctx, "invalid_string", message(), { validation: "ip" });
          return FAILED;
        }
        return v;
      };
    }
    case "cidr": {
      const version: string | undefined = c.version;
      return (v, ctx) => {
        const ok =
          (version === "v4" || !version) && IPV4_CIDR_REGEX.test(v)
            ? true
            : (version === "v6" || !version) && IPV6_CIDR_REGEX.test(v);
        if (!ok) {
          pushIssue(ctx, "invalid_string", message(), { validation: "cidr" });
          return FAILED;
        }
        return v;
      };
    }
    default:
      throw new ZcNotSupportedError(`ZodString check kind "${kind}"`);
  }
}

/* ════════════════════════════ ZodString ════════════════════════════ */

type StringStep = (v: string, ctx: Ctx) => string | typeof FAILED;

function stringStep(c: any): StringStep {
  switch (c.kind) {
    case "min": {
      const n: number = c.value;
      const inclusive = c.inclusive !== false;
      return (v, ctx) => {
        if (inclusive ? v.length < n : v.length <= n) {
          pushIssue(
            ctx,
            "too_small",
            c.message ??
              (inclusive
                ? `String must contain at least ${n} character(s)`
                : `String must contain more than ${n} character(s)`),
            { minimum: n, type: "string", inclusive },
          );
          return FAILED;
        }
        return v;
      };
    }
    case "max": {
      const n: number = c.value;
      const inclusive = c.inclusive !== false;
      return (v, ctx) => {
        if (inclusive ? v.length > n : v.length >= n) {
          pushIssue(
            ctx,
            "too_big",
            c.message ??
              (inclusive
                ? `String must contain at most ${n} character(s)`
                : `String must contain fewer than ${n} character(s)`),
            { maximum: n, type: "string", inclusive },
          );
          return FAILED;
        }
        return v;
      };
    }
    case "regex": {
      const re: RegExp = c.regex;
      return (v, ctx) => {
        if (!re.test(v)) {
          pushIssue(ctx, "invalid_string", c.message ?? "Invalid", { validation: "regex" });
          return FAILED;
        }
        return v;
      };
    }
    case "startsWith": {
      const p: string = c.value;
      return (v, ctx) => {
        if (!v.startsWith(p)) {
          pushIssue(ctx, "invalid_string", c.message ?? `Invalid input: must start with "${p}"`, {
            validation: "startsWith",
          });
          return FAILED;
        }
        return v;
      };
    }
    case "endsWith": {
      const p: string = c.value;
      return (v, ctx) => {
        if (!v.endsWith(p)) {
          pushIssue(ctx, "invalid_string", c.message ?? `Invalid input: must end with "${p}"`, {
            validation: "endsWith",
          });
          return FAILED;
        }
        return v;
      };
    }
    case "trim":
      // 变换：返回新字符串。'  x ' → 'x' 值不同 → 父层判脏；
      // 'x' → 'x' 值相同 → 不脏（零拷贝）。“按需拷贝”的原始类型版本。
      return (v) => v.trim();
    case "toLowerCase":
      return (v) => v.toLowerCase();
    case "toUpperCase":
      return (v) => v.toUpperCase();
    default:
      // 格式类校验（email/uuid/datetime/…）——正则与 stock 逐字一致
      return formatStringStep(c);
  }
}

function makeString(def: any): Validator {
  const steps: StringStep[] = (def.checks ?? []).map(stringStep);
  return (data, ctx) => {
    if (typeof data !== "string") {
      pushInvalidType(ctx, "string", parsedType(data));
      return FAILED;
    }
    let v: string | typeof FAILED = data;
    for (let i = 0; i < steps.length; i++) {
      v = steps[i](v, ctx);
      if (v === FAILED) return FAILED;
    }
    return v;
  };
}

/* ════════════════════════════ ZodNumber ════════════════════════════ */

type NumberStep = (v: number, ctx: Ctx) => number | typeof FAILED;

function numberStep(c: any): NumberStep {
  switch (c.kind) {
    case "min": {
      const n: number = c.value;
      const inclusive = c.inclusive !== false;
      return (v, ctx) => {
        if (inclusive ? v < n : v <= n) {
          pushIssue(
            ctx,
            "too_small",
            c.message ??
              (inclusive
                ? `Number must be greater than or equal to ${n}`
                : `Number must be greater than ${n}`),
            { minimum: n, type: "number", inclusive },
          );
          return FAILED;
        }
        return v;
      };
    }
    case "max": {
      const n: number = c.value;
      const inclusive = c.inclusive !== false;
      return (v, ctx) => {
        if (inclusive ? v > n : v >= n) {
          pushIssue(
            ctx,
            "too_big",
            c.message ??
              (inclusive
                ? `Number must be less than or equal to ${n}`
                : `Number must be less than ${n}`),
            { maximum: n, type: "number", inclusive },
          );
          return FAILED;
        }
        return v;
      };
    }
    case "int":
      return (v, ctx) => {
        if (!Number.isInteger(v)) {
          pushIssue(ctx, "invalid_type", c.message ?? "Expected integer, received number", {
            expected: "integer",
            received: "number",
          });
          return FAILED;
        }
        return v;
      };
    case "multipleOf":
      return (v, ctx) => {
        if (v % c.value !== 0) {
          pushIssue(
            ctx,
            "not_multiple_of",
            c.message ?? `Number must be a multiple of ${c.value}`,
            { multipleOf: c.value, type: "number" },
          );
          return FAILED;
        }
        return v;
      };
    case "finite":
      return (v, ctx) => {
        if (!Number.isFinite(v)) {
          pushIssue(ctx, "not_finite", c.message ?? "Number must be finite");
          return FAILED;
        }
        return v;
      };
    default:
      throw new ZcNotSupportedError(`ZodNumber check kind "${c.kind}"`);
  }
}

function makeNumber(def: any): Validator {
  const steps: NumberStep[] = (def.checks ?? []).map(numberStep);
  return (data, ctx) => {
    if (typeof data !== "number") {
      pushInvalidType(ctx, "number", parsedType(data));
      return FAILED;
    }
    if (Number.isNaN(data)) {
      // 与 stock 一致：z.number() 拒绝 NaN（received: 'nan'）
      pushInvalidType(ctx, "number", "nan");
      return FAILED;
    }
    for (let i = 0; i < steps.length; i++) {
      if (steps[i](data, ctx) === FAILED) return FAILED;
    }
    return data; // 原始值：返回即透传
  };
}

/* ════════════════════════════ 叶子节点 ════════════════════════════ */

function makeDate(def: any): Validator {
  const checks: any[] = def.checks ?? [];
  return (data, ctx) => {
    if (!(data instanceof Date)) {
      pushInvalidType(ctx, "date", parsedType(data));
      return FAILED;
    }
    if (Number.isNaN(data.getTime())) {
      pushIssue(ctx, "invalid_date", "Invalid date");
      return FAILED;
    }
    for (const c of checks) {
      if (c.kind === "min" && data.getTime() < c.value.getTime()) {
        pushIssue(
          ctx,
          "too_small",
          c.message ?? `Date must be greater than or equal to ${c.value.toISOString()}`,
          { minimum: c.value.getTime(), type: "date", inclusive: true },
        );
        return FAILED;
      }
      if (c.kind === "max" && data.getTime() > c.value.getTime()) {
        pushIssue(
          ctx,
          "too_big",
          c.message ?? `Date must be less than or equal to ${c.value.toISOString()}`,
          { maximum: c.value.getTime(), type: "date", inclusive: true },
        );
        return FAILED;
      }
    }
    return data;
  };
}

function literalDisplay(v: unknown): string {
  if (typeof v === "bigint") return `${v}n`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function makeLiteral(def: any): Validator {
  const value = def.value;
  return (data, ctx) => {
    if (data !== value) {
      pushIssue(
        ctx,
        "invalid_literal",
        `Invalid literal value, expected ${literalDisplay(value)}`,
        { expected: String(value), received: parsedType(data) },
      );
      return FAILED;
    }
    return data;
  };
}

function makeEnum(def: any): Validator {
  const values: (string | number)[] = def.values;
  const set = new Set<unknown>(values);
  const expected = values.map((v) => `'${String(v)}'`).join(" | ");
  return (data, ctx) => {
    if (!set.has(data)) {
      pushIssue(
        ctx,
        "invalid_enum_value",
        `Invalid enum value. Expected ${expected}, received '${String(data)}'`,
        { received: String(data) },
      );
      return FAILED;
    }
    return data;
  };
}

function makeNativeEnum(def: any): Validator {
  const obj = def.values;
  const set = new Set<unknown>();
  // 与 stock 一致：跳过数字枚举的反向映射（键为数字字符串）
  for (const k in obj) {
    if (Object.hasOwn(obj, k) && Number.isNaN(Number(k))) {
      set.add(obj[k]);
    }
  }
  const expected = [...set].map((v) => `'${String(v)}'`).join(" | ");
  return (data, ctx) => {
    if (!set.has(data)) {
      pushIssue(
        ctx,
        "invalid_enum_value",
        `Invalid enum value. Expected ${expected}, received '${String(data)}'`,
        { received: String(data) },
      );
      return FAILED;
    }
    return data;
  };
}

/* ════════════════════════════ ZodObject（CoW 核心） ════════════════════════════ */

/** parse(undefined) 是否（a）合法且（b）产出 undefined —— 如 optional/any/unknown/undefined/void */
function isUndefStable(s: z.ZodTypeAny): boolean {
  try {
    const r = s.safeParse(undefined);
    return r.success && r.data === undefined;
  } catch {
    return false;
  }
}

function makeObject(def: any): Validator {
  const mode: "strip" | "strict" | "passthrough" = def.unknownKeys ?? "strip";
  const catchall = def.catchall;
  if (catchall && !(catchall instanceof z.ZodNever)) {
    throw new ZcNotSupportedError(
      "ZodObject with catchall (only the default ZodNever is supported)",
    );
  }

  // 编译期一次性解析 shape / keys / 子编译器 / undefined 稳定性
  const shape: Record<string, z.ZodTypeAny> = def.shape();
  const keys = Object.keys(shape);
  const children: Validator[] = new Array(keys.length);
  const undefStable: boolean[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const child = shape[keys[i]!]!;
    children[i] = go(child);
    undefStable[i] = isUndefStable(child);
  }
  const keySet = new Set(keys);

  // 探针驱动的版本兼容。zod 3.24.1 实测：缺席 optional 键不物化（输出 {}）、
  // present-undefined 保留 —— 二者与透传语义天然一致，下列分支通常不触发。
  const matAbsent =
    mode === "passthrough" ? PROBE.absentOptionalKeptPassthrough : PROBE.absentOptionalKeptStrip;
  const keepPresentUndef =
    mode === "passthrough" ? PROBE.presentUndefKeptPassthrough : PROBE.presentUndefKeptStrip;

  return (data, ctx): any => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      pushInvalidType(ctx, "object", parsedType(data));
      return FAILED;
    }

    let out: any = data; // 乐观假设：直接用原对象
    let dirty = false;
    let anyFailed = false;
    let absentUndef: number[] | null = null; // 需显式补 undefined 的键（旧版本 zod 兼容）
    let presentDrop: number[] | null = null; // 需 delete 的键（旧版本 zod 兼容）

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const inVal = data[k];

      if (inVal === undefined && undefStable[i]) {
        const present = Object.hasOwn(data, k);
        if (!present && matAbsent) {
          absentUndef ??= [];
          absentUndef.push(i);
        } else if (present && !keepPresentUndef) {
          presentDrop ??= [];
          presentDrop.push(i);
        }
        continue; // 透传即可覆盖的行为：什么都不做（零开销）
      }

      ctx.path.push(k);
      const outVal = children[i]!(inVal, ctx);
      ctx.path.pop();
      if (outVal === FAILED) {
        // 失败后继续遍历其余字段 —— 与 stock 一致，一次 parse 收集全部 issue
        anyFailed = true;
        continue;
      }

      if (outVal !== inVal && !anyFailed) {
        // 第一个“被迫修改”的点 —— copy-on-write：此时才浅拷贝
        if (!dirty) {
          dirty = true;
          out = { ...data };
        }
        out[k] = outVal;
      }
    }
    if (anyFailed) return FAILED;

    if (mode !== "passthrough") {
      // strip：只需知道“有没有”多余键（零分配 for-in + Set，首见即停）
      // strict：收集全部多余键用于报错
      let extras: string[] | null = null;
      for (const k in data) {
        if (!Object.hasOwn(data, k)) continue;
        if (!keySet.has(k)) {
          if (mode === "strict") {
            extras ??= [];
            extras.push(k);
          } else {
            extras = [k];
            break;
          }
        }
      }
      if (extras !== null) {
        if (mode === "strict") {
          pushIssue(
            ctx,
            "unrecognized_keys",
            `Unrecognized key(s) in object: ${extras.map((k) => `'${k}'`).join(", ")}`,
            { keys: extras },
          );
          return FAILED;
        }
        // strip：真有多余键才需要一份干净副本（注意：绝不原地 delete，输入完好无损）
        if (!dirty) {
          dirty = true;
          out = {};
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i]!;
            // alwaysSet 语义对齐：stock 只保留“非 undefined 或输入中存在”的键
            if (data[k] !== undefined || Object.hasOwn(data, k)) {
              out[k] = data[k];
            }
          }
        } else {
          for (const k in data) {
            if (!keySet.has(k)) delete out[k];
          }
        }
      }
    }

    if (absentUndef !== null && !anyFailed) {
      if (!dirty) {
        dirty = true;
        out = { ...data };
      }
      for (const i of absentUndef) out[keys[i]!] = undefined;
    }
    if (presentDrop !== null && !anyFailed) {
      if (!dirty) {
        dirty = true;
        out = { ...data };
      }
      for (const i of presentDrop) delete out[keys[i]!];
    }

    return out; // 纯场景：=== data，原引用直达
  };
}

/* ════════════════════════════ ZodArray / ZodTuple ════════════════════════════ */

function makeArray(def: any): Validator {
  const el = go(def.type);
  const min = def.minLength?.value ?? null;
  const max = def.maxLength?.value ?? null;
  const exact = def.exactLength?.value ?? null;
  return (data, ctx): any => {
    if (!Array.isArray(data)) {
      pushInvalidType(ctx, "array", parsedType(data));
      return FAILED;
    }
    if (min !== null && data.length < min) {
      pushIssue(ctx, "too_small", `Array must contain at least ${min} element(s)`, {
        minimum: min,
        type: "array",
        inclusive: true,
      });
      return FAILED;
    }
    if (max !== null && data.length > max) {
      pushIssue(ctx, "too_big", `Array must contain at most ${max} element(s)`, {
        maximum: max,
        type: "array",
        inclusive: true,
      });
      return FAILED;
    }
    if (exact !== null && data.length !== exact) {
      pushIssue(
        ctx,
        data.length < exact ? "too_small" : "too_big",
        `Array must contain exactly ${exact} element(s)`,
        { minimum: exact, maximum: exact, type: "array", inclusive: true },
      );
      return FAILED;
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
  if (def.rest) throw new ZcNotSupportedError("ZodTuple with rest schema");
  const items: Validator[] = def.items.map(go);
  return (data, ctx): any => {
    if (!Array.isArray(data)) {
      pushInvalidType(ctx, "array", parsedType(data));
      return FAILED;
    }
    if (data.length < items.length) {
      pushIssue(ctx, "too_small", `Array must contain at least ${items.length} element(s)`, {
        minimum: items.length,
        type: "array",
        inclusive: true,
      });
      return FAILED;
    }
    if (data.length > items.length) {
      pushIssue(ctx, "too_big", `Array must contain at most ${items.length} element(s)`, {
        maximum: items.length,
        type: "array",
        inclusive: true,
      });
      return FAILED;
    }
    let out: any[] = data;
    let dirty = false;
    let anyFailed = false;
    for (let i = 0; i < items.length; i++) {
      ctx.path.push(i);
      const outVal = items[i](data[i], ctx);
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

/* ════════════════════════════ ZodRecord / ZodMap / ZodSet ════════════════════════════ */

function makeRecord(def: any): Validator {
  const keyV = go(def.keyType);
  const valV = go(def.valueType);
  return (data, ctx): any => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      pushInvalidType(ctx, "object", parsedType(data));
      return FAILED;
    }
    let out: any = data;
    let dirty = false;
    let anyFailed = false;
    for (const k in data) {
      if (!Object.hasOwn(data, k)) continue;
      const inVal = data[k];
      ctx.path.push(k);
      const outKey = keyV(k, ctx);
      const outVal = outKey === FAILED ? FAILED : valV(inVal, ctx);
      ctx.path.pop();
      if (outKey === FAILED || outVal === FAILED) {
        anyFailed = true; // 键/值解析互不影响，继续收集（与 stock 一致）
        continue;
      }
      if ((outKey !== k || outVal !== inVal) && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = { ...data };
        }
        if (outKey !== k) delete out[k]; // 键被重命名；碰撞时后写覆盖（与 stock 一致）
        safeSet(out, outKey, outVal);
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

function makeMap(def: any): Validator {
  const keyV = go(def.keyType);
  const valV = go(def.valueType);
  return (data, ctx): any => {
    if (!(data instanceof Map)) {
      pushInvalidType(ctx, "map", parsedType(data));
      return FAILED;
    }
    let out: Map<any, any> = data;
    let dirty = false;
    let anyFailed = false;
    for (const [k, v] of data) {
      ctx.path.push(k);
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
  const min = def.minSize?.value ?? null;
  const max = def.maxSize?.value ?? null;
  const exact = def.size?.value ?? null;
  return (data, ctx): any => {
    if (!(data instanceof Set)) {
      pushInvalidType(ctx, "set", parsedType(data));
      return FAILED;
    }
    if (min !== null && data.size < min) {
      pushIssue(ctx, "too_small", `Set must contain at least ${min} element(s)`, {
        minimum: min,
        type: "set",
        inclusive: true,
      });
      return FAILED;
    }
    if (max !== null && data.size > max) {
      pushIssue(ctx, "too_big", `Set must contain at most ${max} element(s)`, {
        maximum: max,
        type: "set",
        inclusive: true,
      });
      return FAILED;
    }
    if (exact !== null && data.size !== exact) {
      pushIssue(
        ctx,
        data.size < exact ? "too_small" : "too_big",
        `Set must contain exactly ${exact} element(s)`,
        { minimum: exact, maximum: exact, type: "set", inclusive: true },
      );
      return FAILED;
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

/* ════════════════════════════ Union / DiscriminatedUnion ════════════════════════════ */

function makeUnion(options: z.ZodTypeAny[]): Validator {
  const opts = options.map(go);
  return (data, ctx): any => {
    const base = ctx.issues.length;
    for (let i = 0; i < opts.length; i++) {
      const r = opts[i](data, ctx);
      if (r !== FAILED) return r;
      ctx.issues.length = base; // 截断该分支产生的 issue
    }
    pushIssue(ctx, "invalid_union", "Invalid input");
    return FAILED;
  };
}

function makeDiscriminated(def: any): Validator {
  const disc: string = def.discriminator;
  const options: z.ZodTypeAny[] = def.options;
  const map = new Map<unknown, Validator>();
  let fast = options.length > 0;
  for (const opt of options) {
    const od: any = (opt as any)._def;
    if (od.typeName !== "ZodObject") {
      fast = false;
      break;
    }
    const dSchema = od.shape()[disc];
    if (dSchema instanceof z.ZodLiteral) {
      map.set(dSchema._def.value, go(opt));
    } else if (dSchema instanceof z.ZodEnum) {
      for (const v of dSchema._def.values) map.set(v, go(opt));
    } else {
      fast = false;
      break;
    }
  }
  if (!fast) return makeUnion(options);

  const discValues = new Set(map.keys());
  const expected = [...discValues].map((v) => `'${String(v)}'`).join(" | ");
  return (data, ctx): any => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      pushInvalidType(ctx, "object", parsedType(data));
      return FAILED;
    }
    const key = data[disc];
    if (!discValues.has(key)) {
      ctx.path.push(disc);
      pushIssue(
        ctx,
        "invalid_union_discriminator",
        `Invalid input: expected one of ${expected}, received '${String(key)}'`,
      );
      ctx.path.pop();
      return FAILED;
    }
    const base = ctx.issues.length;
    const r = map.get(key)!(data, ctx);
    if (r !== FAILED) return r;
    ctx.issues.length = base;
    pushIssue(ctx, "invalid_union", "Invalid input");
    return FAILED;
  };
}

/* ════════════════════════════ 包装类节点 ════════════════════════════ */

/** transform/refinement 回调里的 ctx 形参 —— 每个 effect 只建一个，跨调用复用 */
interface EffectShim {
  readonly path: PathSegment[];
  addIssue(arg: any): void;
}

function makeShim(holder: { ctx: Ctx | null }): EffectShim {
  return {
    get path() {
      return holder.ctx ? holder.ctx.path.slice() : [];
    },
    addIssue(arg: any) {
      const ctx = holder.ctx!;
      if (typeof arg === "string") {
        pushIssue(ctx, "custom", arg);
        return;
      }
      const path: PathSegment[] = [...ctx.path, ...(arg?.path ?? [])];
      const issue: Issue = {
        code: arg?.code ?? "custom",
        message: arg?.message ?? "Invalid input.",
        path,
      };
      if (arg?.expected !== undefined) issue.expected = String(arg.expected);
      if (arg?.received !== undefined) issue.received = String(arg.received);
      ctx.issues.push(issue);
    },
  };
}

function makeEffects(def: any): Validator {
  const inner = go(def.schema);
  const eff = def.effect;

  if (eff.type === "preprocess") {
    const holder: { ctx: Ctx | null } = { ctx: null };
    const shim = makeShim(holder);
    return (data, ctx) => {
      holder.ctx = ctx;
      const mapped = eff.transform(data, shim); // 可能抛异常（与 stock 一致，向上传播）
      return inner(mapped, ctx);
    };
  }

  if (eff.type === "transform") {
    const holder: { ctx: Ctx | null } = { ctx: null };
    const shim = makeShim(holder);
    return (data, ctx) => {
      const r = inner(data, ctx);
      if (r === FAILED) return FAILED;
      holder.ctx = ctx;
      return eff.transform(r, shim); // 返回新值 → 父层引用比较自动判脏
    };
  }

  // refinement：纯谓词。约定回调不得修改输入（CoW 的前提，README 有说明）。
  const holder: { ctx: Ctx | null } = { ctx: null };
  const shim = makeShim(holder);
  return (data, ctx) => {
    const r = inner(data, ctx);
    if (r === FAILED) return FAILED;
    const base = ctx.issues.length;
    holder.ctx = ctx;
    const ret = eff.refinement(r, shim);
    if (ret && typeof (ret as any).then === "function") {
      throw new ZcNotSupportedError("async refinements (the sync compiler only accepts sync data)");
    }
    return ctx.issues.length > base ? FAILED : r;
  };
}

function makeDefault(def: any): Validator {
  const inner = go(def.innerType);
  const getDefaultValue: () => unknown = def.defaultValue;
  return (data, ctx) => {
    if (data === undefined) {
      // 与 stock 一致：默认值也要过一遍内层校验（非法默认值 → 校验失败）
      return inner(getDefaultValue(), ctx); // 新值 → 父层自动判脏
    }
    return inner(data, ctx);
  };
}

function makeCatch(def: any): Validator {
  const inner = go(def.innerType);
  const catchValue: (p: { input: unknown; issues: Issue[] }) => unknown = def.catchValue;
  return (data, ctx) => {
    const base = ctx.issues.length;
    try {
      const r = inner(data, ctx);
      if (r !== FAILED) return r;
    } catch {
      /* 吞掉异常 → 落到 catch 值（与 stock 行为一致） */
    }
    ctx.issues.length = base; // 丢弃内部 issue（stock 用独立 ctx，同样不透出）
    return catchValue({ input: data, issues: [] });
  };
}

function makeReadonly(def: any): Validator {
  const inner = go(def.innerType);
  return (data, ctx) => {
    const r = inner(data, ctx);
    if (r === FAILED) return FAILED;
    // 与 stock 一致：浅冻结。CoW 下这反而是优点 —— 冻结的共享结构天然防篡改。
    if (r !== null && (typeof r === "object" || typeof r === "function")) Object.freeze(r);
    return r;
  };
}

function makePipe(def: any): Validator {
  const a = go(def.in ?? def.a);
  const b = go(def.out ?? def.b);
  return (data, ctx) => {
    const r = a(data, ctx);
    if (r === FAILED) return FAILED;
    return b(r, ctx); // 脏标记沿链自然传播
  };
}

/* ════════════════════════════ 编译缓存与分发器 ════════════════════════════ */

const cache = new WeakMap<z.ZodTypeAny, Validator>();

/**
 * 编译入口：schema 树 → 特化校验闭包。
 * “先占位、后替换”处理 z.lazy 递归：占位闭包在真实编译器就绪前转发给它。
 */
export function go(schema: z.ZodTypeAny): Validator {
  const hit = cache.get(schema);
  if (hit) return hit;

  let real: Validator | undefined;
  const placeholder: Validator = (data, ctx) => real!(data, ctx);
  cache.set(schema, placeholder);

  const def: any = (schema as any)._def;
  real = build(def);
  cache.set(schema, real);
  return real;
}

function build(def: any): Validator {
  switch (def.typeName) {
    case "ZodString":
      return makeString(def);
    case "ZodNumber":
      return makeNumber(def);
    case "ZodBoolean":
      return (data, ctx) => {
        if (typeof data !== "boolean") {
          pushInvalidType(ctx, "boolean", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "ZodBigInt":
      return (data, ctx) => {
        if (typeof data !== "bigint") {
          pushInvalidType(ctx, "bigint", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "ZodSymbol":
      return (data, ctx) => {
        if (typeof data !== "symbol") {
          pushInvalidType(ctx, "symbol", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "ZodNull":
      return (data, ctx) => {
        if (data !== null) {
          pushInvalidType(ctx, "null", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "ZodUndefined":
      return (data, ctx) => {
        if (data !== undefined) {
          pushInvalidType(ctx, "undefined", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "ZodVoid":
      return (data, ctx) => {
        if (data !== undefined) {
          pushInvalidType(ctx, "void", parsedType(data));
          return FAILED;
        }
        return data;
      };
    case "ZodAny":
    case "ZodUnknown":
      return (data) => data; // 全接受，纯透传
    case "ZodNever":
      return (data, ctx) => {
        pushInvalidType(ctx, "never", parsedType(data));
        return FAILED;
      };
    case "ZodNaN":
      return (data, ctx) => {
        if (typeof data !== "number" || !Number.isNaN(data)) {
          pushInvalidType(ctx, "nan", parsedType(data));
          return FAILED;
        }
        return data; // 注意 NaN !== NaN 恒真 → 父层永远判脏（输出仍正确，仅多拷贝一次）
      };
    case "ZodDate":
      return makeDate(def);
    case "ZodLiteral":
      return makeLiteral(def);
    case "ZodEnum":
      return makeEnum(def);
    case "ZodNativeEnum":
      return makeNativeEnum(def);
    case "ZodObject":
      return makeObject(def);
    case "ZodArray":
      return makeArray(def);
    case "ZodTuple":
      return makeTuple(def);
    case "ZodRecord":
      return makeRecord(def);
    case "ZodMap":
      return makeMap(def);
    case "ZodSet":
      return makeSet(def);
    case "ZodUnion":
      return makeUnion(def.options);
    case "ZodDiscriminatedUnion":
      return makeDiscriminated(def);
    case "ZodEffects":
      return makeEffects(def);
    case "ZodOptional": {
      const inner = go(def.innerType);
      return (data, ctx) => (data === undefined ? data : inner(data, ctx));
    }
    case "ZodNullable": {
      const inner = go(def.innerType);
      return (data, ctx) => (data === null ? data : inner(data, ctx));
    }
    case "ZodDefault":
      return makeDefault(def);
    case "ZodCatch":
      return makeCatch(def);
    case "ZodReadonly":
      return makeReadonly(def);
    case "ZodPipeline":
      return makePipe(def);
    case "ZodLazy": {
      const getter: () => z.ZodTypeAny = def.getter;
      let inner: Validator | null = null;
      return (data, ctx) => {
        if (inner === null) inner = go(getter()); // 首次 parse 时解析，命中 cache 完成递归
        return inner(data, ctx);
      };
    }
    case "ZodBranded":
      return go(def.type);
    default:
      throw new ZcNotSupportedError(String(def.typeName));
  }
}

/* ════════════════════════════ 静态纯度分析 ════════════════════════════ */

/**
 * 静态纯度：该 schema 是否“永远不可能产生新值”。
 * 纯 schema 的 parse 恒等返回输入引用（strip 模式假定输入不含多余键）。
 * 用于文档化与测试断言，不参与运行时逻辑（运行时以引用比较为准）。
 */
export function isStaticPure(schema: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): boolean {
  if (seen.has(schema)) return true; // z.lazy 环：环上节点视为纯（其展开由调用方保证）
  seen.add(schema);
  const def: any = (schema as any)._def;
  switch (def.typeName) {
    case "ZodString":
      return (def.checks ?? []).every(
        (c: any) => c.kind !== "trim" && c.kind !== "toLowerCase" && c.kind !== "toUpperCase",
      );
    case "ZodNumber":
    case "ZodBoolean":
    case "ZodBigInt":
    case "ZodSymbol":
    case "ZodNull":
    case "ZodUndefined":
    case "ZodVoid":
    case "ZodAny":
    case "ZodUnknown":
    case "ZodNever":
    case "ZodNaN":
    case "ZodDate":
    case "ZodLiteral":
    case "ZodEnum":
    case "ZodNativeEnum":
      return true;
    case "ZodObject":
      // strip 视为纯：仅当输入确有多余键时才拷贝（运行时以引用比较为准）
      return Object
        .values(def.shape() as Record<string, z.ZodTypeAny>)
        .every((c) => isStaticPure(c, seen));
    case "ZodArray":
      return isStaticPure(def.type, seen);
    case "ZodTuple":
      return def.items.every((it: z.ZodTypeAny) => isStaticPure(it, seen));
    case "ZodRecord":
      return isStaticPure(def.keyType, seen) && isStaticPure(def.valueType, seen);
    case "ZodMap":
      return isStaticPure(def.keyType, seen) && isStaticPure(def.valueType, seen);
    case "ZodSet":
      return isStaticPure(def.valueType, seen);
    case "ZodUnion":
      return def.options.every((o: z.ZodTypeAny) => isStaticPure(o, seen));
    case "ZodDiscriminatedUnion":
      return def.options.every((o: z.ZodTypeAny) => isStaticPure(o, seen));
    case "ZodEffects":
      return def.effect.type === "refinement" && isStaticPure(def.schema, seen);
    case "ZodOptional":
    case "ZodNullable":
    case "ZodReadonly":
      return isStaticPure(def.innerType, seen);
    case "ZodPipeline":
      return isStaticPure(def.in, seen) && isStaticPure(def.out, seen);
    case "ZodBranded":
      return isStaticPure(def.type, seen);
    case "ZodLazy":
      return isStaticPure(def.getter(), seen);
    default:
      return false; // Default/Catch/transform/preprocess/Pipe 等：可能产生新值
  }
}
