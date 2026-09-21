// 主题注册表：id 对应 <html data-theme="…">（默认主题不设属性，落在 tokens.css 的 :root）。
// 名称与描述显示在侧栏的主题选择器上。

export interface ThemeDef {
  id: string
  name: string
  desc: string
  /** 选择器色卡用：该主题的纸面色与强调色（展示用副本，令牌真身在 themes.css） */
  paper: string
  accent: string
}

export const THEMES: ThemeDef[] = [
  { id: 'ink', name: '青墨', desc: '宣纸青墨，本色', paper: '#f8f9f7', accent: '#1f6f6b' },
  { id: 'zhujian', name: '朱笺', desc: '朱批眉注，仿宋成文', paper: '#faf6ec', accent: '#a83226' },
  { id: 'qianyin', name: '铅印', desc: '宋体铅字，方角刊本', paper: '#f6f4ee', accent: '#33526e' },
  { id: 'dengxia', name: '灯下', desc: '青灯黄卷，夜读之色', paper: '#151a20', accent: '#e3b05f' },
  { id: 'niupizhi', name: '牛皮纸', desc: '牛皮纸面，钢笔手账', paper: '#d3bc90', accent: '#2f6ba8' },
]

export const DEFAULT_THEME = 'ink'
const STORAGE_KEY = 'inkflow:theme'

export function isValidTheme(id: string | null | undefined): id is string {
  return !!id && THEMES.some((t) => t.id === id)
}

/** 只把主题写到 <html> 上（不落 localStorage）：启动期避免闪白用 */
export function setThemeAttr(id: string) {
  if (isValidTheme(id) && id !== DEFAULT_THEME) document.documentElement.dataset.theme = id
  else delete document.documentElement.dataset.theme
}

/** 本机是否已选过主题（用于决定登录后要不要采纳云端主题） */
export function storedTheme(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isValidTheme(v) ? v : null
  } catch {
    return null
  }
}

/** 切换主题：更新 <html> 并记住在本机 */
export function applyTheme(id: string) {
  setThemeAttr(id)
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {}
}
