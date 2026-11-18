import { useEffect, useState } from 'react'
import { runningInTauri } from './platform'

// Light / Dark / System. The choice is a per-device UI preference, so it lives in localStorage.
// index.html applies it before first paint; keep the storage key and resolution in step with that script.
export type ThemePref = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'tdjr.theme'
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  // Match the native title bar; null hands it back to the OS.
  if (runningInTauri) {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow().setTheme(pref === 'system' ? null : pref).catch(() => {}),
    )
  }
}

export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState(loadPref)
  useEffect(() => {
    apply(pref)
    try {
      if (pref === 'system') localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, pref)
    } catch {
      // storage unavailable: the theme still applies for this session
    }
    if (pref !== 'system') return
    const onChange = () => apply('system')
    darkQuery.addEventListener('change', onChange)
    return () => darkQuery.removeEventListener('change', onChange)
  }, [pref])
  return [pref, setPref]
}
