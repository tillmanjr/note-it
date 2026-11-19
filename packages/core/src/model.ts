// Data model shared by every client (and mirrored by the server in 2c).
// IDs are ULIDs; timestamps are UTC milliseconds; deletion is soft (trash).

export type Id = string

export interface Notebook {
  id: Id
  name: string
  sort: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface Tag {
  id: Id
  parentId: Id | null
  name: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface NoteMeta {
  id: Id
  notebookId: Id
  title: string
  /** Start of the plain-text body, for the note list. */
  snippet: string
  tagIds: Id[]
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface Attachment {
  /** SHA-256 of the content, hex. Content-addressed, so identical files are stored once. */
  hash: string
  mime: string
  size: number
  filename: string
  createdAt: number
}

export type NoteSort = 'updated' | 'created' | 'title'

/** Live notes per notebook and per tag (tags include their sub-tags), and in all. */
export interface NoteCounts {
  all: number
  notebooks: Record<Id, number>
  tags: Record<Id, number>
}

export interface NoteQuery {
  notebookId?: Id
  /** Matches notes tagged with this tag or any descendant tag. */
  tagId?: Id
  /** Full-text search over title and body (prefix match per word). */
  text?: string
  /** true: only trashed notes; default: only live notes. */
  trash?: boolean
  sort?: NoteSort
  limit?: number
}

/** Reference used inside note bodies for attachments, e.g. an image `src`. */
export const ATTACHMENT_SCHEME = 'attachment:'
export const attachmentRef = (hash: string) => `${ATTACHMENT_SCHEME}${hash}`
export const parseAttachmentRef = (src: string): string | null =>
  src.startsWith(ATTACHMENT_SCHEME) ? src.slice(ATTACHMENT_SCHEME.length) : null
