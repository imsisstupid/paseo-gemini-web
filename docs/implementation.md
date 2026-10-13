# Gemini Web provider implementation

The approved design connects a Paseo provider to a Google Pro account's Gemini web UI. No Gemini API keys, private endpoints, cookie extraction, or additional inference providers are used.

## Architecture

- Register a direct provider on Paseo 0.11.2 with Argon and the web app's low/medium/high settings.
- Lazily connect to the agent-scoped Paseo MCP server supplied by `session.open`. Each session owns one Gemini browser tab. The desktop browser retains the user's login.
- Select actual web controls and extract only the latest assistant response. Execute fixed commands through the resident desktop webview, because Gemini Trusted Types blocks Paseo's evaluated browser functions. Fall back to scoped accessibility snapshots only when the desktop bridge is unavailable.
- Deep Research follows the visible plan/start/report workflow. Present its research plan as a Paseo approval before starting. Never claim an unsupported model combination worked.
- Chat mode has no local tools. Read-only mode permits workspace reads. Approval mode asks before every local operation; shell approval describes the actual command. File operations remain inside the workspace, with canonical path checks.
- Persist conversation URLs and limited visible history; release connections/tabs on shutdown and cancel pending approvals.

## Implementation and verification

- [x] Browser MCP connector: real MCP protocol fixtures, structured errors, cleanup.
- [x] Gemini adapter: actual controls, response extraction, streaming completion, cancellation and research plans.
- [x] Local tools: bounded filesystem operations, traversal prevention, shell cancellation and explicit protocol parsing.
- [x] Provider: lifecycle, settings, permissions, persistence and interruption tests using a controlled browser boundary.
- [x] Typecheck and automated tests; install locally and run a real Argon message through Paseo.
- [x] Review permissions, restart behavior and unsupported states. Document tested functions and remaining limits.

The public repository contains the standalone plugin, documentation, and tests. Local dependencies, credentials, and diagnostic artifacts are excluded.

## Live integration findings

- A real Argon low-effort message returned `PASEO_COMPLETION_OK` and the Paseo agent reached idle.
- The Argon high-effort setting was verified against the web control before sending a message.
- A restored high-effort conversation requested `read_file` for this plugin's `package.json`, displayed a Paseo permission, read it only after approval, and returned its actual package name `paseo-gemini-web`.
- Background resident tabs can have response text and a completed toolbar without painting the toolbar. Completion checks therefore scope terminal DOM markers to the assistant response without depending on layout visibility.
- Gemini removes unsupported code-fence language names. Local tool messages use an explicit `protocol: "paseo_tool"` JSON field; an unmarked JSON example is never executable.
- Research selection in Korean is represented by `Deep Research 선택 해제`.
- A real Deep Research request produced the complete three-step IANA research plan in a Paseo plan approval. Research started after approval.
- Gemini renders the completed report in a separate `deep-research-immersive-panel`. The adapter requires the latest completed research card, a matching panel title, finished content, and no active generation before returning the report. It includes used sources only.
- The actual IANA report was returned through a new Paseo provider agent using `/research-result` without creating another research query: 1,456 characters, seven source links, successful terminal event.
- Live research validation covered plan approval/start in the earlier build and report recovery in the final build. The final automatic plan/start/report composition is covered by controlled browser tests; it was not rerun as a second task consuming the subscription's research quota.
- Paseo 0.11 appends non-prefix text revisions. The provider buffers rendered Markdown and publishes one final assistant message; research progress uses status notifications.
- The current automated suite has 91 passing tests, typecheck passes, and the production dependency audit reports no vulnerabilities.
- Temporary inspection plugins were removed; local diagnostic artifacts are excluded from the public repository.
