import './EmptyState.css'

export function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state-ink" aria-hidden="true">
        <span className="empty-state-ripple" />
        <span className="empty-state-ripple" />
        <span className="empty-state-ripple" />
      </div>
      <p className="empty-state-title">从一滴墨开始</p>
      <p className="empty-state-sub">选择左侧笔记，或新建一篇</p>
    </div>
  )
}
