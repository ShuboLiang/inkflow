# InkFlow 同步引擎的已知限制

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
