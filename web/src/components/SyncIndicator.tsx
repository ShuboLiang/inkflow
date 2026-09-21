import './SyncIndicator.css'

export type SyncStatus = 'synced' | 'editing' | 'syncing' | 'error' | 'offline'

const LABELS: Record<SyncStatus, string> = {
  synced: '已同步',
  editing: '本地编辑中',
  syncing: '同步中',
  error: '同步失败',
  offline: '离线',
}

export function SyncIndicator({ status = 'synced' }: { status?: SyncStatus }) {
  const label = LABELS[status]
  return (
    <span className="sync-indicator" data-status={status} role="status" title={label}>
      <span className="sync-indicator-dot" aria-hidden="true" />
      <span className="sync-indicator-text">{label}</span>
    </span>
  )
}
