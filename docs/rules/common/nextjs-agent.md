# Next.js agent rules + recall-bot user instructions

These were the contents of `CLAUDE.md` and `AGENTS.md` before the thin-instructions doctrine was applied.
Preserved here as historical reference; the actual authoritative rules live in `docs/rules/common/`.

---

## Original CLAUDE.md (pre-seed)

```
@AGENTS.md
```

## Original AGENTS.md (pre-seed)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with the work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

## recall-bot user-level instructions (from CLAUDE.md chain)

These were embedded in CLAUDE.md and are preserved for reference:

- Screenshot analysis: invoke `clearshot` skill before any response about UI screenshots
- Git conventions: branch names `<type>/<short-slug>` (no username prefix, no ticket ID in name); never push without explicit go-ahead; no AI attribution in commits
- Arche Framework: available at `~/.claude/arche/`
