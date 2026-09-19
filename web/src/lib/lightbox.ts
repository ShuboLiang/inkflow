// 图片点击看大图：纯 DOM 轻量浮层，编辑器与分享页共用。
// 点击图片 → 全屏浮层按原图显示；点浮层或按 Esc 关闭。

export function openImageLightbox(src: string): void {
  if (document.querySelector('.img-lightbox')) return
  const overlay = document.createElement('div')
  overlay.className = 'img-lightbox'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', '查看大图')

  const img = document.createElement('img')
  img.src = src
  img.alt = '大图'
  overlay.appendChild(img)
  document.body.appendChild(overlay)

  const close = () => {
    window.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  overlay.addEventListener('click', close)
  window.addEventListener('keydown', onKey)
}
