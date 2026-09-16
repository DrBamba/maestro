import { useEffect, type ReactNode } from 'react'

interface ModalProps {
  onClose: () => void
  width: number
  align?: 'center' | 'top'
  children: ReactNode
  /** Dialogs get padding and gaps; the palette manages its own. */
  padded?: boolean
  label: string
}

export default function Modal({
  onClose,
  width,
  align = 'center',
  padded = true,
  label,
  children
}: ModalProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={`scrim scrim--${align}`} onMouseDown={onClose}>
      <div
        className={`modal${padded ? ' modal--dialog' : ''}`}
        style={{ width, maxWidth: 'calc(100vw - 80px)' }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  )
}
