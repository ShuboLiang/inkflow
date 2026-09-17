import './Sidebar.css'

interface SidebarProps {
  email: string
  collapsed: boolean
  onSignOut: () => void
}

export function Sidebar({ email, collapsed, onSignOut }: SidebarProps) {
  return (
    <nav className={collapsed ? 'sidebar collapsed' : 'sidebar'} aria-label="侧栏">
      <div className="sidebar-brand">InkFlow</div>
      <button type="button" className="sidebar-item active">
        全部笔记
      </button>
      <div className="sidebar-section">文件夹</div>
      <div className="sidebar-empty">暂无文件夹</div>
      <div className="sidebar-section">标签</div>
      <div className="sidebar-empty">暂无标签</div>
      <div className="sidebar-footer">
        <span className="sidebar-email" title={email}>
          {email}
        </span>
        <button type="button" className="sidebar-signout" onClick={onSignOut}>
          退出登录
        </button>
      </div>
    </nav>
  )
}
