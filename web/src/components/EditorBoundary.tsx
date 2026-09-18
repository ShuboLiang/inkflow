import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

// 编辑器区域错误边界：任何渲染异常（如公式渲染、同步覆盖）不应拖垮整个页面
export class EditorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('editor crashed', error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', fontFamily: 'var(--font-ui)' }}>
            <p style={{ color: 'var(--ink-900)' }}>编辑器出错了，内容没有丢失。</p>
            <button
              type="button"
              style={{ color: 'var(--qing)', border: '1px solid var(--ink-200)', borderRadius: 6, padding: '6px 14px', background: 'none', cursor: 'pointer' }}
              onClick={() => this.setState({ hasError: false })}
            >
              重新加载编辑器
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
