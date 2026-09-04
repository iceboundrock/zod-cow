# zc-z4 架构对比：自研 codegen vs 复用 zod4 官方 codegen

> 版本锚点：zod 4.5.4 · 本文所有生成代码均为真实产物 dump（`compileFn(schema, {debug:true})` 与 `compileCowDebug(schema)`）。
> 配套代码：`src/cow4/`（当前 zod4 线，复用官方；模块布局见 §11）。
>
> **v1 已不在仓库里**：自研 zod4 前端（当时的 `src/compile-z4.ts` + `src/index-z4.ts`）在
> zc-z4 落地后被删除（issue #4）——`src/index-z4.ts` 这个路径今天指的是 zc-z4 的入口。
> 本文对 v1 的全部描述、代码引用与基准数字都是**历史对照**，记录"为什么从自研 codegen
> 走到复用官方 codegen"这条决策路径；对应源码需回溯到删除前的提交。当前仓库里的 zod4
> 编译线只有 zc-z4。

## TL;DR

| | v1（自研 codegen） | zc-z4（官方 codegen + CoW 修饰） |
|---|---|---|
| 自研代码量 | ~1100 行语义 codegen + 官方正则逐字拷贝 | ~760 行（纯度分析 + 6 个容器骨架 + async 通道） |
| 语义正确性来源 | 自己复刻 zod 语义（issue/format/check 全套） | 官方编译器 + 官方 runtime fallback |
| S1 纯校验（50 万账户） | 521ms | **283ms**（~1.0x vs 官方 parser） |
| S2 脏负载（10% default） | 504ms | **247ms**（1.47x vs 官方 parser） |
| S5 容器（record/map/set） | 不支持 | **353ms**（1.93x vs 官方 parser） |
| S6 tuple | 不支持 | **111ms**（3.06x vs 官方 parser） |
| S7 async schema | 不支持 | **105ms**（2.50x vs stock safeParseAsync） |
| gc 后驻留 | 0MB | **0MB**（官方 parser 为 108~217MB） |
| 跟随上游升级 | 每次手动同步语义 | 自动受益（官方 compiler 优化） |
| 风险 | 语义漂移（正则/issue 格式） | 依赖内部 API（`zod4/v4/core` 导出面） |

**结论先行**：zod4 的 JIT 编译器（`src/v4/core/compile.ts`）就是现成的语义后端。
正确的分层不是"再写一个编译器"，而是——**官方产物做叶子和子树，CoW 骨架只接管容器，
失败一律回退 stock runtime**。

---

## 1. 背景：为什么曾有两条路线

Numeric 文章的 fork 思路是"砍特性换性能"（删掉 default/transform/catch 等 7 个特性，
消除深拷贝）。CoW 层（本仓库）证明这 7 个特性可以保留——引用比较就是天然的脏信号：
子节点返回原引用 = 没变，返回新值 = 变了，父层此刻才第一次浅拷贝（path-copying）。

在 zod3 时代这需要自研整套编译层（v1 路线）。zod 4.1 起，官方自己也上了 JIT
（`import "zod/compile"` 或 `z.compile()`），并且暴露了可编程的内部 API。zc-z4 路线
由此而来：**不自研语义 codegen，把官方编译器当"叶子级/表达式级"后端**。

## 2. 官方 codegen 的可复用面（源码取证）

`zod4/v4/core` 命名空间 re-export 了 `compile.js` 的全部导出：

```ts
import {
  compileFn,                    // 生成单体函数 (input) => out | INVALID | true
  INVALID,                      // Symbol.for("zod.compile.invalid") 失败哨兵
  ZodCompileUnsupportedError,   // 编译拒绝（coerce/递归/__proto__/冷僻 check…）
  ZodCompileAsyncError,         // async refine/transform（同步快路径无法表达）
  regexes,                      // 官方正则全家桶（number/uuid/email 源…）
  util,                         // 官方 util（isPlainObject/shallowClone…）
} from "zod4/v4/core";
```

三个关键产物契约：

| 产物 | 签名 | 语义 |
|---|---|---|
| parser | `(input) => out \| INVALID` | stock zod 语义（校验 + 变换 + 无条件新容器） |
| validator（`assertOnly: true`） | `(input) => true \| INVALID` | 校验语义完整、**跳过输出构造** |
| runtime island | `(input) => out \| INVALID` | 黑盒调 `_zod.run({value, issues:[]}, {})`，同步语境吞 async |

另一个官方挂载点是 `globalConfig.postProcessor`（`zod/compile` 的 side-effect
入口就是往这里装 shim）——本层没用它（它是"每个实例克隆替换 run"的路线，
与 CoW 的"整树单体产物"不兼容），但注意两者**可以共存**：zc-z4 的失败回退调用
`schema.safeParse`，若用户同时启用了 `zod/compile`，回退路径自动享受官方 JIT。

### 2.1 官方 object 生成的真实代码（parser 模式）

```js
// Constants: INVALID, c0, c1, c2
if (typeof input !== "object" || input === null || Array.isArray(input)) return INVALID;
const v0 = input["a"];
if (typeof v0 !== "string") return INVALID;
const v1 = typeof v0 === "string" && v0.length > 4 ? c0(v0) : v0.length;  // code point 惰性扫描
if (v1 > 4) return INVALID;
const v2 = input["b"];
if (typeof v2 !== "string") return INVALID;
c1.lastIndex = 0;
if (!c1.test(v2)) return INVALID;                 // email 格式
const v3 = input["c"];
if (!c2.has(v3)) return INVALID;                  // enum
const v4 = input["d"];
if (!Array.isArray(v4)) return INVALID;
const v5 = new Array(v4.length);
for (let v6 = 0; v6 < v4.length; v6++) {
  const v7 = v4[v6];
  if (typeof v7 !== "number" || !Number.isFinite(v7)) return INVALID;
  if (!Number.isSafeInteger(v7)) return INVALID;
  v5[v6] = v7;
}
const v8 = { "a": v0, "b": v2, "c": v3, "d": v5 };   // ← 无条件新对象
return v8;
```

注意三点：① getter 只读一次（`const v0 = input["a"]`，checks 与输出组装不二次触发）；
② 叶子优化极精细（`.max(4)` 对长字符串才数 code point）；③ **输出构造是无条件的**——
即使所有子值原样通过，也会 `new Array` + 新对象字面量。这就是 stock 分配压力的来源
（50 万账户 +112MB），也是 CoW 唯一需要"修饰"的位置。

### 2.2 同一 schema 的 assertOnly 产物

```js
// 同一棵树，assertOnly: true —— 官方内置的"纯校验器"
if (typeof input !== "object" || input === null || Array.isArray(input)) return INVALID;
const v0 = input["a"];
if (typeof v0 !== "string") return INVALID;
/* …全部校验代码原样保留… */
for (let v5 = 0; v5 < v4.length; v5++) { /* 元素校验 */ }
return true;                                      // ← 不构造任何输出
```

`assertOnly` 把输出构造整体裁掉、校验语义原样保留——这正是 CoW 里"纯净子树"
需要的产物。实测（50 万账户 assertOnly 逐账户循环）：**265ms / +13MB**，对照
parser 产物 332ms / +112MB——**输出构造的净成本 = 67ms + 99MB 分配**。

### 2.3 transform/default/optional 的产物形态

```js
// z.object({ keep: string, role: enum.default("a"), len: string.transform(s=>s.length), opt: number.optional() })
const v1 = input["role"];
let v2 = (() => {
  let v3;
  if (v1 === undefined) { v3 = c1(c0()); }        // shallowClone(defaultValue()) —— #5855
  else {
    if (!c2.has(v1)) return INVALID;
    v3 = v1 === undefined ? c1(c0()) : v1;        // inner 输出 undefined 也替换为 default
  }
  return v3;
})();
if (v2 === INVALID) return INVALID;
const v4 = input["len"];
if (typeof v4 !== "string") return INVALID;
const v5 = c3(v4);                                 // transform helper（payload 伪造 + issue 通道）
if (v5 === INVALID) return INVALID;
const v6 = input["opt"];
let v7 = (() => { /* optional IIFE */ })();
if (v7 === INVALID) {
  if ("opt" in input) return INVALID;              // optout=optional：缺席键不判失败
  v7 = undefined;
}
const v9 = {};
v9["keep"] = v0;
if (v2 !== undefined || "role" in input) v9["role"] = v2;   // mayOutputUndefined 组装规则
```

这些正是 v1 在差分测试里反复踩坑的语义（default 短路、缺席不物化、exactOptional、
catch 常量值、record 数值键重试、for...in 继承键……）。**zc-z4 让官方消化全部这些细节，
自研层只做纯度分派**——这是代码量 1100→600 行且正确性反超的原因。

（未完，下一节：zc-z4 骨架 dump 并排对照）

## 3. zc-z4 的生成代码：官方产物如何被 CoW 修饰

zc-z4 的编译期分派（`emitNode`）：

```
needsValue && cowSafeContainerForChild(schema)?
  ├─ 是 → emitBoxedContainer（optional/nullable 剥壳）→ 五个容器骨架之一
  └─ 否 → isPure(schema)?
        ├─ 是 → 官方 assertOnly 产物 + return accessor（输出===输入）
        └─ 否 → 官方 parser 产物（引用比较判脏，由宿主骨架执行）
```

### 3.1 官方 object 骨架 vs zc-z4 CoW 骨架（同一 schema 并排）

schema：`z.object({ id: number.int(), firstName: string.max(64), email: z.email(), tags: array(string).max(8), address: object({...}) })`

```js
// ═══ zc-z4 CoW 骨架（真实 dump）═══
if (typeof input !== "object" || input === null || Array.isArray(input)) return INVALID;
let x0 = false, x1 = false;                                // dirty / extra
const x2 = input["id"];
if (c0(x2) === INVALID) return INVALID;                    // 纯叶子键：官方 assertOnly 产物
const x3 = input["email"];
if (c1(x3) === INVALID) return INVALID;                    // （email 校验在产物内部）
const x4 = input["tags"];
const x5 = c2(x4);                                         // 容器键：CoW 子骨架产物
if (x5 === INVALID) return INVALID;
if (x5 !== x4) x0 = true;                                  // ← 引用比较即脏信号
const x6 = input["address"];
const x7 = c3(x6);                                         // 同上（嵌套 CoW）
if (x7 === INVALID) return INVALID;
if (x7 !== x6) x0 = true;
for (const k in input) { if (!c4.has(k)) { x1 = true; break; } }   // 官方 for...in 同款
for (const s of Object.getOwnPropertySymbols(input)) {
  if (!c4.has(s)) { x1 = true; break; }                    // strip 会丢 symbol 多余键 → 探测
}
if (!x0 && !x1) {
  return input;                                            // ═══ 官方模板没有的一行 ═══
}
const out = { ...input };                                  // 被迫才拷贝：键存在性/键序天然保真
if (x1) {
  for (const k in input) if (!c5.has(k)) delete out[k];    // strip 剥离（官方语义）
  for (const s of Object.getOwnPropertySymbols(input)) if (!c5.has(s)) delete out[s];
}
return out;
```

与官方 dump 的逐点对应关系：

| 官方 parser | zc-z4 骨架 | 说明 |
|---|---|---|
| `const v8 = {...}` 无条件 | `if (!dirty && !extra) return input;` | CoW 核心：干净输入零分配 |
| `const v5 = new Array(len)` | （元素循环内）`out = input.slice()` | 数组同理，首脏才 slice |
| `if (!c1.test(v2)) return INVALID` | 同左（assertOnly 产物内部） | 叶子校验 100% 官方 |
| （输出组装隐式处理键存在性） | `{ ...input }` | 扩展天然保真 presence/键序 |
| `for (const k in …)` unknown 探测 | 同左逐行照抄 | strict/strip/loose 语义对齐 |

### 3.2 容器自身 checks：双路径时点

`.refine()` / `.min()` 挂在容器上时，stock 语义是"输出构造后对输出跑 checks"。
zc-z4 把 checks 编译成独立校验子程序，**双路径调用**：

```js
const cChecks = /* containerChecksFn 产物 */;
if (!x0 && !x1) {
  if (cChecks(input) === INVALID) return INVALID;   // 干净：输出===输入
  return input;
}
const out = { ...input };
/* …写回/剥离… */
if (cChecks(out) === INVALID) return INVALID;       // 脏：对齐 stock 的"对输出跑 checks"
return out;
```

支持集：`custom`（`.refine()` 的 `def.fn` 纯谓词）+ array 的
`min_length/max_length/length_equals`（`.length` 直读）+ map/set 的
`min_size/max_size/size_equals`（`.size` 直读）。其余（superRefine 改写
`ctx.value`、overwrite、自定义 `when`）→ 该节点整体降级官方 parser 产物。

## 4. 纯度分析：白名单与三大陷阱

**定义**：`isPure(schema)` = 校验通过 ⇒ 输出必然 `===` 输入引用，且无副作用。
纯净子树走官方 validator（值=输入），拿不准的一律非纯（parser 产物 + 引用比较）。

| def.type | 判定 | 理由 |
|---|---|---|
| string/number/boolean/bigint/symbol/null/undefined/void/nan/date/any/unknown/literal/enum | `leafChecksArePure` | 官方产物透传 accessor；但 checks 例外见下 |
| optional/nullable | 递归 inner | 值透传 |
| object/array（自身 checks 安全 + 子树全纯） | true | 骨架接管（strip 由骨架处理） |
| record/map/set | true（骨架接管后） | 键名/键值引用比较见 §5 |
| union | 全分支纯 | 分支透传 |
| readonly | **false** | `Object.freeze` 副作用（冻输入的风险） |
| default/prefault/catch/coerce/transform/pipe/intersection/lazy/custom/nonoptional/success | **false** | 值产生器/黑盒/新容器 |

### 陷阱一：`overwrite` 是值改写（差分 seed=51 实证）

`z.string().max(16).toLowerCase()` 在 zod4 里不是 schema 包装，而是 def.checks 里的
**`overwrite` check**。白名单把 string 判纯 → validator 通过 → `return input` →
stock 输出 "ab1" vs ours "AB1"。修复：叶子纯度必须检查自身 checks——
`overwrite` 一律非纯；`custom` 无 `fn`（superRefine 可改写 `ctx.value`）一律非纯。

### 陷阱二：length/size check 自带默认 `when`（诊断日志实证）

`.max(64)` 的 check 实例上有 `when: [Function: _whenHasLength]`——官方
`generateChecks` 用 `WHEN_DEFAULTED_CHECKS` 白名单豁免（max_size/min_size/
size_equals/max_length/min_length/length_equals）。zc-z4 最初把任何 truthy `when`
当"自定义 when"拒绝 → `.max(8)` 的 array 被误判非纯 → 走 parser → 每元素新数组
→ CoW 全灭（S1 分配 98MB 的根因）。修复：照抄官方白名单，
`hasCustomWhen = when && !WHEN_DEFAULTED_CHECKS.has(check)`。

### 陷阱三：`nullable(object)` 必须剥壳（差分 seed=104/133/137 实证）

容器识别若只看 `def.type === "object"`，`nullable(object)` 会落入"纯叶子键"分支，
走官方 assertOnly——但官方 validator **跳过多余键剥离**（strip 是输出构造行为，
不影响校验成败）→ 输入的多余键原样透传 → 与 stock 分歧。修复：
`cowSafeContainerForChild` 沿 optional/nullable 链剥壳，`emitBoxedContainer`
发射壳检查（null→null、undefined→undefined），到容器后走 CoW 骨架。

> 方法论：这四个 bug 没有一个是靠读代码发现的，全部由随机 schema 差分测试
> 抓出（`REPRO=seed:case` 一键复现）。**纯度分析的完备性只能靠 fuzz 验证**——
> 白名单"宁可误判非纯"的保守性 + 5 万 case 差分，是这条路线的安全性边界。

## 5. record/map/set 骨架（v0.4 新增，激进全覆盖）

官方这三个生成器同样"无条件新容器"：record `const v0 = {}`、map
`new Map()`（还带每条目解构分配）、set `new Set()`。骨架策略与 object 一致，
多出两个 CoW 特有问题：**键名会变**（数值键重试/键转换）与**键序**（声明驱动）。

### 5.1 record：三条编译期路径

```
keyType._zod.values 存在且非 partial?
  ├─ 是 → 路径 A：声明驱动（z.record(z.enum([...]), v)）
  └─ 否 → keyType 是 bare-string（type==="string" && 无 format && 无 coerce && 无 checks）?
        ├─ 是 → 路径 C：键名恒不变，纯值比较
        └─ 否 → 路径 B：keyFast 产物 + 数值键重试 + 键名引用比较
```

**路径 C**（最常见）生成代码骨架：

```js
if (!c0(input)) return INVALID;                            // util.isPlainObject（官方同名函数）
let x0 = input, x1 = false;
for (const k of Reflect.ownKeys(input)) {
  if (k === "__proto__") continue;
  if (!c1.call(input, k)) continue;                        // propertyIsEnumerable（官方同款）
  if (typeof k !== "string") return INVALID;               // symbol 键官方拒绝
  const vIn = input[k];
  const t = cValue(vIn);                                   // 值产物（validator/parser/cow 子骨架）
  if (t === INVALID) return INVALID;
  if (t !== vIn) {                                         // 引用比较
    if (!x1) { x1 = true; x0 = { ...input }; }
    x0[k] = t;
  }
}
return x0;                                                 // 干净 → 原引用
```

**路径 B**（数值键重试，键名会变）：沿用官方 `keyFast + regexes.number 重试`
模板，额外做**键名引用比较**——`outKey !== k` 也判脏，拷贝分支
`delete out[k]; out[outKey] = t;`。键名不变的子场景（string format 键如
`z.record(z.email(), v)`）中 `outKey === k` 恒成立，键名比较零成本。

**路径 A**（enum 声明驱动）：官方输出 = 按声明序**无条件物化全部声明键**
（缺失键 + optional 值 → 写 undefined）+ 未知键 strict 拒绝。骨架：

- 缺失声明键即脏（`!(k in input)` → stock 会物化该键）；
- 未知键 strict 拒绝照抄（`for...in → INVALID`）；
- 拷贝分支 `{...input}` 后逐声明键写回（validator 产物键写 `inVar`——缺失时
  `inVar === undefined` 恰好就是 stock 语义；parser 产物键写产物输出值）。

实测语义锚点：`{a:1}` 对 `z.record(z.enum(["a","b"]), z.number().optional())`
→ stock 物化 `b: undefined` → ours 判脏返回 `{a:1, b:undefined}` ✓；未知键
`{a:1,b:2,extra:3}` → 双方都拒绝 ✓。

### 5.2 map / set

```js
// map：键/值双引用比较，首脏 new Map(input)
for (const [kIn, vIn] of input) {
  /* 纯键：cKey(kIn) 校验，键名恒不变（keyExpr = kIn）
     非纯键：const ko = cKey(kIn)，键名引用比较 */
  const vo = cValue(vIn);
  if (vo === INVALID) return INVALID;
  if (vo !== vIn || keyExpr !== kIn) {
    if (!x1) { x1 = true; out = new Map(input); }
    if (keyExpr !== kIn) out.delete(kIn);
    out.set(keyExpr, vo);
  }
}
return out;

// set：成员引用比较，首脏 new Set(input)，delete(vIn) + add(vo)
```

- **键纯时零开销**：键 schema（string/number）官方产物透传原键 → `keyExpr === kIn`
  恒成立，键名比较被 V8 优化掉。
- **键转换正确性**：键是容器/transform 时（罕见），cow/parser 产物返回新键，
  `delete(kIn) + set(newKey)` 对齐 stock（stock 对 Map 也是 set 转换后的键）。
- **NaN**：`vo !== vIn` 对 NaN 恒真 → 误判脏 → 过度拷贝但结果正确
  （SameValueZero 下 `delete/add` 等价）。与 README 已有的 NaN 说明一致。
- **Map/Set deepStrictEqual**：Node assert 对 Map/Set 做**条目集合比较**
  （顺序无关），`delete+set/add` 的顺序差异不影响差分。

### 5.3 接线方式

- `cowSafeContainerForChild` 增加 `record/map/set` case → 键位/元素位/顶层自动接管；
- `emitBoxedContainer` 尾部扩到六容器 → `nullable(record)` / `optional(map)` / `optional(tuple)` 直接可用；
- `checksAreCowSafe`/`containerChecksFn` 增加 map/set 的 size 系 check；
- 值位置统一走 `childProduct()`（容器→cow 子骨架 / 纯→validator / 非纯→parser / async→async 岛），
  与 object 键位、array 元素位共用同一条选择逻辑。

### 5.4 tuple 骨架（v0.5 新增）

官方 `generateTupleCheck`（compile.js L1289-1374）的逐行镜像 + CoW 修饰。三个关键语义机制：

1. **optinStart / optoutStart**（官方 `getTupleOptStart` 逐字照抄）：从尾向头找第一个
   不可省槽位。optin 三档梯子（`optin !== undefined` 即可省，含 optional/defaulted），
   optout 两档（仅 `optout === "optional"`）。长度守卫：无 rest 时 `[optinStart, N]`，
   有 rest 时 `>= optinStart`。
2. **fillLen 变量**（本层发明）：官方用动态 `out.length` 做尾槽门控（`if (out.length === i)`），
   但 CoW 时输出可能还是输入原引用（不能读/写 `.length`）——必须显式跟踪逻辑长度。
   不变量：`out === input ⟹ fillLen === input.length`（截断/填充路径必先拷贝）。
3. **三段式**：段 1 `[0, optoutStart)` 无条件槽（官方照样物化缺席槽：validator 槽写
   `undefined`、值槽写产出）；段 2 尾槽门控 + 缺席三分支（`dropsWhenAbsent` → 截断
   / validator → 截断 / IIFE → INVALID/undefined 截断、有值填充）；段 3 rest 无门控逐槽。
   截断三态：已拷贝→实截；原引用且目标≠输入长→拷后截；**目标===输入长→输出===输入，零操作**
   （trailing optional 截断到输入长度的场景可以保住原引用）。

收益最大的场景：全数字/全干净 tuple——stock 每次都 `new Array` + 逐槽写，CoW 零拷贝
（S6：4.57x vs stock / 3.06x vs 官方 parser，全部场景中比值最高）。

### 5.5 async 通道（v0.5 新增）

**设计前提**：官方 compileFn 对 async（refine/transform/custom/superRefine/pipe，共 6 处
`isAsyncFunction` 检测点）一律抛 `ZodCompileAsyncError`——这恰好是现成的"子树 async 探测器"。
本层把"探测到 async → 整树降级"改为"就地转 async 岛 + 骨架局部 await"：

1. **async 岛**：`makeAsyncIsland(schema)` = async 黑盒，返回 `Promise<输出 | INVALID>`，
   产物挂 `ZC_ASYNC` symbol 标记。
2. **await 发射**：所有产物调用位（object 键/array 元素/tuple 槽/record 值/map 键值/set 成员/
   容器 checks 的 async refine 谓词）检测 `isAsyncProduct(fn)` → 发射 `await` + `ctx.async = true`。
3. **骨架 async 化**：`buildFn` 依 `ctx.async` 决定 `async (input) =>` 还是 `(input) =>`，
   产物挂 `ZC_ASYNC` → 子骨架父层自动感知（`childProduct` 返回 `kind: "async"`）。
4. **公开 API**：`Compiled` 增加 `async: boolean`、`parseAsync` / `safeParseAsync`；
   async 骨架下 sync API 抛 `$ZodAsyncError`（官方同款语义，实测 sync parse 对 async 树就是抛）。
5. **lazy(async) 补漏**：官方对 lazy 产物是 runtime island，内部 async 编译期不报错 →
   Promise 会静默传出去。`subtreeHasAsync` 静态探测（def 树递归，含 checks 的 fn/superRefine、
   pipe 的 transform、lazy getter 展开，seen 防环）→ async lazy 改走 async 岛。

**关键语义保留**：同步 island（`makeIsland`）遇到 Promise 时抛 `$ZodAsyncError`（官方
compile.js `throwAsync` 同款注释：返回 INVALID 会被 union 读成分支拒绝，必须让 throw 存活）。

**混搭效果**：一棵树里只有 async 子树位付 microtask 成本，其余全部保持引用比较骨架
（S7：5 万条 async transform 场景 2.50x vs stock safeParseAsync，分配 -63%）。

## 6. 降级链状态机

```
compile(schema)
  │
  ├─ compileCowFn（整树骨架编译）
  │     ├─ emitBoxedContainer ── cowSafeContainerForChild（剥壳 + checks 安全）
  │     │     ├─ object/array/tuple/record/map/set 骨架
  │     │     │     ├─ 纯净叶子 → officialFn（assertOnly 产物）
  │     │     │     │     └─ 生成失败 → officialFn(parser) → island
  │     │     │     ├─ 非纯子树 → officialFn(parser 产物)
  │     │     │     │     ├─ 生成失败 → makeIsland（黑盒 _zod.run，遇 Promise 抛 $ZodAsyncError）
  │     │     │     │     └─ ZodCompileAsyncError → makeAsyncIsland（await 通道）★v0.5
  │     │     │     ├─ 容器子树 → subFn 递归（seen 防循环引用）
  │     │     │     │     └─ 子骨架自身 async → kind:"async"，父位发射 await ★v0.5
  │     │     │     └─ async 子树 → makeAsyncIsland + ctx.async（骨架变 async 函数）★v0.5
  │     │     └─ checks 不安全（superRefine/overwrite/自定义 when）→ officialFn(parser) 降级
  │     └─ 顶层不可编译（顶层递归 / schema catchall / __proto__ 键）
  │           └─ stock = true：parse/safeParse/validate 全部直通 stock
  │
  └─ 运行期：任何 INVALID → stock safeParse / safeParseAsync（完整 issues / error map / ZodError）
        └─ 副作用注意：refine 回调在"骨架跑 1 次 + runtime 重跑 1 次"= 2 次
           （官方 zod/compile shim 同语义，README 已标注）

async 骨架（ctx.async = true）的顶层契约：
  Compiled.async = true → sync parse/safeParse/validate 抛 $ZodAsyncError；
  parseAsync/safeParseAsync 可用，失败路径回退 stock safeParseAsync。
```

递归 schema 的实际行为：`z.object({children: z.array(z.lazy(() => Tree))})` 的
顶层骨架照常编译——lazy 子树在元素位走官方 parser 产物，官方 `generateLazyCheck`
自带 cache-parser 黑盒，正确处理循环引用（冒烟 #9：`stock: false` 且语义正常）。
真正整树降级的是顶层递归 schema（def 树循环引用，官方 compileFn 拒绝）。

## 7. 基准（50 万账户，node v24，--expose-gc，3 轮中位）

`zc-v1` 列是该前端删除前的最后一次测量，保留为历史对照；今天的 `bench:z4` 不再跑这一列。

| 场景 | stock | 官方 compileFn parser | zc-z4 | zc-v1 | arktype |
|---|---|---|---|---|---|
| S1 纯校验 | 654ms | 263ms | **283ms** | 521ms | 144ms |
| S1 分配压力 | +160.5MB | +111.0MB | **+30.5MB** | +12.1MB | +26.7MB |
| S1 gc 后驻留 | +123.4MB | +108.1MB | **0.0MB** | 0.0MB | 0.0MB |
| S2 脏负载（10% default） | 619ms | 363ms | **247ms** | 504ms | — |
| S3 扫描 0% / 25% / 50% / 100% 脏 | 622/647/679/660ms | 391/415/452/449ms | **245/268/311/404ms** | 490/518/540/643ms | — |
| S3 zc-z4 驻留 | +123.3MB 恒定 | — | **0 / 20 / 36 / 68.7MB** | — | — |
| S4 validate | — | 219ms(逐账户) | **50ms** | — | 144ms |
| S5 record/map/set | 922ms | 681ms | **353ms** | 不支持 | — |
| S5 分配压力 | +256.1MB | +245.3MB | **+38.1MB** | — | — |
| S5 gc 后驻留 | +217.4MB | +217.4MB | **0.0MB** | — | — |
| S6 tuple | 508ms | 340ms | **111ms** | 不支持 | — |
| S6 分配压力 / 驻留 | +214.0MB / +206MB | +202.2MB / +202MB | **+15.3MB / 0MB** | — | — |
| S7 async transform（5 万条） | 262ms(safeParseAsync) | 编译拒绝 | **105ms(safeParseAsync)** | 不支持 | — |
| S7 分配压力 | +95.6MB | — | **+34.9MB** | — | — |

三个层次的解读：

1. **对 stock**：2.31x（S1）~ 2.50x（S2）~ 2.61x（S5）~ **4.57x（S6 tuple，全场景最高）**，
   且驻留从 123~217MB 归零；async 场景（S7）2.50x。
2. **对官方 JIT parser**：干净场景基本持平（S1 0.93~1.00x，批间噪声内——骨架省掉的输出
   构造恰好抵掉子骨架函数调用开销）；**脏场景反超**（S2 1.47x、S5 1.93x、S6 3.06x）——
   官方 stock 语义的 default shallowClone 与整树重建是固定成本，CoW 只为真正变脏的路径
   付费。S6 的 3.06x 说明：tuple 是重建占比最高的容器（每次 parse 都 new Array + 逐槽写，
   而槽位几乎不变），CoW 修饰收益最大。
3. **async 通道**（S7）：骨架局部 await——async 子树位付 microtask 成本，其余保持引用
   比较骨架；async transform 全脏场景仍有 2.50x，分配 -63%（95.6→34.9MB）。
4. **validate 快路径**：官方 assertOnly 整树单体产物 50ms / 50 万 = 100ns/账户，
   比官方逐账户调用（219ms，含 payload 包装）快 4.4x，分配 0。

S1 的 +30.5MB 短命分配来自官方叶子产物内部（datetime/email 格式校验的临时值），
gc 后驻留 0——CoW 本身零拷贝。v1 的 12.1MB 更低，但速度慢一倍；速度与微量短命
分配之间的取舍，在生产语境（minor GC 便宜）下选了 zc-z4——这也是 v1 最终被移除的原因之一。

## 8. 正确性证据

- `tests/smoke-z4.test.ts`（11 组行为断言）+ `tests/smoke-z4-containers.test.ts`
  （record 三路径 / map / set / size checks / 容器组合）+ `tests/smoke-z4-tuple-async.test.ts`
  （tuple 截断/填充/rest/refine + async 五容器通道/lazy(async)/union async 分支）全部通过。
- `tests/differential-z4.test.ts`：**50000 case**（seeds=500×100，随机嵌套
  object/array/tuple/record/map/set/union + optional/nullable/default/refine/transform
  + **async refine/async transform** 包装），与 stock zod4 全量一致：
  - 成败奇偶一致（成功 20813 / 失败 29187）
  - 输出 `deepStrictEqual` 一致（Map/Set 按条目集合比较）
  - 输入零失真（structuredClone 快照比对）
  - 顶层引用共享率 **89.1%**（成功 case），stock 降级 0 次
- 已知不对齐项（刻意保留）：async rest 槽 + nullable null 输入时 stock runtime 产生
  稀疏数组且丢 null（确定性复现：`z.tuple([z.string()], z.boolean().nullable().refine(async …))
  .safeParseAsync(["a", null, null])` → ownKeys "0,2,length"，slot 1 变 hole）——
  骨架输出稠密数组（更正确），差分生成器规避该组合；详见 upstream-issue-draft.md §Bonus。
- 失败诊断钩子：`REPRO=seed:case node --import tsx tests/differential-z4.test.ts`
  打印 schema desc、input、CoW 骨架源码。

## 9. 版本锚点与风险

**依赖的官方内部面**（均经 `zod4/v4/core` 公开 exports，但官方注释定位为 internal）：

| API | 用途 | 漂移风险 |
|---|---|---|
| `compileFn(schema, {assertOnly, debug})` | 叶子/子树产物 | 签名变化（低）；行为变化由差分兜底 |
| `INVALID` | 失败哨兵 | 极低（Symbol.for 稳定） |
| `ZodCompileUnsupportedError/AsyncError` | 降级判定 + **async 探测器**（v0.5） | 低 |
| `$ZodAsyncError` | 同步 island 遇 Promise 的官方语义抛错；sync API 对 async 骨架 | 低 |
| `regexes.number` / `util.isPlainObject` | record 骨架 | 低（官方内部一致性依赖同款） |
| `WHEN_DEFAULTED_CHECKS` / `fastPathAcceptsAbsence` 等语义谓词（照抄实现，非 import） | 纯度分析 | **中**——zod 改 when 语义时需同步 |
| `getTupleOptStart` / `dropsWhenAbsent`（照抄实现，非 import） | tuple 尾槽截断语义（v0.5） | **中**——zod 改 optin/optout 梯子时需同步 |

**缓解措施**：降级链保证任何漂移最多表现为"退化到 stock"（正确性无损）；
async 通道把 `ZodCompileAsyncError` 用作官方自维护的 async 探测器（官方扩展 async 检测点
时本层自动跟随）；差分测试 5 万 case（含 tuple/async 生成器）是升级 zod 时的强制回归门槛；
已起草上游 issue 推动 `compileFn`/assertOnly 转正（docs/upstream-issue-draft.md），
消除最大的一块内部依赖。

## 10. 结论：两条路线的适用域

- **v1（自研 codegen）** 的适用域是强受控环境 / 长支持窗口：零内部 API 依赖
  （只读 `_zod.def`）、分配更低、可以锁定旧版 zod。本仓库不再需要这个域——
  它只维护一条 zod4 线，v1 已随 issue #4 移除；下面的对比因此是决策记录，
  而不是仍在维护的两个选项。
- **zc-z4（官方 codegen + CoW 修饰）** 是 zod4 时代的正解：语义正确性外包给官方
  编译器与 runtime，自研面缩到"纯度分析 + 6 个容器骨架 + async 通道"，跟随上游
  优化自动受益；速度与官方 JIT 持平，脏场景反超 1.5~1.9x、tuple 3.1x、async 2.5x
  （对 stock 2.3~4.6x），GC 驻留归零。
- 两条路线共享同一个 CoW 心智模型：**引用比较即脏信号，path-copying 即拷贝策略**。
  差别只在"校验与变换这一层由谁实现"。

## 11. Source layout (issue #5)

The engine lives in `src/cow4/` as a set of modules cut along the seams described above; every function kept its body and comments when it moved, so the sections of this document still map one-to-one onto the code.

| Module | Section of this doc | Holds |
|---|---|---|
| `index.ts` | §6 | Thin entry: `compileCowFn`, `compileCowDebug`; re-exports `INVALID`, `Fn`, `ZC_ASYNC`, `isAsyncProduct`, `officialValidator` |
| `product.ts` | §5.5 | `Fn` product contract, `ZC_ASYNC` marker, `isAsyncFn`, `throwAsync` |
| `codectx.ts` | §3 | `CodeCtx`, `escKey`, `buildFn` |
| `predicates.ts` | §9 | Verbatim zod copies: `acceptsAbsence`, `requiresPresence`, `mayOutputUndefined`, `getTupleOptStart`, `dropsWhenAbsent` |
| `purity.ts` | §4 | `isPure`, `leafChecksArePure`, `checksAreCowSafe`, `WHEN_DEFAULTED_CHECKS`, `cowSafeContainerForChild` |
| `official.ts` | §6 | `officialFn`, `officialValidator`, `makeIsland`, `makeAsyncIsland`, `subtreeHasAsync` |
| `emit.ts` | §3, §5.3 | `emitNode`, `emitBoxedContainer`, `childProduct`, `containerChildFn`, `containerChecksFn`, `subFn` |
| `emit-object.ts`, `emit-array.ts` | §3.1, §3.2 | `emitCoWObject`, `emitCoWArray` |
| `emit-tuple.ts` | §5.4 | `emitCoWTuple` |
| `emit-record.ts`, `emit-map.ts`, `emit-set.ts` | §5.1, §5.2 | `emitCoWRecord`, `emitCoWMap`, `emitCoWSet` |

`emit.ts` and the six `emit-*.ts` modules import each other: `emitBoxedContainer` dispatches to the skeletons, and the skeletons recurse into child containers through `containerChildFn` / `childProduct`. The cycle is safe because every binding involved is a hoisted function declaration and none of these modules executes anything at load time. Do not add top-level code that calls across the cycle.
