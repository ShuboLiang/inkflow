import './SyncIndicator.css'

export type SyncStatus = 'synced' | 'editing'

const LABELS: Record<SyncStatus, string> = {
  synced: '已同步',
  editing: '本地编辑中',
}

export function SyncIndicator({ status = 'synced' }: { status?: SyncStatus }) {
  return (
    <span className="sync-indicator" data-status={status} role="status">
      <span className="sync-indicator-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  )
}
