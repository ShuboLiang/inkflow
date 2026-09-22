import { Component, type ReactNode } from 'react'
import './EditorBoundary.css'

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
        <div className="editor-boundary">
          <div className="editor-boundary-box">
            <p className="editor-boundary-text">编辑器出错了，内容没有丢失。</p>
            <button
              type="button"
              className="editor-boundary-retry"
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
