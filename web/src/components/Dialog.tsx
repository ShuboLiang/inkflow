import { useEffect, useRef, useState } from 'react'
import { dialogState, setDialogNotifier, settleDialog, type DialogOptions } from '../lib/dialog'
import './Dialog.css'

// 统一设计的模态弹框（替代 window.confirm/alert/prompt）。
// 命令式 API 在 lib/dialog.ts：confirmDialog / alertDialog / promptDialog；
// <DialogHost /> 挂在应用根部（App），同一时间只处理一个弹框。

export function DialogHost() {
  const [, force] = useState(0)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setDialogNotifier(() => {
      setValue(dialogState.current?.opts.input?.defaultValue ?? '')
      force((n) => n + 1)
    })
    return () => setDialogNotifier(null)
  }, [])

  const opts: DialogOptions | undefined = dialogState.current?.opts
  useEffect(() => {
    if (!opts) return
    if (opts.input) inputRef.current?.focus()
    else confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settleDialog(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [opts])

  if (!opts) return null

  const isAlert = !opts.input && opts.confirmText === '知道了' && !opts.cancelText

  return (
    <div
      className="dlg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settleDialog(null)
      }}
    >
      <div className="dlg-card" role="alertdialog" aria-modal="true" aria-label={opts.title ?? '提示'}>
        {opts.title && <h2 className="dlg-title">{opts.title}</h2>}
        <p className="dlg-message">{opts.message}</p>
        {opts.input && (
          <input
            ref={inputRef}
            className="dlg-input"
            value={value}
            placeholder={opts.input.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') settleDialog(value)
              if (e.key === 'Escape') settleDialog(null)
            }}
          />
        )}
        <div className="dlg-actions">
          {!isAlert && (
            <button type="button" className="dlg-btn" onClick={() => settleDialog(null)}>
              {opts.cancelText ?? '取消'}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={opts.danger ? 'dlg-btn primary danger' : 'dlg-btn primary'}
            onClick={() => settleDialog(opts.input ? value : '')}
          >
            {opts.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
