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
  const set = (id: string, open: boolean) =>
    setCollapsed((prev) => {
      if (prev.has(id) !== open) return prev
      const next = new Set(prev)
      if (open) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // storage unavailable: state still works for this session
      }
      return next
    })
  return {
    isCollapsed: (id: string) => collapsed.has(id),
    toggle: (id: string) => set(id, collapsed.has(id)),
    expand: (id: string) => set(id, true),
  }
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
      <div className="section-head" onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}>
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
