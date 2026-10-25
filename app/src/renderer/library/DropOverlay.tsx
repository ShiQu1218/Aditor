import { i18n } from '../i18n'

/** Full-page drop overlay, shown when files are dragged into the library. */
export function DropOverlay({ show }: { show: boolean }): JSX.Element | null {
  if (!show) return null
  return (
    <div className="drop-overlay show" aria-hidden="true">
      <div>
        {i18n.library.drop.title}
        <br />
        <span className="drop-sub">{i18n.library.drop.desc}</span>
      </div>
    </div>
  )
}
