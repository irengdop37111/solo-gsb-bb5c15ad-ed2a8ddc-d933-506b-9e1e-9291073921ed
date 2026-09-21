# ICU 文案分支预览器（ICU MessageFormat Branch Previewer）

一个 Flask 网页工具：粘贴 ICU MessageFormat 模板、填写变量样例，即可
解析嵌套的 `plural` / `select` / `selectordinal` 语法，按语言环境（locale）
渲染所有可达分支并列出每个分支的触发条件。

## 功能

- **全分支预览**：枚举模板的所有可达分支路径（含嵌套），逐条渲染并标注触发条件
  （如 `count = 0（精确匹配）`、`count 的复数类别为 "one"（示例：count = 1）`）。
- **CLDR 复数规则**：按语言环境计算复数类别（cardinal 基于 Babel/CLDR 数据，
  ordinal 内置常见语言规则），同一变量在多个分支间保证路径自洽。
- **行内错误提示**：括号不配对、未知格式类型、缺少 `other` 分支、重复选择器、
  非法复数类别、变量类型错误（如 plural 变量给了字符串）等，均在编辑器中
  以红色波浪线标出，并在下方列出带行列号的说明，点击可定位。
- **未覆盖分支标记**：对照当前变量样例，标记每个分支 / 每条路径为
  「已覆盖 / 未覆盖 / 不可达」（不可达 = 该复数类别在当前语言环境下不存在，
  或被 `=N` 显式分支抢占）。
- **场景集回归**：为当前模板保存多组带名称的 locale 与变量样例（保存在浏览器
  本地），一键批量调用分析接口并合并每条可达路径的覆盖状态。面板显示总路径数、
  已覆盖 / 未覆盖数量与覆盖率进度条；点击未覆盖项可定位到对应路径的触发条件；
  支持单个场景重跑、删除与「载入编辑器」，并可导出包含场景定义与汇总结果的 JSON。
  单个场景失败时保留错误信息并继续运行其余场景。
- **版本对比**：把当前模板设为基线（保存在浏览器本地）后继续编辑，随时与基线
  对比。后端按**语义路径**对齐新旧模板——由变量名、分支类型、选择器及嵌套父链
  拼接而成（如 `gender:select@male/count:plural@one`），不依赖解析器分配的
  n1/n2 节点序号，因此在模板前面插入新节点也不会造成大面积误报。差异分为
  新增、删除、条件变化（offset / 分支类型 / `=N` 精确匹配值）与渲染文本变化
  四类，界面可按类型筛选，点击变更条目会在编辑器中选中当前版片段、并在基线
  视图中高亮基线片段。对比时所有已保存场景会在新旧两版分别回放并比较输出；
  单侧解析或运行失败只保留该侧错误，不阻断其余场景。
- **变量管理**：从模板一键提取变量；数值 / 布尔自动识别。
- **变量契约审计**：根据模板 AST 推导每个变量在简单占位、`number`、`plural`、
  `select`、`selectordinal` 五类用法中的**允许 JSON 类型**与**必需性**
  （变量是否出现在每一条结构上可能的分支路径上，与 locale 无关）；同一变量
  多类用法取类型交集，无兼容类型（如同时用于 `select` 与 `plural`）时标记
  契约冲突；多个 `select` 用法的取值集合取交集。支持**导入多组场景样例**
  （JSON 文件，兼容场景集导出格式）或直接使用已保存场景批量审计，报告
  **缺失变量、类型冲突、无效复数值**（plural 的 NaN/Infinity、selectordinal
  的非整数）与多余变量，并给出每个问题的**首次出现行列号**（点击可在模板
  中定位）。结果按变量聚合，显示首次出现场景与出现次数；同时生成可复制的
  **JSON Schema 草案**（draft 2020-12，含类型、enum、required），支持
  单个变量片段复制与整份审计 JSON 导出。
- **复制与导出**：复制单条或全部渲染结果；一键导出包含模板、变量与完整
  分析结果的 JSON 文件；场景集可单独导出为回归报告 JSON。

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build
```

### 方式二：Docker

```bash
docker build -t icu-branch-previewer .
docker run --rm -p 5000:5000 icu-branch-previewer
```

### 方式三：本地运行

```bash
pip install -r requirements.txt
python app.py            # 或：gunicorn --bind 0.0.0.0:5000 app:app
```

### 访问

启动后在浏览器打开：**http://localhost:5000**

端口可通过环境变量 `PORT` 修改（Compose 中需同步调整 `ports` 映射）。

## 使用说明

1. 在左侧粘贴 ICU MessageFormat 模板，例如：

   ```
   {gender, select, male{He} female{She} other{They}} has {count, plural, =0{no new messages} one{# new message} other{# new messages}}.
   ```

2. 选择语言环境（如 `en`、`zh-Hans`、`ru`、`ar`），并填写变量样例
   （或点「从模板提取变量」）。
3. 右侧实时展示：
   - **样例渲染结果**：当前变量取值下的输出及其命中的分支条件；
   - **分支节点**：每个 plural/select 的全部分支、触发条件与覆盖状态；
   - **可达分支路径**：所有分支组合的渲染结果，未覆盖的以橙色标记。
4. 点击「复制」复制结果，点击「导出 JSON」下载完整分析。

### 场景集回归

页面底部的「场景集回归」面板用于多组样例的批量回归：

1. 在左侧调好 locale 与变量后，点 **＋ 保存当前为场景**，并为场景命名
   （名称可随时就地修改，场景按模板内容保存在浏览器 `localStorage`，
   切换模板时自动加载该模板对应的场景集）。
2. 重复步骤 1 保存多组场景（如 `en` 的 0/1/其他、`ru` 的 few/many 等）。
3. 点 **▶ 运行全部场景**：后端逐个调用分析逻辑并返回合并结果；
   单个场景失败（模板错误、变量类型错误等）会在行内标红显示错误，
   其余场景继续运行，不影响合并。
4. 右侧「合并路径覆盖」显示总路径数、已覆盖 / 未覆盖数量、覆盖率进度条，
   以及每条路径由哪个场景覆盖；**点击任意未覆盖路径**会滚动定位到上方
   「可达分支路径」中的对应卡片并高亮（其触发条件以 chips 展示）。
5. 每个场景支持 **载入**（把 locale/变量填回编辑器）、**重跑**（仅重跑
   该场景并更新合并）、**删除**。
6. 点 **导出场景 JSON** 下载 `icu-scenarios.json`，包含模板、全部场景定义、
   每个场景的通过 / 失败状态与错误、路径覆盖汇总与每条路径在各场景下的输出。

> 单次运行最多 50 个场景；路径合并以模板中分支节点的路由序列为稳定 key，
> 因此不同 locale 下枚举到的路径会取并集。

### 版本对比

页面底部的「版本对比」面板用于基线模板与当前编辑内容的对照：

1. 调好作为基准的模板后，点 **设为基线**——基线保存在浏览器 `localStorage`
   （键 `icu-preview-baseline-v1`），刷新页面仍在；保存时会**快照当时的场景集**
   （继续编辑后场景列表会切换到新模板对应的集合，快照保证对比时回归场景不丢），
   基线状态行会实时提示「与当前一致 / 当前已修改」。
2. 继续编辑模板，然后点 **与基线对比**。后端把新旧模板各自解析为 AST，
   按语义路径（变量名 `:分支类型@选择器` 沿嵌套父链拼接，同级同名同类节点
   按出现次序加 `[k]` 后缀）对齐，返回四类变更：
   - **新增 / 删除**：仅存在于一侧的分支或整个分支节点（嵌套节点整体增删时
     只报告最外层）；
   - **条件变化**：plural 的 `offset` 改变、`plural ↔ selectordinal` 类型
     切换、`=N` 精确匹配值改变；
   - **文本变化**：同一语义分支（或顶层文本）的消息文本被修改。
3. 变更列表顶部可按类型筛选（全部 / 新增 / 删除 / 条件变化 / 文本变化）；
   **点击任意变更条目**会在上方编辑器中选中当前版对应片段，并在右侧
   「基线模板」只读视图中高亮基线片段。
4. 对比时基线快照的场景与当前场景集合并去重后，会在新旧两版**分别回放**：
   每个场景显示两版各自的渲染输出或错误，输出不同会标记「输出有变化」。
   某一侧解析失败（如基线版本身有语法错误）或运行失败（如变量类型错误）
   只在该侧保留错误，其余场景照常运行。
5. 点 **清除基线** 删除已保存的基线与对比结果。

> 两版模板各自独立解析：即使一侧存在语法错误，也会基于可恢复的 AST 计算
> 差异，并在面板顶部保留该侧的错误提示。

### 变量契约审计

页面底部的「变量契约审计」面板用于校验模板与场景样例的数据契约：

1. 点 **用已保存场景审计** 直接复用「场景集回归」中保存的多组样例；
   或点 **导入场景 JSON** 从文件导入样例——文件可以是场景数组
   `[{"name": "...", "locale": "en", "variables": {...}}, ...]`，
   也可以是场景集导出的 `{"scenarios": [...]}` 包装格式（单次最多 50 组）。
2. 审计结果左侧按**变量聚合**：每张卡片显示变量名、允许的 JSON 类型、
   必需 / 可选、出现的语法位置与首次出现行列号（点击定位到模板）；
   有问题的变量在卡片内列出**缺失变量 / 类型冲突 / 无效复数值 / 多余变量**
   四类问题及其首次出现的场景与总次数，可单独复制该变量的 Schema 片段。
3. 右侧逐场景列出通过 / 失败状态与每个问题的明细；下方展示自动生成的
   **JSON Schema 草案**，点 **复制 JSON Schema** 可整段复制。
4. 点 **导出审计 JSON** 下载 `icu-contract-audit.json`，包含模板、场景
   定义、汇总计数、变量契约、按变量聚合的问题明细、逐场景结果与
   JSON Schema 草案。
5. 审计后继续编辑模板会自动用同一组场景重新审计。

> 必需性按**结构路径**（与 locale 无关）推导：变量出现在全部可能分支
> 路径上才标记为「必需」，只出现在部分分支（如 `{g, select, male{{name}}
> other{...}}` 中的 `name`）为「可选」，缺失可选变量只产生警告。
> 审计规则：`number` / `plural` / `selectordinal` 只接受 JSON number
> （布尔不视作数字）；`select` 只接受 JSON string；简单占位接受字符串 /
> 数字 / 布尔；plural（cardinal）接受小数，selectordinal 只接受整数，
> NaN / Infinity 一律无效。

## HTTP API

`POST /api/preview`

```json
{
  "template": "{count, plural, one{# item} other{# items}}",
  "locale": "en",
  "variables": {"count": 3}
}
```

响应包含 `errors / warnings / infos`（带行列号）、`main`（样例渲染）、
`nodes`（分支结构与覆盖状态）、`paths`（全部可达路径，含稳定标识 `key`）、
`stats`（路径总数、覆盖数、是否截断）以及编辑器高亮用的 `tokens`。

`POST /api/scenarios/run` — 场景集批量回归（单场景失败不中断整批）：

```json
{
  "template": "{g, select, male{He} other{They}} {n, plural, one{#} other{#s}}",
  "scenarios": [
    {"id": "s1", "name": "男-1", "locale": "en", "variables": {"g": "male", "n": 1}},
    {"id": "s2", "name": "其他-2", "locale": "en", "variables": {"g": "x", "n": 2}}
  ]
}
```

响应包含 `summary`（场景通过 / 失败数，路径总数、已覆盖 / 未覆盖数）、
`scenarios`（每个场景的 `status`、`error` 与完整 analyze `result`）以及
`paths`（跨场景合并后的路径，含 `key`、`conditions`、`covered`、
`covered_by` 与各场景输出 `outputs`）。请求体非法或场景数超过 50 返回 400。

`POST /api/compare` — 版本对比（语义对齐新旧模板，场景双版回放）：

```json
{
  "old_template": "{g, select, male{He} other{They}}",
  "new_template": "{g, select, male{He} female{She} other{They}}",
  "scenarios": [
    {"id": "s1", "name": "男性", "locale": "en", "variables": {"g": "male"}}
  ]
}
```

- `old_template` / `new_template` 必填且必须是字符串；`scenarios` 可省略，
  上限 50 个，格式同 `/api/scenarios/run`。
- 响应字段：
  - `old` / `new`：两侧各自的解析结果（`ok` 与带行列号的 `errors`），
    一侧有语法错误不影响另一侧，差异仍基于可恢复的 AST 计算；
  - `changes`：变更列表，每项含 `type`（`added` / `removed` / `condition` /
    `render`）、`level`（`node` / `branch` / `message`）、语义路径 `path`
    （如 `gender:select@male/count:plural@one`）、`detail` 描述，以及
    `old` / `new` 两侧的定位信息（`pos` / `end` / `text` 片段，无该侧时为
    `null`）；
  - `summary`：各类型变更计数与 `total`；
  - `scenarios`：场景在两版的回放结果，`items` 中每个场景含 `old` / `new`
    两侧的 `status` / `output` / `error` 与输出是否变化的 `changed` 标记，
    单侧失败不阻断其余场景。

`POST /api/contract-audit` — 变量契约审计（推导类型/必需性契约，批量审计
场景样例并生成 JSON Schema 草案）：

```json
{
  "template": "{g, select, male{He} other{They}} has {n, plural, one{#} other{#s}}",
  "locale": "en",
  "scenarios": [
    {"id": "s1", "name": "正常", "locale": "en", "variables": {"g": "male", "n": 1}},
    {"id": "s2", "name": "类型错", "locale": "en", "variables": {"g": 1, "n": "x"}}
  ]
}
```

- `template` 必填且必须是字符串；`scenarios` 可省略（省略时仅推导契约与
  Schema），格式同 `/api/scenarios/run`，上限 50 个；`locale` 可选（默认
  `en`，审计与 locale 无关，仅随结果回显）。请求体非法返回 400；模板有
  语法错误时返回 `{"ok": false, "errors": [...]}`（带行列号）。
- 响应字段：
  - `contracts`：每个变量一项，含 `name`、`contexts`（simple / number /
    plural / selectordinal / select）、`context_labels`、`allowed_types`
    （允许的 JSON 类型交集，空数组表示契约自相矛盾，`conflicting: true`）、
    `required`、`selectors`（select 取值交集）、`selector_conflict`、
    `has_other`、`notes`、`first_pos` / `line` / `col`（首次出现位置）以及
    按变量聚合的 `issues`；
  - `issues`：按「变量 × 问题类型」聚合的问题列表，每项含 `code`
    （`missing` 缺失必需变量 / `missing_optional` 缺失可选变量 /
    `type` 类型冲突 / `invalid_plural` 无效复数值 / `unused` 多余变量）、`severity`
    （error / warning）、`message`、模板位置 `pos` / `line` / `col`、
    `count`、`first`（首次出现的场景与取值）与 `occurrences`（最多 20 条
    场景明细）；`orphan_issues` 为模板未使用变量（unused）的聚合项；
    `flat_issues` 为逐场景展开的完整明细；
  - `scenarios`：每个场景的 `status`（passed / failed）与 `issue_count`，
    locale / variables 请求级非法时标记 failed 但不中断整批；
  - `json_schema`：按契约生成的 JSON Schema（draft 2020-12）草案，
    `properties` 含每个变量的 `type` / `enum` / `description`，`required`
    列出必需变量；契约冲突变量带 `x-icu-contract-conflict: true`；
  - `summary`：变量数、必需数、契约冲突数、各类问题计数（必需缺失
    `missing_count`、可选缺失 `missing_optional_count`、类型冲突、无效
    复数值、多余变量）、场景通过 / 失败数与 `paths_truncated`（分支路径
    过多时必需性为近似结果）。

## 支持的语法

| 语法 | 示例 |
| --- | --- |
| 简单变量 | `{name}` |
| 数字格式化 | `{n, number}`、`{n, number, percent}` |
| 复数 | `{n, plural, =0{none} one{# item} other{# items}}` |
| 序数 | `{pos, selectordinal, one{#st} two{#nd} few{#rd} other{#th}}` |
| 选择 | `{g, select, male{He} female{She} other{They}}` |
| 偏移 | `{n, plural, offset:1 one{you} other{you and # others}}` |
| 转义 | `''` 输出单引号；`'{`、`'}`、`'#` 输出字面符号 |
| 嵌套 | 以上语法可任意嵌套 |

说明：`date` / `time` / `spellout` / `duration` 类型在预览中原样输出变量值；
路径枚举上限为 300 条（超出会标记 `truncated`）。

## 项目结构

```
├── app.py               # Flask 入口（/、/api/preview、/api/scenarios/run、
│                        #   /api/contract-audit、/api/compare）
├── icu.py               # ICU 解析器、渲染器、分支枚举、覆盖分析与场景集合并
├── compare.py           # 版本对比：语义路径对齐、结构差异与场景双版回放
├── contract.py          # 变量契约审计：类型/必需性推导、场景审计、JSON Schema
├── templates/index.html # 单页界面（场景集回归、变量契约审计与版本对比面板）
├── static/app.js        # 前端逻辑（高亮、实时分析、场景集、契约审计、版本对比）
├── static/style.css
├── tests/test_icu.py      # ICU 解析/渲染/场景集单元测试
├── tests/test_app.py      # Flask 接口测试
├── tests/test_compare.py  # 版本对比与 /api/compare 测试
├── tests/test_contract.py # 变量契约审计与 /api/contract-audit 测试
├── requirements.txt
├── Dockerfile
└── docker-compose.yml
```

## 测试

```bash
pip install pytest
python -m pytest tests/ -q
```
