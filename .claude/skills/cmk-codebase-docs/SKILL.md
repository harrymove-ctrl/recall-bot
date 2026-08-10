---
name: cmk:codebase-docs
description: Generate or update hierarchical, AI-navigable documentation for a codebase under `docs/ai/`. Use whenever the user asks to "document the codebase for AI", "bootstrap AI docs", "generate codebase map", "set up AI navigation docs", "update AI docs", "refresh docs after change", or mentions building progressive-disclosure docs so an AI can find the right source files quickly. Produces a tree of concise docs that *point to* code rather than duplicate it. Use even when the user only says "document this repo" without specifying the structure.
version: 0.1.0
---

# cmk-codebase-docs

This file is Claude Code's native discovery entry point. Before acting, read
`.agents/skills/cmk-codebase-docs/SKILL.md` completely and apply it.

The Claude Code adapter supplies discovery only; the shared skill carries the
guidance.
