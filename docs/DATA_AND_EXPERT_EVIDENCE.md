# EV Desk 数据、专家观点与证据体系

更新日期：2026-07-14

本文档说明 EV Desk 当前已经接通的数据、证据口径、Paul Wei 专家模型、持续更新方式，以及上线时仍需由项目所有者提供的账号或授权。它也是以后新增专家和数据源时的接口约定。

## 1. 当前完成状态

| 能力 | 状态 | 当前实现 |
|---|---|---|
| 加密 K 线 | 已完成 | Binance 主源，Binance Data API、OKX、Kraken 依次降级；只保留已收盘 K 线 |
| 永续上下文 | 已完成 | Binance Futures 资金费率、标记价、OI、24H OI 变化、24H 价格与成交额；OKX Swap 降级 |
| 统一行情 API | 已完成 | `GET /api/v1/market/bundle`，前端优先调用，失败才浏览器直连 |
| 17 个规则化分析视角 | 已完成 | 每根闭合 K 线保存方向、置信度、理由、计划、版本和证据快照 |
| Paul Wei 行为模型 | 已完成 | 本地 skill + 最新 1H OHLCV 生成结构化观点；通过受保护接口导入 |
| 历史方法证据 | 已完成首批 | BTC/ETH/SOL 的 15m、1h、4h；统一执行规则、费用、置信区间和回撤 |
| 长历史教练训练 | 14 位完成，3 位待补输入 | Paul 真实账本 + BTC/ETH/NQ/ES；12 个范围，开发/验证/最终留出严格按时间切分 |
| 计划质量门控 | 受限上线 | 248,295 个候选计划训练；仅 BTC 1h、ETH 4h 可作“只否决”安全层 |
| 24H 前瞻赛场 | 已完成 | Cloudflare Worker + D1 + 定时任务 + 连续哈希账本 |
| 宏观数据 | 接口完成，需密钥 | FRED 的 10Y、10Y 实际利率、广义美元、VIX、Fed 资产负债表 |
| 美股与 US Tech 100 | 已可使用延迟行情 | GitHub 每 30 分钟发布闭合 K 线快照；有凭证时 Worker 优先 Alpaca；US Tech 100 对应 `^NDX` |
| 黄金与原油 | 已可使用延迟行情 | 定时快照使用 Yahoo Finance 的 `GC=F` 与 `CL=F`；生产低延迟或商业服务仍应换成有相应许可的数据源 |
| 决策 K 线 | 已完成 | 前端自绘 OHLC、成交量、EMA20/50、关键区与参考进场/止损/目标；和专家计划使用同一份行情与价位对象 |
| 机会雷达 | 已完成 | 自动扫描跨资产自选池，隔离每个品种的资金费率与专家上下文，记录已收盘证据时点，并区分触发、接近、等待与失效 |
| 教练近期战绩 | 已完成 | 每个最终留出范围发布最后 20 笔原始结算，页面展示曲线、近期盈亏、连胜连亏与证据等级，不从降采样曲线反推逐笔 |
| TradingView Charting Library | 独立事项 | 当前行情与证据系统不依赖 TV；若使用完整 Charting Library，需向 TradingView 申请授权并接自有 datafeed |

## 2. 三层证据必须分开

### 当前观点

回答“最新闭合 K 线下，这个方法现在怎么看”。字段包括：

- 数据源和闭合时间
- 方向或 `watch`
- 置信度与理由
- 入场、止损、目标、触发、失效
- 方法/模型版本
- 原始证据与内容哈希

当前观点不是战绩。`watch` 和无动作同样会保存，避免只记录事后看起来正确的观点。

### 历史证据

回答“同一套固定规则在过去数据上表现如何”。统一口径为：

- 只使用当时及更早的闭合 K 线，不使用未来数据
- 挂单 12 根 K 线失效
- 成交后最多持有 30 根 K 线
- 同一根 K 线同时碰止损和目标时先记止损
- 往返成本 0.10%，结果以 R 表示
- 展示样本数、胜率、胜率 95% 区间、EV、EV 95% 区间、Profit Factor、最大回撤、累计 R
- 展示近 90 日与此前样本的差异，但只称为环境漂移，不称为专家成长

当前历史文件：

- `data/expert-evidence.json`：机器可读完整证据
- `data/expert-evidence.js`：静态网页直接加载版本
- 引擎：`arena-v2.0.0`
- 内容哈希：`921e30c470b21072c518a3a7d76df6fc9373d73a29213da77574e9f4f737efd5`

首批覆盖：

| 标的 | 周期 | 数据范围 | K 线数 | 模拟交易数（17 方法合计） |
|---|---:|---|---:|---:|
| BTCUSDT | 15m | 180 天 | 17,279 | 20,130 |
| BTCUSDT | 1h | 730 天 | 17,519 | 27,207 |
| BTCUSDT | 4h | 1,095 天 | 6,569 | 11,055 |
| ETHUSDT | 15m | 180 天 | 17,279 | 22,133 |
| ETHUSDT | 1h | 730 天 | 17,519 | 28,235 |
| ETHUSDT | 4h | 1,095 天 | 6,569 | 10,683 |
| SOLUSDT | 15m | 180 天 | 17,279 | 24,155 |
| SOLUSDT | 1h | 730 天 | 17,519 | 28,900 |
| SOLUSDT | 4h | 1,095 天 | 6,569 | 11,100 |

### 前瞻成长

回答“专家启用后，新观点在真实时间顺序中表现如何”。只有这层可以用于动态权重和成长：

- 信号先封存，之后才可结算
- 失败记录不能由界面删除
- 每条 signal/trade 连接到前一条记录哈希
- 少于 5 笔不调权；之后对小样本强收缩
- 统计可按标的、周期和行情环境拆分
- “成长”是适用环境识别和可信权重校准，不是修改过去规则或回填历史

## 3. Paul Wei 的正确定位

Paul Wei 在系统里是 `behavior_model`，不是普通技术指标，也不是本人实时发言。

当前输入：

- 本地 skill：`~/.codex/skills/paul-wei-style-trading`
- Paul Wei 历史行为重建数据
- BTC/ETH/SOL 最新已收盘 1H K 线
- BTC 为原生迁移；ETH/SOL 为跨资产迁移，风险需要按 ATR/R 重新缩放

解释顺序：

1. 先看 `no_action`，回答是否值得行动。
2. 再分进攻多、进攻空、减多、减空。
3. `reduce_long` 和 `close_long` 是降风险，不等于开空。
4. 只有 `open_short`、`add_short`、`reverse_long_to_short` 才是进攻空头。
5. Paul Wei 提供方向语言与风险单位；具体入场、止损和目标由 EV Desk 的独立关键位引擎生成，并在页面明确标注边界。

当前样本外校准：

- 固定训练截止：2025-05-03 23:00 UTC
- 留出期截止：2026-05-03 23:00 UTC
- 每日查询 359 次，其中有方向动作 33 次
- 24H 方向命中 45.5%，平均有符号收益 +0.094%
- 72H 平均有符号收益 -0.272%
- 168H 平均有符号收益 +0.199%
- 前半 16 次与后半 17 次差异只表示稳定性/环境漂移，不证明模型自动成长

相关文件：

- `data/paul-wei-live.json`：完整实时模型输出
- `data/paul-wei-live.js`：网页加载版本
- `data/expert-views/paul-wei.json`：可提交给专家观点接口的批次
- `tools/build_paul_wei_feed.py`：生成器

## 4. 长历史教练训练与计划门控

### 4.1 原始数据清单

本轮使用项目所有者提供的本地档案。原始文件不发布，只发布聚合、质量清单、血缘哈希和模型参数。

| 数据 | 清洗后规模 | 覆盖 | 当前用途 |
|---|---:|---|---|
| Paul Wei 执行/订单 | 173,058 条执行；43,214 张订单；98,777 条 XBTUSD 交易执行 | 2020-05 至 2026-04 | 行为标签教师账本 |
| BTCUSDT 永续 1m | 2,890,080 | 2021-01-01 至 2026-06-30 | 主训练行情 |
| ETHUSDT 永续 1m | 2,890,080 | 2021-01-01 至 2026-06-30 | 主训练行情 |
| BTCUSDT 指数 1m | 2,871,353 | 2021-01-01 至 2026-06-30 | 基差对齐与质量检查 |
| ETHUSDT 指数 1m | 2,884,312 | 2021-01-01 至 2026-06-30 | 基差对齐与质量检查 |
| BTC 衍生品指标 5m | 577,415 个唯一时点 | 2021-01-01 至 2026-07-01 | OI/仓位/taker 上下文质检 |
| ETH 衍生品指标 5m | 481,684 | 2021-12-01 至 2026-07-01 | 部分 OI/仓位/taker 上下文质检 |
| NQ 1m | 1,048,575 | 2022-12-26 至 2025-12-11 | 跨资产压力测试 |
| ES 主力连续 1m | 355,021 | 2023-11-20 至 2024-11-19 | 跨资产压力测试 |

BTC/ETH 主训练行情各自完整连续，没有缺失分钟。指数和指标目前只用于数据对齐、质量判断与后续上下文特征储备，不会假装已经进入本版计划模型。

### 4.2 Paul Wei 教师账本

- 160,413 条交易执行；XBTUSD 中 32,909 条提供流动性、65,868 条移除流动性。
- 形成 4,825 个行为片段、4,248 个活跃小时。
- 4,822 个片段可由本次 XBTUSD 账本核验；另有 3 个片段晚于账本截止，明确保留为 skill-only 标签。
- 动作分组：进攻空 1,436、进攻多 1,245、空头降险 1,156、多头降险 988。
- `open_long` 的 24H 后验样本为 288，方向命中 63.2%，均值 +1.108%；`add_long` 为 818 个样本，方向命中 57.0%，均值 +0.799%。
- 空头动作的分布更弱且偏斜，因此不能把“Paul 风格”简化成永远做空。
- `reduce_long`、`close_long`、`reduce_short`、`close_short` 始终解释为降风险，不解释成反向开仓。

上述 24H 结果是动作后的市场风险方向后验，不是包含滑点、资金费率和真实仓位路径的可执行 PnL。

### 4.3 时间切分与执行口径

所有范围先由分钟数据聚合为 15m、1h、4h，共 12 个 `标的 × 周期`：

- BTC/ETH：通常以 2021-2023 为开发、2024 为验证、2025 以后为最终留出。
- NQ：同样按自然年份做开发、验证、最终留出。
- ES：数据只有一年，使用 60% / 20% / 20% 的时间顺序切分。
- 任何信号只读取当前及更早的已收盘 K 线；不随机打乱。
- 候选计划挂单 12 根失效，成交后最多持有 30 根；同根先止损；往返成本 0.10%。
- 固定专家规则不针对最终留出调参。计划模型阈值只使用开发和验证，`selection.used_holdout=false`。

### 4.4 负结果也保留

14 个可独立产生方向的规则化方法镜头被单独拿出来做最终留出压力测试。它们的范围加权 EV 均为负；最接近中性的动量镜头仍为 `-0.088R`。网格是执行方式，不独立押注方向；情绪缺完整历史资金费率；宏观缺历史利率、美元、波动率与流动性输入。这 3 位保持未参赛，页面会写出原因，不以 0 战绩参与排名。

这不等于“技术分析毫无价值”，而是说明单一镜头不足以承担完整策略责任。页面将其显示为分析视角与保守先验，不把流派名字当作盈利证明。

简单多数投票同样失败：

| 阶段 | 范围 | 样本 | 范围平衡 EV | 正向范围 |
|---|---:|---:|---:|---:|
| 开发 | 12 | 47,266 | -0.329R | 0% |
| 验证 | 12 | 17,180 | -0.294R | 0% |
| 最终留出 | 12 | 23,543 | -0.364R | 0% |

因此网页不会把专家票数或技术指标数量直接解释成胜率。

### 4.5 反策略与执行补救

持续负收益不自动意味着反向交易有正收益。管线为 14 个方向镜头同时生成两条互不覆盖的账本：

1. **简单反向实验**：保留原镜头作为方向触发器，但方向取反，并按新方向重新生成结构进场、止损和目标。它不是把原策略收益乘以 `-1`。
2. **成本感知补救**：保留原方向，从 `最大成本/R = 0.12、0.18、0.25、0.35`、`最低 RR = 1.2、1.5、2.0`、`全部/避开逆势/只做顺势` 组合出 36 套少交易方案。

所有候选只用开发集与验证集选择；最终留出只在选择完成后披露，不能据此更换参数或降低门槛。统一启用要求为：开发与验证各至少 4 个有效范围、200 笔交易、范围加权 EV 不低于 `+0.03R`、正向范围不低于 55%。简单反向还要求原策略在开发与验证均不高于 `-0.05R`，避免把随机波动误认成可反向的稳定错误。

本轮结果：

| 研究路线 | 通过开发+验证 | 最终结论 |
|---|---:|---|
| 简单反向 | 0 / 14 | 14 位最终留出范围加权 EV 全部为负，不启用 |
| 成本感知补救 | 0 / 14 | 没有独立策略达到预设门槛 |
| Brooks 最佳候选 | 未通过 | 成本不高于 0.12R、RR 不低于 1.5、只做顺势；开发 -0.019R、验证 +0.103R、最终留出 +0.047R，只观察不激活 |

14 个镜头最终留出的平均毛期望约为 `-0.007R/笔`，平均往返成本约为 `0.316R/笔`。这表明主要故障不是“方向总是相反”，而是规则化镜头的边际优势很薄，止损距离相对 0.10% 往返成本过窄且出手过密。当前补救方式是保留它们作为结构特征和否决依据，由组合计划门控限制可执行范围；原战绩、反向战绩和补救候选始终分开显示。

### 4.6 受限计划门控

从 248,295 个已执行候选计划提取只在信号时点可见的特征，包括计划赔率、进场/止损/目标相对 ATR、波动、时段、行情结构和 17 个相对观点。最终采用强约束浅层梯度提升分类器：120 棵树、深度 3、学习率 0.04、最小叶节点 250、80% 子采样。

| 阶段 | 通过门控的计划 | 胜率 | 每笔 EV | 范围加权 EV | Profit Factor | 最大回撤 | 累计 R |
|---|---:|---:|---:|---:|---:|---:|---:|
| 验证 | 213 | 57.7% | +0.056R | +0.032R | 1.11 | -18.16R | +12.02R |
| 最终留出 | 251 | 57.0% | +0.074R | +0.064R | 1.14 | -11.99R | +18.65R |

验证 AUC 为 0.605，最终留出 AUC 为 0.5934，属于有限而不是强区分能力。只有 `BTCUSDT|1h` 与 `ETHUSDT|4h` 同时满足验证、最终留出均为正且各自不少于 20 笔，因此部署模式固定为：

```text
status: accepted_limited
mode: veto_only
scopes: BTCUSDT|1h, ETHUSDT|4h
```

门控只可拒绝 EV Desk 已经生成的方向与关键位计划；不能创建方向、入场、止损、目标或仓位。其他标的/周期仍能查看规则计划，但网页必须显示“未获得训练授权”。最终留出正值是研究证据，持续上线资格仍由封存后的前向赛场确认。

### 4.7 数据质量问题

- NQ 文件恰好包含 Excel 最大的 1,048,575 个数据行加表头，可能在导出时被截断。
- BTC 指标原始文件有 40,152 条完全重复记录，已按时点去重。
- BTC 指数缺失 18,727 分钟，ETH 指数缺失 5,768 分钟；均不用于替代完整永续行情。
- ETH 指标从 2021-12-01 才开始，完整行情窗口的小时匹配率为 83.34%。
- ES 原文件混有 ES、MES、价差与远月。管线只保留 ES 单腿，按每日成交量选择主力，并记录 4 次前向加法移仓调整。
- Paul 执行 ID 无重复；订单中有 35 个重复 ID/重复行，保留在质量统计中。

### 4.8 产物与重训

可发布文件：

- `data/coach-training.json` / `data/coach-training.js`
- `data/plan-gate-model.json` / `data/plan-gate-model.js`
- `tools/prepare_coach_training.py`
- `arena-worker/scripts/build-coach-training.mjs`
- `arena-worker/scripts/export-plan-training-samples.mjs`
- `tools/train_plan_gate.py`
- `tools/train_coaches.sh`

本地档案齐备时执行：

```bash
tools/train_coaches.sh "/path/to/enent contract"
```

`tools/update_data.sh full` 在检测到本地档案目录时也会调用这条完整训练链。`.gitignore` 排除 `enent contract/` 和临时训练目录；原始订单、执行 ID、trade ID 与分钟 K 线不会进入 GitHub。

## 5. 数据更新命令

统一脚本：

```bash
tools/update_data.sh live
```

`live` 模式会：

1. 获取 BTC/ETH/SOL 最新已收盘 1H K 线。
2. 重新运行 Paul Wei 评分。
3. 保留现有样本外校准，避免每小时重复做重计算。
4. 更新三个 Paul Wei 数据文件。
5. 若设置了服务地址和管理令牌，自动导入观点并触发一次赛场轮询。

生产前端每次行情刷新还会读取服务器最新的 Paul Wei `expert view`。因此 `data/paul-wei-live.js` 只是离线/静态降级文件，实时生产观点不需要重新发布整个前端。

完整重建：

```bash
tools/update_data.sh full
```

`full` 会先重新下载历史 K 线和资金费率、重建方法历史证据，再完整重算 Paul Wei 校准。建议方法规则变更后或每月执行，不需要每小时执行。

自动发布到服务：

```bash
ARENA_API="https://ev-desk-arena.example.workers.dev" \
ADMIN_TOKEN="your-secret" \
tools/update_data.sh live
```

建议 Paul Wei 生产器在装有 skill 的可信机器上每小时第 3 至第 8 分钟运行。服务端会拒绝异常时间戳，不会重复封存同一个 `source view id`。

## 6. 本地运行

终端一：

```bash
cd arena-worker
npm ci
cp wrangler.example.toml wrangler.toml
npm run db:local
npm run dev -- --port 8790
```

本地 `wrangler.toml` 的 D1 ID 可以使用占位 UUID；`.dev.vars` 至少设置：

```text
ADMIN_TOKEN=your-local-secret
```

终端二：

```bash
python3 -m http.server 8780
```

访问 `http://localhost:8780/app.html`。`config.js` 会在 localhost 自动发现 `http://localhost:8790`；若 Worker 未运行，网页自动降级为浏览器直连行情和本地账本。

## 7. Cloudflare 上线

1. 创建 D1：`npx wrangler d1 create ev-desk-arena`。
2. 复制 `wrangler.example.toml` 为 `wrangler.toml`，填入真实 `database_id` 和前端域名。
3. 执行 `npm run db:remote`。
4. 设置管理令牌：`npx wrangler secret put ADMIN_TOKEN`。
5. 设置 FRED：`npx wrangler secret put FRED_API_KEY`。
6. 需要更稳定的美股生产行情时设置 `ALPACA_KEY_ID` 与 `ALPACA_SECRET_KEY`；未设置时自动使用延迟行情。
7. 执行 `npm run deploy`。
8. 将生产 `config.js` 的 `arenaApi` 和 `marketApi` 都设为 Worker origin。
9. 执行一次 `tools/update_data.sh live` 导入 Paul Wei 最新观点。
10. 检查 `/health`、`/api/v1/arena/meta`、`/api/v1/market/bundle` 与专家赛场页面。

生产密钥不要写入仓库。`.dev.vars.example` 只列变量名，不包含真实值。

## 8. 需要项目所有者申请或提供的内容

### 必需于公开 24H 服务

- Cloudflare 账号、D1 数据库 ID 和部署权限
- 一个长随机 `ADMIN_TOKEN`
- 生产前端域名，用于 `ALLOWED_ORIGIN`

### 宏观观点必需

- FRED API key。没有 key 时，宏观专家保持 `watch` 并显示缺失原因。

### 美股生产行情可选增强

- Alpaca Market Data key/secret
- `iex` 可作为基础免费数据；需要完整美股覆盖和更低延迟时使用有相应权限的 SIP 方案
- 不申请密钥也能查看美股、US Tech 100、黄金和原油的延迟 K 线，但免费备援可能受限流影响，不承诺交易所级实时性

### TradingView 完整图表可选

- 当前数据系统不需要 TradingView API。
- 若要交易所式完整 TradingView Charting Library，需要申请库授权。
- 获得授权后，仍应让 TradingView datafeed 请求 EV Desk 的统一行情服务，不应让页面散落调用多个交易所。
- TradingView 的显示层不替代行情许可、专家证据或前瞻账本。

## 9. 外部专家观点接口

提交地址：`POST /api/v1/admin/expert-views`

认证：`Authorization: Bearer <ADMIN_TOKEN>`

最小结构：

```json
{
  "schema": "ev_desk_expert_view_v1",
  "expert": {
    "id": "expert_id",
    "name": "Expert Name",
    "school": "专业方向",
    "kind": "human",
    "version": "2026-07-13"
  },
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "asOf": "2026-07-13T08:00:00Z",
  "validUntil": "2026-07-13T10:00:00Z",
  "direction": "long",
  "stance": "long_bias",
  "confidence": 0.65,
  "reason": "结构化理由",
  "action": "等待回踩确认",
  "riskUnit": "0.5R",
  "evidence": {
    "source": "已获授权的专家观点或模型输出"
  }
}
```

约束：

- 外部种类只能是 `human` 或 `behavior_model`。
- `asOf` 不得在未来超过 5 分钟，也不得早于 31 天。
- 有效期不得早于观点时间，且最长 7 天。
- 如果提供价格计划，方向、入场、止损和目标必须一致。
- 人类专家观点必须获得授权，不应抓取付费群、私聊或非公开内容。

## 10. 公开 API

- `GET /health`
- `GET /api/v1/market/bundle?symbol=BTCUSDT&timeframes=15m,1h,4h,1d`
- `GET /api/v1/desk/snapshot?symbol=BTCUSDT&timeframe=4h`
- `GET /api/v1/arena/meta`
- `GET /api/v1/arena/leaderboard?symbol=BTCUSDT&timeframe=1h`
- `GET /api/v1/arena/opportunities?symbol=BTCUSDT&timeframe=4h`
- `GET /api/v1/arena/views?symbol=BTCUSDT&timeframe=1h`
- `GET /api/v1/arena/positions?expert=paul_wei&symbol=BTCUSDT&timeframe=1h`
- `GET /api/v1/arena/ledger?expert=paul_wei&symbol=BTCUSDT&timeframe=1h&limit=100`
- `GET /api/v1/arena/experts/paul_wei?symbol=BTCUSDT&timeframe=1h`
- `GET /api/v1/arena/proof/:hash`

## 11. 可信度边界

- 连续哈希可检测账本中的静默修改，但不是区块链，也不能单独证明运营方没有替换整个数据库。
- 成熟付费服务应定期把 chain head 签名并发布到独立位置。
- 规则化 Brooks、ICT、威科夫、缠论等只是结构化分析镜头，不等于原作者完整主观判断。
- Paul Wei 输出是历史行为相似度，不是本人实时喊单。
- 任何方法的历史正 EV 都不保证未来；样本量、置信区间、回撤和前瞻表现必须同时展示。
- EventEdge 等独立研究模型只有在明确接口、授权和前瞻验证后才能作为新专家接入，不能因为历史报告存在就冒充专家实时观点。

## 12. 官方数据文档

- Binance Spot Market Data: https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market
- Binance USD-M Klines: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/market-data/rest-api/Kline-Candlestick-Data
- Binance Futures Market Data: https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
- OKX API v5: https://www.okx.com/docs-v5/en/
- FRED API: https://fred.stlouisfed.org/docs/api/fred/overview.html
- Alpaca Market Data: https://docs.alpaca.markets/us/docs/about-market-data-api
