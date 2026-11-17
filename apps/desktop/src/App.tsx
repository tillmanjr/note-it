import { useEffect, useState } from 'react'
import type { NoteStore } from '@tdjr/core'
import { openStore } from './platform'
import { Workspace } from './components/Workspace'
import './App.css'

export default function App() {
  const [store, setStore] = useState<NoteStore | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    openStore().then(setStore, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) return <div className="splash error">Could not open the note database: {error}</div>
  if (!store) return <div className="splash">Opening notes…</div>
  return <Workspace store={store} />
}
