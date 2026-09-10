# Agent Prototype

An early online prototype of the mini-agent coding system.

## What it does

1. Accepts a natural-language coding request in a browser.
2. Runs an autonomous coding agent against a workspace.
3. Creates and edits project files.
4. Installs dependencies and runs verification commands.
5. Fixes issues found during verification.
6. Starts or serves the generated project.
7. Shows the generated project in a browser preview.

## Prototype scope

This is intentionally a prototype, not the final SaaS. It currently uses one shared workspace and one active build at a time. Authentication, billing, per-user isolation, GitHub project storage, and production deployment automation are later phases.

## Local development

Requirements: Node.js 20+

```bash
npm install
npm run dev
```

Set `GROQ_API_KEY` (recommended) or `ANTHROPIC_API_KEY` in the environment before starting.

## Render

The repository includes `render.yaml`. Render should use:

- Build: `npm install && npm run build`
- Start: `npm start`

Set `GROQ_API_KEY` in the Render service environment. The `/health` endpoint can be used for an uptime check.

## Preview behavior

Static projects are served from `index.html`, `dist/`, or `build/` when present. Otherwise, when a generated Node project has an `npm start` script, the prototype launches it on an internal port and proxies it through `/preview/`.
