import { useId } from 'react'

// The app logo (same shapes as apps/desktop/app-icon.svg), colored from the live theme accent so it
// matches the New note button in light and dark.
export function Logo({ size = 24 }: { size?: number }) {
  const gradient = useId()
  return (
    <svg className="app-logo" width={size} height={size} viewBox="0 0 1024 1024" role="img" aria-label="Notes">
      <title>Notes</title>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--accent) 88%, white)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent)' }} />
        </linearGradient>
      </defs>
      <path d="M264 64H720L960 304V760Q960 960 760 960H264Q64 960 64 760V264Q64 64 264 64Z" fill={`url(#${gradient})`} />
      <path d="M720 64V244Q720 304 780 304H960Z" style={{ fill: 'color-mix(in srgb, var(--accent) 45%, white)' }} />
      <path
        d="M336 736V320L688 736V320"
        fill="none"
        stroke="#fff"
        strokeWidth={112}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
