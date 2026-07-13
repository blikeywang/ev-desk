# EV Desk 数据、专家观点与证据体系

更新日期：2026-07-13

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
| 24H 前瞻赛场 | 已完成 | Cloudflare Worker + D1 + 定时任务 + 连续哈希账本 |
| 宏观数据 | 接口完成，需密钥 | FRED 的 10Y、10Y 实际利率、广义美元、VIX、Fed 资产负债表 |
| 美股 K 线 | 接口完成，需密钥 | Alpaca；免费 IEX 或付费 SIP，由 `ALPACA_FEED` 决定 |
| 大宗商品 | 待授权源 | 浏览器端仍可尝试 Yahoo 降级；生产服务不把非授权代理当可靠主源 |
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

## 4. 数据更新命令

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

## 5. 本地运行

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

## 6. Cloudflare 上线

1. 创建 D1：`npx wrangler d1 create ev-desk-arena`。
2. 复制 `wrangler.example.toml` 为 `wrangler.toml`，填入真实 `database_id` 和前端域名。
3. 执行 `npm run db:remote`。
4. 设置管理令牌：`npx wrangler secret put ADMIN_TOKEN`。
5. 设置 FRED：`npx wrangler secret put FRED_API_KEY`。
6. 需要美股时设置 `ALPACA_KEY_ID` 与 `ALPACA_SECRET_KEY`。
7. 执行 `npm run deploy`。
8. 将生产 `config.js` 的 `arenaApi` 和 `marketApi` 都设为 Worker origin。
9. 执行一次 `tools/update_data.sh live` 导入 Paul Wei 最新观点。
10. 检查 `/health`、`/api/v1/arena/meta`、`/api/v1/market/bundle` 与专家赛场页面。

生产密钥不要写入仓库。`.dev.vars.example` 只列变量名，不包含真实值。

## 7. 需要项目所有者申请或提供的内容

### 必需于公开 24H 服务

- Cloudflare 账号、D1 数据库 ID 和部署权限
- 一个长随机 `ADMIN_TOKEN`
- 生产前端域名，用于 `ALLOWED_ORIGIN`

### 宏观观点必需

- FRED API key。没有 key 时，宏观专家保持 `watch` 并显示缺失原因。

### 美股生产行情必需

- Alpaca Market Data key/secret
- `iex` 可作为基础免费数据；需要完整美股覆盖和更低延迟时使用有相应权限的 SIP 方案

### TradingView 完整图表可选

- 当前数据系统不需要 TradingView API。
- 若要交易所式完整 TradingView Charting Library，需要申请库授权。
- 获得授权后，仍应让 TradingView datafeed 请求 EV Desk 的统一行情服务，不应让页面散落调用多个交易所。
- TradingView 的显示层不替代行情许可、专家证据或前瞻账本。

## 8. 外部专家观点接口

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

## 9. 公开 API

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

## 10. 可信度边界

- 连续哈希可检测账本中的静默修改，但不是区块链，也不能单独证明运营方没有替换整个数据库。
- 成熟付费服务应定期把 chain head 签名并发布到独立位置。
- 规则化 Brooks、ICT、威科夫、缠论等只是结构化分析镜头，不等于原作者完整主观判断。
- Paul Wei 输出是历史行为相似度，不是本人实时喊单。
- 任何方法的历史正 EV 都不保证未来；样本量、置信区间、回撤和前瞻表现必须同时展示。
- EventEdge 等独立研究模型只有在明确接口、授权和前瞻验证后才能作为新专家接入，不能因为历史报告存在就冒充专家实时观点。

## 11. 官方数据文档

- Binance Spot Market Data: https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market
- Binance USD-M Klines: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/market-data/rest-api/Kline-Candlestick-Data
- Binance Futures Market Data: https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
- OKX API v5: https://www.okx.com/docs-v5/en/
- FRED API: https://fred.stlouisfed.org/docs/api/fred/overview.html
- Alpaca Market Data: https://docs.alpaca.markets/us/docs/about-market-data-api
