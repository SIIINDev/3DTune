
<!-- BEGIN project-map-protocol -->
## Project map — read this before exploring the codebase

A pre-built map of this repository lives at `~/.claude/graph/<repo-dir-name>.json`.
Read it **first**. It exists so you do not spend tokens re-discovering the
structure on every session.

```bash
cat ~/.claude/graph/$(basename "$PWD").json
```

### What is inside

| Key | Meaning |
|-----|---------|
| `nodes` | Modules, not files: `id`, `label`, `type`, `files`, one-sentence `summary`, `activity` (edit count) |
| `edges` | Verified relationships only — `imports`, `calls`, `configures`, `writes`, `reads` |
| `decisions` | Why things were built this way. Not recoverable from code. |
| `history` | The owner's own commits: `what` (subject), `why` (body), `files` |

### How to use it

1. Read the map to decide **where** to look.
2. Open the actual files before changing anything or making a claim about behaviour.

**The map tells you WHERE to look, never WHAT the code says.** A `summary` is a
prior interpretation and may be stale. Never state how the code behaves, and never
edit, based on the map alone — the file on disk is the only authority.

Nodes whose summary reads `unclear — not yet analysed` were deliberately not
determined. Treat that as unknown, not as "nothing there".

### Keeping it current

A hook appends a line to `~/.claude/graph/<slug>.stale` on every file edit.

If that file exists when you start:
- Say how many edits accumulated since the map was last built.
- If the structure changed (files added/removed/moved, new module, new dependency),
  update the map, then delete the `.stale` file.
- Cosmetic edits do not require a rebuild.

After finishing a substantive piece of work:
- Add or adjust the affected `nodes` and `edges`.
- Append to `decisions` if you chose an approach over an alternative — record the
  rejected option and the reason, since the code will only ever show the winner.
- Only add an edge you actually verified in the source. A plausible-looking
  dependency you did not confirm is worse than a missing one.
- Update `updated` to the current timestamp.

Do not rebuild the whole map after every edit — it is expensive and unnecessary.
Update at the boundary of a completed task.
<!-- END project-map-protocol -->
