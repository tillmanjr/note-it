import { useRef, useState } from 'react'
import type { Id, NoteStore, Notebook } from '@tdjr/core'
import { importNotes, notebookNameFromFile, readEnex, type EnexNote, type ImportReport } from '@tdjr/enex'

interface Pending {
  fileName: string
  notebookName: string
  notes: EnexNote[] | null
  error: string | null
}

type Stage = 'choose' | 'importing' | 'done'

const count = (n: number, one: string, many = `${one}s`) => n > 0 && `${n} ${n === 1 ? one : many}`

// Evernote import: pick .enex files → check target notebooks → import with progress → report.
export function ImportDialog({
  store,
  notebooks,
  onClose,
}: {
  store: NoteStore
  notebooks: Notebook[]
  /** Called when the dialog closes; `openNotebook` is the first imported notebook, if any. */
  onClose: (openNotebook: Id | null) => void
}) {
  const [stage, setStage] = useState<Stage>('choose')
  const [pending, setPending] = useState<Pending[]>([])
  const [progress, setProgress] = useState({ file: 0, done: 0, total: 0 })
  const [reports, setReports] = useState<ImportReport[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const existing = (name: string) =>
    notebooks.some((n) => n.name.localeCompare(name.trim(), undefined, { sensitivity: 'base' }) === 0)

  const addFiles = async (files: FileList | null) => {
    if (!files) return
    const added = await Promise.all(
      Array.from(files).map(async (f): Promise<Pending> => {
        try {
          return { fileName: f.name, notebookName: notebookNameFromFile(f.name), notes: readEnex(await f.text()), error: null }
        } catch (e) {
          return { fileName: f.name, notebookName: '', notes: null, error: e instanceof Error ? e.message : String(e) }
        }
      }),
    )
    setPending((prev) => [...prev.filter((p) => !added.some((a) => a.fileName === p.fileName)), ...added])
  }

  const ready = pending.filter((p) => p.notes && p.notebookName.trim())

  const run = async () => {
    setStage('importing')
    const results: ImportReport[] = []
    for (const [i, p] of ready.entries()) {
      setProgress({ file: i, done: 0, total: p.notes!.length })
      results.push(
        await importNotes(store, p.notes!, {
          notebookName: p.notebookName.trim(),
          onProgress: (done, total) => setProgress({ file: i, done, total }),
        }),
      )
    }
    setReports(results)
    setStage('done')
  }

  const close = () => onClose(stage === 'done' ? (reports[0]?.notebookId ?? null) : null)

  return (
    <div className="overlay" onMouseDown={() => stage !== 'importing' && close()}>
      <div className="dialog import-dialog" role="dialog" aria-label="Import from Evernote" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Import from Evernote</h2>
          {stage !== 'importing' && (
            <button className="close" title="Close" onClick={close}>
              ×
            </button>
          )}
        </header>

        {stage === 'choose' && (
          <>
            <p className="hint">
              In Evernote, export a notebook as <b>.enex</b>, then choose the files here. Each file goes into the notebook
              named on the right (an existing notebook with that name is reused). Importing the same file again skips notes
              that are already there.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".enex"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            {pending.length > 0 && (
              <table className="import-files">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Notes</th>
                    <th>Into notebook</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pending.map((p) => (
                    <tr key={p.fileName}>
                      <td className="file">{p.fileName}</td>
                      {p.error ? (
                        <td colSpan={2} className="error">
                          {p.error}
                        </td>
                      ) : (
                        <>
                          <td className="num">{p.notes!.length}</td>
                          <td>
                            <input
                              value={p.notebookName}
                              onChange={(e) =>
                                setPending((prev) => prev.map((x) => (x === p ? { ...x, notebookName: e.target.value } : x)))
                              }
                            />
                            {existing(p.notebookName) && <span className="badge">existing</span>}
                          </td>
                        </>
                      )}
                      <td>
                        <button title="Remove" onClick={() => setPending((prev) => prev.filter((x) => x !== p))}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <footer>
              <button onClick={() => fileInput.current?.click()}>Choose .enex files…</button>
              <span className="spacer" />
              <button className="primary" disabled={ready.length === 0} onClick={() => void run()}>
                Import {ready.reduce((n, p) => n + p.notes!.length, 0) || ''} notes
              </button>
            </footer>
          </>
        )}

        {stage === 'importing' && (
          <div className="import-progress">
            <div>
              Importing <b>{ready[progress.file]?.notebookName}</b> ({progress.file + 1} of {ready.length}) — {progress.done} /{' '}
              {progress.total} notes
            </div>
            <progress max={progress.total || 1} value={progress.done} />
          </div>
        )}

        {stage === 'done' && (
          <>
            <ul className="import-report">
              {reports.map((r) => (
                <li key={r.notebookId + r.total}>
                  <div className="report-title">
                    <b>{r.notebookName}</b>: {r.imported} imported
                    {r.skippedDuplicates > 0 && `, ${r.skippedDuplicates} already present (skipped)`}
                    {r.failed.length > 0 && <span className="error">, {r.failed.length} failed</span>}
                  </div>
                  <div className="report-details">
                    {[
                      count(r.totals.images, 'image'),
                      count(r.totals.files, 'file attachment'),
                      count(r.totals.tables, 'table'),
                      count(r.totals.checklistItems, 'checklist item'),
                      count(r.totals.encrypted, 'encrypted section') && `${count(r.totals.encrypted, 'encrypted section')} (kept locked)`,
                      count(r.totals.remoteImages, 'web image') && `${count(r.totals.remoteImages, 'web image')} still linked online`,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Text only'}
                  </div>
                  {[...r.warnings.map((w) => `${w.title}: ${w.message}`), ...r.failed.map((f) => `${f.title}: failed — ${f.error}`)].map(
                    (msg) => (
                      <div key={msg} className="report-warning">
                        ⚠ {msg}
                      </div>
                    ),
                  )}
                </li>
              ))}
            </ul>
            <footer>
              <span className="spacer" />
              <button className="primary" onClick={close}>
                Done
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
