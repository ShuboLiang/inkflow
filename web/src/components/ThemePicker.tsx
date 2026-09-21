import { THEMES } from '../lib/theme'
import './ThemePicker.css'

// 侧栏底部的主题选择器：一排「纸面 / 强调色」对开的圆色卡，点击即换全站皮肤
export function ThemePicker({ theme, onChange }: { theme: string; onChange: (id: string) => void }) {
  return (
    <div className="theme-picker">
      <span className="theme-picker-label">主题</span>
      <div className="theme-picker-swatches">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={theme === t.id ? 'theme-swatch active' : 'theme-swatch'}
            style={{ background: `linear-gradient(135deg, ${t.paper} 50%, ${t.accent} 50%)` }}
            title={`${t.name}：${t.desc}`}
            aria-label={`主题 ${t.name}`}
            aria-pressed={theme === t.id}
            onClick={() => onChange(t.id)}
          />
        ))}
      </div>
    </div>
  )
}
