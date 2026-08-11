# Apple Health 本地看板 — 项目交接文档（Handover）

> 本文档供接手方（IDE / 开发者）快速了解项目全貌，并按 GitHub 标准完成同步与后续开发。
> 生成日期：2026-08-11 · 版本：v2.0

---

## 1. 项目是什么

**Apple Health 本地看板** 是一个**完全本地运行**的 Apple Health 数据可视化看板：

- 输入：iPhone「健康」App 导出的 `export.xml`（几十 MB ~ 数百 MB）
- 输出：深色数据看板（概览 / 睡眠 / 心率 / 其他指标四大模块），在浏览器中打开
- 特性：**零后端、零网络请求、零数据上传**——解析与渲染全部在浏览器本地完成（`file://` 双击即可用）
- 附带 Node 脚本：模拟数据生成、自动化验证、数据健康度检查

## 2. 当前能力清单

### 2.1 解析引擎（engine.js）
- 流式块扫描 Apple Health `export.xml`（兼容：单行自闭合 / 长行折行 / 非自闭合 + MetadataEntry / iOS 17–18 新旧睡眠编码）
- 时区感知聚合（按记录自身偏移归当地日）
- 指标注册表 `KNOWN`：步数、活动能量、基础能量、距离、心率、静息心率、步行心率、HRV、血氧、体温、呼吸频率、体重、身高、有氧适能、爬楼、锻炼时间、站立时间、骑行、步行速度、步长、双足支撑、腕温、睡眠目标、睡眠等 20+ 类
- 睡眠三口径聚合：`sleep`（全部）/ `sleepNight`（晚间：18:00–次日 10:30 开始）/ `sleepNap`（午睡：10:30–18:00 开始）
- 睡眠期 HRV：仅统计「入睡→醒来」区间内的 HRV 记录（`daily.hrvSleep`）
- 异常容错：缺字段/坏值/坏日期/负值/未知单位/未知类型全部跳过并计数，不崩溃
- 数据保护：原始文件只读，不修改不删除

### 2.2 看板 UI（index.html + app.js）
| 模块 | 能力 |
|------|------|
| 概览 | 数据摘要、今日 6 指标卡、主趋势图（7D/30D/90D/180D/1Y/ALL）、心率分布、步数周热力、数据质量面板 |
| 睡眠 ⭐ | 三口径切换（全部/晚间/午睡）× 三粒度（日/周/月）；单日时间轴；睡眠质量评分（7.5h=100/6h=60 参考 Apple，四维加权）；90 天评分历史（65 分参考线）+ 自动改进建议；时长状态分级（<5h 严重不足 / 5–5.5h 不足 / >8h 偏高）；睡眠×HRV 双轴叠加图；周热力（多块纵向堆叠）；在床时长虚线框（16h 上限保护） |
| 心率 | 日/周/月粒度；平均/静息/最高/最低/HRV/峰值时段卡；区间带趋势；分布直方图；强度分区；HRV 与静息/步行对比 |
| 其他指标 | 通用指标分析引擎：27+ 指标（核心+自动收录其他类型），每指标独立面板（指标卡/趋势/周热力/12 周统计），日/周/月粒度 |

### 2.3 脚本（scripts/）
| 脚本 | 用途 | 运行 |
|------|------|------|
| `verify.js` | 自动化验证（17 项：解析正确性/逐日核对/性能/异常防御） | `node scripts/verify.js` |
| `make-sample.js` | 生成 1.5 年模拟样例 + 逐日真值答案 | `node scripts/make-sample.js` |
| `make-stress.js` | 生成 32.6 万条压力测试数据 | `node scripts/make-stress.js` |
| `_analyze-real.js` | 流式分析真实导出（指标清单/睡眠拆分/心率） | `node scripts/_analyze-real.js <export.xml>` |
| `_health-check.js` | 数据健康度检查（值域/覆盖率/异常识别） | `node scripts/_health-check.js <export.xml>` |
| `_cdp-test2.js` / `_cdp-mobile.js` | 浏览器端到端回归（需 Edge + 本地 http server） | 见 §7 |

## 3. 文件结构

```
health-dashboard/
├── index.html          # 看板页面（结构与全部样式）
├── engine.js           # 解析引擎（浏览器/Node 双端，UMD）
├── app.js              # 看板逻辑（四大模块 + 图表绘制，Canvas 自绘零依赖）
├── README.md           # 用户使用说明（导出→打开→更新→FAQ）
├── LICENSE             # MIT
├── .gitignore          # 隐私/大文件排除
├── HANDOVER.md         # 本文档
├── sample/
│   ├── export.xml          # 1.5 年模拟样例（10MB，含异常注入，可提交）
│   ├── export-answers.json # 样例逐日真值（验证用，可提交）
│   └── export-real.xml     # ⚠️ 真实健康数据（200MB，已 gitignore，勿提交）
│   └── export-stress.xml   # ⚠️ 压力数据（75MB，已 gitignore，可脚本生成）
└── scripts/            # 见 §2.3
```

## 4. 环境要求

| 项 | 要求 | 说明 |
|----|------|------|
| 浏览器 | Chrome / Edge / Safari / Firefox（近 2 年版本） | 运行看板本体，**无需任何服务器**，`file://` 直接打开 |
| Node.js | ≥ 18（开发/验证用） | 仅脚本需要（生成样例、自动化验证、健康检查）；看板本身不依赖 Node |
| 依赖 | **零 npm 依赖** | 无 package.json / node_modules / 构建步骤 |
| 网络 | 无 | 页面不加载任何 CDN/远程资源 |

**开始使用**：双击 `index.html` → 拖入 `export.xml`。

## 5. GitHub 同步指南（给接手 IDE）

仓库已本地初始化并完成首次提交，接手方只需：

```bash
# 1. 在 GitHub 创建空仓库（如 vitals-ark），不要勾选 README 初始化
# 2. 在项目根目录执行：
git remote add origin https://github.com/<你的用户名>/vitals-ark.git
git branch -M main
git push -u origin main

# 3. 验证忽略项（应无输出）：
git check-ignore sample/export-real.xml
```

**同步前必读**：
- `sample/export-real.xml`（真实健康数据，200MB）已在 `.gitignore`，**绝不提交**
- `sample/export-stress.xml`（75MB）已忽略；如需复现可 `node scripts/make-stress.js`
- 已提交内容约 3MB（含 10MB 模拟样例？实际按体积约 12MB），适合 GitHub 免费仓库

## 6. 常见开发任务

| 任务 | 修改位置 |
|------|---------|
| 新增指标类型 | `engine.js` → `KNOWN` 表（key/kind/unit/label）+ `EXPECT_UNIT` 单位表；指标自动出现在「其他指标」模块 |
| 调整睡眠评分权重/基准 | `app.js` → `sleepScoreCalc()`（7.5h/6h 基准、dims 权重） |
| 修改晚间/午睡分割 | `engine.js` → sleep 分支 `isNight` 判断（18:00 / 10:30 两处常量） |
| 调整主题色 | `index.html` → `:root` CSS 变量 |
| 新增图表类型 | `app.js` → 参照 `drawLineChart` 等（Canvas 自绘，无第三方库） |

## 7. 验证方法

```bash
node scripts/verify.js          # 17 项自动化验证（解析/核对/性能/异常），全绿为准
node scripts/_health-check.js sample/export-real.xml   # 数据健康度（需先有真实数据）
```

浏览器端回归（可选）：在项目根目录 `python -m http.server 8123`，然后用 Edge headless 跑 `scripts/_cdp-test2.js`（覆盖四模块 + 真实数据 + 交互）。

## 8. 已知限制 / 后续方向

- 不提供云端部署/账号体系（定位：纯本地隐私工具）
- 不做医疗诊断（评分与建议为参考模型，权重可调）
- 不自动增量同步 iPhone 数据（需手动重新导出）
- 后续可扩展：PWA 离线包、多用户对比、睡眠报告导出（PDF）
