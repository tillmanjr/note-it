# Tag paths, editing and moving

Decided with the user on 2026-11-22. Tags are hierarchical (each has an optional parent); a path like `Ingredients/Lemons` names a tag by its parents.

## Decisions

| Area | Decision |
|---|---|
| Renaming in the tag list | The edit box holds the tag's **full path**, with its own name selected. The edited path is where the tag goes: the tag keeps its notes and sub-tags, and missing parents are created. Top-level `Foo` → `Foo/Bar` makes it `Bar` under a new `Foo`; `Ingredients/Lemons` → `Fruit/Citrus/Lemons` moves it; `Lemons` alone moves it to the top level. The parent path is looked up without the tag itself, which is what makes `Foo` → `Foo/Bar` create a new `Foo`. |
| Moving | Also by drag and drop in the tag list (mouse and pen): drop on a tag to put it under that tag, or on the Tags heading for the top level. On touch screens a press-and-move scrolls the list, so the path edit is how to move a tag there. Pointer events, not HTML drag and drop, which the desktop webview reserves for dropped files. |
| Landing on an existing tag | Asks first, then **merges**: notes tagged with either keep the surviving tag, sub-tags are combined (merging again where names match), and the moved tag is deleted. |
| Tags on a note | Clicking a tag chip makes it an editable path. The edited path replaces that tag **on this note only** (created if new); the tag itself isn't renamed. Example: pick `Ingredients`, click its chip, add `/Grapes`. |
| Add Tag box | **Tab** completes the highlighted suggestion to its path plus `/`, ready for a sub-tag: `Ingr` → Tab → `Ingredients/` → `Grapes`. Enter still adds the highlighted tag as it is. |

Names compare case-insensitively everywhere (`sameTagName`). The store calls are `relocateTag(id, path)`, `moveTag(id, parentId)` and `mergeTag(source, target)`. The first two report a `conflict` instead of merging unless asked to (`{ merge: true }`), so the app can confirm first.
