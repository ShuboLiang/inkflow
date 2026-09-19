// 命令式弹框 API（与 DialogHost 组件配套，见 components/Dialog.tsx）。
// 用法：await confirmDialog({...}) / alertDialog({...}) / promptDialog({...})

export interface DialogOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** 带输入框的弹框（prompt 模式） */
  input?: { defaultValue?: string; placeholder?: string }
}

export type DialogResolver = (value: string | null) => void

export const dialogState: { current: { opts: DialogOptions; resolve: DialogResolver } | null } = {
  current: null,
}

let notify: (() => void) | null = null

export function setDialogNotifier(fn: (() => void) | null): void {
  notify = fn
}

export function openDialog(opts: DialogOptions): Promise<string | null> {
  // 已有弹框时直接取消旧的（理论上一处交互只触发一个）
  dialogState.current?.resolve(null)
  return new Promise<string | null>((resolve) => {
    dialogState.current = { opts, resolve }
    notify?.()
  })
}

export function settleDialog(value: string | null): void {
  const c = dialogState.current
  dialogState.current = null
  c?.resolve(value)
  notify?.()
}

/** 确认框：resolve(true) 表示确认 */
export function confirmDialog(opts: Omit<DialogOptions, 'input'>): Promise<boolean> {
  return openDialog({ ...opts, confirmText: opts.confirmText ?? '确定' }).then((v) => v !== null)
}

/** 提示框：单按钮 */
export function alertDialog(opts: Pick<DialogOptions, 'title' | 'message'>): Promise<void> {
  return openDialog({ ...opts, confirmText: '知道了' }).then(() => {})
}

/** 输入框：resolve 输入值；取消 resolve null */
export function promptDialog(
  opts: Omit<DialogOptions, 'input'> & { input: DialogOptions['input'] },
): Promise<string | null> {
  return openDialog({ ...opts, confirmText: opts.confirmText ?? '确定' })
}
