# cow-zod-prototype

[![CI](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml)

[English](README.md) | 简体中文

> 英文 [README.md](README.md) 是权威版本，本文是它的中文对照；两者章节结构相同，修改时请同步更新。

Zod 兼容的 **CoW（Copy-on-Write）编译层** 原型，源自对 [Numeric fork](https://numeric.substack.com/p/how-we-doubled-zod-performance-to) 思路的延伸。

`compile(schema)` 返回一个快速 parser：只要没有任何东西被迫改变（没有 default、transform、strip、coerce、catch、preprocess、pipe 点火），输出就 `===` 输入原引用；一旦有值真的变了，只拷贝从那个叶子到根的一条路径，其余兄弟子树继续与输入共享。

**与 Numeric fork 的核心差异**：Numeric 为了让 `parse` 返回原始对象，直接删除了 `default / transform / coerce / catch / pipe / preprocess / intersection` 七个特性。本原型全部保留，用 **引用比较作为脏信号 + 按需拷贝**，只在"运行时真的产生了新值"的那一点才拷贝。

- 不 fork zod、不改 Zod API：zod schema 原样消费（读取 `.def` 树），类型推断继续用 `z.infer`
- 编译期一次性解析 shape / keys / checks，生成特化校验代码
- **输入永不失真**：绝不原地修改。Numeric fork 的 strip 会原地 delete 输入上的多余键，这里修复了该 footgun
- 失败路径不自带 issue 数据：编译产物返回哨兵，调用方回退 stock `safeParse` 拿完整 `ZodError`

## 两条编译线

| 线 | 入口 | 引擎 | 状态 |
|---|---|---|---|
| **zod4** | `src/index-z4.ts` → `src/cow4/` | 复用 zod4 **官方 JIT codegen**（`compileFn` / `assertOnly`）作为语义后端，叠加 object / array / tuple / record / map / set 六个 CoW 容器骨架，支持 async | **活跃线**，所有新工作都在这里 |
| zod3 | `src/index.ts` → `src/compile.ts` | 自研闭包树编译器；string 格式正则逐字拷贝自 zod 3.24.1 | **冻结参考实现**：CoW 思路的起点和对比基线，保持测试通过但不再扩展 |

zod 3 与 zod 4 并排安装：`import { z } from "zod"` 是 3.24.1，`import { z } from "zod4"` 是 zod@4.5.4 的 npm 别名。两条线不共享代码。早期的自研 zod4 前端（v0.2）已被当前 zod4 线完全取代并移除，其结论记录在 [CHANGELOG](CHANGELOG.md#020)。

## 快速开始

需要 Node.js >= 22.13.0 与 pnpm 11.24.0。

```bash
pnpm install
pnpm run test:z4     # zod4 线：版本金丝 + 冒烟测试 + 20000 case 差分模糊（对比 stock zod4）
pnpm test            # zod3 线：27 个单元测试 + 20000 case 差分模糊（对比 stock zod3）
pnpm run bench:z4    # zod4 基准，50 万条记录（需 node --expose-gc，脚本已配置）
pnpm run bench       # zod3 基准
pnpm run probe:z4    # 勘察 stock zod4 的 def 结构与行为
pnpm run probe       # 实测 stock zod3 的边界语义（zod3 线）
pnpm exec tsx examples/demo.ts   # 60 秒 demo：CoW 的三个承诺（zod3 线）
```

环境变量：`SEEDS` / `CASES` 设定差分模糊规模（默认 200 × 100）；`REPRO=seed:case` 重跑某一个失败的 zod4 差分 case 并 dump schema、输入和生成代码；`BENCH_N` 设定基准记录数。

> **CI 里的基准跑的是冒烟结果，不是参考数字。**
> [Benchmarks workflow](https://github.com/iceboundrock/zod-cow/actions/workflows/bench.yml)
> 只在手动触发（或每周）时用缩小的 `BENCH_N`（默认 50 000）跑 `bench:z4` 和 `bench`，把表格打印到 job summary。
> 它的作用是发现跑坏的 bench 脚本、不用 clone 就能看到大致形状；GitHub 托管 runner 噪声太大，跨次数字不可比。
> 本 README 和 `docs/` 中的所有数字都来自本地运行（node v24，50 万条记录）。

## 使用

### zod4 线

```ts
import { z } from "zod4";                       // 通过 npm 别名引入 zod@4.5.4
import { compile } from "./src/index-z4.js";

const User = z.object({
  id: z.number().int(),
  name: z.string(),
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

const fast = compile(User);

fast.parse(data);           // CoW：干净时 === 输入原引用，否则只拷贝脏路径
fast.safeParse(data);       // 不抛错版本；失败路径走 stock safeParse，issues/ZodError 全部官方
fast.validate(data);        // 纯校验（官方整树 assertOnly 产物）：成功返回输入引用，失败返回 null
await fast.parseAsync(data);     // async 变体；schema 含 async refine/transform 时唯一可用的入口
await fast.safeParseAsync(data);
fast.async;                 // true = 骨架含 async 子树，此时同步 API 抛 $ZodAsyncError（与 stock 一致）
fast.stock;                 // true = 本层对整树放弃，全部直通 stock（语义无损）
fast.code;                  // 生成的 CoW 骨架源码，用于调试（降级到 stock 时为 null）
```

### zod3 线

```ts
import { z } from "zod";                        // zod@3.24.1
import { compile } from "./src/index.js";

const fast = compile(User);

fast.parse(data);     // 同上的 CoW 语义；失败抛带 issues 的 ZcError
fast.validate(data);  // 同 parse 的运行时，返回类型为 DeepReadonly<User>
fast.safeParse(data); // 不抛错版本
fast.pure;            // 静态纯度：true 表示成功时恒等返回输入引用
```

## CoW 不变量

每个编译后的节点是 `(input) => output | FAILED 哨兵`，不需要任何"修改通知"协议：

| 输入类型 | 脏信号判定 |
|---|---|
| 原始类型（string / number / bigint …） | 值比较：`'  x '.trim() !== '  x'` 为脏；`'x'.trim() === 'x'` 不脏，零拷贝 |
| object / array / tuple / record / Map / Set | 引用比较：子节点返回输入原引用即"没变"，父层不拷贝 |
| default / transform / coerce / catch / preprocess / pipe | 返回新值，父层通过 `outVal !== inVal` 自动感知 |

父层在**第一个**变化点做一次浅拷贝（`{...input}` / `slice()` / `new Map(input)`），后续脏子节点直接写入该副本，兄弟子树继续共享。这就是持久化数据结构的 path copying：改一个叶子只拷贝它到根的一条路径。成本模型：期望分配次数 ≈ Σ P(节点变脏) × 深度；最坏退化为全量重建（= stock 行为），典型情况 ≈ 0。

### 何时被迫拷贝

| 特性 | 何时拷贝 |
|---|---|
| string / number / boolean / bigint / date / literal / enum / instanceof、refine（纯谓词）、optional / nullable / readonly / any / unknown | **永不** |
| object / array / tuple / record / map / set | 所有子值未变则永不：返回**输入原引用** |
| union / discriminatedUnion | 命中分支返回其输入则永不 |
| default | 仅当 `undefined` 实际被替换 |
| transform / preprocess / pipe / catch | 仅当运行时实际产生新值 |
| strip（对象默认模式） | 仅当输入**确实存在**多余键（零分配 `for...in` + `Set` 探测） |
| strict / passthrough | 永不（strict 有多余键直接失败） |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | 仅当值实际变化（值比较） |

由此约束每一处改动：

- 绝不修改输入。strip 绝不能在输入对象上 `delete`。
- 输出可能与输入别名，所以 refine 不得修改值，`readonly` 的冻结会作用到共享结构上。
- 失败路径只返回哨兵，调用方回退 stock `safeParse` 拿完整 `ZodError`。

## zod4 线如何与 stock 保持一致

zod4 线不重新实现 zod 的语义。zod4（>= 4.1）自带 JIT 编译器（`src/v4/core/compile.ts`），本层按子树复用它的产物：

1. **官方产物做叶子和子树。** `compileFn(schema)` 得到 stock 语义的 parser；`compileFn(schema, {assertOnly: true})` 得到跳过输出构造的 validator。
2. **纯度分析**是一份保守白名单，判定"校验通过 ⇒ 输出 === 输入"。纯净子树用官方 validator，非纯子树用官方 parser + 引用比较。
3. **容器骨架**是字符串模板 codegen，逐行镜像 zod 自己的 `generate*` 函数，然后把无条件的 `const out = {...}` 改写成"比较引用、首脏才拷贝、干净时 `return input`"。容器自身的 checks（`min` / `max` / `refine`）在两条路径上都对最终输出执行。
4. **Async**：async 子树变成 async 岛，所有产物调用位发射 `await`，骨架变成 async 函数。async 产物上的同步 API 抛 `$ZodAsyncError`，与 stock 一致。
5. **降级链**，按子树独立，永不牺牲正确性：CoW 骨架 → 官方 validator（纯净叶子）→ 官方 parser（非纯子树）→ runtime island（`_zod.run` 黑盒）→ 整树 stock `safeParse`（`compiled.stock === true`）。

本层依赖 zod4 内部 API（`zod4/v4/core` 的 `compileFn`、`INVALID`、编译错误类）和几处手工照抄的谓词，锚定 **zod 4.5.4**：`tests/canary-z4.test.ts` 断言编译器所假设的 stock 行为，升级时测试先红而不是静默漂移。[docs/upstream-issue-draft.md](docs/upstream-issue-draft.md) 是请求 zod 上游把这一面公开的 issue 草稿。

zod3 线则靠探针对齐（`src/probe.ts` 在运行时实测 stock zod3 的边界语义）：缺席 optional 键不物化、present-undefined 键保留、默认值要过内层校验、失败后继续收集兄弟字段的 issue、`readonly` 浅冻结。

完整设计（生成代码与官方产物并排 dump）见 [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md)。

## 基准

zod4 线，v0.5 测量：50 万账户，node v24.19，`--expose-gc`，3 轮取中位（`pnpm run bench:z4`）。"官方 parser"指 zod4 自己的 `compileFn` parser 产物。

| 场景 | stock zod4 | 官方 parser | **zc-z4（CoW）** | arktype |
|---|---|---|---|---|
| S1 纯校验 | 654 ms | 263 ms | **283 ms** | 144 ms |
| S1 分配压力 | +160.5 MB | +111.0 MB | **+30.5 MB** | +26.7 MB |
| S1 gc 后驻留 | +123.4 MB | +108.1 MB | **0.0 MB** | 0.0 MB |
| S2 脏负载（10% default 注入） | 619 ms | 363 ms | **247 ms** | — |
| S3 扫描 0% / 25% / 50% / 100% 脏 | 622 / 647 / 679 / 660 ms | 391 / 415 / 452 / 449 ms | **245 / 268 / 311 / 404 ms** | — |
| S3 gc 后驻留 | +123.3 MB 恒定 | — | **0 / 20 / 36 / 68.7 MB** | — |
| S4 validate | — | 219 ms（逐账户） | **50 ms** | 144 ms |
| S5 record / map / set | 922 ms | 681 ms | **353 ms** | — |
| S5 分配压力 / 驻留 | +256.1 MB / +217.4 MB | +245.3 MB / +217.4 MB | **+38.1 MB / 0.0 MB** | — |
| S6 tuple | 508 ms | 340 ms | **111 ms** | — |
| S6 分配压力 / 驻留 | +214.0 MB / +206 MB | +202.2 MB / +202 MB | **+15.3 MB / 0 MB** | — |
| S7 async transform（5 万条） | 262 ms（safeParseAsync） | 编译拒绝 | **105 ms（safeParseAsync）** | — |
| S7 分配压力 | +95.6 MB | — | **+34.9 MB** | — |

解读：

- **对 stock**：2.31x（S1）到 2.61x（S5）到 **4.57x（S6 tuple，全场景最高）**，gc 后驻留从 123～217 MB 归零；async（S7）2.50x。
- **对官方 JIT parser**：干净场景持平（S1 0.93～1.00x，批间噪声内：骨架省掉的输出构造恰好抵掉子骨架调用开销），脏场景反超（S2 1.47x、S5 1.93x、S6 3.06x），因为 default 的 `shallowClone` 与整树重建是 stock 语义的固定成本，CoW 只为真正变脏的路径付费。
- **validate 快路径**：官方整树 `assertOnly` 产物 50 ms / 50 万 = 100 ns/账户，零分配。
- S1 的 +30.5 MB 是官方叶子产物内部的短命分配（datetime/email 格式校验的临时值），CoW 本身零拷贝。

zod3 线对 stock zod 3.24.1（仍付解释器税）测得 4.3～5.0x。那张表，以及已移除的 v0.2 前端和 v0.3 的表，都在 [CHANGELOG](CHANGELOG.md)。

## 正确性证据

- **差分模糊**（`tests/differential-z4.test.ts`）：随机嵌套 object / array / tuple / record / map / set / union，套 optional / nullable / default / refine / transform 及 async refine / transform，与 stock zod4 比较成败奇偶、`deepStrictEqual` 输出（Map/Set 按条目集合比较）和输入零失真（structuredClone 快照）。v0.5 的 50 000 case 运行：成功 20 813 / 失败 29 187，成功 case 顶层引用共享率 **89.1%**，stock 降级 0 次。代码默认 200 × 100 = 20 000 case。
- **冒烟测试**（`tests/smoke-z4*.test.ts`）：原引用、strip、strict、default、transform、嵌套共享、数组元素、optional、union、降级链、record 三路径、map / set 与 size checks、tuple 截断 / 填充 / rest / refine、async 贯穿全部容器、`lazy(async)`、union 的 async 分支。
- **版本金丝**（`tests/canary-z4.test.ts`）：断言编译器所假设的 stock zod4 行为（default 短路、catch 不吞异常、optional 把 undefined 交给带 default 的内层……）。
- zod3 线有 27 个单元测试和自己的 20 000 case 差分模糊（`tests/differential.test.ts`），顶层引用共享率约 92%。
- 架构文档里的每一个纯度陷阱都是模糊测试抓出来的，不是读代码发现的。纯度分析的完备性只能靠 fuzz 证明，所以任何纯度规则或容器骨架的改动都必须跑差分套件并报告引用共享率。

## 已知限制（原型范围）

- **结构共享可观察**：两次 parse 同一输入返回同一引用；修改输出会影响输入。类型层用 `DeepReadonly` 提示；需要独立副本时用 stock `schema.parse`。
- **refine 不得修改输入**（CoW 前提）；开发期可 deep-freeze 输入抓违规。
- **失败时的 refine 副作用**：parse 失败时 refine 回调先在骨架里跑一次，再在 stock 回退里跑一次，共两次。官方 `zod/compile` shim 语义相同。
- **键序**：纯透传保留输入键序；stock 按 shape 序重排（`deepStrictEqual` 不感知，快照工具可能感知）。
- **不支持，明确失败而非静默漂移**：
  - zod4 线：`intersection`、`file` / `templateLiteral` / `promise`、无 `pattern` 的 `string_format`（如 `url`）、递归顶层 schema、schema 级 `catchall`。官方 `ZodCompileUnsupportedError` 使整树降级到 stock（`compiled.stock === true`），正确但不是 CoW。
  - zod3 线：`intersection`、`catchall`、tuple rest、`ZodPromise`、async refine。编译期抛 `ZcNotSupportedError`。
- **NaN**：`z.nan()` 恒判脏（`NaN !== NaN`），输出仍正确，仅多一次拷贝。
- **symbol 键 / getter**：透传会保留 spread 可见的自有可枚举 symbol 键，与 stock 的重建行为有细微差异。
- **刻意不对齐的 stock quirk**：tuple 带 async rest 槽且 nullable 槽输入为 `null` 时，stock zod4 runtime 产生稀疏数组并丢掉 `null`；骨架输出稠密数组。差分生成器规避该组合，复现见上游 issue 草稿。

## 目录

```
src/index-z4.ts             zod4 compile() API（活跃线）
src/cow4/                   zod4 引擎：官方 codegen + CoW 容器骨架 + async 通道
                            （index、product、codectx、predicates、purity、official、emit、emit-{object,array,tuple,record,map,set}）
src/probe-z4.ts             zod4 def 结构与行为勘察（一次性诊断）
src/probe-z4-flags.ts       zod4 语义金丝 flag（版本升级自动报警）
src/index.ts                zod3 compile() API（冻结参考）
src/compile.ts              zod3 闭包树编译器
src/internal.ts             zod3 协议：FAILED 哨兵 / Ctx / issue 辅助 / safeSet
src/regexes.ts              zod 3.24.1 内部格式正则的逐字拷贝（zod3 线）
src/probe.ts                stock zod3 行为探针
tests/harness.ts            零依赖测试框架（test / summary / deepEqual）
tests/canary-z4.test.ts     zod 版本金丝（stock zod4 行为 ↔ 编译器假设）
tests/smoke-z4*.test.ts     zod4 行为断言（容器 / tuple / async）
tests/differential-z4.test.ts   zod4 差分模糊（20000 case，REPRO 钩子）
tests/unit.test.ts          zod3 单元测试（27 项）
tests/differential.test.ts  zod3 差分模糊（20000 case）
bench/bench-z4.ts           zod4 基准（S1 纯校验 / S2 脏负载 / S3 脏比例 / S4 validate / S5 容器 / S6 tuple / S7 async）
bench/bench.ts              zod3 基准（50 万账户）
examples/demo.ts            60 秒上手
docs/ARCHITECTURE-z4.md     zod4 引擎架构深度走读（英文，权威版本；docs/ARCHITECTURE-z4.zh-CN.md 是冻结的中文快照）
docs/upstream-issue-draft.md   给 zod 上游的 issue 草稿：请求公开 compileFn / assertOnly / INVALID
CHANGELOG.md                v0.1～v0.5 历史与各版本的历史基准表
```

## 延伸阅读

- [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md)：生成代码与官方产物并排对照、纯度白名单与三大陷阱、record / map / set / tuple 骨架、async 通道、降级链状态机、版本锚点与风险。
- [CHANGELOG.md](CHANGELOG.md)：项目如何从自研 zod3 编译器（v0.1）经自研 zod4 移植（v0.2，已移除）走到复用官方 codegen（v0.3～v0.5），附每一步的基准表。
- [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md)：请求公开 `compileFn` API 的理由，以及模糊测试中发现的 zod4 runtime quirk。
- [AGENTS.md](AGENTS.md)：贡献者与编码代理的工作约定（命令、模块地图、版本锚点、PR 规则）。
