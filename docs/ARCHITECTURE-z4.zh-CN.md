> **Note.** This file is the Chinese counterpart of [docs/ARCHITECTURE-z4.md](ARCHITECTURE-z4.md), which is the source of truth; a change to the English document is applied here in the same PR. The text below still reflects v0.5 (issue #7) and is being brought up to date under #52. Section numbers match the English document except for its appendix.
>
> **说明。** 本文是 [docs/ARCHITECTURE-z4.md](ARCHITECTURE-z4.md) 的中文对应版本，英文版是权威版本；英文文档的每次改动都在同一个 PR 里同步到这里。下文目前仍是 v0.5 时的内容（issue #7），正在 #52 中更新。除英文版的附录外，章节编号与英文版一一对应。

# zc-z4 架构对比：自研 codegen vs 复用 zod4 官方 codegen

> 版本锚点：zod 4.5.4 · 本文所有生成代码均为真实产物 dump（`compileFn(schema, {debug:true})` 与 `compileCowDebug(schema)`）。
> 配套代码：`src/cow4/`（当前 zod4 线，复用官方；模块布局见 §11）。
>
> v1 已不在仓库里：自研 zod4 前端（当时的 `src/compile-z4.ts` + `src/index-z4.ts`）在
> zc-z4 落地后被删除（issue #4）；`src/index-z4.ts` 这个路径今天指的是 zc-z4 的入口。
> 本文对 v1 的全部描述、代码引用与基准数字都是历史对照，记录"为什么从自研 codegen
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

结论：zod4 的 JIT 编译器（`src/v4/core/compile.ts`）就是现成的语义后端。
与其再写一个编译器，不如让官方产物做叶子和子树，CoW 骨架只接管容器，
失败一律回退 stock runtime。

---

## 1. 背景：为什么曾有两条路线

Numeric 文章的 fork 思路是"砍特性换性能"（删掉 default/transform/catch 等 7 个特性，
消除深拷贝）。CoW 层（本仓库）证明这 7 个特性可以保留：引用比较就是天然的脏信号，
子节点返回原引用 = 没变，返回新值 = 变了，父层此刻才第一次浅拷贝（path-copying）。

在 zod3 时代这需要自研整套编译层（v1 路线）。zod 4.1 起，官方自己也上了 JIT
（`import "zod/compile"` 或 `z.compile()`），并且暴露了可编程的内部 API。zc-z4 路线
由此而来：不自研语义 codegen，把官方编译器当"叶子级/表达式级"后端。

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
| validator（`assertOnly: true`） | `(input) => true \| INVALID` | 校验语义完整、跳过输出构造 |
| runtime island | `(input) => out \| INVALID` | 黑盒调 `_zod.run({value, issues:[]}, {})`，同步语境吞 async |

另一个官方挂载点是 `globalConfig.postProcessor`（`zod/compile` 的 side-effect
入口就是往这里装 shim）。本层没用它（它是"每个实例克隆替换 run"的路线，
与 CoW 的"整树单体产物"不兼容），但两者可以共存：zc-z4 的失败回退调用
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
② 叶子优化极精细（`.max(4)` 对长字符串才数 code point）；③ 输出构造是无条件的：
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

`assertOnly` 把输出构造整体裁掉、校验语义原样保留，这正是 CoW 里"纯净子树"
需要的产物。实测（50 万账户 assertOnly 逐账户循环）：265ms / +13MB，对照
parser 产物 332ms / +112MB，输出构造的净成本是 67ms 加 99MB 分配。

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
catch 常量值、record 数值键重试、for...in 继承键……）。zc-z4 让官方消化全部这些细节，
自研层只做纯度分派，这是代码量 1100→600 行且正确性反超的原因。

## 3. zc-z4 的生成代码：官方产物如何被 CoW 修饰

zc-z4 的编译期分派（`emitNode`）：

```
needsValue && cowSafeContainerForChild(schema)?
  ├─ 是 → emitBoxedContainer（optional/nullable 剥壳，运行包装层自己的 refine 谓词）→ 六个容器骨架之一
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

干净路径的自有 symbol 探测：stock 在所有模式下都会丢弃自有 symbol 键（strict 的未知键循环只看字符串键，所以也不会拒绝 symbol），
因此按原引用放行之前必须证明没有这样的键，而 `Object.getOwnPropertySymbols` 是唯一不必列出全部键的问法（`Reflect.ownKeys` 会分配全部键）。
它在对象的所有模式下运行（strip 自 #33 起，strict 与 loose 自 #42 起；对 strict 与 loose 而言它是干净路径上唯一的探测），
自 #51 起也在 enum 键 record 的干净路径上运行（§5.1；辅助函数是 `codectx.ts` 里的 `emitOwnSymbolProbe`，两种骨架共用），默认保持开启。
`compile(schema, { ownSymbolKeys: "ignore" })`（#43）去掉它：选项在 `compile` 里解析一次，由树中每个 `CodeCtx` 携带
（`subFn` 用父上下文的选项创建子上下文），此时带有未声明自有 symbol 键的干净输入按原引用返回并保留该 symbol，而 stock 的重建会丢弃它；
strict 与 loose 对象在 #42 之前、record 在 #51 之前无条件如此，现在在所有模式与所有 record 路径上都是可选项。
其余不变：已声明的 symbol 键照常校验并写入，拷贝路径按构造丢弃未声明的 symbol，`validate()` 仍是官方 validator。
差分模糊测试用不生成额外自有 symbol 的生成器对该选项再跑一遍（§8）。

两个探测证明不了的事（#48）：`for...in` 探测列出可枚举的字符串键（自有与继承的，因此它会遍历原型链，在 Proxy 上会触发 `ownKeys`、`getOwnPropertyDescriptor` 与 `getPrototypeOf`），自有 symbol 探测列出自有 symbol（在 Proxy 上触发 `ownKeys`）；干净路径上没有任何显式的描述符或原型探测，
所以干净输入会连同 stock 重建时会规范化掉的东西一起原样返回。共四类：不可枚举的未声明字符串键（对象的每种模式；record 也一样，其键循环像 stock 一样跳过不可枚举的字符串键，
然后返回输入，而 stock 的重建会丢弃它）、被输入定义为不可枚举的已声明键（§5.1）、输入的原型（类实例仍是该实例；loose 对象还会让可枚举的继承键留在原型上，
因为只有 strip 在干净路径上运行 `for...in`，而 stock 的 loose 追加会把它写成自有键；record 两边都拒绝类实例），以及被触发的 Proxy 陷阱集合
（strip 通过 `for...in` 探测触发 `ownKeys`、`getOwnPropertyDescriptor` 与 `getPrototypeOf`，而 stock 的 strip 模板什么都不触发；loose 只通过自有 symbol 探测触发 `ownKeys`，`"ignore"` 下什么都不触发，
而 stock 的 `for...in` 追加三个都触发；strict 两边都运行官方的未知键循环，也是一个 `for...in`）。拷贝路径是官方组装，每种情况都与 stock 一致。要证明它们不存在，每个对象要多一个 `Object.getOwnPropertyNames` 或 `Reflect.ownKeys` 数组、
每个已声明键要多一次 `propertyIsEnumerable` 调用或每个干净容器要多一次原型读取，正是 `ownSymbolKeys: "ignore"` 想省掉的那类开销，
所以它们只记录（README 已知限制）并由 smoke 第 16、17 组对照 stock 的行为钉住，不探测。

### 3.2 容器自身 checks：双路径时点

`.refine()` / `.min()` 挂在容器上时，stock 语义是"输出构造后对输出跑 checks"。
zc-z4 把 checks 编译成独立校验子程序，在两条路径上都调用它：

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

## 4. 纯度分析：白名单与四大陷阱

定义：`isPure(schema)` = 校验通过 ⇒ 输出必然 `===` 输入引用，且无副作用。
纯净子树走官方 validator（值=输入），拿不准的一律非纯（parser 产物 + 引用比较）。

| def.type | 判定 | 理由 |
|---|---|---|
| string/number/boolean/bigint/symbol/null/undefined/void/nan/date/any/unknown/literal/enum | `leafChecksArePure` | 官方产物透传 accessor；但 checks 例外见下 |
| optional/nullable | 包装层自身 checks 通过 `leafChecksArePure` 且 inner 纯 | 值透传；包装层上的 overwrite、superRefine 或 async refine 像叶子上一样改写值或改变时序（#57），而在容器之上 validator 还会保留 stock 会剥掉的未声明键（#56） |
| object/array（自身 checks 安全 + 子树全纯） | true | 骨架接管（strip 由骨架处理） |
| record/map/set | true（骨架接管后） | 键名/键值引用比较见 §5 |
| union | 全分支纯，且没有分支是容器或经 optional / nullable 剥壳后是容器 | 分支透传；容器分支需要 union 位置给不出的骨架，见陷阱四（#47） |
| readonly | false | `Object.freeze` 副作用（冻输入的风险） |
| default/prefault/catch/coerce/transform/pipe/intersection/lazy/custom/nonoptional/success | false | 值产生器/黑盒/新容器 |

### 陷阱一：`overwrite` 是值改写（差分 seed=51 实证）

`z.string().max(16).toLowerCase()` 在 zod4 里不是 schema 包装，而是 def.checks 里的
`overwrite` check。白名单把 string 判纯 → validator 通过 → `return input` →
stock 输出 "ab1" vs ours "AB1"。修复：叶子纯度必须检查自身 checks，
`overwrite` 一律非纯；`custom` 无 `fn`（superRefine 可改写 `ctx.value`）一律非纯。

### 陷阱二：length/size check 自带默认 `when`（诊断日志实证）

`.max(64)` 的 check 实例上有 `when: [Function: _whenHasLength]`，官方
`generateChecks` 用 `WHEN_DEFAULTED_CHECKS` 白名单豁免（max_size/min_size/
size_equals/max_length/min_length/length_equals）。zc-z4 最初把任何 truthy `when`
当"自定义 when"拒绝 → `.max(8)` 的 array 被误判非纯 → 走 parser → 每元素新数组
→ CoW 全灭（S1 分配 98MB 的根因）。修复：照抄官方白名单，
`hasCustomWhen = when && !WHEN_DEFAULTED_CHECKS.has(check)`。

### 陷阱三：`nullable(object)` 必须剥壳（差分 seed=104/133/137 实证）

容器识别若只看 `def.type === "object"`，`nullable(object)` 会落入"纯叶子键"分支，
走官方 assertOnly，但官方 validator 跳过多余键剥离（strip 是输出构造行为，
不影响校验成败）→ 输入的多余键原样透传 → 与 stock 分歧。修复：
`cowSafeContainerForChild` 沿 optional/nullable 链剥壳，`emitBoxedContainer`
发射壳检查（null→null、undefined→undefined），到容器后走 CoW 骨架。

这条链上的包装层可以带自己的 checks，而在 #56 之前骨架会把它们丢掉：门控把 `optional(object)` 上的 `.refine`
当作纯谓词放行，`emitBoxedContainer` 却只发射壳检查和容器骨架，于是
`z.object({ a: z.string() }).optional().refine(f)` 接受了 stock 拒绝的输入。stock 在包装层自身的代码之后、
对该层产出的值运行其 checks：短路时是短路值（optional 为 `undefined`，nullable 为 `null`），否则是内层输出，
且内层包装的 checks 先于外层。现在 `emitBoxedContainer` 先收集整条链；短路分支在返回前运行本层及其上方每一层的
checks，容器输出则由内到外运行每一层的 checks。带这类 checks 的链把容器编译成只调用一次的嵌套骨架，因为内联骨架
会在自己的分支里把干净输入直接返回，之后发射的任何代码在该路径上都不会运行；不带 checks 的链仍像以前一样内联。
门控（`wrapperChecksAreCowSafe`）只放行 `.refine` 谓词，即 `containerChecksFn` 能发射的 checks；包装层上的其他
check（overwrite、superRefine、async refine、经 `.check()` 附加的长度 / 大小检查）让整条链走官方 parser，`isPure`
同样拒绝它（它以前只递归 inner 而不看包装层的 checks，于是这样的链走了 validator 并保留未声明键；同一行也修复了
#57 的叶子情形）。差分生成器从未构造过这种形状：一个子节点最多套一层包装，而其 refine 谓词对容器永远不会失败。
现在三个被包装的子节点里有一个在包装层之上再叠一个 check（同步或 async refine、overwrite），refine 谓词也拒绝恰好
三个条目的容器；在未修复的引擎上，每一遍各找出 20 000 case 中的 5 个。

### 陷阱四：union 分支不是骨架位置（#44 评审中发现，生成器加入 union 后由差分复现，#47）

白名单判容器为纯的前提是"本层骨架接管"，这在顶层和键 / 元素 / 值位置成立
（`cowSafeContainerForChild` / `containerChildFn` 把容器路由进子骨架）。而 union 整体是一个官方产物，
其分支拿不到骨架：`z.union([z.object({ a: z.string() }), z.number()])` 被判纯（各分支皆纯），
`childProduct` 为整个 union 发射 `assertOnly` validator，输入 `{ a: "x", extra: 1 }` 按原引用返回并保留
`extra`，而 stock 会重建对象并丢掉它（顶层与嵌套皆然；strict 分支会保留未声明的自有 symbol 键，
`array(object)`、`optional(object)` 分支与 discriminatedUnion 表现相同）。修复：只要有一个分支是容器
（object / array / tuple / record / map / set）或经 optional / nullable 剥壳后是容器，`isPure(union)` 即为
`false`；该 union 走官方 parser + 引用比较，按 stock 的方式重建命中的容器。代价是带容器分支的 union
失去 CoW 路径（现在总会拷贝）；按顺序尝试各分支 CoW 产物的 union 骨架是长期修复。差分生成器自此修复起
生成 union（2 到 3 个随机分支，四分之一为两个 object 分支的 discriminatedUnion）；下文引用的早期运行
虽然列表里写着 "union"，实际一个也没生成。

> 方法论：前三个陷阱没有一个是靠读代码发现的，全部由随机 schema 差分测试
> 抓出（`REPRO=seed:case` 一键复现；第四个在评审中发现，之所以逃过 fuzz 只是因为生成器不生成 union，于是生成器补上了它）。纯度分析的完备性只能靠 fuzz 验证：
> 白名单"宁可误判非纯"的保守性 + 5 万 case 差分，是这条路线的安全性边界。

## 5. record/map/set 骨架（v0.4 新增，激进全覆盖）

官方这三个生成器同样"无条件新容器"：record `const v0 = {}`、map
`new Map()`（还带每条目解构分配）、set `new Set()`。骨架策略与 object 一致，
多出两个 CoW 特有问题：键名会变（数值键重试/键转换）与键序（声明驱动）。

### 5.1 record：三条编译期路径

```
keyType._zod.values 存在且非 partial?
  ├─ 是 → 路径 A：声明驱动（z.record(z.enum([...]), v)）
  └─ 否 → keyType 是 bare-string（type==="string" && 无 format && 无 coerce && 无 checks）?
        ├─ 是 → 路径 C：键名恒不变，纯值比较
        └─ 否 → 路径 B：keyFast 产物 + 数值键重试 + 键名引用比较
```

路径 C（最常见）生成代码骨架：

```js
if (!c0(input)) return INVALID;                            // util.isPlainObject（官方同名函数）
let x0 = input, x1 = false;
for (const k of Reflect.ownKeys(input)) {
  if (k === "__proto__") continue;
  if (!c1.call(input, k)) {                                // propertyIsEnumerable（官方同款）
    if (typeof k === "symbol" && !x1) { x1 = true; x0 = { ...input }; }  // 不可枚举的自有 symbol：stock 的重建会丢弃它（#51）
    continue;
  }
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

不可枚举键的跳过分支就是路径 B 与 C 处理未声明自有 symbol 键的地方（#51）：可枚举的 symbol 会像 stock 一样被当作键来校验
（字符串键 schema 拒绝、接受 symbol 的 schema 通过、loose record 原样保留），而不可枚举的 symbol 会被 stock 跳过、随后被其重建丢弃，
干净路径却会连同它一起返回输入。`Reflect.ownKeys` 已经列出了它，所以跳过分支在 `typeof k === "symbol"` 时把 record 判脏，不增加任何调用；
`{ ...input }` 只拷贝可枚举键，因此与 stock 一样丢掉它。在 `ownSymbolKeys: "ignore"`（#43）下该分支只是 `continue`，symbol 按原引用保留。

路径 B（数值键重试，键名会变）：沿用官方 `keyFast + regexes.number 重试`
模板，额外做键名引用比较，`outKey !== k` 也判脏，拷贝分支
`delete out[k]; out[outKey] = t;`。键名不变的子场景（string format 键如
`z.record(z.email(), v)`）中 `outKey === k` 恒成立，键名比较零成本。

路径 A（enum 声明驱动）：官方输出 = 按声明序无条件物化全部声明键
（缺失键 + optional 值 → 写 undefined）+ 未知键 strict 拒绝。骨架：

- 缺失声明键即脏（`!(k in input)` → stock 会物化该键）；
- 未知键 strict 拒绝照抄（`for...in → INVALID`）；
- 未声明的自有 symbol 键：`for...in` 永远不会产出它，strict 与 loose 都看不到，而 stock 的重建在每条路径上都会丢弃它，
  正是对象骨架的 #42 情形。没有键为脏时骨架运行与对象骨架相同的 `Object.getOwnPropertySymbols` 探测（`emitOwnSymbolProbe`，#51），
  发现未声明的 symbol 即判脏；拷贝路径按构造就不会带上它。`ownSymbolKeys: "ignore"` 在这里同样跳过探测。
  本地 Node 24 实测（单记录热循环，每轮 2 000 000 次）6 键 enum record 干净输入：带探测 74 ns，不带 31.5 ns，官方 parser 99 ns；
- 拷贝分支 `{...input}` 后逐声明键写回（validator 产物键写 `inVar`，缺失时
  `inVar === undefined` 恰好就是 stock 语义；parser 产物键写产物输出值）。

实测语义锚点：`{a:1}` 对 `z.record(z.enum(["a","b"]), z.number().optional())`
→ stock 物化 `b: undefined` → ours 判脏返回 `{a:1, b:undefined}` ✓；未知键
`{a:1,b:2,extra:3}` → 双方都拒绝 ✓。`{a:1, b:2, [Symbol()]: 3}` 对 `z.record(z.enum(["a","b"]), z.number())`
→ stock 丢弃该 symbol → ours 也拷贝并丢弃，同一输入去掉 symbol 后仍是原引用 ✓（#51；此前干净路径会连同 symbol 返回输入，
而拷贝路径会丢弃它）。被定义为不可枚举属性的*已声明*键（symbol enum 值或已声明的字符串键）属于 #48 那一族，只记录不探测：
探测只问是否存在未声明的 symbol，所以干净路径按定义原样返回输入，而 stock 的重建会写入一个可枚举的数据属性；拷贝路径像 stock 一样写入该键。
对象骨架的行为相同（README 已知限制）。

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

- 键纯时零开销：键 schema（string/number）官方产物透传原键 → `keyExpr === kIn`
  恒成立，键名比较被 V8 优化掉。
- 键转换正确性：键是容器/transform 时（罕见），cow/parser 产物返回新键，
  `delete(kIn) + set(newKey)` 对齐 stock（stock 对 Map 也是 set 转换后的键）。
- NaN：`vo !== vIn` 对 NaN 恒真 → 误判脏 → 过度拷贝但结果正确
  （SameValueZero 下 `delete/add` 等价）。与 README 已有的 NaN 说明一致。
- Map/Set deepStrictEqual：Node assert 对 Map/Set 做条目集合比较
  （顺序无关），`delete+set/add` 的顺序差异不影响差分。

### 5.3 接线方式

- `cowSafeContainerForChild` 增加 `record/map/set` case → 键位/元素位/顶层自动接管；
- `emitBoxedContainer` 尾部扩到六容器 → `nullable(record)` / `optional(map)` / `optional(tuple)` 直接可用；
- `checksAreCowSafe`/`containerChecksFn` 增加 map/set 的 size 系 check；
- 值位置统一走 `childProduct()`（容器→cow 子骨架 / 纯→validator / 非纯→parser / async→async 岛），
  与 object 键位、array 元素位共用同一条选择逻辑。

### 5.4 tuple 骨架（v0.5 新增）

官方 `generateTupleCheck`（compile.js L1289-1374）的逐行镜像 + CoW 修饰。三个关键语义机制：

1. optinStart / optoutStart（官方 `getTupleOptStart` 逐字照抄）：从尾向头找第一个
   不可省槽位。optin 三档梯子（`optin !== undefined` 即可省，含 optional/defaulted），
   optout 两档（仅 `optout === "optional"`）。长度守卫：无 rest 时 `[optinStart, N]`，
   有 rest 时 `>= optinStart`。
2. fillLen 变量（本层发明）：官方用动态 `out.length` 做尾槽门控（`if (out.length === i)`），
   但 CoW 时输出可能还是输入原引用（不能读/写 `.length`），所以必须显式跟踪逻辑长度。
   不变量：`out === input ⟹ fillLen === input.length`（截断/填充路径必先拷贝）。
3. 三段式：段 1 `[0, optoutStart)` 无条件槽（官方照样物化缺席槽：validator 槽写
   `undefined`、值槽写产出）；段 2 尾槽门控 + 缺席三分支（`dropsWhenAbsent` → 截断
   / validator → 截断 / IIFE → INVALID/undefined 截断、有值填充）；段 3 rest 无门控逐槽。
   截断三态：已拷贝→实截；原引用且目标≠输入长→拷后截；目标===输入长→输出===输入，零操作
   （trailing optional 截断到输入长度的场景可以保住原引用）。

收益最大的场景：全数字/全干净 tuple。stock 每次都 `new Array` + 逐槽写，CoW 零拷贝
（S6：4.57x vs stock / 3.06x vs 官方 parser，全部场景中比值最高）。

### 5.5 async 通道（v0.5 新增）

设计前提：官方 compileFn 对 async（refine/transform/custom/superRefine/pipe，共 6 处
`isAsyncFunction` 检测点）一律抛 `ZodCompileAsyncError`，这恰好是现成的"子树 async 探测器"。
本层把"探测到 async → 整树降级"改为"就地转 async 岛 + 骨架局部 await"：

1. async 岛：`makeAsyncIsland(schema)` = async 黑盒，返回 `Promise<输出 | INVALID>`，
   产物挂 `ZC_ASYNC` symbol 标记。
2. await 发射：所有产物调用位（object 键/array 元素/tuple 槽/record 值/map 键值/set 成员/
   容器 checks 的 async refine 谓词）检测 `isAsyncProduct(fn)` → 发射 `await` + `ctx.async = true`。
3. 骨架 async 化：`buildFn` 依 `ctx.async` 决定 `async (input) =>` 还是 `(input) =>`，
   产物挂 `ZC_ASYNC` → 子骨架父层自动感知（`childProduct` 返回 `kind: "async"`）。
4. 公开 API：`Compiled` 增加 `async: boolean`、`parseAsync` / `safeParseAsync`；
   async 骨架下 sync API 抛 `$ZodAsyncError`（官方同款语义，实测 sync parse 对 async 树就是抛）。
5. lazy(async) 补漏：官方对 lazy 产物是 runtime island，内部 async 编译期不报错 →
   Promise 会静默传出去。`subtreeHasAsync` 静态探测（def 树递归，含 checks 的 fn/superRefine、
   pipe 的 transform、lazy getter 展开，seen 防环）→ async lazy 改走 async 岛。

关键语义保留：同步 island（`makeIsland`）遇到 Promise 时抛 `$ZodAsyncError`（官方
compile.js `throwAsync` 同款注释：返回 INVALID 会被 union 读成分支拒绝，必须让 throw 存活）。

混搭效果：一棵树里只有 async 子树位付 microtask 成本，其余全部保持引用比较骨架
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
顶层骨架照常编译，lazy 子树在元素位走官方 parser 产物，官方 `generateLazyCheck`
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

1. 对 stock：2.31x（S1）~ 2.50x（S2）~ 2.61x（S5）~ 4.57x（S6 tuple，全场景最高），
   且驻留从 123~217MB 归零；async 场景（S7）2.50x。
2. 对官方 JIT parser：干净场景基本持平（S1 0.93~1.00x，批间噪声内，骨架省掉的输出
   构造恰好抵掉子骨架函数调用开销）；脏场景反超（S2 1.47x、S5 1.93x、S6 3.06x），
   因为官方 stock 语义的 default shallowClone 与整树重建是固定成本，CoW 只为真正变脏的路径
   付费。S6 的 3.06x 说明：tuple 是重建占比最高的容器（每次 parse 都 new Array + 逐槽写，
   而槽位几乎不变），CoW 修饰收益最大。
3. async 通道（S7）：骨架局部 await，async 子树位付 microtask 成本，其余保持引用
   比较骨架；async transform 全脏场景仍有 2.50x，分配 -63%（95.6→34.9MB）。
4. validate 快路径：官方 assertOnly 整树单体产物 50ms / 50 万 = 100ns/账户，
   比官方逐账户调用（219ms，含 payload 包装）快 4.4x，分配 0。

S1 的 +30.5MB 短命分配来自官方叶子产物内部（datetime/email 格式校验的临时值），
gc 后驻留 0，CoW 本身零拷贝。v1 的 12.1MB 更低，但速度慢一倍；速度与微量短命
分配之间的取舍，在生产语境（minor GC 便宜）下选了 zc-z4，这也是 v1 最终被移除的原因之一。

## 8. 正确性证据

- `tests/smoke-z4.test.ts`（19 组行为断言，第 18 组为 #56：容器之上 optional / nullable 包装层的 refine 在顶层和嵌套位置都像 stock 一样拒绝（object 与 array，record、map、set 与 tuple 之上亦然）、能看到短路值、沿两层包装链按 stock 的顺序运行、看到剥离后的拷贝并在通过时保持共享，包装层上的 async refine 或 superRefine 走官方 parser；第 19 组为 #57：叶子之上包装层的 overwrite 或 superRefine 在顶层、object 键位和 union 分支都像 stock 一样改写；第 14 组为 #47：带 strip object 分支的 union 在顶层和嵌套位置都像 stock 一样丢掉未声明键、兄弟仍共享，strict 分支丢掉未声明的自有 symbol，`optional(object)`、`array(object)` 与 discriminatedUnion 分支像 stock 一样剥离，纯叶子 union 保留 validator、父层仍共享；第 16 组为 #51：strict 与 loose 的 enum 键 record 在默认与 `"probe"` 下都会拷贝并丢弃未声明的自有 symbol（无论是否可枚举），去掉 symbol 的同一输入按原引用共享，`"ignore"` 共享且不生成探测，两种设置下拷贝路径都丢弃 symbol；字符串键、带 check 的字符串键与数字键 record 仍拒绝可枚举的 symbol 键、对不可枚举的 symbol 键拷贝并丢弃且不增加探测调用；接受 symbol 的键 schema 与 loose record 像 stock 一样保留 symbol；strip 对象下嵌套的 enum 键 record 也被覆盖；已声明键（symbol 或字符串）被定义为不可枚举时按原样返回，#48 那一族；第 17 组为 #48：不可枚举的未声明字符串键在对象每种模式与 record 每条路径（含数字键 record）的干净路径上都保留、拷贝路径像 stock 一样丢弃，类实例原样返回而拷贝是普通对象、record 两边都拒绝它，可枚举的继承键 strip 像 stock 一样拷贝、strict 两边都拒绝、loose 仍留在原型上而 stock 写成自有键，抛错的 `ownKeys`、`getOwnPropertyDescriptor` 或 `getPrototypeOf` 陷阱在 strip 的 `for...in` 探测下两种设置都抛错而 stock 的 strip 能解析、strict 与 loose 的 `ownKeys` 默认两边都抛错、loose 对 `getOwnPropertyDescriptor` 与 `getPrototypeOf` 不触发、`"ignore"` 下三个都不触发，对象骨架的 `code` 不含显式的描述符或原型探测）+ `tests/smoke-z4-containers.test.ts`
  （record 三路径 / map / set / size checks / 容器组合）+ `tests/smoke-z4-tuple-async.test.ts`
  （tuple 截断/填充/rest/refine + async 五容器通道/lazy(async)/union async 分支）全部通过。
- `tests/differential-z4.test.ts`：50000 case（seeds=500×100，随机嵌套
  object/array/tuple/record/map/set/union + optional/nullable/default/refine/transform
  + async refine/async transform 包装），与 stock zod4 全量一致：
  - 成败奇偶一致（成功 20813 / 失败 29187）
  - 输出 `deepStrictEqual` 一致（Map/Set 按条目集合比较）
  - 输入零失真（structuredClone 快照比对）
  - 顶层引用共享率 89.1%（成功 case），stock 降级 0 次
  - 自 #43 起每个 case 都会用 `ownSymbolKeys: "ignore"` 再编译一次，对同一 RNG 流去掉额外自有 symbol 后的输入运行，检查同样的三项，另加：任何深度的生成骨架都不含 `getOwnPropertySymbols`，且该 pass 共享的顶层引用不少于默认 pass。自 #51 起两个 record 生成器也会生成额外的自有 symbol（十分之一，其中一半通过 `Object.defineProperty` 设为不可枚举），输入快照保留可枚举性，运行器在 `deepEqual` 之外还固定检查顶层输出上该 symbol 是否存在，因为 harness 的比较器只拷贝可枚举键，看不到按原引用存活的不可枚举 symbol；未修复的引擎在默认 pass 下该生成器失败 26 / 20 000 case（全部是这项检查），修复后为 0；默认规模下的共享率为 85.1%（默认）与 86.0%（`"ignore"`），新生成器在两个引擎上相同，旧生成器下为 85.6% / 86.2%
- 自 #47 起生成器生成 union（2 到 3 个随机分支，四分之一为两个 object 分支的 discriminatedUnion），上面的列表此前虚有其名；在未修复的引擎上新生成器在默认 pass 失败 15 / 20 000 case、`"ignore"` pass 失败 11 个，全部是陷阱四形态的输出不一致，修复后为 0。默认规模下成功 case 的顶层引用共享率为 85.6%（默认）与 86.2%（`"ignore"`），同一生成器在未修复引擎上为 85.9% 与 86.6%（该规则放弃的容器分支 union 的 CoW 路径），旧生成器下为 88.8% / 89.4%。
- 自 #56 起三个被包装的子节点里有一个在包装层之上再叠一个 check（同步或 async refine，或把字符串转大写的 overwrite，#57），refine 谓词除字符串 "forbidden" 外也拒绝恰好三个条目的容器；在未修复的引擎上每一遍各找出 20 000 case 中的 5 个（容器之上的包装层 refine 从未运行，或叶子之上的包装层 overwrite 被判为纯），修复后为 0。默认规模下成功 case 的共享率为 85.4%（默认）/ 86.1%（`"ignore"`），旧生成器在两个引擎上均为 85.1% / 86.0%。
- 已知不对齐项（刻意保留）：async rest 槽 + nullable null 输入时 stock runtime 产生
  稀疏数组且丢 null（确定性复现：`z.tuple([z.string()], z.boolean().nullable().refine(async …))
  .safeParseAsync(["a", null, null])` → ownKeys "0,2,length"，slot 1 变 hole）；
  骨架输出稠密数组（更正确），差分生成器规避该组合；详见 upstream-issue-draft.md §Bonus。
- 失败诊断钩子：`REPRO=seed:case node --import tsx tests/differential-z4.test.ts`
  打印 schema desc、input、CoW 骨架源码：先是顶层骨架，随后按构建顺序列出树中构建的每个嵌套容器骨架
  （各自是一次独立的 `Function` 构建，以提升常量的形式进入父骨架），每个带 `// ── nested skeleton #n ──` 标题。
  它们由 `CodeCtx.sources` 收集：`subFn` 把父上下文的列表交给子上下文，`buildFn` 追加每个构建出的函数体，
  构建后失败并被官方产物替换的子骨架会被再次移除，因此 dump 只含树实际调用的函数（#46）。

## 9. 版本锚点与风险

依赖的官方内部面（均经 `zod4/v4/core` 公开 exports，但官方注释定位为 internal）：

| API | 用途 | 漂移风险 |
|---|---|---|
| `compileFn(schema, {assertOnly, debug})` | 叶子/子树产物 | 签名变化（低）；行为变化由差分兜底 |
| `INVALID` | 失败哨兵 | 极低（Symbol.for 稳定） |
| `ZodCompileUnsupportedError/AsyncError` | 降级判定 + async 探测器（v0.5） | 低 |
| `$ZodAsyncError` | 同步 island 遇 Promise 的官方语义抛错；sync API 对 async 骨架 | 低 |
| `regexes.number` / `util.isPlainObject` | record 骨架 | 低（官方内部一致性依赖同款） |
| `WHEN_DEFAULTED_CHECKS` / `fastPathAcceptsAbsence` 等语义谓词（照抄实现，非 import） | 纯度分析 | 中：zod 改 when 语义时需同步 |
| `getTupleOptStart` / `dropsWhenAbsent`（照抄实现，非 import） | tuple 尾槽截断语义（v0.5） | 中：zod 改 optin/optout 梯子时需同步 |

缓解措施：降级链保证任何漂移最多表现为"退化到 stock"（正确性无损）；
async 通道把 `ZodCompileAsyncError` 用作官方自维护的 async 探测器（官方扩展 async 检测点
时本层自动跟随）；差分测试 5 万 case（含 tuple/async 生成器）是升级 zod 时的强制回归门槛；
已起草上游 issue 推动 `compileFn`/assertOnly 转正（docs/upstream-issue-draft.md），
消除最大的一块内部依赖。

## 10. 结论：两条路线的适用域

- v1（自研 codegen）的适用域是强受控环境 / 长支持窗口：零内部 API 依赖
  （只读 `_zod.def`）、分配更低、可以锁定旧版 zod。本仓库不再需要这个域：
  它只维护一条 zod4 线，v1 已随 issue #4 移除；下面的对比因此是决策记录，
  而不是仍在维护的两个选项。
- zc-z4（官方 codegen + CoW 修饰）是 zod4 时代的正解：语义正确性外包给官方
  编译器与 runtime，自研面缩到"纯度分析 + 6 个容器骨架 + async 通道"，跟随上游
  优化自动受益；速度与官方 JIT 持平，脏场景反超 1.5~1.9x、tuple 3.1x、async 2.5x
  （对 stock 2.3~4.6x），GC 驻留归零。
- 两条路线共享同一个 CoW 心智模型：引用比较即脏信号，path-copying 即拷贝策略。
  差别只在"校验与变换这一层由谁实现"。

## 11. Source layout (issue #5)

The engine lives in `src/cow4/` as a set of modules cut along the seams described above; every function kept its body and comments when it moved, so the sections of this document still map one-to-one onto the code.

| Module | Section of this doc | Holds |
|---|---|---|
| `index.ts` | §6 | Thin entry: `compileCowFn`, `compileCowDebug`; re-exports `INVALID`, `Fn`, `ZC_ASYNC`, `isAsyncProduct`, `officialValidator` |
| `product.ts` | §5.5 | `Fn` product contract, `ZC_ASYNC` marker, `isAsyncFn`, `throwAsync` |
| `codectx.ts` | §3 | `CodeCtx`（携带 debug dump 共享的 `sources` 列表）, `escKey`, `buildFn` |
| `predicates.ts` | §9 | Verbatim zod copies: `acceptsAbsence`, `requiresPresence`, `mayOutputUndefined`, `getTupleOptStart`, `dropsWhenAbsent` |
| `purity.ts` | §4 | `isPure`, `leafChecksArePure`, `checksAreCowSafe`, `WHEN_DEFAULTED_CHECKS`, `cowSafeContainerForChild` |
| `official.ts` | §6 | `officialFn`, `officialValidator`, `makeIsland`, `makeAsyncIsland`, `subtreeHasAsync` |
| `emit.ts` | §3, §5.3 | `emitNode`, `emitBoxedContainer`, `childProduct`, `containerChildFn`, `containerChecksFn`, `subFn` |
| `emit-object.ts`, `emit-array.ts` | §3.1, §3.2 | `emitCoWObject`, `emitCoWArray` |
| `emit-tuple.ts` | §5.4 | `emitCoWTuple` |
| `emit-record.ts`, `emit-map.ts`, `emit-set.ts` | §5.1, §5.2 | `emitCoWRecord`, `emitCoWMap`, `emitCoWSet` |

`emit.ts` and the six `emit-*.ts` modules import each other: `emitBoxedContainer` dispatches to the skeletons, and the skeletons recurse into child containers through `containerChildFn` / `childProduct`. The cycle is safe because every binding involved is a hoisted function declaration and none of these modules executes anything at load time. Do not add top-level code that calls across the cycle.
