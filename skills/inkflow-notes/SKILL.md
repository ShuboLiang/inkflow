---
name: inkflow-notes
description: 向 InkFlow 笔记应用写入或更新笔记。当用户说「记到 InkFlow」「保存到 InkFlow」「用 InkFlow 记笔记」「把这个写成笔记」，或要求把 Markdown/文本/总结存进 InkFlow 时使用。自动处理 Markdown 转 TipTap JSON、图片上传 Storage、文件夹（支持多级 a/b）与标签。
---

# InkFlow 笔记写入

InkFlow 是部署在 `https://kod.liangshubo.top` 的 Supabase 笔记应用（本地开发环境为 http://localhost:8000）。
笔记内容必须存 **TipTap 文档 JSON**（不是原始 Markdown/HTML），本 skill 的脚本已完成转换，优先用脚本，不要手写 REST。

## 前置条件（一次性，之后免密）

首次配置只需跑一次登录，token 会缓存到 `~/.inkflow/auth.json`，之后所有调用（包括新的 AI 会话）**不再需要账号密码**，token 过期自动用 refresh_token 续期：

```bash
INKFLOW_EMAIL=你的邮箱 INKFLOW_PASSWORD=你的密码 \
  node "$SKILL_DIR/scripts/write-note.mjs" --login
# 本地开发环境加 INKFLOW_URL=http://localhost:8000
```

建议在终端里自己跑这条命令配置，密码不经过 AI 对话。缓存按服务地址分键，本地（`http://localhost:8000`）与线上互不干扰；换账号重跑一次 `--login` 即覆盖。

没有缓存时的兜底（CI/自动化等场景，token 优先级：显式 INKFLOW_TOKEN > 缓存 > 邮箱密码）：

```bash
# 邮箱密码（用后同样写入缓存）
export INKFLOW_EMAIL=你的邮箱
export INKFLOW_PASSWORD=你的密码

# 或预签发 token
export INKFLOW_TOKEN=<access_token> INKFLOW_USER_ID=<uuid>
```

`INKFLOW_URL` 默认 `https://kod.liangshubo.top`（线上服务），指向本地开发环境时设 `http://localhost:8000`；`INKFLOW_ANON_KEY` 已内置，无需设置。

## 用法

脚本就在本文件同目录的 `scripts/write-note.mjs`（仓库内路径 `skills/inkflow-notes/scripts/write-note.mjs`）：

```bash
# 查看系统已有标签（重要：写笔记选标签前必查）
node skills/inkflow-notes/scripts/write-note.mjs --list-tags

# 新建笔记（Markdown 文件 → 笔记，--tags 只能从已有标签中挑选）
node skills/inkflow-notes/scripts/write-note.mjs --title "深度学习基础" note.md \
  --folder "课程/机器学习" --tags "游戏"

# 从标准输入读入
cat summary.md | node "$SKILL_DIR/scripts/write-note.mjs" --title "会议总结" --stdin --folder "工作"

# 搜索笔记（标题/正文/标签命中），拿 id 用于更新
node skills/inkflow-notes/scripts/write-note.mjs --find "关键词"

# 更新已有笔记（用笔记 uuid 覆盖）
node skills/inkflow-notes/scripts/write-note.mjs --title "深度学习基础(修订)" note.md --id <uuid>
```

输出：JSON `{ id, title, folder_id, updated_at }`。`id` 即笔记 uuid，更新时用。AI 更新笔记时不知道 id 就先 `--find`。

**更新语义**：`--id` 模式只覆盖显式提供的字段——没传 `--folder`/`--tags`/`--title` 时保留原值（只改正文不会把笔记移出文件夹或清空标签）；`--tags ""` 显式清空。

## 标签选择规范（严格遵守）

**生成或写入笔记时，标签【只能】从用户已存在的标签中选择，【严禁】新建标签！**

1. **先查后选**：在确定打什么标签前，先执行 `node skills/inkflow-notes/scripts/write-note.mjs --list-tags` 查看当前系统已存在的全部标签；
2. **匹配原则**：从已有标签列表中挑选与当前笔记内容最贴合的 0~3 个标签；
3. **无合适则不打标签**：如果现有标签中没有与笔记主题契合的标签，**直接不传 `--tags` 参数，不要凭空发明新标签**；
4. **脚本硬拦截**：`write-note.mjs` 底层已强制校验，任何不存在的新标签会被自动过滤剔除。

## Markdown 支持范围

脚本转换器覆盖编辑器全部常用语法：`#`/`##`/`###` 标题、`**粗体**`、`*斜体*`、`` `行内代码` ``、
` ``` ` 代码块、`- `/`1. ` 列表、`- [ ]`/`- [x]` 待办清单、GFM 表格（`| 列1 | 列2 |`，首行表头）、
`> ` 引用、`$行内公式$`、`$$块级公式$$`、`[链接](url)`。

**重点标记**（色值与编辑器色板一致，写进去可直接渲染）：
- `{{重点}}` 红色文字（最常用），`{{蓝:文字}}` 指定色文字；色名：红/橙/绿/青/蓝/紫/灰
- `==高亮==` 黄色荧光，`==红:高亮==` 指定底色；底色名：黄/红/橙/绿/青/蓝/紫

图片 `![说明](路径)`：
- `https://` 开头：原样引用
- 本地路径：自动上传到 Storage 公共桶 `images` 并替换为公共 URL
- 每个非空行是一个段落；列表/引用连续的行会合并为一个列表/引用块

`--dry-run` 只打印转换后的 TipTap JSON、不写库（调试语法用）。

## 行为约定

- `--folder` 用 `/` 分隔多级路径（如 `课程/数学`），**不存在会逐级自动创建**
- 不传 `--folder` 的**新建**笔记属于「无文件夹」，出现在「全部笔记」
- 不传 `--id` 总是**新建**笔记（不会按标题合并）；要覆盖旧笔记必须显式给 `--id`
- 更新时脚本会自动 `version + 1` 并刷新 `updated_at`，与客户端的同步冲突逻辑兼容；
  客户端打开时实时拉取，几秒内在界面上可见

## 裸 HTTP API（仅在脚本不满足需求时直接用）

认证：`POST /auth/v1/token?grant_type=password`（带 `apikey` header）→ `access_token`；
后续请求带 `apikey` + `Authorization: Bearer <token>`。

- 笔记表：`GET/POST/PATCH /rest/v1/notes`（RLS 限定本人；`content` 是 TipTap JSON）
- 文件夹：`/rest/v1/folders`（`parent_id` 支持子文件夹）
- 图片上传：`POST /storage/v1/object/images/{uuid}.png`（`x-upsert: true`），
  公共读 `GET /storage/v1/object/public/images/{uuid}.png`
- 不要直接写 `updated_at` 为旧值——同步按它做 LWW 排序

## 限制

- 客户端旧版本缓存可能导致新笔记延迟几秒显示，属正常
- 脚本不做嵌套列表/删除线/文字颜色等冷门语法（保留为纯文本）
