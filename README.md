# 鸟类环志记录与鸟点地图（gbbirdring）

面向环志站与鸟类监测志愿者：登记环志编号、鸟种与量度（喙/翅/尾/体重）、鸟点生境与调查批次，并在地图上查看鸟点分布。地图使用高德地图 JS API（key 走 `VITE_AMAP_KEY`），**未配置 key 时自动退化为本地 SVG 网格视图，构建与运行均不依赖该 key**。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21812>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| 构建 | Vite 6（`npm run build` 含 `vue-tsc --noEmit` 类型检查） |
| UI | Element Plus 2 |
| 路由 | Vue Router 4（5 条业务路由 + 404） |
| 状态 | Pinia（ringStore / measureStore / siteStore / sessionStore） |
| 地图 | 高德地图 JS API（可选，按需动态加载）+ 本地 SVG 网格退化视图 |
| 存储 | IndexedDB（Dexie，库名 `gbbirdring-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 地图 key 说明（可选）

- 未配置 `VITE_AMAP_KEY`：`<SiteMap>` 渲染本地 SVG 网格视图，标记按生境配色落在对应格位，表单拾取坐标即落到格位中心；**构建与运行都不依赖该 key**。
- 配置后：`.env` 里填 `VITE_AMAP_KEY=<你的 key>`，再 `docker compose up -d --build`（compose 通过 build args 传入，Dockerfile 用 `ARG VITE_AMAP_KEY` 注入 Vite）。高德控制台需为该访问域名开启 JS API。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21812
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射 / 可选 VITE_AMAP_KEY build arg
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT、可选 VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # ring-record / recovery / morphometrics / bird-site / session（+ ui.ts）
│       ├── stores/            # ringStore / reportStore / measureStore / siteStore / sessionStore
│       ├── components/common/ # SiteMap / MeasureInput / RingCodeInput / SpeciesPicker / ReportPanel / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useSiteFilter / useAmap
│       ├── pages/             # RingBoard / RingList / MeasureEntry / SiteList / SessionList
│       ├── router/index.ts    # 路由表
│       └── utils/             # stats.ts / geo.ts / db.ts / export.ts / recovery.ts（通报解析）/ reconcile.ts（对账）/ date.ts（+ seed.ts / id.ts / plain.ts / format.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 统计台 | 鸟种数、初捕/重捕比、鸟点分布图、鸟种计数与生境分布 |
| `/rings` | 环志记录 | 金属环号 + 彩环双段录入与自动查重，重复时提示并跳转历史记录；支持粘贴上级中心回捕通报，按金属环号与本地初捕记录自动对账 |
| `/measure` | 量度测量 | 6 项量度带单位与范围校验，与同鸟种历史均值比对给出偏离提示 |
| `/sites` | 鸟点台账 | 地图 / SVG 网格双模式切换，表单拾取坐标即时落点，点位间距提示 |
| `/sessions` | 调查批次 | 观测条件录入，关闭批次后统计鸟种数、初捕数与重捕数 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbbirdring-db`），表：`rings`、`morphs`、`sites`、`sessions`、`reports`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为环志表增加 `[speciesCn+ringDate]` 复合索引并回填历史彩环字段；`db.version(3)` 新增回捕通报表 `reports`（按 `ringNo / status / sourceHash / importedAt` 索引），并为环志表增加 `reportId` 索引。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入示例数据（6 个鸟点、4 个调查批次、18 条环志记录与 14 条量度）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 回捕通报对账（环志记录页）

把上级中心发来的通报原文整段粘贴到环志记录页「回捕通报对账」面板即可，处理规则：

- **解析**：从自由文本提取金属环号（`A-10231` / `B 20511` / 裸号）、鸟种（内置目录 + 常见鸟种后缀兜底）、回收日期（`2026年9月18日` / `2026-09-18` / `9月18日`）、上报站点（保护站 / 环志站 / 监测点等关键词及「在 / 由 / 来自 + 地名」），导入前有即时预览。
- **已对账**：本地存在该环号的初捕记录、鸟种一致且回收日期不早于初捕日期时，自动在初捕所在鸟点挂一条「回收」记录，带上上报站点与回收日期，并计入统计台的回收数。
- **待认领**：本地查无此环号，通报保留，等人登记初捕后「重新对账」自动挂上，或直接「人工认领」到某条初捕记录。
- **待核实**：鸟种不一致、回收日期早于初捕、缺日期或无初捕基准时，本地记录与通报**双方都保持原样**，由人在「确认挂接」中裁定。
- **去重**：通报按归一化原文指纹去重，同一段通报（仅空格 / 换行差异也算相同）再贴不重复挂；跨通报重报同一环号同一天只关联既有回收记录。
- **原子性与重试**：整批导入在单个 IndexedDB 事务内完成，解析失败在开事务前报错、写入中途失败整体回滚，本地记录与已对好的结果都不动；输入框保留原文，修改后可直接重试。
