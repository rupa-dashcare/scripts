# Working in this repo

## Always

**End every turn with one succinct question at the very bottom**, after the normal
explanation, summarising the work or naming the next step. One line, one question.
Not a menu, not a recap — the single most useful thing to decide next.

## Repo layout

Two unrelated things live here.

- `gx.sh` — a standalone bash git helper. Nothing to do with the workflow system.
- `workflow/` — the personal workflow system. Design lives in `workflow/DESIGN.md`;
  read it before changing anything structural.

## Working in `workflow/`

TypeScript, Node 20, ESM. Run from inside `workflow/`.

```
npm run check      # typecheck + architecture rules + tests — run before every commit
npm run wf -- ...  # the CLI: doctor | ingest
```

### Invariants — do not break these without changing DESIGN.md first

1. **Selection never uses an LLM.** Whether something becomes a ticket is decided by
   pure rules over explicit human triggers (a reaction, a label, a folder). Models only
   draft the title and description of items already selected.
2. **Priority and due date come from rules, not models.** A model may suggest an
   override; it goes in a comment, never the field.
3. **Jira is the only source of truth for "does this ticket exist."** Dedup is a hashed
   `srckey-*` label queried in one batch. Never add a second store for issue state — the
   KV store holds credentials and cursors only.
4. **Ingest is stateless and idempotent.** Re-running over the same window must create
   nothing new. `test/pipeline.test.ts` guards this; it is the most important test here.
5. **Agent operations must be plannable.** Every `Operation` exposes `plan()` before
   `execute(plan)`, so a write cannot skip the dry-run the user confirms.
6. **Jira access is a hard boundary.** Writes go to `RUPA` and nowhere else; reads span
   `RUPA`, `PP`, `DL` and `DEV` and nothing else. Every Jira call routes through `ProjectAccess`
   — reads are *wrapped* in a `project IN (...)` clause rather than validated, and write
   keys are checked before any HTTP call. Never add a Jira call that bypasses it.
7. **Nothing reaches a log unredacted.** All logging goes through `StructuredLogger`,
   which pipes every line through `Redactor` — there is no bypass. Redaction works by
   registered secret value *and* by credential shape, so an unknown token is still
   caught. Never `console.log` a request, header, or config object directly.
8. **The dependency rule** — `domain` imports nothing; `core` imports `domain` + `ports`;
   only `container.ts` imports `adapters`. `npm run arch` enforces it and will fail CI.

### Adding a source

A new class implementing `Source`, plus fixtures, plus one `register()` line in
`container.ts`. Nothing in `core/` should need to change.

## Conventions

- Prefer plain functions for pure logic; classes only at seams that get swapped or extended.
- Tests use the in-memory fakes in `test/fakes/`, not mocking libraries.
- Never commit credentials. `.env` is gitignored; `.env.example` documents the shape.
