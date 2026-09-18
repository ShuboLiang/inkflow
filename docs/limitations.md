# InkFlow 同步引擎的已知限制

## 未决 bug：页面偶发完全卡死

用户报告"插入/点击块级公式后页面冻结、无报错"。自动化（playwright-core + 系统 Chrome，
无头/有头均试）覆盖以下路径均未复现：点击公式、拖拽选中经过行内/块级公式（正向/反向/
按住 5s/30s 高强度交替）、拖拽节点本身、撤销重做、长文档、dev/prod 构建。

已排除的方向：
- ProseMirror MutationObserver 回环（NodeView 无 contentDOM 时 PM 默认忽略非 selection 突变）
- useEditorState selector 新引用导致无限重渲染（v3 默认 deepEqual）
- setContent → onUpdate 回环（v3 setContent 默认不发 update）
- push/pull 同步回环（回声按 version 过滤，编辑中笔记跳过）
- 纯公式文档（仅 blockMath、含/不含尾部段落）的正/反向拖拽、按住 5s、拖后 Delete/
  Backspace/打字替换、Ctrl+A、点空白定位——自动化全部无卡死
- 尾部段落保护微任务已审查：会终止（插入后 lastChild 变为段落）；已加固为执行时
  重新读取文档末尾并 try/catch 兜底
- handleShellClick 在纯块级节点文档上 setTextSelection 可能抛错：已加 try/catch +
  Selection.atEnd 兜底
- **math 节点 HTML5 拖放（dnd）路径**：PM 对 `node.type.spec.draggable` 的 atom 节点
  支持拖放重排，自动化无法完全复刻真实鼠标 dnd，该路径嫌疑最大但未能实证。
  已按确定性修复处理：InlineMath/BlockMath 均设 `draggable: false`（PM 不再给节点
  dom 加 draggable 属性、不进入 dnd 分支），公式只能选中、换位用剪切粘贴。

重要环境发现：长驻 dev server 的 Vite 模块图/HMR 多次被证实过期——供给过期的
transform（缺 import、缺 export），运行期抛 ReferenceError 或白屏。用户复现卡死时
极可能跑的是这种半更新状态。**任何"页面卡死"反馈第一步先确认：重启 dev server +
硬刷新后是否还能复现。**

已装监控（2026-09）：`web/src/lib/diagnostics.ts` 收集 error/unhandledrejection/
长任务(>500ms)/rAF 冻结(>3s)，严重事件落 localStorage（`inkflow:diagnostics`），
顶栏有"复制诊断"按钮可导出 JSON。下次卡死时请用户：若页面还能动，点"复制诊断"；
若完全卡死，重开页面后点"复制诊断"（持久化数据还在），把 JSON 发给开发者。

## 背景

同步采用 LWW（Last-Write-Wins）策略：本地 Dexie 为唯一事实来源，dirty=1 的笔记定时推送到
Supabase；pull 按 `updated_at > lastSyncAt` 增量合并；版本号（version）用于检测跨设备冲突。

## 已修复：打字内容丢失（2026-09）

根因是两个叠加的竞态：

1. push 在网络往返期间不清点本地新输入，结束后无条件清 dirty，导致新内容不再被推送；
2. 自己 push 的 realtime 回声触发 pull，用推送时的旧快照覆盖本地 Dexie，编辑器
   `setContent` 回滚了用户正在输入的内容。

修复：`syncEngine.setActiveEdit` 登记正在编辑的笔记，pull 永远跳过它；push 清 dirty 前
校验 updatedAt 是否还是同一"代"；版本一致的干净行视为回声直接跳过；编辑器聚焦时（含
IME 组合输入）不应用外部内容，失焦再对齐。

## 剩余风险

- **LWW 与并发编辑的根本冲突**：两台设备同时编辑同一篇笔记时，后同步的一方会覆盖另一方。
  正在编辑的笔记本地优先（服务器版本留底到 note_versions），不编辑的笔记服务器优先。
  内容本身不丢（败方都进 note_versions），但合并靠人工。根本解法是 CRDT（如 Yjs）或 OT，
  属于架构级改造。
- **正在编辑的笔记收不到远端更新**：打开期间其他设备对它的修改会被 pull 跳过，直到切换
  笔记。若需要实时协同，必须上 CRDT。
- **时钟偏移**：`updated_at` 由写入方本地时钟产生，设备时钟差较大时增量 pull 的
  `updated_at > lastSyncAt` 边界可能漏拉或重拉。可改为服务器触发器统一盖 `now()`。
- **version 是客户端递增**：恶意或 bug 客户端可以伪造 version 压制他人数据。严肃场景应在
  服务器端用触发器/函数做版本裁决。
- **note_versions 只增不减**：需要保留策略或定期清理任务。
- **Realtime 断线无显式重订阅**：断线期间的变更靠恢复后的 online 事件和增量 pull 兜底，
  长连接静默死亡（未触发 offline 事件）时会有延迟。
- ** IME 保护以焦点为界**：编辑器失焦瞬间正好有远端覆盖到达时，setContent 仍会重置
  光标（不丢内容，只丢光标位置）。

## 选区异常（"选不中文字"）的真相

用户录屏的"选区自动扩张/坍缩、高亮偏移"经逐帧复现确认为**浏览器原生选词/选段模式**
（连续快速点击+拖拽同一位置触发：双击选词、三击选段、拖拽按词/段粒度扩展）。
在纯 vanilla contenteditable（无 TipTap、无任何应用代码）上以相同操作序列复现了
逐位一致的行为，与应用无关。唯一的应用侧问题（拖拽结束后选区被空白点击定位
坍缩）已通过 handleShellClick 的拖拽阈值（>5px 不干预）修复。
