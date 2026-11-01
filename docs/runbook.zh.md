# 使用与运维手册（中文）

## 1. 它解决什么

对话上下文有上限，压缩（compaction）会丢掉细节，新会话从零开始，换项目后前面学到的东西带不过去。
momery 把「值得记住的东西」从上下文窗口搬到硬盘上的纯文本文件里，并给模型 9 个工具按需取回。
记忆不依赖模型本身，所以压缩、续聊、换会话、换项目都不会丢。

## 2. 装了什么

- 插件：`@momery/dsh-momery`（profile 里一行 `include:momery`，已启用）。
- 技能：`momery`（出现在技能目录里，模型需要时自动加载协议）。
- 系统提示：每次请求都带一段约 120 词的「Long-term memory (momery)」，说明存储位置和用法。
- 工具：`memory_brief` / `memory_search` / `memory_read` / `memory_write` / `memory_status` /
  `memory_end` / `memory_curate` / `memory_distill` / `memory_reindex`。
- 存储：默认 `C:\Users\Lin\.momery`（可用 `memoryRoot` 配置改）。

## 3. 日常怎么用（对用户）

正常对话即可，不需要记命令。模型会：

1. 开工前调用 `memory_brief` 取回项目卡片和相关笔记；
2. 出现决策/约束/坑/偏好时调用 `memory_write` 落盘；
3. 收尾时调用 `memory_end` 写日志并提炼笔记。

你可以直接说：

- 「把这条记下来」→ 模型用 `memory_write`。
- 「上次那个问题怎么解决的？」→ 模型用 `memory_search`。
- 「看看 download 项目里当时怎么定的」→ 模型用 `memory_search project="f-work-download"` 或 `memory_read`。
- 「这个项目记忆都有啥」→ 模型用 `memory_brief` / `memory_status`。
- 「把项目规则整理一下」→ 模型用 `memory_curate`。
- 「把日志整理成摘要」→ 模型用 `memory_distill promote=true`。

## 4. 两个整理动作

### 4.1 精炼卡片 `memory_curate`

`CARD.md` 是每个未来会话最先看到的内容，必须短且准。积累了一批决策之后（或卡片报
`CARD TRUNCATED` 时），让模型把「目的 + 常驻规则」重写一遍：

```powershell
node F:\work\momery\bin\momery.mjs curate --purpose "一句话说明这个项目为什么存在" --rules "只用 pnpm,部署到 sin,脚本兼容 5.1"
```

- 不传 `--rules` 时，会从 decision / preference / issue 类型的笔记标题自动合成一份，
  再人工删改。
- `--dry-run` 先看结果不写盘。
- 规则是「祈使句 + 仍然成立」，不是流水账；6 条左右足够。

### 4.2 蒸馏日志 `memory_distill`

journal 只增不减，长期会变吵。`memory_distill` 会：

1. 在每个月的日志末尾重写 `## Digest` 摘要脚注（每会话一行）；
2. 生成 `journal/YYYY-MM.digest.md` 完整摘要文件；
3. `promote=true` 时返回「值得升级成笔记」的候选（标题 + 要点 + 推断类型）。

```powershell
node F:\work\momery\bin\momery.mjs distill --promote
```

只把真正改变项目做法的两三条升级成笔记，其余留作历史。重复运行是安全的：只重写生成的
摘要内容，不动原始日志正文。

## 5. 命令行（不经过模型）

```powershell
node F:\work\momery\bin\momery.mjs status
node F:\work\momery\bin\momery.mjs status --all --pending
node F:\work\momery\bin\momery.mjs search "inject schema" --project all
node F:\work\momery\bin\momery.mjs brief "构建 失败"
node F:\work\momery\bin\momery.mjs read projects/f-work-momery/MEMORY.md
node F:\work\momery\bin\momery.mjs curate --purpose "..." --rules "a,b"
node F:\work\momery\bin\momery.mjs distill --promote
node F:\work\momery\bin\momery.mjs reindex
```

写入示例：

```powershell
node F:\work\momery\bin\momery.mjs write --title "部署走 Fly.io sin" --type decision --tags deploy,fly --content "## 决策`n只部署 sin 区；密钥在 fly secrets。"
node F:\work\momery\bin\momery.mjs pending --project f-work-momery --file pending.md
```

## 6. 目录结构

```
~/.momery/
  README.md                 存储说明
  index.json                项目注册表（slug、真实路径、别名、最后活跃时间）
  catalog.jsonl             每条笔记一行 JSON，给脚本/外部索引
  global/
    PREFERENCES.md          跨项目用户偏好
    LESSONS.md              跨项目经验教训
    index.md                生成的项目总览
  projects/<slug>/
    MEMORY.md               生成的索引（人/模型入口）；Purpose 与 Durable rules 两节是手写区
    CARD.md                 ≤40 行的常驻卡片（purpose/rules/pending/key notes）
    pending.md             待办
    notes/<id>.md           一条知识一个文件
    journal/YYYY-MM.md      按月分片的会话日志 + 生成的 Digest 脚注
    journal/YYYY-MM.digest.md  蒸馏后的单行摘要
```

slug 由项目根路径派生：`F:\work\momery` → `f-work-momery`。项目根取最近的
`.git` / `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` 等标记目录。

## 7. 手工维护

- 可以手改 `pending.md`、`notes/*.md`、`MEMORY.md` 的 Purpose / Durable rules 两节，
  以及 `global/*.md`。改完后调用 `memory_reindex` 重建索引。
- `MEMORY.md` 的表格、`CARD.md`、`catalog.jsonl`、`global/index.md`、`journal/*.digest.md`
  是生成物，别手改。
- 笔记 frontmatter 字段：`schema_version, id, title, type, status, scope, project,
  tags, confidence, valid_from, valid_until, created, updated, superseded_by, sources, relations`。
- 过期知识：新笔记写入时带 `supersedes=[旧id]`，旧笔记自动变 `superseded` 并从默认检索中消失。

## 8. 备份、同步、迁移

- 备份：`git init` 之后提交即可；整个存储就是一个文本目录。
- 同步：任意文件同步工具（OneDrive/Syncthing/git）。多人多机请用 git，避免同名冲突。
- 迁移：把目录拷到新机器，设置 `MOMERY_ROOT` 或插件 `memoryRoot` 指向它。
- 忘记某个项目：直接删 `projects/<slug>` 目录，然后 `memory_reindex`。

## 9. 让其他工具也能读到记忆

存储是纯文本，别的编码代理直接读文件即可。推荐在每个项目根放一个 `AGENTS.md`
（Claude Code 用 `CLAUDE.md`），内容例如：

```markdown
## 长期记忆
本项目的历史决策、约束、坑与待办在 `~/.momery/projects/<slug>/`：
先读 MEMORY.md，再按需读 notes/。新结论写回 notes/ 后在会话结束更新 pending.md。
```

也可以直接 `@` 引用具体笔记文件。

## 10. 常见问题

- **记忆为空？** 新项目第一次 `memory_brief` 才注册；没用过就没有。用 `memory_write` 播种。
- **搜不到？** 换关键词，或先 `memory_brief` 看卡片；中文用 2 字词更稳。
- **CARD.md 出现 `CARD TRUNCATED`？** 待办或规则太长了。跑 `memory_curate`，精简 `pending.md`，
  归档旧笔记，再 `memory_reindex`。
- **规则过时了？** 直接 `memory_curate --rules "..."` 覆盖，旧规则不会残留。
- **日志太长？** `memory_distill`；原始日志仍保留，摘要只是新增文件与脚注。
- **两个会话同时写？** 写操作有文件锁（30 秒过期、60 秒超时），不会互相覆盖；极端情况下会报
  `memory store is locked by another writer`，稍后重试即可。
- **想换存储位置？** 在 profile 的 `cordis.patch.yml` 给 `momery` 行加 `memoryRoot: D:\memory`，
  或设置环境变量 `MOMERY_ROOT`。

## 11. 设计边界

- 不存密钥、个人隐私、整份文件内容；只存结论与线索。
- 词法检索，不做向量；标题写成断言、标签写成检索把手，比换检索引擎更有效。
- 跨项目读取是显式动作（`project="all"` 或指定 slug），默认不注入，避免别的仓库文本变成注入源。
- 精炼与蒸馏是**有判断的动作**：工具负责机械部分（写回、生成、摘要），取舍仍由模型/人决定。