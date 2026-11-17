import { useState, type ReactNode } from 'react'

const STORAGE_KEY = 'tdjr.collapsedSections'

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/** Which left-pane sections are collapsed, remembered per device (a UI convenience only). */
export function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // storage unavailable: state still works for this session
      }
      return next
    })
  return { isCollapsed: (id: string) => collapsed.has(id), toggle }
}

export function Section({
  title,
  collapsed,
  onToggle,
  actions,
  className = '',
  children,
}: {
  title: ReactNode
  collapsed: boolean
  onToggle: () => void
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`pane-section ${className} ${collapsed ? 'collapsed' : ''}`}>
      <div className="section-head" onClick={onToggle}>
        <span className="chevron">{collapsed ? '▸' : '▾'}</span>
        <span className="section-title">{title}</span>
        {actions && (
          <span className="section-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {!collapsed && <div className="section-body">{children}</div>}
    </section>
  )
}
