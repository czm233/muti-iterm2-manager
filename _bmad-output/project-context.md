---
project_name: 'muti-iterm2-manager'
user_name: 'czm'
date: '2026-03-09'
sections_completed: ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'quality_rules', 'workflow_rules', 'anti_patterns']
status: 'complete'
rule_count: 18
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

- Python `>=3.9`
- FastAPI `>=0.115.0`
- Uvicorn `>=0.30.0`
- Pydantic `>=2.8.0`
- `iterm2` Python API
- `pyobjc-framework-Cocoa` on macOS only
- Frontend is plain `HTML/CSS/JS` served as static assets
- Runtime mode selected by `MITERM_BACKEND=auto|iterm2|mock`

## Critical Implementation Rules

### Language-Specific Rules

- Keep Python file and symbol organization consistent with current `snake_case` style.
- Use `dataclass` for internal runtime models; use Pydantic models only for FastAPI request validation.
- Keep business orchestration out of route handlers; put it in `DashboardService`.
- Prefer `async` flows end-to-end for terminal operations, refresh, broadcast, and monitoring.
- Preserve current lightweight in-memory architecture unless a requirement explicitly asks for persistence.

### Framework-Specific Rules

- `server.py` should stay thin: parse requests, map exceptions, and return serialized data.
- `service.py` is the single orchestration center for terminal lifecycle, monitoring, and event broadcasting.
- Any terminal implementation must go through the `TerminalBackend` abstraction; do not bypass it from routes or services.
- Maintain WebSocket event compatibility with existing event types: `snapshot`, `terminal-updated`, `workspace-mode`, `monitor-layout`.
- Static frontend assets are served directly by FastAPI; do not introduce a separate frontend build pipeline unless explicitly requested.

### Testing Rules

- Current repo has no established test suite; prefer adding focused tests only where low-coupling coverage is practical.
- Best test targets are `analyzer.py`, `display.py`, and `service.py` with `MockTerminalBackend`.
- Avoid adding brittle tests that depend on a real iTerm2 instance unless the requirement explicitly asks for integration coverage.

### Code Quality & Style Rules

- Keep changes minimal and aligned with the current compact project structure.
- Reuse existing models, service methods, and backend hooks instead of introducing parallel abstractions.
- Preserve response shapes already consumed by `static/app.js`.
- Do not upgrade the frontend into React/Vite or another framework unless explicitly required.
- Keep comments and docs concise; prioritize code clarity over explanatory noise.

### Development Workflow Rules

- Follow the delivery process documented in `docs/development-workflow.md`.
- Use `./stop.sh` and `./start.sh` for formal local delivery flow.
- Prefer `MITERM_BACKEND=mock` for safe local UI or workflow verification when real iTerm2 is not necessary.
- Treat this project as a local macOS tool, not a general cross-platform service.

### Critical Don't-Miss Rules

- Do not assume cross-platform support; real backend behavior depends on macOS + iTerm2 authorization.
- Do not assume terminal windows still exist; user may manually close them, and code must handle missing window/session errors gracefully.
- `apply_grid_layout()` currently broadcasts monitor layout metadata; it does not fully reposition real windows by itself.
- Terminal status detection is keyword-based; do not silently replace it with a more complex state machine unless requested.
- Preserve the distinction between real backend and mock backend behavior when adding new features.

---

## Usage Guidelines

**For AI Agents:**

- Read this file before implementing any code.
- Follow all rules exactly as documented.
- When in doubt, prefer the more restrictive option.
- Update this file if new project-specific patterns emerge.

**For Humans:**

- Keep this file lean and focused on agent needs.
- Update it when the technology stack or implementation patterns change.
- Remove rules that become obvious or obsolete.

Last Updated: 2026-03-09
