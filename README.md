# cow-zod-prototype

[![CI](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml)

Zod 兼容的 **CoW（Copy-on-Write）编译层** 原型 —— 源自对 [Numeric fork](https://numeric.substack.com/p/how-we-doubled-zod-performance-to) 思路的延伸。

> **v0.2：已适配 zod 4**。双前端共享同一 CoW 核心（`internal.ts`）：
> zod3 前端（`compile.ts` + `src/index.ts`）与 zod4 前端（`compile-z4.ts` + `src/index-z4.ts`）。
> zod4 的适配要点与基准结论见下文 [zod4 适配（v0.2）](#zod4-适配v02)。

**核心差异**：Numeric 为了让 `parse` 返回原始对象，直接删除了 `default / transform / coerce / catch / pipe / preprocess / intersection` 七个特性；本原型用 **引用比较作为脏信号 + 按需路径拷贝**，让这些特性全部保留，且只在"运行时真的产生了新值"的那一点才拷贝。

- 不 fork zod、不改 Zod API：zod schema 原样消费（读取 `.def` 树），类型推断继续用 `z.infer`
- 编译期一次性解析 shape / keys / checks，生成特化校验闭包
- 单一可变 ctx + 惰性 path（只在产生 issue 时物化 path 快照）
- **输入永不失真**：绝不原地修改（Numeric fork 的 strip 会原地 delete 多余键，这里修复了该 footgun）

## 快速开始

要求：Node.js >= 22.13.0（pnpm@11.24.0）

```bash
pnpm install
pnpm run probe       # 实测 stock zod 边界语义（探针驱动版本兼容）
pnpm test            # 27 个单元测试 + 20000 case 差分模糊测试（对比 stock zod）
pnpm run bench       # 50 万账户基准（需 node --expose-gc，脚本已配置）
pnpm exec tsx examples/demo.ts   # 60 秒上手 demo
```

## 使用

```ts
import { z } from "zod";
import { compile } from "./src/index.js";

const User = z.object({
  id: z.number().int(),
  name: z.string(),
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

const fast = compile(User);

fast.parse(data);     // CoW：未被迫修改时 === 输入原引用；被迫时只拷贝脏路径
fast.validate(data);  // 同 parse 的运行时，返回 DeepReadonly<User> 类型视图
fast.safeParse(data); // 不抛错版本
fast.pure;            // 静态纯度：true 表示成功时恒等返回输入引用
```

## CoW 机制（为什么不需要任何"修改通知"协议）

每个编译后的节点是 `(data, ctx) => value | FAILED`：

| 输入类型 | 脏信号判定 |
|---|---|
| 原始类型（string/number/bigint…） | 值比较：`'  x '.trim() !== '  x'` → 脏；`'x'.trim() === 'x'` → 不脏，零拷贝 |
| 对象 / 数组 / Map / Set | 引用比较：子节点透传原引用 → 父层不拷贝 |
| default / transform / coerce / catch / preprocess / pipe | 返回新值 → 父层通过 `outVal !== inVal` 自动感知 |

父层在**第一个**变化点做一次浅拷贝（`{...data}` / `slice()`），后续脏字段直接写入该副本；
兄弟子树继续共享 —— 即持久化数据结构的 path-copying：改一个叶子只拷贝它到根的一条路径。
成本模型：期望分配次数 ≈ Σ P(节点变脏) × 深度；最坏退化为全量重建（= stock 行为），典型 ≈ 0。

## "被迫复制"的完整清单

| 特性 | 何时拷贝 |
|---|---|
| string/number/boolean/bigint/date/literal/enum/instanceof 类、refine（纯谓词）、optional/nullable/readonly/any/unknown | **永不** |
| object/array/record/tuple/map/set | 所有子值未变 → **原引用** |
| union / discriminatedUnion（判别值快速分派） | 命中分支的产出未变 → 原引用 |
| default | 仅当 undefined 实际注入（且默认值同样过内层校验，与 stock 一致） |
| transform / preprocess / pipe / catch | 仅当运行时实际产生新值 |
| strip（默认模式） | 仅当输入**确实存在**多余键（零分配 for-in + Set 探测） |
| strict / passthrough | 永不（strict 有多余键直接失败） |
| `.trim() / .toLowerCase() / .toUpperCase()` | 仅当值实际变化（值比较） |

## 与 stock zod 的语义对齐

探针（`src/probe.ts`）在运行时实测 stock 行为，编译器据此自适应：

- **缺席 optional 键**：不物化（输出 `{}`，与 stock 3.24.1 一致 —— 透传天然正确）
- **present-undefined 键**：保留显式 `undefined`（`alwaysSet` 语义，strip 重建分支有对应守卫）
- **default 值**：同样通过内层 schema 校验（非法默认值 → 失败，与 stock 一致）
- **issue 收集**：失败后继续遍历兄弟字段/元素，一次 parse 收集全部 issue（表单校验友好）
- **readonly**：浅冻结输出（stock 行为）；CoW 下冻结的共享结构天然防篡改
- **string 格式校验**（email/uuid/datetime/…）：正则逐字拷贝自 zod 3.24.1 内部实现

**验证**：单元测试 27 项 + 差分模糊测试 20000 case（随机 schema + 随机数据，断言
成败奇偶 / 输出 deepStrictEqual / 输入零失真）。当前全部通过，成功 case 的顶层引用共享率 ≈ 92%。

## 基准（50 万账户，node v24，--expose-gc，3 轮取中位）

| 变体 | 耗时（中位） | 分配压力（gc 前） | gc 后驻留 |
|---|---|---|---|
| S1 纯校验 · stock zod 3.24.1 | 2092 ms | +266.7 MB | +183.8 MB |
| S1 纯校验 · **zc compiled（CoW）** | **487 ms（4.29x）** | **+10.1 MB** | **+0.0 MB** |
| S1 参照线 · arktype 2.2 | 182 ms | +10.7 MB | +0.0 MB |
| S2 脏负载（role 带 default，10% 缺失）· stock | 2185 ms | +246.8 MB | +183.8 MB |
| S2 脏负载 · **zc compiled（CoW）** | **434 ms（5.03x）** | **+20.2 MB** | +10.3 MB |

对比 Numeric 报告的 ~2x：本原型 4.3-5.0x，因为除零拷贝外还叠加了
无包装对象 / 惰性 path / 编译期 shape 解析。与 arktype 剩余 ~2.7x 差距 =
逐节点函数分发（解释器残差），下一步可用 `new Function` 单体 codegen 消除（ArkType 路线）。

## zod4 适配（v0.2）

### 使用

```ts
import { z } from "zod4";                          // zod@4.5.4（npm 别名，与 zod3 共存）
import { compile } from "./src/index-z4.js";       // API 与 zod3 版完全同构

const fast = compile(User);
fast.parse(data); fast.validate(data); fast.safeParse(data); fast.pure;
```

### zod4 与 zod3 的结构差异（全部经 `src/probe-z4.ts` 实测锚定）

| 维度 | zod3 | zod4 |
|---|---|---|
| checks 位置 | 包装类型（`ZodString` 的 checks 数组） | 扁平 `def.checks`，且 `z.email()/z.iso.*()/z.int()` 把 format check **直接挂在 def 本身**（`def.check`） |
| check 实例 | `c.kind` + `c.value` | `check` kind 命名不同（`min_length/max_length/greater_than/string_format/number_format/overwrite/custom`…），可能是实例或裸 def，需归一化 |
| `.int()` | `ZodNumber` check kind `"int"` | `number_format "safeint"`（isInteger + 2^53 范围，越界报 too_big） |
| 对象模式 | `def.unknownKeys` 标志 | strict = `catchall: never`，loose = `catchall: unknown` |
| 对象输出重建 | `alwaysSet` 规则 | **`optin`/`optout` 驱动**：缺席 optional 键不物化、present-undefined 保留、缺席必填键报 `nonoptional` |
| `.default()` | 默认值**要过**内层校验 | **短路**（默认值不校验）；且 `handleDefaultResult` 会在内层产出 undefined 时补默认值 |
| `.optional()` | 纯透传 undefined | 内层 `optin === "defaulted"` 时把 undefined **交给内层**（让 default 点火） |
| `.catch()` | **吞异常** | **不吞异常**（只有校验失败才落 catch 值） |
| `.transform()` | `ZodEffects` | `pipe(in, transform)`；`fn(value, payload{issues, addIssue})` |
| refine | `ZodEffects.refinement` | `def.checks` 里的 `custom` check；所有 check 实例都有惰性编译的 `_zod.check(payload)` —— 作为未手写 kind 的通用通道 |
| string format | 正则逐字拷贝进 `regexes.ts` | `string_format` 检查**自带 pattern 正则**（email/uuid/datetime/ipv4…直接内联） |
| record 键 | 仅 string | 支持 number 键（数值字符串回退重试）；**enum/literal 键是声明键驱动**（声明键全部必填 + 多余键报 unrecognized_keys） |
| NaN | `invalid_type received nan` | 同左（z.number() 拒绝 NaN） |

### zod4 基准（50 万账户，node v24.19，--expose-gc，3 轮取中位）

| 变体 | 耗时（中位） | 分配压力（gc 前） | gc 后驻留 |
|---|---|---|---|
| S1 纯校验 · stock zod4 parse | **223 ms** | +110 MB | +108 MB |
| S1 纯校验 · stock zod4 + JIT（`zod4/compile`） | 235 ms | +110 MB | +108 MB |
| S1 纯校验 · **zc CoW parse** | 510 ms（0.51x） | **+0.3 MB** | **+0.0 MB** |
| S1 参照线 · arktype 2.2 | 158 ms | +27 MB | +0.0 MB |
| S2 脏负载（default，10% 缺失）· stock | 381 ms | +134 MB | +123 MB |
| S2 脏负载 · **zc CoW** | 500 ms（0.76x） | **+18 MB** | +10 MB |
| S3 脏比例扫描 zc 驻留 | 0%→0 MB / 25%→20 MB / 50%→36 MB / 100%→69 MB | — | （stock 恒 +123 MB） |

**结论（z4 上价值主张的变化）**：

1. **zod4 已把"解释器税"基本消掉**：同一场景 z3 stock 2092ms → z4 stock 223ms（9.4x）。z4 的 parse 已是每类型特化函数 + 惰性 path，无每节点上下文分配。
2. **zc CoW 在 z4 上不再是速度冠军**（z3 时代 4.3-5.0x → z4 上 0.5-0.8x）：免重建输出树省下的分配成本（V8 bump-allocator 很便宜）不足以抵消通用闭包树相对 z4 特化函数的调用开销。微探针显示 zc 的**叶子校验更快**（string 1.6x / number 2.4x），差距集中在 object 组装层 —— z4 classic 的 object 走 `$ZodObjectJIT` 代码生成。
3. **zc 的结构性收益不变且更纯粹**：分配压力 -99.7%、gc 后驻留 0 MB（stock 恒 +108 MB）、输出 === 输入原引用（结构共享、可安全 alias、支持增量更新语义）。
4. `zod4/compile` JIT 在本场景与 stock 持平（其收益场景不同）；arktype 仍最快（158ms）。
5. 若要追平速度，路线仍是 worklog v0.1 提出的 `new Function` 单体 codegen（把 CoW 语义编译进单个函数体），消除逐闭包分发 —— zc 的语义层已经就绪，缺的只是代码生成层。

### zod4 验证

- `pnpm run test:z4`：单元测试 39 项（含探针金丝断言 + optional/default 组合回归）+ 差分模糊测试 20000 case 全部与 stock zod4 一致，成功 case 顶层引用共享率 91.2%
- `pnpm run bench:z4`：本基准
- `pnpm run probe:z4`：z4 def 结构/行为勘察（含 `REPRO=seed:case` 精确复现差分失败的调试钩子）

## 已知限制（原型范围）


- **结构共享可观察**：两次 parse 同一输入返回同一引用；修改输出会影响输入。
  → 类型层用 `DeepReadonly` 提示；需要独立副本时用 stock `schema.parse`。
- **refine 不得修改输入**（CoW 前提）；开发期可用 deep-freeze 输入抓违规。
- **键序**：纯透传保留输入键序；stock 按 shape 序重排（deepStrictEqual 不感知，快照工具可能感知）。
- **不支持**（编译期抛 `ZcNotSupportedError`，明确而非静默漂移）：
  z3：`intersection`、`catchall`、tuple rest、`ZodPromise`、异步 refine（运行时检测）；
  z4：`intersection`、`file/templateLiteral/promise` 等未覆盖 def.type、无 pattern 的 string_format（如 url）、异步 refine/transform（运行时检测）。
- **NaN 细节**：`z.nan()` 恒判脏（`NaN !== NaN`），输出仍正确，仅多一次拷贝。
- **symbol 键 / getter**：透传会保留 spread 可见的自有可枚举 symbol 键，与 stock 的重建行为有细微差异。
- 未做：`new Function` 单体 codegen（追平 z4 JIT/arktype 速度的下一步）、async。

## 目录

```
src/internal.ts         协议（双版本共享）：FAILED 哨兵 / Ctx / issue 辅助 / safeSet
src/probe.ts            stock zod3 行为探针
src/probe-z4.ts         zod4 def 结构 + 行为勘察（一次性诊断，含 REPRO 钩子）
src/probe-z4-flags.ts   zod4 语义金丝 flag（版本升级自动报警）
src/regexes.ts          zod 3.24.1 内部格式正则的逐字拷贝（z3 前端用）
src/compile.ts          zod3 前端编译器
src/compile-z4.ts       zod4 前端编译器（含 z4 特有语义：optin/optout、default 短路、
                        catch 不吞异常、generic check 通道、record 声明键驱动）
src/index.ts            zod3 compile() API
src/index-z4.ts         zod4 compile() API
tests/unit.test.ts          z3 单元测试（27 项）
tests/differential.test.ts  z3 差分模糊（20000 case）
tests/unit-z4.test.ts       z4 单元测试（39 项，含金丝 + 回归）
tests/differential-z4.test.ts z4 差分模糊（20000 case，REPRO 钩子）
bench/bench.ts          z3 基准（50 万账户）
bench/bench-z4.ts       z4 基准（S1 纯校验 + JIT 线 + S2 脏负载 + S3 脏比例扫描）
examples/demo.ts        60 秒上手
```

## v0.3 — zc-v2：复用 zod4 官方 codegen 的 CoW 修饰层

### 动机

zod4（≥4.1）自带 JIT 编译器：`src/v4/core/compile.ts`，经 side-effect 入口
`import "zod/compile"` 或显式 `z.compile()` 暴露。它把整棵 schema 树编译成
单体校验函数（`new Function` + 常量提升），并内置了两个关键产物：

| 官方能力 | 说明 | 本层如何复用 |
|---|---|---|
| `compileFn(schema)` parser 产物 | stock 语义（无条件新容器） | 非纯净子树的语义后端（transform/default/catch/record/union… 全部官方实现） |
| `compileFn(schema, {assertOnly:true})` validator 产物 | 纯校验、跳过输出构造 | 纯净叶子键的校验后端 + `validate()` 整树快路径 |
| `INVALID` 哨兵 + runtime fallback | 失败路径回退 runtime 收集完整 issues | 本层任何失败只回传哨兵，issues/path/ZodError 100% 官方 |

v1（Task3）自研了 ~1100 行语义 codegen；v2 的自研代码只剩：

1. **纯度分析**（~120 行，保守白名单）：判定"校验通过 ⇒ 输出必 === 输入"。
   陷阱实测：`overwrite` check（`.trim()/.toLowerCase()`）是值改写 → 非纯；
   length/size 系 check 自带默认 `when` 函数（官方 `WHEN_DEFAULTED_CHECKS`
   白名单），不能当作自定义 when 拒绝；
   `optional/nullable` 包装的容器必须剥壳识别（裸判 def.type 会把
   `nullable(object)` 误送官方 assertOnly，丢失 strip 剥离语义）。
2. **容器 CoW 骨架 codegen**（object/array 两个模板，~200 行）：把官方
   "无条件新容器"（`const out = {...}` / `new Array(n)`）改写为
   "引用比较判脏 + 条件浅拷贝"。干净输入 `return input`（官方模板没有的一行）；
   被迫拷贝时 `out = { ...input }` —— 键存在性/键序由扩展天然保真，
   strip 多余键用官方同款 `for...in + Set` 探测后 delete。
3. **容器自身 checks 子程序**（refine/min/max）：独立校验函数，双路径调用
   对齐 stock 语义（checks 作用于最终输出：干净时=输入，脏时=重建后的 out）。

### 降级链（每棵子树独立，永不牺牲正确性）

```
CoW 容器骨架
  ├─ 纯净叶子 → 官方 assertOnly validator（校验完整、零构造）
  ├─ 非纯子树 → 官方 parser 产物 + 引用比较判脏
  ├─ 产物生成失败 → runtime island（黑盒 _zod.run）
  └─ 整树不可编译（async/递归顶层/schema catchall）→ stock safeParse
失败路径统一回退 stock（完整 issues/error map/ZodError）。
与 "zod/compile" 全局 shim 共存：回退路径自动享受官方 JIT。
```

### 基准（v0.3，50 万账户，node v24，--expose-gc，3 轮取中位）

| 场景 | stock | 官方 JIT parser | zc-v2 (CoW) | zc-v1 (自研) | arktype |
|---|---|---|---|---|---|
| S1 纯校验 | 685ms | 279ms | **280ms** | 566ms | 120ms |
| S1 分配压力 | +160.5MB | +111.0MB | **+30.5MB** | +12.1MB | +26.7MB |
| S1 gc 后驻留 | +123.4MB | +108.1MB | **0.0MB** | 0.0MB | 0.0MB |
| S2 脏负载（10% default 注入） | 641ms | 383ms | **238ms** | 537ms | — |
| S3 100% 脏 | 662ms | 439ms | **420ms** | 668ms | — |
| S4 validate（整树产物） | — | 174ms(逐账户) | **27ms** | — | 120ms |

要点：

- **复用官方 codegen 后，zc-v2 比 v1 快 2.0x**（S1 566→280ms），与官方
  parser 产物速度持平（1.00x），但分配 -73%（30.5 vs 111MB）、驻留 0MB。
- 脏负载下 zc-v2 反超官方 parser **1.61x**（default shallowClone 与输出
  重建是官方 stock 语义的固定成本，CoW 免除干净部分的重建）。
- `validate()` 是官方 assertOnly 整树单体产物：27ms / 50 万账户 = 54ns/账户，
  比 arktype（120ms）快 4.4x，分配 0。
- 剩余 30.5MB 短命分配来自官方叶子产物内部（datetime/email 格式校验的临时
  值），gc 后驻留 0MB —— CoW 本身零拷贝。

### 正确性

- `tests/differential-z4-v2.test.ts`：50000 case 随机 schema/数据，与 stock
  zod4 成败奇偶 + 输出 deepStrictEqual + 输入零失真全部一致（REPRO=seed:case
  可复现）。顶层引用共享率 81.8%（成功 case）。
- `tests/smoke-v2.ts`：11 组行为断言（原引用/strip/strict/default/transform/
  嵌套共享/数组元素/optional/union/降级链）。

### 版本锚点

本层读取 zod4 内部 API：`zod4/v4/core` 的 `compileFn/INVALID/
ZodCompileUnsupportedError/ZodCompileAsyncError`，以及语义谓词的照抄实现
（`WHEN_DEFAULTED_CHECKS`、`fastPathAcceptsAbsence`、`mayOutputUndefined`）。
锚定 zod **4.5.4**；升级 zod 时需重跑差分测试确认谓词未漂移。

## v0.4 — record/map/set CoW 骨架 + 架构对比文档

- **record 骨架**（激进全覆盖，三条编译期路径）：
  - 路径 A：enum 声明驱动键——缺失声明键判脏（stock 无条件物化）、未知键 strict 拒绝、拷贝分支逐声明键写回
  - 路径 B：一般键（string format / number 数值重试 / partialRecord）——官方 keyFast + 数值键重试模板 + **键名引用比较**（outKey !== k → 删旧键写新键）
  - 路径 C：bare-string 键——键名恒不变，纯值比较
- **map/set 骨架**：键/值/成员引用比较，首脏 `new Map(input)` / `new Set(input)`，纯键零开销（键名恒等）；Map/Set `.min()/.max()` size checks 支持
- 接线：`cowSafeContainerForChild` / `emitBoxedContainer` / `childProduct()` 统一扩展，`nullable(record)`、`optional(map)`、record 值为嵌套 object 等组合全部 CoW
- 验证：差分 50000 case（含 map/set 生成器）与 stock 全一致，成功 case 引用共享率 89.8%；S5 容器基准 2.65x vs stock、1.93x vs 官方 parser、驻留 0MB
- 架构深度走读：**[docs/ARCHITECTURE-v2.md](docs/ARCHITECTURE-v2.md)** —— v1 自研 codegen vs v2 复用官方 codegen 的完整对比（生成代码并排 dump、纯度白名单、三大陷阱复盘、降级链状态机、基准解读）

## v0.5 — tuple CoW 骨架 + async schema 支持 + 上游 issue 草稿

- **tuple 骨架**（六容器齐装）：官方 `generateTupleCheck` 逐行镜像 + CoW 修饰。
  - `optinStart`/`optoutStart`（官方 `getTupleOptStart` 逐字照抄）+ 官方同款长度守卫（无 rest 时 `[optinStart, N]`）
  - **fillLen 变量**：官方用动态 `out.length` 做尾槽门控，CoW 时输出可能还是输入引用（不能读写 `.length`）→ 显式跟踪逻辑长度；不变量 `out === input ⟹ fillLen === input.length`
  - 三段式：无条件槽（缺席槽保留官方物化语义）/ 尾槽门控 + 缺席三分支（`dropsWhenAbsent` 截断 / validator 截断 / IIFE INVALID/undefined 截断、有值填充）/ rest 无门控逐槽
  - 截断三态：已拷贝→实截；原引用且目标≠输入长→拷后截；**目标===输入长→输出===输入，零操作**（trailing optional 短输入可保住原引用）
- **async 通道**（不再整树降级）：
  - 官方 compileFn 的 6 处 `isAsyncFunction` 抛点即现成的 async 探测器 → `ZodCompileAsyncError` 就地转 **async 岛**（返回 `Promise<out|INVALID>`，产物挂 `ZC_ASYNC` 标记）
  - 全部产物调用位（object 键/array 元素/tuple 槽/record 值/map 键值/set 成员/容器 checks 谓词）async 感知 → 发射 `await` + `ctx.async` → 骨架变 async 函数，子骨架父层自动感知
  - `lazy(async…)` 补漏：官方对 lazy 产物是 runtime island 编译期不报 async → `subtreeHasAsync` 静态探测（def 树递归 + getter 展开 + 防环）
  - 同步 island 遇 Promise 抛 `$ZodAsyncError`（官方 `throwAsync` 同款语义：返回 INVALID 会被 union 误读成分支拒绝）
  - 公开 API：`CompiledV2.async` 标志 + `parseAsync`/`safeParseAsync`；async 骨架下 sync API 抛 `$ZodAsyncError`（官方同款）
- **验证**：差分 50000 case（生成器新增 bTuple + async refine/transform 变体）与 stock 全一致（成功 20813/失败 29187，引用共享率 89.1%，stock 降级 0）；冒烟新增 14 组 tuple/async 行为断言
- **基准**（本批，50 万条，node v24.19）：S6 tuple **4.57x** vs stock / **3.06x** vs 官方 parser（全场景最高——tuple 是重建占比最大的容器）；S7 async（5 万条）**2.50x** vs stock safeParseAsync、分配 -63%
- **上游 issue 草稿**：[docs/upstream-issue-draft.md](docs/upstream-issue-draft.md) —— 推动 `compileFn`/`assertOnly`/`INVALID`/错误类转正为公开 API；附模糊测试中发现的 zod4 runtime quirk（async rest 槽稀疏数组丢 null，确定性复现）
