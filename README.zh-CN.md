# cow-zod-prototype

[![CI](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml)

[English](README.md) | 简体中文

> 英文 [README.md](README.md) 是权威版本，本文是它的中文对照；两者章节结构相同，修改时请同步更新。

Zod 兼容的 CoW（Copy-on-Write）编译层原型，源自对 [Numeric fork](https://numeric.substack.com/p/how-we-doubled-zod-performance-to) 思路的延伸。

`compile(schema)` 返回一个快速 parser：只要没有任何东西被迫改变（没有 default、transform、strip、coerce、catch、preprocess、pipe 点火），输出就 `===` 输入原引用；一旦有值真的变了，只拷贝从那个叶子到根的一条路径，其余兄弟子树继续与输入共享。

与 Numeric fork 的核心差异：Numeric 为了让 `parse` 返回原始对象，直接删除了 `default / transform / coerce / catch / pipe / preprocess / intersection` 七个特性。本原型全部保留，用引用比较作为脏信号、按需拷贝，只在"运行时真的产生了新值"的那一点才拷贝。

- 不 fork zod、不改 Zod API：zod schema 原样消费（读取 `.def` 树），类型推断继续用 `z.infer`
- 编译期一次性解析 shape / keys / checks，生成特化校验代码
- 本层自身绝不改动输入：不在输入上原地删除或改写任何东西。Numeric fork 的 strip 会原地 delete 输入上的多余键，这里修复了该 footgun。唯一能落到输入上的原地写入是 `readonly` 的 `Object.freeze`，两条线都只在 stock 自己也会冻结输入的位置冻结，即 `any` / `unknown` 这类透传叶子（stock 直接返回输入；见[何时被迫拷贝](#何时被迫拷贝)，zod4 线见 #28，zod3 线见 #27）；作用于容器时被冻结的是副本
- zod4 线的失败路径不自带 issue 数据：编译产物返回哨兵，调用方回退 stock `safeParse` 拿完整 `ZodError`。zod3 线在遍历时自行构造 `ZcError`，消息经由 zod 自己的 error map 生成，issue 列表（code、path、message、params）与 stock 一致，由其差分模糊验证

## 两条编译线

| 线 | 入口 | 引擎 | 状态 |
|---|---|---|---|
| zod4 | `packages/zod-cow-v4/src/index.ts` → `packages/zod-cow-v4/src/cow4/` | 复用 zod4 官方 JIT codegen（`compileFn` / `assertOnly`）作为语义后端，叠加 object / array / tuple / record / map / set 六个 CoW 容器骨架，支持 async | 主线：发布的包，新特性都在这里 |
| zod3 | `packages/zod-cow-v3/src/index.ts` → `packages/zod-cow-v3/src/compile.ts` + `codegen.ts` | 自研编译器：叶子与包装节点是闭包树，object / array / tuple 骨架按 schema 生成（`new Function`，叶子检查内联为谓词），`new Function` 不可用时回退到闭包骨架；string 格式正则逐字拷贝自 zod 3.24.1 | 持续维护：CoW 思路的起点和对比基线，保持测试通过并继续优化；不发布 |

两条线各自是一个 workspace 包，各装各的 zod：`packages/zod-cow-v4`（以 [`zod-cow-v4`](packages/zod-cow-v4/README.md) 发布）对 zod 4.5.4，`packages/zod-cow-v3`（私有）对 zod 3.24.1；两者都用真实的 `zod` 说明符引入。两条线不共享代码。早期的自研 zod4 前端（v0.2）已被当前 zod4 线完全取代并移除，其结论记录在 [CHANGELOG](CHANGELOG.md#020)。

## 快速开始

需要 Node.js >= 22.13.0 与 pnpm 11.24.0。

```bash
pnpm install
pnpm run build       # 构建 zod-cow-v4（ESM + 类型声明，输出到 packages/zod-cow-v4/dist）
pnpm run test:v4     # zod4 线：版本金丝 + 冒烟测试 + 20000 case 差分模糊（对比 stock zod4）
pnpm run test:v3     # zod3 线：53 个单元测试 + 20000 case 差分模糊（对比 stock zod3，含有序 issue 列表），生成骨架与闭包骨架各跑一遍
pnpm run smoke:pack  # 打包 zod-cow-v4，并在临时消费者项目中验证 tarball
pnpm run bench:v4    # zod4 基准，对构建产物测量，50 万条记录（需 node --expose-gc，脚本已配置）
pnpm run bench:v3    # zod3 基准：S1～S9、单记录校准与规模扫描，ArkType 为一列
pnpm run probe:v4    # 勘察 stock zod4 的 def 结构与行为
pnpm run probe:v3    # 实测 stock zod3 的边界语义（zod3 线）
pnpm run demo        # 60 秒 demo：以发布的 zod-cow-v4 API 展示 CoW 的承诺
```

环境变量：`SEEDS` / `CASES` 设定差分模糊规模（默认 200 × 100）；`REPRO=seed:case` 重跑某一个失败的 zod4 差分 case 并 dump schema、输入和生成代码（`REPRO=112:80 pnpm --filter zod-cow-v4 exec tsx tests/differential-z4.test.ts`）；`BENCH_N` 设定基准记录数（不小于 10 的整数）。S2、S3、S9 的脏行 / 无效行比例按每 round(1 / 比例) 行标记一行，所以只有 `BENCH_N` 是该周期的倍数时比例才精确（1% 行需要 100 的倍数）；每个场景都会打印实际标记的行数。

> 本 README 和 `docs/` 中的基准表来自
> [Benchmarks workflow](https://github.com/iceboundrock/zod-cow/actions/workflows/bench.yml)
> 的 [run 33948313612](https://github.com/iceboundrock/zod-cow/actions/runs/33948313612)：GitHub 托管的 `ubuntu-latest` runner，node v24，`BENCH_N=50 000`，构建后的 `zod-cow-v4` 包，预热与计时都按候选顺序的完整轮换进行（每个候选至少 2 轮预热加 3 轮计时，向上取整到候选数的整数倍：五个候选时为 5 加 5 轮），取中位。
> 该 workflow 在手动触发（或每周）时先构建 `zod-cow-v4`，再跑 `bench-v4` 和 `bench-v3`，把表格打印到 job summary。
> 在这个记录数下 runner 噪声有几毫秒，接近 1.0x 的比值（S1 对公开编译 API、对 ArkType）应视为持平。
> 本地 `pnpm run bench:v4` 使用脚本默认的 50 万条记录。

## 安装与使用

`zod-cow-v4` 是发布的包。它的 README，[packages/zod-cow-v4/README.md](packages/zod-cow-v4/README.md)（英文），是面向使用者的文档，也是安装、用法、API 和 zod peer 策略文字的唯一出处：安装方式（`pnpm add zod-cow-v4 zod`）和 API 表都在那里。

zod3 线不发布。它位于 `packages/zod-cow-v3`，由自己的测试和 `bench-v3` 通过 workspace 导出使用；其 API 与 zod4 线不同（`ZcError` 而非 `ZodError`、`validate()` 返回 `DeepReadonly` 视图、静态 `.pure` 标志），见 `packages/zod-cow-v3/src/index.ts` 和 `pnpm run demo:v3`。

## CoW 不变量

每个编译后的节点是 `(input) => output | FAILED 哨兵`，不需要任何"修改通知"协议：

| 输入类型 | 脏信号判定 |
|---|---|
| 原始类型（string / number / bigint …） | 值比较：`'  x '.trim() !== '  x'` 为脏；`'x'.trim() === 'x'` 不脏，零拷贝 |
| object / array / tuple / record / Map / Set | 引用比较：子节点返回输入原引用即"没变"，父层不拷贝 |
| default / transform / coerce / catch / preprocess / pipe | 返回新值，父层通过 `outVal !== inVal` 自动感知 |

父层在第一个变化点做一次浅拷贝（`{...input}` / `slice()` / `new Map(input)`），后续脏子节点直接写入该副本，兄弟子树继续共享。这就是持久化数据结构的 path copying：改一个叶子只拷贝它到根的一条路径。成本模型：期望分配次数 ≈ Σ P(节点变脏) × 深度；最坏退化为全量重建（= stock 行为），典型情况 ≈ 0。

### 何时被迫拷贝

| 特性 | 何时拷贝 |
|---|---|
| string / number / boolean / bigint / date / literal / enum / instanceof、refine（纯谓词）、optional / nullable / any / unknown | 永不 |
| readonly | zod4 线把子树交给官方 parser（纯度分析把 `Object.freeze` 视为副作用），所以冻结的正是 stock zod 4 会冻结的东西。作用于容器（`object` / `array` / `tuple` / `record` / `map` / `set`）时那是一个新容器：副本被冻结，输入既不被冻结也不被共享。作用于透传叶子（`any` / `unknown` / `custom` 或其包装）时 stock 直接返回输入并原地冻结，本线同样如此（#28）。zod3 线通过 stock 的重建模式得到同样的结果：当内层 schema 在 stock 中可能重建（容器、`date`，或其外的包装、union 分支、effect、pipeline 一侧）时，`readonly` 在调用内层 schema 期间置位 `ctx.force`，其下每个容器骨架都从已校验的值组装输出（即脏路径所做的拷贝：getter 只读一次、未声明的 symbol 键丢弃、嵌套容器全新），`date` 叶子返回副本，而透传叶子（`any` / `unknown`）和 `catch` 的回退仍交回输入；于是只在 stock 原地冻结输入的地方原地冻结输入，其余地方冻结的都是新容器，无论最终由哪个 union 分支、哪条 `catch` 路径或哪个回调结果决定（#27，#63 的 review） |
| object / array / tuple / record / map / set | 所有子值未变则永不：返回输入原引用 |
| union / discriminatedUnion | 命中分支返回其输入则永不：叶子分支把输入原样交回，容器分支（object / array / tuple / record / map / set，含 optional / nullable 包裹或嵌套 union 内）在 union 骨架（#58）里跑自己的 CoW 骨架，骨架按 stock 的顺序逐个尝试分支（discriminatedUnion 按判别键分派），所以干净输入共享，脏分支只拷贝自己的路径。union 带 async 分支、是 `z.xor`、或带 `.refine` 谓词以外的 check 时命中的容器按 stock 重建：整个 union 交给官方产物 |
| default | 仅当 `undefined` 实际被替换。zod3 线的替换值是 stock 对默认值的输出：容器默认值在 stock 的重建模式下经过内层 schema，所以结果逐层重建，绝不与 schema 自带的默认值别名（否则修改结果就会改变之后的每次 parse）；原始值或透传默认值与 stock 一样原样交回 |
| transform / preprocess / pipe / catch | 仅当运行时实际产生新值 |
| strip（对象默认模式） | 仅当输入确实存在多余键（小型固定 shape 使用 `for...in` + 生成的比较，大型 shape 回退到 `Set`，并探测自有 symbol；`compile(schema, { ownSymbolKeys: "ignore" })` 可关闭该探测，#43） |
| strict / passthrough | 仅当输入带有未声明的自有 symbol 键（stock 在所有模式下都会丢弃它；strict 遇到多余字符串键直接失败）；与 strip 相同的自有 symbol 探测，由同一选项关闭（#42） |
| record | 仅当输入带有未声明的自有 symbol 键（stock 的重建在每条路径上都会丢弃它）：enum 键的 record（`z.record(z.enum(…), v)`，strict 或 loose）在干净路径上运行与对象相同的自有 symbol 探测；遍历键的 record（`z.record(z.string(), v)` 及其他所有键 schema）像 stock 一样把可枚举的 symbol 键当作键来校验，并在已有的键循环里把不可枚举的 symbol 键判脏。两者由同一选项关闭（#51） |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | 仅当值实际变化（值比较） |

由此约束每一处改动：

- 绝不修改输入。strip 绝不能在输入对象上 `delete`。唯一的原地写入是 `readonly` 的 `Object.freeze`：两条线都对容器冻结副本，对透传叶子则与 stock 一样原地冻结（zod4 线见 #28，zod3 线见 #27）。
- 输出可能与输入别名，所以 refine 不得修改值。
- zod4 线的失败路径只返回哨兵，调用方回退 stock `safeParse` 拿完整 `ZodError`。zod3 线自己保留 stock 的两种失败：类型不符即 abort（哨兵），检查失败即 dirty（记录 issue 后值继续向上传，后续检查、祖先 refine 与 union 的行为与 stock 一致）。

## zod4 线如何与 stock 保持一致

zod4 线不重新实现 zod 的语义。zod4（>= 4.1）自带 JIT 编译器（`src/v4/core/compile.ts`），本层按子树复用它的产物：

1. 官方产物做叶子和子树。 `compileFn(schema)` 得到 stock 语义的 parser；`compileFn(schema, {assertOnly: true})` 得到跳过输出构造的 validator。
2. 纯度分析是一份保守白名单，判定"校验通过 ⇒ 输出 === 输入"。纯净子树用官方 validator，非纯子树用官方 parser + 引用比较。
3. 容器骨架是字符串模板 codegen，逐行镜像 zod 自己的 `generate*` 函数，然后把无条件的 `const out = {...}` 改写成"比较引用、首脏才拷贝、干净时 `return input`"。容器自身的 checks（`min` / `max` / `refine`）在两条路径上都对最终输出执行。
4. Async：async 子树变成 async 岛，所有产物调用位发射 `await`，骨架变成 async 函数。async 产物上的同步 API 抛 `$ZodAsyncError`，与 stock 一致。
5. 降级链，按子树独立，每一级都保持 stock 的结果：CoW 骨架 → 官方 validator（纯净叶子）→ 官方 parser（非纯子树）→ runtime island（`_zod.run` 黑盒）→ 整树 stock `safeParse`（`compiled.stock === true`）。

本层依赖 `zod/v4/core`（一个公开的 permalink 子路径，但其中的编译器导出 `compileFn`、`assertOnly`、`INVALID` 和产物协议不受支持）和几处手工照抄的谓词，锚定 zod 4.5.4，即包的 peer 范围下界：`packages/zod-cow-v4/tests/canary-z4.test.ts` 断言编译器所假设的 stock 行为，升级时测试先红而不是静默漂移。[docs/upstream-issue-draft.md](docs/upstream-issue-draft.md) 是请求 zod 上游把这一面公开的 issue 草稿。

zod3 线则靠探针对齐（`packages/zod-cow-v3/src/probe.ts` 在运行时实测 stock zod3 的边界语义）：缺席 optional 键不物化、present-undefined 键保留、默认值要过内层校验、失败后继续收集兄弟字段的 issue、`readonly` 浅冻结。它的 issue 消息来自 zod 自己的 error map（`defaultErrorMap`、`z.setErrorMap` 覆盖与 schema 的创建参数 map），所以 `required_error` / `invalid_type_error` / 自定义消息与 stock 一致。它的 object、array、tuple 骨架按 schema 生成（`packages/zod-cow-v3/src/codegen.ts`）：具名属性读取、每个子节点一个单态调用点、叶子检查内联为谓词（仅在谓词失败时才把值交给叶子闭包）、未声明键探针先把每个枚举到的键与该位置期望的 shape 键比较再查键集合，且没有 refine / transform 的子树在成功路径上不做任何 path 记录（容器把自己的键拼接到子节点留下的 issue 上）。`compile.ts` 里的闭包骨架实现同一算法，在 `new Function` 不可用时使用。

完整设计（生成代码与官方产物并排 dump）见 [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md)。

## 基准

zod4 线，[Benchmarks workflow run 33948313612](https://github.com/iceboundrock/zod-cow/actions/runs/33948313612)：5 万账户，GitHub 托管 `ubuntu-latest` runner，node v24，`--expose-gc`，构建后的 `zod-cow-v4` 包，预热与计时都按候选顺序的完整轮换进行（每个候选至少 2 轮预热加 3 轮计时，向上取整到候选数的整数倍：五个候选时为 5 加 5 轮），取中位（`pnpm run bench:v4`，`BENCH_N=50000`）。"z.compile()"指 Zod 4.5 的公开编译 API：parse 场景用 `z.compile(schema).safeParse`，纯校验场景用 `z.validate(compiled, data)`。"ArkType"指 arktype 2.2.3 的常规公开 API（parse 用直接调用 `Type(data)`，纯校验用 `.allows()`），schema 与 zod schema 约束逐项对齐；基准在计时前用合法与非法 fixture 检查这一等价性，ArkType 没有原生等价物的场景打印 `N/A` 并给出原因（见下文[跨库对比](#跨库对比)）。公开 API 背后的内部 `compileFn` / `assertOnly` 产物是工程对照，在该次运行的诊断表里与公开列对比，二者持平（S1 1.00x，S2 1.01x，S3 1.02x～1.06x，S8 1.04x），因此不再作为这里的一列。这个记录数下 runner 噪声大于 S1 / S3 的差距：同一分支上同一套件的上一次运行（[33945725973](https://github.com/iceboundrock/zod-cow/actions/runs/33945725973)，在被回退的 tuple 内联实验之前）每一列都低 5%～20%，S3 对 `z.compile()` 读作 1.13x～1.18x，而本次读作 0.88x～0.97x。

批量场景（一次调用解析整个数据集）：

| 场景 | stock zod4 | z.compile() | **zod-cow-v4** | ArkType |
|---|---|---|---|---|
| S1 干净输入 parse（无未声明键） | 68 ms | 23 ms | **24 ms** | 23 ms |
| S1 分配压力 / gc 后驻留 | +18.0 MB / +11.6 MB | +11.0 MB / +10.8 MB | **+3.1 MB / 0.0 MB** | +5.4 MB / 0.0 MB |
| S2 10% default 注入 | 69 ms | 23 ms | **25 ms** | 805 ms |
| S2 分配压力 / 驻留 | +19.8 MB / +11.6 MB | +18.2 MB / +11.6 MB | **+4.1 MB / +1.0 MB** | +91.2 MB / +11.6 MB |
| S3 扫描 0% / 25% / 50% / 100% 脏 | 68 / 69 / 70 / 70 ms | 23 / 23 / 23 / 24 ms | **23 / 25 / 26 / 25 ms** | 806 / 806 / 799 / 781 ms |
| S3 gc 后驻留 | +11.6～+12.3 MB | +11.6 MB 恒定 | **0.0 / 2.0 / 3.6 / 6.9 MB** | +11.6 MB 恒定 |
| S4 纯校验 | N/A（没有纯校验 API） | 17 ms（`z.validate`） | **18 ms**（`validate()`） | 23 ms（`.allows()`） |
| S5 record / map / set | 81 ms | 41 ms | **30 ms** | N/A（`Map` / `Set` 只做 instanceof；非等价参考 10 ms） |
| S5 分配压力 / 驻留 | +54.0 MB / +21.7 MB | +49.6 MB / +21.7 MB | **+29.4 MB / 0.0 MB** | N/A |
| S6 tuple | 43 ms | 14 ms | **5 ms** | 2 ms |
| S6 分配压力 / 驻留 | +55.0 MB / +20.6 MB | +20.2 MB / +20.2 MB | **+1.5 MB / 0.0 MB** | +0.0 MB / 0.0 MB |
| S7 async transform（5 千条） | 12 ms（safeParseAsync） | N/A（`z.compile()` 把 async schema 原样返回，不编译） | **7 ms（safeParseAsync）** | N/A（没有原生 async morph） |
| S7 分配压力 | +12.8 MB | N/A | **+9.0 MB** | N/A |
| S8 strip 未声明键 parse 对齐 | 79 ms | 29 ms | **24 ms** | 1 092 ms（`onDeepUndeclaredKey("delete")`） |
| S8 分配压力 / 驻留 | +28.2 MB / +11.6 MB | +11.2 MB / +10.8 MB | **+8.0 MB / +8.0 MB** | +157.5 MB / +66.6 MB |
| S10 parse 失败，逐行 `safeParse`，1% / 10% / 50% / 100% 非法行 | 69 / 88 / 151 / 224 ms | 18 / 40 / 128 / 227 ms | **25 / 47 / 132 / 231 ms** | 30 / 91 / 287 / 426 ms |

单记录热循环（同一个小输入，每轮 5 万次操作，取每次操作的中位纳秒数；用于和公开的单对象基准形状对照，不是产品工作负载）：

| 场景 | stock zod4 | z.compile() | **zod-cow-v4** | ArkType |
|---|---|---|---|---|
| 校准 parse（6 字段原始类型对象） | 608 ns | 30 ns | **99 ns** | 65 ns |
| 校准 validate（同一记录） | N/A | 12 ns（`z.validate`） | **11 ns**（`validate()`） | 19 ns（`.allows()`） |
| S9 纯校验失败：首字段 / 末字段 / 嵌套 / email / tuple 槽 | N/A | 1 611 / 1 772 / 1 881 / 2 538 / 1 192 ns | **19 / 222 / 229 / 151 / 46 ns** | 267 / 18 / 34 / 218 / 50 ns |
| S10 带错误信息的 parse 失败：首键 / 末键 / 嵌套 / refine | 3 780 / 3 646 / 3 993 / 3 609 ns | 3 716 / 3 815 / 4 066 / 3 847 ns | **3 643 / 3 743 / 3 682 / 4 043 ns** | 7 053 / 12 225 / 7 469 / 6 206 ns |

对 zod-cow-v4 的比值（大于 1 表示对方耗时更长，即 zod-cow 更快；N/A 单元不计算）：

| 场景 | stock / zod-cow | z.compile() / zod-cow | ArkType / zod-cow |
|---|---|---|---|
| S1 干净输入 parse | 2.80x | 0.95x | 0.97x |
| S2 10% default | 2.72x | 0.90x | 31.90x |
| S3 0% / 25% / 50% / 100% 脏 | 2.88x / 2.78x / 2.64x / 2.80x | 0.97x / 0.94x / 0.88x / 0.97x | 34.42x / 32.34x / 30.27x / 31.26x |
| S4 纯校验 | n/a | 0.93x | 1.25x |
| S5 record / map / set | 2.75x | 1.39x | n/a |
| S6 tuple | 8.04x | 2.62x | 0.40x |
| S7 async transform | 1.55x | n/a | n/a |
| S8 strip 未声明键 parse 对齐 | 3.35x | 1.22x | 46.28x |
| S10 parse 失败，1% / 10% / 50% / 100% 非法 | 2.79x / 1.89x / 1.15x / 0.97x | 0.73x / 0.86x / 0.98x / 0.98x | 1.20x / 1.94x / 2.18x / 1.85x |
| 校准 parse / validate | 6.11x / n/a | 0.31x / 1.13x | 0.65x / 1.75x |

怎么读：

- 对 stock：同步批量场景 2.6x～8.0x（S1 2.80x，S2 2.72x，S3 2.64x～2.88x，S5 2.75x，S6 8.04x，S8 3.35x），干净输入下 gc 后驻留的 12～22 MB 降到零。async（S7）在 5 千条上是 1.55x，这个规模下几毫秒的 runner 噪声占比很大。
- 对公开编译 API：对象输入在任何脏比例下都在 runner 噪声内持平（S1 0.95x，S2 0.90x，S3 0.88x～0.97x：5 万条上差 0～3 ms；run 33945725973 里 S3 为 1.13x～1.18x）。拷贝路径像编译 parser 一样从捕获的局部变量拼出输出，脏行的代价与编译 parser 相同，周围的干净行则零代价；改动之前（run 33940596453）S3 100% 脏读作 0.70x。strip 输入上领先（S8 1.22x：拷贝按构造就丢掉未声明键，未动过的 `tags` 数组保持共享），容器场景领先（S5 1.39x，S6 2.62x），因为 stock 语义的整树重建是固定开销，CoW 只为真正变化的路径付费。小对象逐条 parse 落后（校准 parse 0.31x，S10 1% 非法 0.73x）：骨架每个对象的固定开销是 strip 模式的探测，见下文。
- 对 ArkType：干净 parse 持平（S1 0.97x），纯校验领先（S4 1.25x，校准 validate 1.75x），tuple 落后（S6 0.40x，2 ms 对 5 ms：ArkType 预编译的检查直接返回输入、零分配，骨架每行还要付 strip 探测），单记录 parse 落后（0.65x）。S2/S3/S8 的差距（zod-cow 领先 30x～46x）是架构性的：任何 morph（包括键默认值和未声明键删除）都会让 ArkType 2.2.3 离开预编译的 `allows` 路径，走解释执行的遍历，先深拷贝整个输入再套用排队的 morph（S3 在 5 万条上分配 +90 MB，S8 +158 MB，每一行都重建），而 zod-cow 把 default 当普通叶子编译，只拷贝真正变化的行。S1 只是对干净 fixture 的公平比较：zod 默认的对象模式会 strip 未声明键，ArkType 按引用保留，所以 S8 才是两边做同样工作的场景。
- 失败路径：`validate()` 只靠编译 validator 就回答 `null`（19～229 ns），公开的 `z.validate` 失败时回退到 runtime parser（1.2～2.5 µs），ArkType 的 `.allows()` 按自己的代价顺序检查键（便宜的 `active` 键失败时 18 ns，`id` 失败时 267 ns）。带错误信息时（S10）每条 zod 路径对每个非法记录都是 3.6～4.1 µs：两个编译变体的快路径只占构建 `ZodError` 的 runtime parse 的一小部分，所以它们的重复工作看不出来；失败的 refine 谓词在 `z.compile()`、zod-cow 和 ArkType 上都跑两次（成功 parse 时各跑一次）。混合数据集上 zod-cow 随非法比例从 2.79x（1%）滑到 0.97x（100%）对 stock。
- validate 快路径：`validate()` 就是同一 array schema 的官方整树 `assertOnly` 产物，所以 S4 按构造与 `z.validate` 持平（18 ms 对 17 ms，0.93x）。它的价值是纯校验成本：18 ms / 50 000 = 每账户 360 ns，gc 后零驻留。
- S1 的 +3.1 MB 是 strip 模式探测产生的短命分配：每个对象恰好一个空的自有 symbol 数组（32 字节），这里是 10 万个对象，用来证明该对象可以按原引用返回。这个探测（`Object.getOwnPropertySymbols`）也是骨架每个对象的固定开销：本地 Node 24 上对一个 6 字段记录测得骨架调用 65 ns，其中约 36 ns 是它，`for...in` 探测约 9 ns，叶子 validator 调用测不出开销，同一 schema 的编译 parser 是 24 ns。它默认保留，因为 stock 会丢弃自有 symbol 键，透传必须证明没有。数据确定不带 symbol 键的调用方可以用 `compile(schema, { ownSymbolKeys: "ignore" })` 关闭它（#43，见[包 README](packages/zod-cow-v4/README.md#compileoptions)）；基准把它作为 calibration 一节里单独标注的可选行来测量，各场景的 zod-cow-v4 列仍使用默认值。本地 Node 24、每轮 2 000 000 次操作下，calibration parse 带探测为 75 ns，不带为 32 ns，`z.compile()` 为 24 到 29 ns。

zod3 线有自己的套件 `bench-v3`（`pnpm run bench:v3`），方法相同，ArkType 按 zod3 的约束构建。数据来自 [Benchmarks workflow run 33998778811](https://github.com/iceboundrock/zod-cow/actions/runs/33998778811)（同类 runner，node 24，`BENCH_N=50 000`，zod3 线的生成骨架，#63 的最终提交）：

| 场景 | stock Zod 3 | zod-cow-v3 | ArkType | stock / zod-cow | ArkType / zod-cow |
|---|---:|---:|---:|---:|---:|
| S1 干净输入 parse | 249 ms（+75.4 MB / +17.7 MB） | **27 ms（0 / 0）** | 23 ms | 9.40x | 0.87x |
| S2 10% 默认值 | 262 ms | **28 ms** | 801 ms（morph） | 9.23x | 28.19x |
| S3 0% / 25% / 50% / 100% 脏 | 260 / 259 / 264 / 273 ms | **27 / 28 / 28 / 30 ms** | 791 / 808 / 802 / 782 ms | 9.72x～9.09x | 29.59x～26.09x |
| S4 validate（与 parse 同一运行时） | N/A | **28 ms** | 24 ms（`allows`，非等价参照） | n/a | n/a |
| S5 record / map / set，干净 / 10% 脏 | 193 / 219 ms | **13 / 16 ms** | N/A（仅 instanceof） | 14.62x / 13.41x | n/a |
| S6 tuple，干净 / 50% 脏 | 124 / 132 ms | **5 / 8 ms** | 2 ms / N/A | 23.03x / 16.41x | 0.42x |
| S7 同步 transform，每行都变 / 空操作 | 216 / 222 ms | **17 / 16 ms** | 373 / 381 ms | 12.51x / 13.94x | 21.54x / 23.90x |
| S8 strip 未声明键 | 266 ms | **36 ms（+16.0 MB / +8.8 MB）** | 1 080 ms | 7.28x | 29.59x |
| S9 逐行 parse，1% / 10% / 50% / 100% 无效 | 253 / 266 / 304 / 330 ms | **33 / 37 / 56 / 78 ms** | 35 / 101 / 291 / 454 ms | 7.64x～4.23x | 1.05x～5.81x |
| 校准 parse，6 字段记录 | 2 049 ns | **127 ns** | 80 ns | 16.2x | 0.63x |
| S9 失败热循环（首键 / 末键 / 嵌套 / 三个兄弟 / 数组 / tuple） | 6.4 / 6.4 / 6.2 / 7.9 / 6.2 / 4.0 µs | **1.4 / 1.3 / 1.3 / 2.5 / 1.4 / 0.9 µs** | 7.0 / 12.1 / 7.5 / 19.8 / 7.6 / 6.1 µs | 3.1x～4.9x | 5.0x～9.4x |

怎么读：zod3 线在干净 parse 上接近 ArkType（S1 0.87x，27 ms 对 23 ms；同一套件的上一次运行读作 0.99x、24 ms，两次运行之间规模扫描里每个对象行都慢了约 25 ns/对象而叶子、tuple 与 ArkType 行不变，本地对两个提交做 A/B 复现不出这个差异，所以属这个规模下的 runner 波动；S4 把同一个 parse 运行时放在 ArkType 仅做校验的 `allows` 旁边作为非等价参照，28 ms 对 24 ms，不出比值），叶子与 tuple 扫描持平；深嵌套与长数组落后（该次运行的规模扫描：嵌套深度 5 为 305 ns 对 79 ns，100 元素数组 380 ns 对 168 ns，每个嵌套骨架和每个元素各一次单态调用）；凡 ArkType 的 morph 重建整棵树之处（S2、S3、S7、S8）则大幅领先。失败路径携带 stock 的 issue 列表（该次运行的一致性小节：16 / 16 个 fixture 顺序与每个属性完全一致；未声明的差异会中止运行），成本为 stock 的五分之一。本轮之前 zod3 线在 S1 上对 stock 为 3.2x～3.7x（本地 50 万行：572 ms 对 2 101 ms），失败热循环慢于 stock；50 万行的前后对照表见 [CHANGELOG](CHANGELOG.md#unreleased)。run 33992895288、33940596453 与 33837195401 的被取代表格和更早的本地 50 万记录表格（含 v0.5 的 zod4 表、已移除的 v0.2 前端与 v0.3 的表）见 [CHANGELOG](CHANGELOG.md)。

### 跨库对比

ArkType 列只在 arktype 2.2.3 能用常规公开 API 表达同一工作负载时才测。`packages/bench-v4/schemas.ts` 在 zod schema 旁边构造 ArkType schema，`gates.ts` 在计时前把合法与刻意非法的 fixture（非整数和不安全整数的 `id`、ASCII 与星体字符的超长名字并配一个所有实现都接受的 64 星体字符名字、非有限数、畸形 email 和 datetime、非法 role、超长 tags、缺失 role、非法嵌套与容器值、tuple 长度与类型错误、各层级的未声明键）跑过每个实现；未声明的分歧会中止运行，已声明的以 `known divergence` 打印。

| 场景 | ArkType 等价 | ArkType API | 说明 |
|---|---|---|---|
| S1 | 是 | `Type(data)` | `.int()` 用 `number.integer & number.safe`，`string[] <= 8`，字面量联合。zod 的 `.max(64)` 数 Unicode 码点，ArkType 的 `string <= 64` 数 UTF-16 单元（64 个星体字符能过 zod、过不了该关键字），所以上界按 zod 自己的规则写入：原生 `string <= 64` 做联合的第一分支，溢出分支只用一个数码点的谓词。`z.number()` 拒绝两个无穷而 ArkType 的 `number` 接受，所以数字通过 ArkType 的 range API 带一个有限范围（原生 range 节点）。zod 的 email 和 datetime 正则作为 ArkType 正则约束写入，因为 `string.email` 和 `string.date.iso` 接受超集（`.a@x.com`、只有日期、带时区偏移）。gate 为每一项都保留边界 fixture（64 与 65 个星体字符、±Infinity、NaN）。多余键在 ArkType 里按引用透传、在 zod 里被 strip 进拷贝（在多余键 fixture 上声明）；S1 数据没有多余键，S8 测 strip 的情形 |
| S2、S3 | 是 | `Type(data)`，`role: "'admin' \| 'member' \| 'viewer' = 'viewer'"` | 同样的缺键输入，同样的输出。已声明分歧：zod 对显式存在的 `undefined` 也套 default，ArkType 拒绝 |
| S4、校准 validate、S9 | 是 | `Type.allows(data)` | 纯校验，与 `z.validate(compiled, data)` 和 `validate()` 并列。ArkType 按自己的代价顺序检查键，zod 按声明顺序，S9 各位置的结果反映了这一点 |
| S5 | 否 | N/A | `Map` / `Set` 只是 instanceof 检查，没有 `Map<K, V>` / `Set<T>` 泛型，条目和成员从不校验。最接近的 schema 作为标注的非等价参考（10 ms）运行，不进入比值 |
| S6、S9 tuple | 是 | `Type(data)`，一对有限数（与 S1 相同的有限范围）加 `["string", "string?"]` | 已声明分歧：zod 的可选槽接受显式存在的 `undefined`，ArkType 的 `string?` 只接受缺席；数据只有 1 元素和 2 元素的 label |
| S7 | 否 | N/A | `.pipe(async fn)` morph 返回一个未 await 的 Promise，后接的 `.to("string")` 把它当对象拒绝；同步 lowercase 或 `Promise.resolve()` 包装都是另一种工作负载 |
| S8 | 是 | `type(shape).onDeepUndeclaredKey("delete").array()` | ArkType 原生的深层未声明键删除，对应 zod 的嵌套 strip；它是 morph，所以每一行都重建。已声明分歧：未声明的自有 symbol 键被 zod strip、被 ArkType 保留（其删除只看字符串键）。gate 同时检查没有实现改动输入 |
| S10、校准 parse | 是 | 返回 `ArkErrors` 的 `Type(data)` | 两边都是带详细错误的常规 parse API（`ZodError` / `ArkErrors`）；refine 场景用同一谓词的 `.narrow()` |

## 正确性证据

- 差分模糊（`packages/zod-cow-v4/tests/differential-z4.test.ts`）：随机嵌套 object / array / tuple / record / map / set / union（普通 union 取 2 到 3 个随机分支，因此会出现带未声明键的 object 分支；另有两个 object 分支的 discriminatedUnion；生成器自 #47 起才生成 union，此前尽管列表如此写，却从未生成过），套 optional / nullable / default / refine / overwrite / transform 及 async refine / transform（三个被包装的子节点里有一个在包装层之上再叠一个 check：同步或 async refine、overwrite，且 refine 谓词除一个字符串外还拒绝恰好三个条目的容器，因此容器之上包装层的 check 得到覆盖，#56），与 stock zod4 比较成败奇偶、`deepStrictEqual` 输出（每次解析都按迭代顺序比较 Map 与 Set 的内容，自 #67 与 #70 起）和输入零失真（structuredClone 快照）。v0.5 的 50 000 case 运行：成功 20 813 / 失败 29 187，成功 case 顶层引用共享率 89.1%，stock 降级 0 次。代码默认 200 × 100 = 20 000 case。生成器还会产生稀疏数组与 tuple、与后面条目冲突的 record 与 map 键 transform 及 set 成员 transform，以及带自有 `__proto__` 数据属性的 record 输入（#67）。五分之一的 enum 键 record 在字符串或数字键之外声明一个 symbol 键（enum entries 形式的 symbol 值，或单独的 `z.literal(sym)` 键），写成可枚举数据属性，因此 record 自有 symbol 探测的提升 `Set` 形态也进入差分检查，与 object shape 自 #33 起一样（#61）。每个 case 跑两遍：先用默认选项，再以 `ownSymbolKeys: "ignore"` 编译，输入相同但不带该选项被记录为与 stock 不同的那个额外自有 symbol（自 #42 起生成器在所有对象模式下都会发出它），并额外检查生成的顶层骨架不含探测、第二遍的引用共享不少于第一遍（自 #61 声明 symbol record 键起，默认规模下成功 case 中分别为 81.7% 与 82.4%；自 #67 加入冲突与稀疏 case 起为 81.4% 与 81.9%，这些 case 按构造必然拷贝，此前的生成器在同一骨架上为 85.5% 与 86.4%；自 #56 叠加包装层 check 起为 85.4% 与 86.1%；加入 union 生成器与 #47 的 union 规则后为 85.6% 与 86.2%；此前为 88.8% 与 89.4%，#43）。
- 冒烟测试（`packages/zod-cow-v4/tests/smoke-z4*.test.ts`）：原引用、strip、strict、default、transform、嵌套共享、数组元素、optional、union、降级链、`ownSymbolKeys` 选项（两种取值在 strip、strict、loose 模式与 record 三路径下、嵌套传播、已记录的分歧、`TypeError`）、record 三路径、map / set 与 size checks、tuple 截断 / 填充 / rest / refine、async 贯穿全部容器、`lazy(async)`、union 的 async 分支。
- 版本金丝（`packages/zod-cow-v4/tests/canary-z4.test.ts`）：断言编译器所假设的 stock zod4 行为（default 短路、catch 不吞异常、optional 把 undefined 交给带 default 的内层……）。
- zod3 线有 57 个单元测试和自己的 20 000 case 差分模糊（`packages/zod-cow-v3/tests/differential.test.ts`）：随机的 object / array / tuple / record / map / set / union / discriminatedUnion schema、接受容器的透传叶子 `unknown`、union 分支可以是叶子、容器或带包装的 schema（于是会出现 `readonly` 之下的 union，以及 union 分支上的 `readonly` / `catch` / `transform`），配 optional / nullable / default / catch / readonly / refine / transform 包装、创建参数 error map 以及 string 的 `length` / `includes` / `startsWith` 检查、稀疏数组与 tuple、与后面条目冲突的 record / map 键 transform 和 set 成员 transform、record 输入上自有的 `__proto__` 数据属性，对比 stock zod3 的成败一致性、`deepStrictEqual` 输出（Map 与 Set 的内容按迭代顺序比较）、零输入改动（structuredClone 快照）、输入与输出的冻结状态，并在每个失败 case 上比较有序的 issue 列表（每条 issue 按 stock 的顺序，带上它携带的每个属性：code、path、message、`fatal`、检查参数、union 的嵌套错误）。它跑两遍：生成骨架与闭包回退（`--no-codegen`）。成功 case 的顶层引用共享率在这个生成器下约 85%（加入稀疏、冲突和 `__proto__` 用例之前为 87%，这些用例按构造必然触发拷贝；在更早、较小的生成器下为 92.1%，与本轮工作之前相同）。
- 架构文档里的每一个纯度陷阱都是模糊测试抓出来的，不是读代码发现的。纯度分析的完备性只能靠 fuzz 证明，所以任何纯度规则或容器骨架的改动都必须跑差分套件并报告引用共享率。

## 已知限制（原型范围）

- 结构共享可观察：两次 parse 同一输入返回同一引用；修改输出会影响输入。只有 zod3 线的 `validate()` 在类型层用 `DeepReadonly` 提示这一点；zod4 线的 `validate()` 返回 `unknown`，`parse` / `safeParse` 用普通的 zod 输出类型。需要独立副本时用 stock `schema.parse`。
- refine 不得修改输入（CoW 前提）；开发期可 deep-freeze 输入抓违规。
- 回调看到的是 CoW 输出而不是新容器：容器之上的 `refine` / `superRefine` / `transform` 在其下没有任何改动时收到的是输入引用，而 stock 的回调收到的是 stock 刚重建的容器。仅因自身长度 / 大小检查而变脏的容器（`array.max`、`set.size`）也包括在内：值按原引用继续向上，issue 已记录。容器之上 optional / nullable 包装层的 `refine` 也是这样的回调：骨架像 stock 一样在短路值和容器输出上运行它，内层包装先于外层（#56）。只有在回调内比较引用身份时才能观察到。在 `readonly` 或已触发的 `default` 之下，zod3 骨架运行于 stock 的重建模式，那里的回调与 stock 的回调一样收到新容器。
- 失败时的 refine 副作用：parse 失败时 refine 回调先在骨架里跑一次，再在 stock 回退里跑一次，共两次。官方 `zod/compile` shim 语义相同。
- 键序：纯透传保留输入键序；stock 按 shape 序重排（`deepStrictEqual` 不感知，快照工具可能感知）。async 解析时 stock 在每个 async 键的 promise 结算时写入它，键序即结算顺序，而这里的拷贝保持 shape 序（#71）。zod4 对象骨架做出的拷贝按 shape 序排列，与 stock 一致。
- 不支持，明确失败而非静默漂移：
  - zod4 线：`intersection`、`file` / `templateLiteral` / `promise`、无 `pattern` 的 `string_format`（如 `url`）、递归顶层 schema、schema 级 `catchall`。官方 `ZodCompileUnsupportedError` 使整树降级到 stock（`compiled.stock === true`），正确但不是 CoW。
  - zod3 线：`intersection`、`catchall`、tuple rest、`ZodPromise`。编译期抛 `ZcNotSupportedError`；async refine / transform / preprocess（回调返回 `Promise`）在 parse 时抛出。普通 thenable 与 stock 一样按同步结果处理（stock 的检测是 `instanceof Promise`）；stock 的同步 parser 会把 preprocess 返回的 `Promise` 当作数据交给内层 schema，本线则拒绝它。
- 带 async 分支的 union 总会拷贝命中的容器：union 骨架（#58）按顺序尝试各分支的 CoW 产物，但只要某个分支下面任何位置有 async refine 或 transform，整个 union 就作为 async 岛交给 stock 的 runtime（stock 会启动所有分支并取第一个成功的，顺序 await 链无法复现后续分支的副作用），而该 runtime 会重建命中的容器。`z.xor`、stock 自己的 codegen 拒绝的 discriminatedUnion（`unionFallback`、没有静态判别值的分支、重复的判别值）、以及带 `.refine` 谓词以外 check（overwrite、superRefine、经 `.check()` 附加的长度规则）的 union 走同一条路。
- 容器之上的 `z.exactOptional`（直接包裹、再套一层包装、或包裹带容器分支的 union）在任何位置都走官方 parser，所以命中的容器总会拷贝：骨架的包装链在 `undefined` 上对每个 optional 层都走捷径，而 stock 对 exact-optional 层从不走捷径；这道闸门保住 stock 的答案，直到 #74 让骨架把该层视为透明。叶子之上的 `z.exactOptional` 不受影响。
- NaN：`z.nan()` 恒判脏（`NaN !== NaN`），输出仍正确，仅多一次拷贝。
- zod3 线的 `z.lazy`：getter 在编译时解析一次，所有分析（`.pure`、effect 与重建分析）和每次 parse 都用这一个 schema。stock 每次 parse 都调用 getter；zod 4 自己的 `z.compile()` 同样只解析一次（在首次 parse 时）并缓存结果。答案随调用而变的 getter 被固定在首次答案上。getter 是 `compile()` 运行的唯一用户代码。
- symbol 键 / getter：stock 的重建在每条路径上都会丢弃未声明的自有 symbol 键（无论其是否可枚举），对象的所有模式与 record 皆然。默认情况下骨架先证明没有这样的键再按原引用返回输入，否则拷贝：对象骨架在所有模式下探测（strip 自 #33 起，strict 与 loose 自 #42 起），enum 键的 record 以同样方式探测，遍历键的 record 像 stock 一样把可枚举的 symbol 键当作键来校验，并在其键循环里把不可枚举的 symbol 键判脏（#51）。在 `compile(schema, { ownSymbolKeys: "ignore" })` 下跳过这些探测：干净输入按原引用返回并保留自有 symbol 键，而骨架做出的拷贝仍像 stock 一样丢弃它们，所以此时结果取决于容器是否为脏（#43）。zod4 对象骨架与 enum 键 record 骨架在两条路径上都只读取 getter 一次，与 stock 相同；数组、tuple、遍历键的 record、map、set 骨架在第一次被迫变化时从输入重建干净前缀，之后的每个条目都用循环那一次读取的值写入，所以经 transform 与后面条目冲突的键或成员会被后者覆盖，拷贝保持 stock 的顺序，空洞成为自有的 `undefined` 槽位，自有或经 transform 得到的 `__proto__` 键被丢弃（#67）；前缀重建是唯一会把输入读两次的地方：第一次变化之前的 getter 会被再读一次，Map / Set 的迭代器会为前缀重新启动一次，所以第二次回答不同的 getter 或子类迭代器在那里给出的是第二次的答案（#36，#70 的评审）。从第一次变化起，每个条目都只被观察一次，与 stock 相同。zod3 线不做自有 symbol 探测：未声明的自有 symbol 键在其干净路径上以任何模式都会保留。其对象骨架像 stock 一样从已校验的值组装拷贝（getter 只读一次、symbol 键丢弃、不可枚举的已声明键照写、继承的可枚举键会被 strip / strict 探测看到），其 record 骨架按 stock 的顺序从已解析的键值对组装拷贝（继承的可枚举键写成自有键，自有或经 transform 得到的 `__proto__` 键丢弃），数组和 tuple 骨架用 `slice()` 拷贝并把空洞实体化为自有的 `undefined` 槽位（#65）。
- 干净路径原样返回输入，所以只要没有触发拷贝，stock 重建时会规范化掉的东西都会保留下来：不可枚举的未声明字符串键（`for...in` 探测与 record 的键循环都会跳过它）、已声明键的属性描述符（输入把某个已声明键定义为不可枚举时，无论字符串键还是 symbol 键、对象还是 enum 键的 record，都按定义原样返回，而 stock 的重建会写入一个可枚举的数据属性；自有 symbol 探测只问是否存在未声明的 symbol，拷贝路径则像 stock 一样写入该键）、输入的原型（类实例仍按该实例返回，而 stock 返回普通对象；自 #58 的 union 骨架起，输入会原样交给 object 分支，所以被前一个分支拒绝、又被 object 分支接受的 `Set`、`Map` 或 `Date` 按原引用返回，而 stock 返回普通对象；数组或 tuple 的空洞若被继承的*值*覆盖，读到的是该值并按原引用返回，而 stock 会把它写成自有槽位；空洞之下若继承的是 `undefined`，则像 stock 一样实体化，#70 的评审；strip 对象的 `for...in` 探测会看到可枚举的继承键并像 stock 一样拷贝，loose 对象在干净路径上不枚举，这样的键仍留在原型上，而 stock 的 `for...in` 追加会把它写成自有键；record 两边都拒绝类实例）以及 Proxy 陷阱（`for...in` 会触发 `ownKeys`、`getOwnPropertyDescriptor`，以及在遍历原型链时触发的 `getPrototypeOf`；strip 对象的 `for...in` 探测三个都会触发，而 stock 的 strip 模板不枚举任何东西；loose 对象只通过自有 symbol 探测触发 `ownKeys`，`ownSymbolKeys: "ignore"` 下什么都不触发，而 stock 的 `for...in` 追加三个陷阱都会触发；所以抛错的陷阱在两个方向上都会表现不同）。不为它们增加显式探测：在每个干净容器上证明它们不存在，正是 `ownSymbolKeys: "ignore"` 想省掉的那种开销；需要这种规范化的输入可以用 stock 的 `parse`（#48）。
- 刻意不对齐的 stock quirk：tuple 带 async rest 槽且 nullable 槽输入为 `null` 时，stock zod4 runtime 产生稀疏数组并丢掉 `null`；骨架输出稠密数组。差分生成器规避该组合，复现见上游 issue 草稿。异步调度：stock 的 runtime 在循环内启动每个条目的解析，同步结果立即写入，异步结果等其 promise 落定后写入，所以异步解析返回的 record、Map 或 Set 按落定顺序排列，键冲突时更早的异步键值对会胜过更晚的同步键值对（`z.set(z.union([z.string().refine(async …), z.number()]))` 对 `Set {"a", 1}` 得到 `Set {1, "a"}`）。set、map 与遍历键的 record 骨架遵循同一调度（只有条目按迭代顺序落定且未变化时才共享输入），差分对异步输出也做有序比较（#70）。zod 自己的编译器没有异步模式（抛出 `ZodCompileAsyncError`），所以 runtime 是唯一的 stock 参照。对象、enum 键 record、数组与 tuple 骨架仍就地 `await` 每个子节点：它们的输出按键或下标寻址，所以与 stock 一致，只有异步对象的键顺序（即上文的键顺序限制）和子节点副作用的交错不同；像 stock 那样在第一个 `await` 之前启动所有子节点由 #71 跟踪。

## 目录

一个 pnpm workspace：每个 zod 大版本一个包，每条线再配一个基准包（[ADR 0001](docs/adr/0001-package-layout.md)）：

```
packages/zod-cow-v4/        以 zod-cow-v4 发布（主线）；peer zod >=4.5.4 <4.6.0，ESM + 类型声明输出到 dist/
  README.md                 面向使用者的文档：安装、用法、API、peer 策略
  src/index.ts              compile() API
  src/cow4/                 引擎：官方 codegen + CoW 容器骨架 + async 通道
                            （index、product、codectx、predicates、purity、official、emit、emit-{object,array,tuple,record,map,set}）
  src/probe-z4.ts           zod4 def 结构与行为勘察（一次性诊断，不参与构建）
  src/probe-z4-flags.ts     zod4 语义金丝 flag（版本升级自动报警，不参与构建）
  tests/harness.ts          零依赖测试框架（test / summary / deepEqual），与 zod3 包的副本逐字节相同
  tests/canary-z4.test.ts   zod 版本金丝（stock zod4 行为 ↔ 编译器假设）
  tests/smoke-z4*.test.ts   zod4 行为断言（容器 / tuple / async）
  tests/differential-z4.test.ts   zod4 差分模糊（20000 case，REPRO 钩子）
  scripts/pack-smoke.ts     tarball 冒烟（文件清单、manifest、import、require、消费者 typecheck）
packages/zod-cow-v3/        私有的 zod-cow-v3；导出 TypeScript 源码，不构建
  src/index.ts              compile() API
  src/compile.ts            编译器：叶子与包装节点的闭包树、作为 codegen 回退的闭包骨架、纯度分析
  src/codegen.ts            生成的 object / array / tuple 骨架（new Function，叶子谓词内联）
  src/internal.ts           协议：FAILED 哨兵 / Ctx / 经 zod error map 的 issue 构造 / safeSet
  src/regexes.ts            zod 3.24.1 内部格式正则的逐字拷贝
  src/probe.ts              stock zod3 行为探针
  tests/harness.ts          测试框架的另一份副本（另有 harness.test.ts 自测）
  tests/unit.test.ts        zod3 单元测试（53 项，--no-codegen 跑闭包回退）
  tests/differential.test.ts   zod3 差分模糊（20000 case，比较 issue 列表，--no-codegen 跑闭包回退）
packages/bench-v4/          bench.ts（S1 纯校验 / S2 脏负载 / S3 脏比例 / S4 validate / S5 容器 / S6 tuple / S7 async，ArkType 为一列）、harness.ts（测量）、gates.ts（等价性门）与 demo.ts，对构建后的 zod-cow-v4 运行
packages/bench-v3/          bench.ts（S1 干净 / S2 默认值 / S3 脏比例 / S4 validate / S5 容器 / S6 tuple / S7 transform / S8 strip，ArkType 为一列）、calibration.ts（单记录热循环、规模扫描）、failures.ts（S9，先比 issue 一致性）、schemas.ts、harness.ts、gates.ts 与 zod3 的 demo.ts
docs/ARCHITECTURE-z4.md     zod4 引擎架构深度走读（英文，权威版本；docs/ARCHITECTURE-z4.zh-CN.md 是其中文对应版本）
docs/upstream-issue-draft.md   给 zod 上游的 issue 草稿：请求公开 compileFn / assertOnly / INVALID
docs/adr/0001-package-layout.md   ADR：每个 zod 大版本一个包的 pnpm workspace 布局、发布名 `zod-cow-v4`、benchmark 按线拆分、peer 依赖策略、zod3 线不发布
CHANGELOG.md                v0.1～v0.5 历史与各版本的历史基准表（覆盖整个 workspace）
```

## 延伸阅读

- [packages/zod-cow-v4/README.md](packages/zod-cow-v4/README.md)：发布包的使用者文档（安装、用法、API、peer 策略）。
- [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md)：生成代码与官方产物并排对照、纯度白名单与四大陷阱、record / map / set / tuple 骨架、async 通道、降级链状态机、版本锚点与风险。
- [CHANGELOG.md](CHANGELOG.md)：项目如何从自研 zod3 编译器（v0.1）经自研 zod4 移植（v0.2，已移除）走到复用官方 codegen（v0.3～v0.5），附每一步的基准表。
- [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md)：请求公开 `compileFn` API 的理由，以及模糊测试中发现的 zod4 runtime quirk。
- [AGENTS.md](AGENTS.md)：贡献者与编码代理的工作约定（命令、模块地图、版本锚点、PR 规则）。
