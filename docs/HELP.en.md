# Sage User Guide (English)

2026-10-05 · 0.6.849

<a id="overview"></a>

# What is Sage

Sage is a project-based desktop AI workspace: chat, file editing, tool calls and plugins are organized around a project folder. Data is stored in the project's `.sage/` directory by default, which keeps backup and migration simple.

## Getting started
1. Add a project folder; it appears in the sidebar with its conversations.
2. Configure a model provider or a CLI engine plugin in Settings (see "Models and backends" and "CLI engine plugins").
3. Start a conversation and describe your goal. Direct API is the only built-in engine.

## Layout
The sidebar manages projects, conversations and plugin entries; tabs open conversations, files and plugin pages; the status bar shows the run mode and usage. Open this help any time via Settings → About → Sage Help and search by feature name or question.

## Related topics
- First-run setup
- Models and backends
- Plugin list and activation scope

<a id="onboarding"></a>

# First-run setup

The new setup guide starts by asking how you want to connect. Sage requires a direct API connection or an installed, enabled and configured CLI engine plugin. A relay supplies authorized models through the API engine. The guide never fills credentials, submits token applications or sends chat messages for you.

## Connect a relay
1. Choose Yes, use a relay. Enter the full connection address supplied by its operator.
2. Answer whether you have a token. Paste an existing token, or click Apply beside the Token field, apply on the relay website, and return with your token. Apply appears only when the application page is reachable and Token is empty; otherwise check the address or contact the operator.
3. Click Connect and wait for Connected. If the completed fields connected automatically, continue.
4. In model settings, wait for the relay provider and authorized models to appear automatically. Initial synchronization can take a little while. Connected does not mean synchronized. If no models appear, check the token’s model permissions instead of adding a duplicate relay provider.
5. Relay capability data is reused, so local verification is usually unnecessary. Continue to global models. Skip vision for now if no confirmed vision model is available.

## Configure a direct provider
1. Decline relay setup and choose to configure a model provider. Click Add provider or select an existing regular API provider.
2. Enter its name and API Host, confirm the API protocol (OpenAI Chat Completions or Anthropic Messages), then enter the API Key. Use the full API base URL from the vendor’s documentation, retaining /v1 or other required paths. Do not use the website homepage. Click + if no key input row exists.
3. Click Test connection. Returned model IDs are saved automatically. If model enumeration is unsupported, enter exact IDs manually: click Edit in the model list, type each ID and press Enter, then click Done.
4. An empty list differs from a failed connection. For an empty list, check account model permissions or enter IDs manually. For authentication or network errors, correct the configuration and retry; failure is not successful setup.
5. Click View model capability verification, then Retry all unverified capabilities. Verification sends real requests to the provider; wait for this run to finish. Continue immediately if none remain. If some stay unknown, review and retry them or choose models with confirmed capabilities. Unknown does not mean supported.

## Choose global models
- Global default model: the main model for conversations, reasoning and tools. Projects and chats inherit it unless they override it. Choose one that supports chat and tool use.
- Global vision model: reads images and screenshots, including when the main model cannot handle images directly. Only confirmed vision models appear in the selector. One model can serve both roles; vision setup can be skipped for now.
- Wait for autosave before continuing. If saving fails, retry in Settings before treating setup as complete.

## CLI or independent exploration
Choose Use a CLI plugin to install an engine from the plugin marketplace and enable it globally. Follow its instructions to install the CLI and sign in or configure its API. Confirm CLI detection and authentication, then select the engine in General. The plugin manages its models and credentials; API global models are not required for this route. Explore on my own closes the guide.

## Conversations and Help
Choose a project folder and click + beside Conversations, or use New conversation in the guide. Compose your request and send it yourself. Open Help using the ? button at the bottom-left. Describe a question directly in the search field, such as “How do I add a model?” Help searches local documentation without making a model call.

## Display and recovery
This is guide version 2. New users and users who only saw the old guide see it automatically once. Afterward, ordinary app upgrades do not repeat it. Reopen it in Settings → General → Getting started · New. Close at any time, go back, or use Show this step to return to its setting. Existing configuration is preserved. Explicitly choosing an API route switches the backend to Direct API.

## Related topics
- What is Sage
- Relay connection and deployment
- Models and backends
- CLI engine plugins

<a id="chat-intro"></a>

# Chat, queue and resend

Chats accept text, images and attachments; new messages can queue while execution is running.

## Send and interject
The composer shows send, newline and interjection shortcuts. An interjection can add instructions between tool calls, while a queued message waits for its turn.

## Resend
Resending a failed reply replaces that turn's question and failed response to avoid duplicate bubbles. A running turn cannot start twice.

## Attachment limits
Settings → Conversations configures the per-image limit (default 5 MB) and text-file inline limit (default 1 MB). Oversized images are rejected; oversized text files fall back to path-only.


## Limits
Completed side effects (commands, writes, network requests) are not guaranteed to replay safely. Check actual results before resending.


## Before sending
Check project, conversation, model and policy. Compose text and optionally attach images, file references or capability selectors. Typed and dictated text remain drafts until sent. During execution use the displayed queue/interjection controls instead of assuming repeated clicks confirm distinct runs.

## Editing and resending
Confirm where execution will resume before editing a historical user message. Resending may repeat model and tool calls. Changes already written to files or external services are not automatically undone by message editing. Inspect existing results and state what is already complete.

## Drafts and attachments
Drafts follow their conversations when switching. Removing an attachment removes pending content. After send failure inspect both the error and message state before retrying work with external side effects.

## Related topics
- Tools and approval
- Resume after interruption
- Context Window & Compaction Strategy

<a id="chat-search"></a>

# Conversation full-text search

As conversations accumulate, use the search box at the top of Settings → Conversations to search across all of them; both active and archived groups match.

## Search scope
Three layers are covered: conversation titles, message bodies and conversation memories. Result rows badge which layer matched so you can judge whether to open them.

## Follow-up actions
From the results you can configure conversation memory, copy a conversation ID, archive or unarchive, and delete.

## Related topics
- Chat, queue and resend
- Long-term memory and auto-merge
- History and log cleanup

<a id="chat-experts"></a>

# Experts and execution plans

The project manager decomposes work and schedules experts according to task dependencies.

## Execution modes
The picker at the bottom-left of the composer offers Auto, Agent and Expert team. Auto decides when you send the first message: requests mentioning the expert team or team collaboration, delegation cues (assign people, dispatch, divide work, convene), or naming an expert member or role (project manager, including custom names) go to the Expert team; so do requests packing several engineering actions (implement, refactor, fix, design) into one sentence; questions and small single tasks stay with the Agent.

## Mode locking
After sending, the picker shows and locks the mode actually used, and reopening the chat restores that mode. The mode only applies to the first message.

## Plan view and completion
The execution-plan button above the composer shows progress and status. Hover a task name to expand its details and collapse others. Interrupted work is shown as resumable; only running work spins. After all tasks finish, the floating plan closes after a short grace period; reopening a completed chat does not replay the completion popup.

## Custom experts and parallelism
Settings → Conversations lets you create, edit or delete expert roles: name, icon and system prompt are all customizable, and AI can assist generation. Built-in roles restore with one click. Parallelism controls how many experts run concurrently; the default adapts to provider type (official API 3, third-party 2), or set 1–8 manually.


## Related topics
- Chat, queue and resend
- Resume after interruption
- Tools and approval

<a id="chat-resume"></a>

# Resume after interruption

Reopen the app and use Continue execution for an unfinished plan.

## Avoid unnecessary repetition
Completed tasks are preserved. Verify interrupted results and continue the remaining tasks. A resumed task replaces its earlier execution card.

## Limits
Execution does not continue after the app exits. This is not process-level checkpoint restoration: an interrupted command may have partially completed, so inspect files and external effects before retrying.

## Related topics
- Experts and execution plans
- Chat, queue and resend
- Scheduled tasks

<a id="chat-tools"></a>

# Tools and approval

Before the model reads or writes files or runs commands, each tool call passes through security rules and then, depending on policy, AI or human review.

## Decision order
Explicit denials take precedence; direct-allow rules may skip ordinary approval. Failed, timed-out or uncertain AI reviews fall back to a person. Full access is a separate, broader mode.

## Inspect reasons
Filter decision history by project, chat, policy and stage to see matched rules and reasons (see "History and log cleanup" for retention).

## Limits
Approval does not guarantee successful execution: runtime restrictions can still reject an operation.

## Related topics
- Security policies and filesystem sandbox
- Keep sandbox, approve networking separately
- History and log cleanup

<a id="chat-capabilities"></a>

# Choose skills, plugins and MCP in chat

The Skills, plugins & MCP button lists capabilities available to the current project without requiring you to memorize tool names.

## Steps
1. Open the picker and filter All, Skills, Plugins or MCP.
2. Search names, descriptions or sources. Sources distinguish similarly named tools.
3. Select an item to insert its selector at the cursor. Existing draft text and attachments remain.
4. Add the objective, scope, inputs and desired result, then send.

For example, choose a reporting skill and add “Review only this project's commits from this week and produce Markdown.” Selection does not call a tool, send a message or grant permission.

## Capability types
A skill is an on-demand instruction document. A plugin tool is a service method declared tool:true. MCP tools are discovered from enabled servers. Disabled packages/servers and plugin methods not exposed as tools are excluded.

## Empty or incomplete lists
Check the project, skill scope, effective plugin activation and MCP connection test. Refresh re-discovers MCP tools. A failed server does not hide working sources; unavailable sources are listed separately. Refresh never submits the draft.

## Engines and approvals
This catalogue follows Sage's API conversation toolchain. CLI availability depends on the engine bridge. Sending still applies file, network, plugin and approval checks. Selecting a capability does not authorize every future action.

<a id="context-strategy"></a>

# Context Window & Compaction Strategy

Long conversations exceed the model's context window. Before each send, Sage automatically "compacts" the context: it evicts old turns and, when needed, condenses the evicted content into a summary so the request stays within the window. Two switches control the compaction strength and the summary quality.

## Context Compression Mode (strength)

Controls how much recent history is kept and how early compaction triggers.

- Auto (default): picks one of the three presets below from the current turn's size and tool-call count. Short or writing-heavy content leans conservative; long content leans balanced; very long or tool-heavy content leans aggressive.
- Conservative: cap ~160k tokens, keeps the last 5 turns. Best for large-window models and long discussions needing full recall; costs bigger, pricier, slower requests.
- Balanced: cap ~120k tokens, keeps the last 3 turns. The everyday sweet spot (fallback when unset).
- Aggressive: cap ~80k tokens, keeps the last 2 turns. For very long conversations or small-window / low-budget models; loses early detail sooner.

Explicit limits win: if a fixed window (e.g. 200K tokens) is set in the conversation context panel or settings, that value takes precedence; the mode only affects kept turns and trigger timing.

## Summary Generation Strategy (quality)

Controls how evicted old turns are condensed.

- Auto (default): uses the configured model to summarize a turn only when it exceeds 4,000 characters; otherwise truncates. Falls back to truncation if the model call fails. Balances quality and cost.
- Simple Truncation (fast): keeps only the head snippet. Fastest and spends no model tokens; loses the semantics of the truncated part.
- LLM Smart Summary (more accurate): always condenses evicted content with the model. Best semantic retention; spends extra tokens and time on every compaction.

## How to choose

- Want zero fuss: keep both on Auto; covers most scenarios.
- Long coding / tool-heavy work, afraid of losing detail: Conservative + LLM Smart Summary.
- Small model / save tokens / want speed: Aggressive + Simple Truncation.
- Writing / long-form discussion: Conservative or Auto mode with Auto summary.

## Reviewing compaction records

Both the context panel (grid icon in the composer) and Settings → Context Window open "Compaction Records", listing each compaction's trigger (automatic/manual), mode, summary strategy and before/after token counts, so you can judge whether the current configuration fits.

## Related topics
- Chat, queue and resend
- Long-term memory and auto-merge
- Request monitor and debug links

<a id="model-providers"></a>

# Models and backends

Add Anthropic or OpenAI-compatible providers with an endpoint, credentials and models.

## Model selection
Choose global defaults or project/chat-specific models. A vision model can preprocess images for a text-only model; inspect the request monitor if preprocessing fails.

## Test connection
When models are configured, "Test connection" really calls the first model in the list (one minimal completion request) and the verdict is based on that call. With no model configured it can only check endpoint connectivity, which does not prove any model works. A service without model enumeration (404 from the list endpoint) does not affect the real call test.

## CLI engines
CLIs connect through plugins: install the CLI engine plugin under Settings → Global → Plugins, enable it globally, then select the engine in General settings. A CLI needs a local installation and login; see "CLI engine plugins".

## Model capability verification
Double-click a model in settings to probe capabilities such as vision, web search, reasoning and tool use. Automatic probes run when idle; manual probes run immediately. Results are summarized per model with per-capability status, history and a price chart.



## Configuration appears ineffective
Check conversation overrides, then project overrides, then the global default and actual execution engine. Use the provider's exact model ID. Connection success does not prove every model, tool or image capability works; test the capabilities you need.

## No output or rate limiting
Inspect status, model, stage and error in the request monitor. For 401/403 check credentials and permissions; for 429 check quota/rate limits; for timeouts check connectivity and service health. Do not paste API keys into public help requests. CLI login and API provider credentials are separate configurations.

## Models and settings in mobile conversations

In the mobile conversation's “+ → Model and reasoning effort”, “Use project / global default” shows the inherited provider, model name and source. Restoring the default keeps inheritance instead of pinning the parent's current model. Composite and routed providers show their configured public model name; downstream members are still selected per request.

Matching desktop and mobile version 0.6.849 lets you change the model, reasoning effort and conversation security profile while a reply runs. Saved changes apply to the next turn, including the next queued message. The current reply, tools, interjection continuations and expert tasks keep their starting settings. Full access still requires confirmation. Older desktops remain read-only during execution and explain the upgrade; the relay forwards existing operations and does not need a simultaneous upgrade.

## Related topics
- Composite providers and model mappings
- CLI engine plugins
- Request monitor and debug links

<a id="model-composite"></a>

# Composite providers and model mappings

Composite providers map available models to underlying providers for unified selection.

## Time-based model switching
A mapping can use `public-model=member-model|active windows|fallback-model`, for example `qwen3.8-flash=qwen3.8-flash|22:00-08:00|qwen3.7-plus`. The member model is used during the configured windows; at other times Sage routes to the fallback model from any enabled provider that supports it. Without the third field, the mapping remains unavailable outside its configured windows. Multiple windows are comma-separated and use the local clock.

## Check mappings
Enable the destination provider and verify its model before saving a mapping. Inspect the actual model and errors in the request monitor when calls fail. A display name is not necessarily a server model identifier.

## Related topics
- Models and backends
- Request monitor and debug links

<a id="editor-intro"></a>

# File editing and opening inside Sage

Supported files such as Markdown and HTML open in app tabs.

## Edit and preview
The editor offers source and supported previews; read-only documents cannot be saved as edits. Verify the file path before saving.

## Web links
When the browser plugin is installed and enabled for the project, supported web links prefer its browser tab; otherwise they use the system browser.

## Default view and line numbers
Settings → Appearance → Editor chooses whether Markdown opens as source or preview (also switchable per file) and whether line numbers are shown.



## Saving and conflicts
Save with Cmd/Ctrl + S and confirm the unsaved indicator clears. Historical Git blobs and read-only generated content cannot directly overwrite project files; open the working file to edit it. Compare disk changes before saving when another process edited the file.

## Missing files
Check project and directory filters. Hiding a directory affects display and search, not deletion or model authorization. Reads outside the project remain subject to the security policy.

## Related topics
- File syntax checking
- Selected text and context actions
- Built-in browser

<a id="editor-syntax"></a>

# File syntax checking

Files are checked automatically when opened. The result appears as a warning badge next to the file name in the info bar (the number is the error count). Hover or keyboard-focus the badge to expand the error list; click an entry to jump to that line. Editing re-checks after a short debounce.

## Coverage
JSON/JSONC, YAML, XML/SVG and JS/TS (including JSX/TSX) are supported. Very large files (around 2MB and above) are skipped; each format reports at most 20 issues.

## Limits
This checks only whether the content parses; it is not type checking or linting. Unsupported formats (such as PHP or Java) show no badge, which does not make them valid.

## Related topics
- File editing and opening inside Sage
- Selected text and context actions

<a id="editor-ctxmenu"></a>

# Selected text and context actions

Select text and use available context-menu actions such as copy, translation or chat operations.

## Scope
Actions depend on the editor, preview or conversation surface. Text sent to a model becomes request context; avoid including unnecessary sensitive material.

## Related topics
- File editing and opening inside Sage
- File syntax checking

<a id="plugins"></a>

# Plugin development and loading

Plugins package tools, views, skills and lifecycle handlers. Installation and effective activation are separate: an installed package is not necessarily running in the current project.

## Install and use
1. Open Settings → Plugins → Plugin packages and choose an offline bundle, marketplace entry or development directory.
2. Review package identity, version, dependencies and permissions in the installation plan.
3. Enable globally or only for the current project.
4. Open Configure and fill required fields. Secret settings are global only.
5. Use contributed sidebar, toolbar or tab entries. Search conversational tools through Skills, plugins & MCP in the composer.

## Development directories
A directory needs sage.plugin.json and its declared entry file. Start, stop and reload development mode as code changes. Reload after manifest changes and review permissions again: adding a declaration does not silently grant a previously installed package new permissions. Keep source outside the installation cache.

## Built-in and external modules
Git and Browser are always available host modules. They cannot be disabled or uninstalled and no longer have a sidebar quick-button setting. Workspace sections still support collapse/expand. Specs, Docs and CLI engines are separate packages governed by installation and activation.

## Troubleshooting
Missing entry: check project, effective activation, dependencies, visible/when and the exact slot name.
Missing method: names must exist in both the manifest and globalThis.sagePlugin.services.
Permission denied: inspect granted permissions, not only declarations, and review through installation again.
Service failure: inspect service, method, duration and error in plugin logs; validate both input and output schemas.

## Related topics
- Plugin list and activation scope
- Extension development: a minimal plugin
- Extension development: services and permissions
- Extension Points and Skill Packages

## Runtime and persistent state
Idle plugin runtimes may be reclaimed and recreated on the next call. Active calls and development sessions are protected. Use sdk.settings for durable state rather than relying on globals. If the runtime limit is reached, retry after active calls finish.

<a id="plugin-activation"></a>

# Plugin list and activation scope

Global activation is the default for projects. A project override applies only to that project; Follow global removes the override.

## Three states
| Layer | Meaning | Where |
| --- | --- | --- |
| Installed | A validated package is stored locally | Settings → Plugins → Plugin packages |
| Global activation | Default availability across projects | Global enable control |
| Project override | Explicit enable or disable here | Project configuration; Follow global restores inheritance |

The manifest scope (global, project or both) determines configurable scopes. Git and Browser remain enabled regardless of legacy disabling settings.

## Configuration precedence
Global fields affect all projects. Project fields affect the current project. Fields supporting both prefer a project override. Restoring inheritance is different from saving an empty string: the former falls back, while the latter can be an explicit empty value. A save error means persistence is not confirmed.

## Cannot enable a package
Check missing dependencies, required versions, host dependencies and granted permissions. Install and activate dependencies first. Disabling removes the package's services, skills and subscriptions from effective project capabilities; refresh the conversation picker when necessary.

## Remove and restore
Stop dependent workflows before uninstalling. Reinstallation does not prove every previous project override was restored; inspect effective activation and configuration again. Disable temporarily when removal is unnecessary.

<a id="plugin-market"></a>

# Plugin marketplace

After configuring a marketplace URL (or using a relay connection) in Settings → Plugins, the install section of the plugin workbench shows the marketplace list with category filters and keyword search for one-click online installation. Offline package installation remains available without a marketplace.

## Using it
1. Open Settings → Plugins and configure the marketplace URL or relay connection (see "Relay connection and deployment").
2. Open the plugin workbench and browse or search the marketplace section.
3. Click Install; manage activation under "Plugin list and activation scope".

## Limits
The marketplace is only a distribution channel: activation scope and permission constraints are identical to offline-installed plugins. When the marketplace is unreachable its section is hidden; offline installation is unaffected.

## Related topics
- Plugin development and loading
- Plugin list and activation scope
- Relay connection and deployment

<a id="extension-platform"></a>

# Extension Points and Skill Packages

Load an extension project under plugin development. Context strategies appear in the compression-mode selector; model routers can be added under Models. Git colors follow Git activation.

## Skills
Skills support offline Markdown/packages, marketplace installation, scaffolds, development reload, export with dependencies and marketplace submission. Existing skill directories remain supported. The online marketplace needs a marketplace URL or relay.

## Browser acceptance
Install the bundled browser acceptance skill, enable Browser and the skill package, and configure a vision model. It uses actual screenshots, DOM checks, desktop/mobile viewports and integrated project tabs. A missing vision model cannot produce a visual pass.

## MCP
STDIO and Streamable HTTP support JSON import previews, connection tests and configured-server plugin APIs. Imported servers start disabled. Full contracts are documented in the SDK EXTENSIBILITY.md.

## Related topics
- Skills
- Plugin marketplace
- Hooks (hook slots)
- CLI engine plugins

<a id="dev-quickstart"></a>

# Extension development: a minimal plugin

This guide targets package format 1 and SDK 1.4. Ordinary plugins run as isolated services, without direct Electron, Node filesystem or host-page DOM access.

## Create a project
1. Use the plugin development area to scaffold or select an independent directory.
2. Put sage.plugin.json at its root, plugin.js as the entry, views under views/ and skills under skills/.
3. Choose a unique namespaced id such as local.hello and an x.y.z package version.
4. Load, review validation and permissions, start development mode and enable for the project.

## Minimal runnable files
This example requests no extra permissions and exposes a chat tool and toolbar action. The toolbar reports completion; call hello.greet in chat to display the returned string.

```json
{
  "format": 1,
  "id": "local.hello",
  "name": "Hello",
  "version": "1.0.0",
  "sdk": "^1.4.0",
  "entry": "plugin.js",
  "permissions": [],
  "services": {
    "hello": {
      "version": "1.0.0",
      "methods": {
        "greet": {
          "description": "Return a greeting",
          "input": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          },
          "output": {
            "type": "string"
          },
          "tool": true
        }
      }
    }
  },
  "contributes": [
    {
      "id": "hello",
      "slot": "toolbar",
      "title": "Hello",
      "service": "hello",
      "method": "greet"
    }
  ]
}
```

plugin.js:
```javascript
globalThis.sagePlugin = {
  services: {
    hello: { greet: async () => 'Hello from Sage' }
  }
};
```

## Verify incrementally
First load successfully. Search local.hello in the conversation picker and ask to call it and show the result. Change the string, reload and verify the new result. Stop development mode, export a .sageplugin and test import without the development directory.

## Common errors
Invalid JSON, wrong entry paths, missing method implementations and mismatched output schemas cause validation or invocation failures. A description is not a schema. Add and verify one method at a time.

## Reference files
The repository's docs/plugin-examples/local.notes includes settings and a view. resources/plugin-sdk/sage-sdk.d.ts provides types. Continue with docs/PLUGIN_MANUAL.md, EXTENSION_COOKBOOK.md and PLUGIN_EXTENSION_CATALOG.md.

<a id="dev-services"></a>

# Extension development: services and permissions

The services manifest is the stable interface, and JavaScript implements matching names. Chat tools, buttons and hooks reuse these methods.

## Input and output
Declare description, input and output; set tool:true for conversational exposure. Supported schema types are object, array, string, number, integer, boolean and null, with properties, required, additionalProperties, items, enum, length and numeric bounds. This is a bounded subset, not full JSON Schema; unsupported keywords fail package validation.

Prefer additionalProperties:false and explicit required fields/limits. Await persistence before returning. Throw on failure rather than returning success unconditionally from a catch block.

## Host services
Use sdk.host(service, method, args) and declare required permissions. Host-validated examples include workspace.read/write, git.status/commit, browser.list/open and channels.list/send. Consult packaged types and the current API reference for exact arguments; do not invent service names.

Ordinary packages cannot directly require('fs') or run arbitrary shell code. The controlled tools.Bash host service retains standard approval and runtime sandbox checks. Package permission is not unrestricted operating-system access.

## Cross-plugin dependencies
Use sdk.call with consumes and compatible dependency versions. Explain missing required dependencies; degrade gracefully for optional ones. Git/Browser belong in hostDependencies rather than installable-package dependencies.

## Settings and secrets
Use sdk.settings.get/set for declared settings. Scope precedence matches the client. Secrets support global scope only. Do not hardcode credentials in manifests, skills, HTML or logs. Routing extensions return provider/model references, not API keys.

## Acceptance checks
Cover valid input, missing/extra fields, oversized values, wrong types, missing permissions, disabled dependencies, service exceptions and reactivation. Verify real writes/sends only against authorized test destinations.

<a id="dev-ui"></a>

# Extension development: UI slots and context

contributes declares an entry, service methods execute actions, and view opens a sandboxed plugin page. A slot does not grant access to conversation bodies or arbitrary DOM.

## Supported slots
| Area | Names |
| --- | --- |
| Title bar | titlebar.left, titlebar.right |
| Sidebar and pages | sidebar.middle, sidebar.bottom, sidebar.tabs, tab, panel, menu |
| Common/status | toolbar, status |
| Conversation | conversation, conversation.input, conversation.header, conversation.actions |
| Scheduled tasks | scheduled.toolbar, scheduled.task |
| Help | help.toolbar |
| Toolbars | editor.toolbar, git.toolbar, browser.toolbar |
| Settings | settings, settings.navigation, settings.models, settings.context, settings.appearance, settings.appearance.colors, settings.skills, settings.mcp |

## Context-aware slots
conversation.header appears above the composer and conversation.actions in its action bar. Both pass {context:{conversationId}} to service actions. scheduled.task passes {context:{taskId}} and help.toolbar passes {context:{topicId}}. scheduled.toolbar passes an empty object. Existing slots retain their argument contract.

These are identifiers only: no message bodies, attachments, credentials or task configuration, and no permission bypass. A view entry opens its declared page without automatically injecting this context into the iframe. Use service/method for context-aware actions.

## Service button example
```json
{
  "id": "inspectTask",
  "slot": "scheduled.task",
  "title": "Inspect task",
  "service": "taskActions",
  "method": "inspect",
  "when": "project",
  "order": 100
}
```
Its input schema must accept context.taskId as a string, and output must match the actual result. Do not reject context in the schema while targeting this slot.

## Interaction behavior
While running, duplicate clicks are disabled. Errors and completion are visible. Present detailed results through the plugin's own view, notification or returned content. Use action-oriented titles, short badges and order for sorting. Feedback from old project requests is ignored, and disabling removes the entry.

## Page safety
Pages use the bridge to call their own services rather than manipulating host DOM. Do not depend on remote scripts, inline event attributes or Node globals. Follow theme colors and support narrow windows, keyboard focus and readable errors. Start from the complete UI bridge example.

<a id="dev-lifecycle"></a>

# Extension development: hooks, events and strategies

Decide whether the extension makes a decision, receives a notification, supplies an algorithm or adds a UI entry before choosing its declaration.

## Four mechanisms
| Need | Declaration | Result |
| --- | --- | --- |
| Affect execution decisions | hooks | Interpreted by the hook protocol |
| Receive host notifications | events | Bounded notification, not new authorization |
| Supply selectable functionality | extensions / extensionPoints | Versioned schema-checked dispatch |
| Add user controls | contributes | Buttons or plugin views |

## Hooks
Request hooks.respond and bind an event to your own service method. matcher narrows handling, order controls ordering and timeoutMs bounds waiting. Use the packaged types and catalogue for supported events. Legacy hooks.json does not execute. Avoid long human interaction inside a hook; diagnose timeout, exception and invalid output separately.

## Events
Host events include sage/workspace.opened, sage/settings.changed, sage/git.committed, sage/browser.created, sage/browser.navigated, sage/browser.closed, sage/engine.started and sage/engine.finished. Subscribers remain permission-bound. A notification is not permission to send messages or delete data.

## Strategies
sage/context.compact returns a summary and retention count with context.transform permission. sage/models.route returns providerId/modelId with models.use. Declare a compatible version, schemas and service method, then select the implementation in the relevant settings. Merely declaring a strategy does not replace the default.

## Debugging and compatibility
Test absent/multiple subscribers, incompatible versions, missing permission, disabling, timeout, exceptions and invalid results. Inspect call chains for cycles. Preserve existing fields in compatible updates; version breaking protocols explicitly rather than expecting old callers to guess.

<a id="dev-release"></a>

# Extension development: debug, package and upgrade

Source directories, running development instances and installed packages are distinct. When a change appears ineffective, identify which copy is active first.

## Development loop
Edit → validate → load/reload → enable for the target project → invoke → inspect logs. Review changed permissions. Across windows, verify project configuration; global installation does not imply equal effective activation.

## Conversational development
The Plugin tool supports scaffold, inspect, dev-start, dev-stop, package and validate. Specify the directory and id. Do not write source into host installation caches. Development operations remain within the current project. Export does not execute third-party package scripts and does not silently overwrite an existing output file.

## Package acceptance
1. Increment the plugin version and inspect manifest, entry, views, skills and type references.
2. Export with required dependencies and install into a clean project.
3. Verify persisted configuration, deactivate/reactivate, removal of entries on uninstall and reinstall behavior.
4. Cover empty values, errors, timeout, offline behavior, narrow windows, light/dark themes and both languages.
5. Use explicit test destinations for writes, messages and network requests, then verify actual results.

## Upgrades and permissions
Old installations do not silently acquire new permissions. Review the update plan. Confirm the active package digest/version after changing contents. Fix incompatible dependencies rather than bypassing validation.

## Release documentation
Include purpose, install/configure steps, permission explanations, limitations, troubleshooting, changelog and reproducible examples. Maintain source documentation in docs/; SDK copies are distribution artifacts rather than competing sources.

<a id="skills"></a>

# Skills

Skills are reusable Markdown knowledge packages: the model reads them when a task matches, like attaching a manual to a conversation. Skills install standalone or ship inside plugin packages.

## Install and scope
Settings → Skills manages global skills (all projects); the skills page in project settings manages project-level skills (current project only). A project skill of the same name wins. Offline Markdown/package installation, marketplace installation, scaffolds and development-folder loading are supported.

## Activation dependencies
A skill can declare host dependencies: the browser acceptance skill, for example, requires the Browser host module first. With an unmet dependency the checkbox shows "Enable first: …" and stays disabled.

## In conversations
Skills use progressive disclosure: the name and description enter the conversation context first; the body is read by the model through the Skill/Plugin tool when needed — nothing to paste manually. A skill body is capped at 128KB and its description at 200 characters.


## Write a plain skill
Place a Markdown file in the project's .sage/skills/ directory or use skill installation in Settings. Start with YAML metadata:
```markdown
---
name: review-release
description: Review the current release and produce an acceptance checklist
---
# Release review
Read project instructions, confirm scope, then verify build and test results.
```
The description should state when to use it; the body should define inputs, steps, outputs and failure handling. A project skill overrides a global skill of the same name. Duplicate plugin names resolve deterministically to the first available entry; use unique names. The picker shows the source.

## Instructions are not authorization
Skills do not automatically expand file, network or plugin permissions. Required services must still be configured. Store credentials in secret settings, not Markdown. Refresh the catalogue after changes and send a clear new request.

## Related topics
- Extension Points and Skill Packages
- Plugin list and activation scope
- Built-in browser

<a id="hooks"></a>

# Hooks (hook slots)

Declare hooks in manifest.hooks and grant hooks.respond. Legacy hooks.json execution and the separate hook settings page have been removed. Existing files are not read, executed or deleted.

## Management
Manage activation in Settings → Plugins → Plugin packages. Disabling a plugin stops its subscriptions.

## Four extension conventions
Hooks affect pipeline decisions; events are notifications; extensions provide strategies; contributes adds UI entries. See the plugin developer manual and docs/PLUGIN_EXTENSION_CATALOG.md.

## Related topics
- Extension Points and Skill Packages
- Plugin development and loading
- Tools and approval

<a id="mcp-servers"></a>

# MCP server management

Settings → MCP manages external tool servers with STDIO and Streamable HTTP transports.

## Encrypted environment variables
Enter secret values under “Encrypted MCP environment variables” on the server list page. Values are encrypted in local settings; the renderer only receives variable names and protected placeholders. Secrets are used for MCP requests only and are not injected into terminals or other child processes. The HTTP Bearer field references a variable by name.

## Adding servers
STDIO requires a command, arguments, environment variables and working directory. HTTP requires a URL, bearer-token env var name and headers. JSON import adds servers in bulk (imported as disabled). Names must be unique.

## Test connection
Test establishes a real session and pulls the tool list, showing available tool count and names.

## Automatic loading in conversations
Sage connects to enabled servers and caches their tool catalogues in the background after startup or an MCP settings change. API conversations use the cached catalogue directly. Disabled servers are excluded, failed connections are skipped, and tool calls still follow the existing approval rules.

## Enable and export
Each server can be enabled or disabled independently. Export produces a secret-free JSON template for sharing configuration.

## Limits
Imported servers start disabled and must be enabled manually. MCP template exports omit secret environment values; encrypted settings backups protect them. Full contracts are documented in the SDK EXTENSIBILITY.md.


## From configuration to a callable tool
1. For STDIO use an existing executable, separate arguments correctly and verify the working directory and dependencies.
2. For HTTP use the actual MCP endpoint, not a website URL. The token field names an environment variable; do not put secrets in descriptions.
3. Save, test, inspect discovered tool names and enable.
4. Search the server in the conversation picker and refresh if missing.

## Cache and recovery
Catalogues are reused to reduce send latency. Background refresh retries failed sources; the picker can force discovery. Changing an endpoint/environment or disabling a server prevents stale calls from silently targeting the changed configuration.

## Common failures
Executable missing: verify the full path in a terminal; GUI applications may not inherit your shell PATH.
Timeout: inspect service availability, proxy, certificate and endpoint.
Connected with zero tools: confirm tools/list support; a server may expose only resources or prompts.
Execution failure: discovery success does not validate every argument or permission. Read the tool result. MCP output is data, not additional user authorization.

## Related topics
- Extension Points and Skill Packages
- Plugin development and loading
- Tools and approval

<a id="engine-plugins"></a>

# CLI engine plugins

Install a CLI engine under Settings → Global → Plugins, enable it globally, then select it in General settings. Claude/Codex do not ship in the DMG. Missing or disabled plugins cannot launch a CLI.

## Security boundary
Development is managed globally with an explicit test project. Native engine adapters execute local code: review the source and engine.native permission. Ordinary UI plugins remain sandboxed.

## Extending
Create a CLI engine plugin and implement Engine API v1 to add another CLI without host changes. See the plugin manual for cancellation and tool approval requirements.

## Related topics
- Plugin development and loading
- Models and backends
- Tools and approval

<a id="browser-plugin"></a>

# Built-in browser

Browser is a Sage host module: once installed and enabled for a project, web links prefer in-app tabs; otherwise they go to the system browser. Host modules can be disabled but not uninstalled separately.

## Blank page and navigation
The new-tab blank page aggregates local-port chips (one click opens a local dev server) and bookmarks. The address bar accepts URLs, file:// addresses and local absolute paths.

## Bookmarks
Manage bookmarks from the browser menu: add the current page, edit name and address, and delete. Bookmarks live in app data and work across projects.

## Limits
Embedded rendering is independent of the system browser. If a specific site has compatibility issues, open it in the system browser instead.

## Related topics
- File editing and opening inside Sage
- Skills (browser acceptance skill)
- Plugin list and activation scope

<a id="git-plugin"></a>

# Git sidebar

Git discovers repositories in the current project and its child directories. Git and Browser are always available. Confirm the repository path before changing branches, the index or a remote.

## Changes to a commit
1. Open working changes and select a file to inspect its diff.
2. Stage selected or Stage all. Staging prepares a commit; it does not push.
3. Unstage preserves working files and removes their changes from the index, including before the repository's first commit.
4. Enter a message and Commit staged changes. Only the index is committed; unstaged changes remain.
5. A failed commit retains the message and shows an error. Check conflicts, author identity and hooks before retrying.

## Fetch, Pull and Push
| Operation | Effect | Important detail |
| --- | --- | --- |
| Fetch | Downloads objects, updates remote tracking refs and prunes deleted refs | Does not switch or merge the working branch |
| Pull | Fetches and fast-forwards the current branch | ff-only rejects diverged history |
| Push | Uploads commits to the configured remote/upstream | First publication asks for a remote and sets upstream |

Only one mutation runs per repository at a time, including worktrees sharing a Git directory. Progress disables duplicate actions. Relevant lists refresh after either success or failure.

## Branches and tags
Double-click or use the branch context menu to switch. Track a remote branch locally; create, rename or delete local branches; set or remove upstreams. Context actions also merge, rebase, fast-forward and create tags. Local deletion requires Git's merged-history checks; deleting a remote branch really changes the remote.

A history-row menu creates a branch from a commit or checks out that commit. Leave the checkout name empty to detach HEAD; enter a name to continue on a new branch. In-app dialogs can be cancelled without mutating the repository.

## History and files
Focus history on a ref, search or page through commits, inspect parents, changed files and historical trees. Historical text opens read-only; images can be previewed. Viewing historical files never overwrites working files. Hover truncated refs for their complete names.

## Configuration
Settings → Plugins → Git controls scan interval, branch prefix, force-with-lease and commit-message guidance. Prefixes apply to new names without a namespace; existing prefixes or names containing / are not prefixed again. Enable forced pushes only for an intended history-rewriting workflow. First publication uses a normal push.

## Related topics
- Git troubleshooting and conflict recovery
- File editing and in-app opening
- Terminal panel

<a id="git-recovery"></a>

# Git troubleshooting and conflict recovery

Read the error and confirm the repository and branch before retrying. Repeated clicks or forced pushes do not resolve the underlying cause.

## Pull rejected
No upstream: publish the branch to a chosen remote or configure an existing upstream in the branch menu.
Cannot fast-forward: both histories have commits. Fetch, compare and explicitly choose merge or rebase. Sage's Pull does not silently choose a strategy.
Local changes would be overwritten: commit the intended changes or use your stash workflow in the terminal. Switching never automatically discards files.

## Push failed
Check the remote URL, connectivity, SSH agent or credential helper. Sage does not wait for a password in an invisible terminal; configure authentication in the terminal and retry.
A non-fast-forward rejection means remote history is missing locally. Fetch and integrate first. Do not enable force merely to silence the error. force-with-lease is not a backup, and server-side branch protection can still reject it.
For detached HEAD, create a local branch from that commit before publishing.

## Merge or rebase conflicts
1. Open working changes and inspect both sides of each conflict.
2. Keep the intended result in the editor, remove conflict markers and save.
3. Stage the resolutions and ensure no conflicts remain.
4. Commit a merge result; use Continue rebase for a rebase.
5. Use Abort merge or Abort rebase to stop. Git restores the operation's earlier state; inspect its warning when complex pre-existing changes make recovery uncertain.

## Wrong repository or stale history
Check the project and selected child repository, then refresh. Background scans use cached data for quick switching; manual refresh re-reads it. A repository does not need a remote named origin. A newly initialized repository has no history until the first commit.

## Commit failed
For missing author identity, configure user.name and user.email for this repository in the terminal. Fix failed hooks from their output; Sage does not bypass hooks. Empty messages are rejected and unstaged files are not automatically committed.

## Verify results
In the matching repository terminal inspect git status, git branch -vv, git remote -v and git log --oneline --decorate -10. Do not publish credential-bearing output.

<a id="project-wiki"></a>

# Project Wiki and DeepWiki

Docs is a Sage plugin: once installed and enabled for a project, a docs/wiki tab appears in the sidebar. It generates project Wiki documents and embeds DeepWiki viewing.

## Generating a Wiki
Pick a depth and create: generation streams and can be stopped at any time. The result is a Markdown document with table-of-contents navigation and Mermaid diagrams. Regenerate or delete and retry when the result disappoints.

## Reading and troubleshooting
Click a TOC entry to jump to its section. When generation fails, check the model configuration and errors in the request monitor.

## Related topics
- Plugin list and activation scope
- Models and backends
- Request monitor and debug links

<a id="terminal-panel"></a>

# Terminal panel

The terminal panel provides multi-tab terminals inside the app. Each tab has its own PTY process with theme-matched colors and adjustable font size.

## Open and close
Ctrl/Cmd+` toggles the terminal panel. The tab bar supports creating, closing individual and closing all terminals. Scrollback history is preserved when switching tabs.

## Theme and font size
Terminal colors (background, foreground, cursor, selection) follow the app theme automatically. Font size follows Settings → Appearance code font size and applies immediately.

## Limits
Terminal processes end when the window closes and are not shared across windows. An exited process shows its exit code in the tab.

## Related topics
- Keyboard shortcuts
- File editing and opening inside Sage
- Security policies and filesystem sandbox

<a id="desktop-pet"></a>

# Desktop pet

The desktop pet is an independent transparent overlay. Drag it within a display's visible work area to start project chats with text or voice and read replies or background notifications.

## Enable and configure
Open Settings → General → Desktop Pet. The enable switch, appearance and chat mode are grouped together and save automatically. Choose Pixel cat, Comic cat, Pixel dog or Comic dog; the pet's context menu also switches appearance. Appearance Off hides the image while keeping the small launcher visible. Turn off Desktop Pet to hide both.

The default chat mode keeps an ongoing conversation for the same project during the current pet session. Changing projects creates a new conversation. New conversation each time starts one for every message.

## Text and voice
1. Move near the pet to reveal the edit and voice buttons. Click edit to expand the input; use the plus button to choose a recent project.
2. Type and press Enter or click Send. Select a project before sending. Replies appear in bubbles; open the main window for full content.
3. Click voice to record. The button becomes a black dot; click it to stop. A transcript with a selected project sends automatically. Without a project, the transcript remains for review and project selection. The pet uses the client's microphone, recognition service and input device settings.
4. Escape returns to the small launcher. Leaving hides the tools after about 300 ms while preserving the draft, project and recording session. Move back to continue. With appearance Off, the launcher and expanded input remain visible.

## Side and corner peeking
Drag to the visible work-area edge to leave only the head and paws showing. At any of the four corners, the head and paws peek diagonally toward the desktop interior. The pet blinks while waiting and nods gently when the pointer approaches. Each visit triggers one greeting; staying nearby does not repeatedly restart it. Chat and voice controls remain available.

The chat bar, project list and message bubbles open inward: right from the left edge, left from the right edge, down from the top and up from the bottom. At a corner, content opens inward along both axes while the head stays in place. Using tools or receiving messages keeps the head tucked. Leaving hides tools while retaining the draft; bubbles follow their own dismissal rules.

Click the head to bring the pet out, diagonally from a corner. Moving more than 4 pixels while holding starts a drag without triggering the click on release. Drag along an edge to keep peeking; pull about 48 points inward to reveal the full body. Menu bars and the Dock are outside the visible work area.

## Holding and position
Holding the full body switches to a hanging pose that sways gently around the scruff. A taller drawing area preserves its proportions instead of shrinking it into a square. Release gives a short landing bounce at that position; the pet does not slide to the screen bottom. Holding pauses idle and pointer animations.

Position and edge are stored locally in pet-state.json and restored after restart. Removing a monitor brings the pet back into the available work area. Position is not transferred by settings backups.

## Messages and permissions
New activity messages and scheduled task success or failure can show clickable bubbles. Notifications dismiss after about 8 seconds or manually; clicking opens the associated activity or task run. Replies take priority over queued notifications, and dragging defers display. Task silence and conditional notification settings still apply; enabling the pet does not replay old activities.

Approval requests are handled in the main window. Hidden pages and Reduce Motion pause automatic animation while chat and bubbles remain usable. The context menu can switch appearance or quit the pet; quitting turns off its enable switch.

## Related topics
- Voice input and permissions
- Scheduled tasks
- Appearance and themes

<a id="scheduled-intro"></a>

# Scheduled tasks

Describe the time, work, scope and destination in a conversation. Sage presents a confirmation card and schedules only after saving. You can also create a task on the Scheduled tasks page.

## Create a task
1. State a frequency or one-time date and the project, for example “Every day at 9, check this project's build status and write a summary back here.”
2. Review name, instructions, schedule, model, timeout, authorization and destinations.
3. A linked conversation can supply inherited authorization; turn inheritance off to select an independent policy.
4. Check the next run after saving. Use Run now to verify the model, tools and output before relying on the schedule.

## Execution and output
Tasks run in isolated API contexts without overwriting your interactive conversation. Output can go to a selected conversation, a new conversation, channels or silent execution. Result workflows support conditional steps; nonmatching nodes skip their descendants and matching results follow configured destinations.

## Time and lifecycle
Schedules use the computer's local timezone and require Sage to remain running. The task page shows next and latest runs. Missed recurring triggers are coalesced after resumption; runs for the same task do not overlap. Pause stops future triggers; inspect the current run separately. Archiving a linked conversation pauses associated tasks.

## Edit, import and export
Save the full edited configuration. If another editor changed the task, reload rather than overwriting it. Export produces a reusable template without source-conversation approval snapshots. Imports start paused: review model, destination conversation, channels and policy before enabling.

## History and approvals
Run details distinguish execution failure, pending approval, timeout and delivery failure. Work beyond existing authorization still waits for a human decision and is bounded by task timeout. Successful execution with failed channel delivery is a different outcome; inspect delivery details before rerunning the work.

## Related topics
- Scheduled authorization inheritance
- Channel integration
- Request monitor and debug links

<a id="scheduled-authorization"></a>

# Scheduled authorization inheritance

Inheritance is available, bounded by the originating conversation at confirmation time. New conversation-created tasks select it by default; the confirmation card can switch to an independent policy.

## What is inherited
- A snapshot of the effective source policy, including file, command, network and review rules.
- Reusable approvals for exact calls: tool name and complete arguments must match.
- An “allow everything in this conversation” grant is not copied as an unlimited future grant; only concrete calls confirmed or actually admitted under it are retained.
- One-time approvals, consumed execution receipts and operating-system microphone/screen permissions are not transferred.

Approving a Bash command for one destination does not authorize another command, port or extra target. Plugin methods and arguments and MCP tool aliases also participate in matching. New calls are evaluated under the inherited policy and may require human approval.

## Invalidation
Each run checks the source conversation, project and policy. A missing or archived source, a project mismatch or changes to policy contents, active plugin code/permissions/settings, or MCP destinations/environment invalidate the snapshot. Review the source policy, edit the task and save to explicitly capture authorization again. Pausing or re-enabling alone never widens authorization.

## Restarts and later changes
Saved exact-call snapshots survive restart. Later temporary approvals in the source do not silently extend existing tasks. Resaving captures only source grants currently available. Older tasks without snapshots retain their existing independent-policy behavior.

## Independent policies and import
Disable inheritance to choose the task's own policy. Plugin-created tasks and manual tasks without a source cannot invent inherited permission. Exported templates exclude reusable authorization snapshots; imports require policy and destination review.

## Repeated approval requests
Compare tool name, path, command, destination and complete arguments against the earlier approval. Dynamic filenames, changed query arguments or new destinations may require approval. Adjust policy to the actual scope instead of selecting full access merely to suppress prompts.

<a id="channels-intro"></a>

# Channel integration

Channels connect external messaging platforms with project conversations and configured destinations.

## Setup
Enter platform credentials, recipient and callback information, then enable and test the channel. Inbound messages can trigger conversations and responses can be forwarded according to channel settings.

## Troubleshooting
Check permissions, subscribed events, recipients and credentials. External messages do not automatically expand project security permissions.

## Service health probes
Settings shows health dots next to feedback and update services: green for OK, red for errors (not configured, timeout or HTTP error), grey for not yet probed. Probes run in the main process, refresh on startup and every 5 minutes, and also trigger when entering settings or changing addresses.


## Related topics
- Feishu long connection and live replies
- Relay connection and deployment
- Scheduled tasks

<a id="channels-feishu"></a>

# Feishu long connection and live replies

Feishu app channels can receive messages through Webhook or WebSocket and separately enable live replies.

## Two different options
WebSocket receives inbound events; it does not itself stream outgoing replies. Live replies update one message card as content is generated.

## Configuration
Check application credentials, event subscriptions and recipients. Long connections require the app to run with network access. Card updates remain subject to Feishu permissions, API limits and latency.

## Related topics
- Channel integration
- Relay connection and deployment

<a id="channels-relay"></a>

# Relay connection and deployment

A relay connects external messages and the desktop app; configure server and client separately.

## Deployment
Follow the sage-website deployment guide for addresses, tokens and callbacks. Uploading an installer does not update relay code; server code changes require deployment and restart.

## Requesting a token
Settings → Relay: while the Token field is empty and the relay site exposes an application page (connection address + /apply), an Apply button appears next to the field and opens that page in your browser. Submit the request there; once an administrator approves it, collect the token with the query key shown on the page. The button hides once a token is filled in, and stays hidden when the page is unreachable — ask an administrator to issue a token directly.

## Download cleanup
sage-website checks download on startup and hourly, deleting older Sage releases according to latest-mac.json. Current releases, newer staged uploads and unrelated files are retained.

## Related topics
- First-run setup
- Plugin marketplace

<a id="spec-intro"></a>

# Spec workflow

Spec organizes development through three documents: requirements (what to build), design (how) and tasks (executable, checkable items). Spec is an optional plugin — install and enable the Specs plugin for the project, then use the specs entry in the sidebar.

## Three phases
1. Requirements: goals, use cases and acceptance criteria.
2. Design: approach, constraints and trade-offs.
3. Tasks: work broken into executable, verifiable items.

## Limits
Document approval does not grant unrestricted tool permissions; execution still follows security policy (see "Tools and approval"). Entry points depend on the installed Specs plugin version.

## Architecture map
The architecture view button in the sidebar shows all Specs in the project: classified by engineering dimension with task progress and completion status for an overview of overall progress.


## Related topics
- Create a Spec
- Refine requirements and design
- Execute and retry

<a id="spec-create"></a>

# Create a Spec

Create one from the specs entry: describe goals, use cases and acceptance criteria, then confirm design and tasks from the generated requirements document.

## Steps
1. Fill in the goal and background; the more specific the acceptance criteria, the more usable the generated document.
2. After generation, verify the assumptions in the document and edit what does not match reality.
3. Confirm requirements before moving into design and tasks.

## Limits
Verify assumptions before approving execution. The document is only a plan — real results come from execution.

## Related topics
- Spec workflow
- Refine requirements and design
- Execute and retry

<a id="spec-refine"></a>

# Refine requirements and design

Add constraints and feedback in the Spec conversation so the documents converge on real intent.

## Practices
- Check the design against the requirements: do the choices and flow cover every acceptance criterion?
- Write feedback directly in the Spec conversation and regenerate the affected phase document.
- Keep the three documents consistent: when one changes, re-check the other two.

## Limits
Document approval does not grant unrestricted tool permissions; execution still follows security policy.

## Related topics
- Create a Spec
- Execute and retry
- Tools and approval

<a id="spec-execute"></a>

# Execute and retry

Execute the task list and check each task's actual artifacts and acceptance results. For failed tasks, read the error and verify completed effects before retrying.

## Steps
1. Start execution from the tasks phase and watch each task's artifacts.
2. On failure, read the error message and check the files and external effects the task already produced.
3. Fix the cause and retry only the affected tasks; avoid rerunning everything and duplicating changes.

## Limits
Entry points depend on the installed Specs plugin version; tool calls during execution still go through approval.

## Related topics
- Spec workflow
- Analyze existing work
- Tools and approval

<a id="spec-retro"></a>

# Analyze existing work

Analyze an existing project's structure and behavior first, then derive requirements, design and improvement tasks in reverse.

## Practices
1. Start from the reverse-analysis entry and let the AI read the project structure, key files and runtime behavior.
2. Cross-check AI conclusions against actual code, runtime results and tests — especially the parts it claims have "no issues".
3. Only then generate improvement tasks and proceed per "Execute and retry".

## Related topics
- Spec workflow
- Execute and retry

<a id="loop-intro"></a>

# Loop iteration

Loop drives multi-round improvement from a goal and evaluation results: set the goal and metrics, and the loop executes, evaluates and adjusts until it passes or hits the budget. Available entry points depend on the installed and enabled plugins (such as delivery-loop).

## Practices
Define stopping conditions and resource budgets (rounds, time) before starting. Prefer quantifiable evaluation metrics over "looks better now" judgments.

## Limits
Tool calls inside the loop still follow security policy and approval. Verify each round's claims against actual artifacts instead of trusting the loop's own summary.

## Related topics
- Spec workflow
- Execute and retry
- Tools and approval

<a id="sandbox-intro"></a>

# Security policies and filesystem sandbox

Manage policies under Security and authorization and select one beside the composer.

## When changes apply
Policy names can update immediately; execution-policy changes take effect on the next start or resume, not during an active operation.

## Filesystem boundaries
Commands are offline by default and restricted by project scope, protected paths and environment rules. Ordinary approval does not remove the sandbox. Web-tool domain rules do not govern command networking.

## File browser directory filters
Settings → Security directory filters let you hide directory names (such as .sage, tmp) from the file list, filename search and content search. Filters apply to all projects. They do not delete files or control model access. The .sage directory is hidden by default.



## Policy appearance and management
Names, descriptions, icons and colors help distinguish policies. Click outside an icon/color picker to dismiss it, or Escape to close and restore trigger focus. Dismissal without selection preserves the value; only one picker opens at a time. Appearance changes do not change execution permissions.

## Manual approval scope
One-time approval applies to the current request. Reusable approval matches the tool and arguments. Conversation grants remain subject to deterministic denials and runtime sandboxing. Scheduled inheritance uses a separate snapshot; see Scheduled authorization inheritance.

## Related topics
- Keep sandbox, approve networking separately
- Tools and approval

<a id="sandbox-network"></a>

# Keep sandbox, approve networking separately

Edit a security policy and enable Keep sandbox, approve networking separately under Direct allow.

## AI review then human approval
The model requests Bash with network=true and networkReason describing purpose, destinations and data sent. AI denial blocks the request. Recommendations to allow, uncertainty, failures and timeouts all require your final decision. The configured review model is used, otherwise the conversation model.

## Permission scope
Allow network once enables outbound connections to any IP address for that command and its descendants. Filesystem isolation remains and listening stays disabled. Mentioned domains are not enforced restrictions; web-tool domain lists do not restrict this grant.

## Failures
Grants are single-use and invalidated by command, policy or checked-script changes. Request approval again when needed; do not bypass a denial or remove filesystem isolation.

## Related topics
- Security policies and filesystem sandbox
- Tools and approval
- History and log cleanup

<a id="monitor-intro"></a>

# Request monitor and debug links

The request monitor records model requests, responses, usage and errors.

## Locate a reply
Click the debug icon beside the copy/document actions below a reply. The monitor filters requests linked to that reply and selects the latest; a single reply may involve several model calls.

## Historical records
Older records without message links, or removed records, cannot be located exactly. The monitor explains this and shows conversation records. Request logs live under the project's .sage/monitor/, separately from security decisions.

## Related topics
- Models and backends
- History and log cleanup
- Project Wiki and DeepWiki
## Diagnostic memory limits
The monitor keeps at most 800 recent records and 24 MiB of estimated payload. Large fields and images are shortened or omitted; actual model requests and full conversations are unchanged. A slow disk queues at most 32 diagnostic writes, so additional diagnostics may not be persisted. Live workflow previews show bounded tails while completed documents remain in the project.

<a id="troubleshooting"></a>

# Common problems and diagnostic order

Report the entry point, expected result, actual error, project and version. Inspect state before reinstalling or clearing data.

## Chat and speed
| Symptom | First check | Help topic |
| --- | --- | --- |
| Wrong model | Conversation/project overrides and engine | Models and backends |
| Waiting indefinitely | Approval, tool, queue or model phase | Tools and approval; Request monitor |
| Input feels locked | Dictation, optimization or large attachments | Voice input; Context strategy |
| Interrupted answer | Error, completed tools and resumable state | Resume after exit |
| Increased tokens/cost | History, images, tool output and compression | Context window and compression |

## Plugins, Git and tasks
| Symptom | First check | Help topic |
| --- | --- | --- |
| Missing plugin button | Installation, project activation, dependencies, slot | Plugin activation; UI slots |
| Missing/duplicate skill | Project overrides, unique names, refresh | Skills; Capability picker |
| No MCP tools | Enablement, connection test, endpoint, refresh | MCP servers |
| Pull/Push rejected | Upstream, divergence, authentication, local changes | Git troubleshooting |
| Task did not trigger | Sage running, enablement, timezone, next run | Scheduled tasks |
| Task asks again | Changed arguments, source policy or snapshot | Authorization inheritance |
| Work succeeded but no output | Destination, channel and delivery error | Channels; Run history |

## Interface and OS
For shortcuts check focus, modal dialogs and duplicate bindings. For voice check both microphone and speech permissions. For capture check Screen Recording. An uneditable historical file may be a read-only Git snapshot. Missing tree entries may be directory filtering, not lost data.

## Collect evidence
Confirm the version in Help. Copy the error and inspect request monitoring, plugin logs, decision history or task runs as relevant. Inspect screenshots for credentials/private content. Back up before destructive recovery; deleting the entire data directory is not a routine fix.

<a id="data-storage"></a>

# Chat storage and migration

Conversations are stored in .sage/chats/<id>/meta.json; conversation memory uses memory.json beside it.

## Legacy migration
On first access, .sage/conversations/ migrates to chats/. When both exist, missing data is merged. Conflicting chats files are retained and old files backed up under chats/.legacy-conversations/.

## Backups
Migration does not restore a running process. Include .sage when backing up projects and do not manually rename conversation-ID folders.

## Related topics
- Long-term memory and auto-merge
- Settings backup and recovery
- History and log cleanup

<a id="memory-merge"></a>

# Long-term memory and auto-merge

Memory lives in three scopes: this chat (.sage/chats/<id>/memory.json) > project (.sage/memory.json) > global (~/.sage/memory.json). One fact keeps one entry.

## Merged on save
New entries are checked by character similarity. An identical statement, or one differing by only a few characters, is folded into the existing entry instead of adding a duplicate: the newest wording wins, tags are unioned, the original creation date is kept, and the replaced wording is stored in that entry's mergedFrom. If the new text is only a shorter restatement, the more complete existing text is kept so details do not shrink over time.

## Conflicts and priority
When two memories contradict, the one updated most recently wins. Effective scope is still chat > project > global. Scopes never delete each other: a project entry shadows the global twin, and removing either leaves the other intact. Injection passes one copy per fact.

## Legacy duplicates
Duplicates left by older releases are merged per scope when you open Settings → Memory. Before a merge, the file is copied to .merge-backups/ beside it (up to 5 copies per scope). If the backup cannot be written, the merge is skipped rather than deleting anything.

## Related topics
- Chat storage and migration
- History and log cleanup

<a id="data-cleanup"></a>

# History and log cleanup

Configure retention days, snapshot counts and log sizes at the bottom of Settings → General.

## History snapshots
settings.json.history and projects.json.history keep at least the newest 50 valid snapshots by default. Only snapshots both older than 30 days and outside the newest 50 are deleted. Corrupt backups are preserved. Checks run on retention-settings or history saves.

## Decision logs
Former decisions.log data uses date/project shards under decisions/ in app data. Defaults: 5 MB per file, 30 days, 100 MB total. Exceeding age or total size removes oldest files. Writes and queries check hourly, immediately on new shards or changed configuration.

## Legacy logs
audit.log is older security audit history, still readable. Request-monitor logs are separate and are not controlled by these decision-log settings.

## Related topics
- Settings backup and recovery
- Request monitor and debug links
- Tools and approval

<a id="settings-backup"></a>

# Settings backup and recovery

General settings provide configuration export, import and history recovery.

## Save protection
Settings use atomic replacement and history snapshots. If another window changes the revision, keep your draft and reload before saving. Damaged settings are not silently replaced with empty configuration.

## Credentials
Use the offered encryption, password and module-selection options. Restoring on another host may require a password or entering credentials again.

## Related topics
- History and log cleanup
- Chat storage and migration
- Updates and timestamps

<a id="update-intro"></a>

# Updates and timestamps

Automatic updates can check, download and install releases using the configured update source.

## Before and after updating
Save files and inspect running tasks. Updating the desktop app does not deploy server code. Reopened unfinished plans can use Continue execution.

## Timestamps
Ordinary chats omit seconds: today shows time only, yesterday has a label, this year omits the year, and other years show a full date. Audit and request-monitor views retain seconds where precision matters.

## Runtime configuration
Settings → General runtime configuration adjusts main-process limits: max tool iterations, request timeout, tool output cap, file read cap, context compression threshold, plugin package size cap, MCP timeout, scheduler interval, channel retry count and connection timeout. Each field has safe bounds. Restore defaults resets all. Changes apply to new requests.

## Prevent system sleep
Settings → General prevent sleep keeps macOS awake while Sage runs so services and channel messages stay available. System defaults resume when Sage quits.


## Related topics
- Settings backup and recovery
- Resume after interruption
- Relay connection and deployment

<a id="appearance"></a>

# Appearance and themes

Settings → Appearance offers light, dark or system-following modes, plus built-in extended themes and custom themes.

## Custom themes
Copy the current colors to create a new named theme; custom themes can be adjusted and deleted. Changes to a built-in extended theme are stored as a diff only, with per-row reset and full rollback to default colors.

## Fonts and sizes
Theme colors, fonts and font sizes are set separately for light and dark; changes apply immediately and are saved with the selected theme.

## Date and time
Settings → Appearance → Date & time configures the timezone (system or IANA), date format presets and custom patterns. Smart dates show time-only for today, a label for yesterday and omit the year for the current year. Format tokens include YYYY, MM, DD, HH, mm, ss. A live preview is shown below.


## Related topics
- Updates and timestamps
- Settings backup and recovery

<a id="multi-window"></a>

# Multi-window workspace

Open separate windows for different projects. Each window maintains its own tabs, terminals and conversation state.

## Opening new windows
File → Open in New Window, or Ctrl/Cmd+N. The new window selects the current project automatically, or a different project path can be specified.

## Independent state
Each window keeps its own file tabs, terminal panel and conversation list. Switching projects releases old terminals and aborts old conversations. Tab state persists per window and restores on reload.

## Cross-window sync
Conversation list changes merge across windows to avoid duplicates or loss. Settings changes take effect when each window reloads.

## Limits
Closing a window terminates all its terminal processes. Running tasks prompt for confirmation before the window closes. Tab state is not shared between windows.

## Related topics
- Keyboard shortcuts
- Chat storage and migration
- Resume after interruption

<a id="voice-input"></a>

# Voice input and permissions

Voice dictation writes into the current draft and never sends automatically. Select the intended conversation first.

## Two shortcut modes
| Mode | Default | Behavior |
| --- | --- | --- |
| Hold to talk | Fn | Hold to start; release or leave the window to stop |
| Manual toggle | Fn + Control | Press once to start and again to stop |

Both work only in Sage and can be reassigned or cleared in Settings → Keyboard shortcuts. The microphone button uses manual toggle behavior. Key repeat does not repeatedly switch recording. Hold mode does not take ownership of an existing manual recording.

## First authorization
macOS microphone and Speech Recognition permissions are independent. Follow the prompt; after denial, Open system settings leads to the relevant panel. Releasing a held key while permission is pending cancels that start. After granting permission, hold again; capture does not unexpectedly resume.

## Recording and stopping
Transcription updates the draft and joins finalized segments. Review it after stopping before sending. Switching conversations, closing the window or optimizing input stops capture. In manual mode, press the shortcut or microphone button again to stop.

## Device and troubleshooting
Choose a microphone in Settings → General or follow the system default. Refresh requests permission and scans devices.
No text: check input levels, system permissions and the voice helper; read the specific displayed error.
Poor recognition: reduce noise and check application language; mixed-language results depend on system recognition.
No shortcut response: focus Sage, close modal dialogs, finish shortcut recording and check conflicts or cleared bindings.

## Fn key
On macOS, native AppKit events recognize Fn/Globe. Hold Fn to talk; Fn + Control (Fn⌃) toggles recording in either key order. Release Fn to finish recording a new Fn binding in settings. A warning appears if the native module is unavailable; keyboards without Fn can use a custom binding. Existing custom bindings are preserved; choose Restore default to use these keys.

<a id="screenshot"></a>

# Capture, annotate and copy

Shift + Cmd + A (⇧⌘A) freezes the display under the pointer and shows a dimmed desktop overlay while Sage is focused. Customize it in shortcut settings. Chats, settings and files all use this screen-selection and annotation workflow.

## Use
1. Focus Sage and press the capture shortcut.
2. Drag an area on the desktop overlay. The outside is dimmed, the inside stays clear, and the output pixel dimensions appear beside it.
3. Drag inside to move the area or use any of its eight handles to resize before confirming. The toolbar follows the selection and stays within the display.
4. Click the green check (Enter / Cmd + C) to copy the edited image and close; or click the download icon (Cmd + S) to save a PNG to a chosen location.
5. To use the image in a chat, focus its composer, paste with Cmd + V, review and send.

Capture never adds a draft attachment or sends a message automatically. Saving does not replace the clipboard. Cancelling a save, or a copy/save failure, preserves your edits. The red cross or Escape closes the editor. Capture errors and permission instructions appear in the independent window. The overlay fades out smoothly on normal dismissal; reduced-motion settings close it directly.

## Adjust selection
Use the selection tool to drag inside. While annotating, drag a border or handle, or hold Space while dragging to move. Adjustments do not scale the background or annotations; content outside the selection is excluded from export. Drag outside to select a new area. Cmd + A selects the full display. Escape during a drag restores the previous area; Escape again exits capture.

With multiple displays, use the display dropdown or Control + Tab to switch. Capture selects one display at a time, without stitching across displays. A successful display switch or retake starts a new selection. Disconnecting, rotating, resizing or changing the scale of the captured display closes the overlay to avoid incorrect coordinates. Dock work-area changes preserve it.

## Tools
- Drag rectangles, ellipses or arrows.
- Click an annotation tool to open its options. Three dots choose line width; swatches choose blue, green, yellow, black, white or red. Click the tool again to close its options.
- Drag a mosaic region. Export flattens the pixelated area into the PNG.
- Click the image and type directly. The three A buttons choose size; click existing text to edit it again. Multiple lines are supported.
- Choose from 48 emoji in a scrollable six-column grid. Arrow keys navigate the grid; choose a size, then click to place it. Mosaic uses three dots for block size.
- Select moves or resizes the retained area; undo restores the previous selection.
- Cmd + Z undoes; Shift + Cmd + Z redoes. History holds up to 200 edits.
- Retake hides the overlay before reading the screen again. A failure preserves the current selection and edits; success replaces them with a fresh full background.

## Edit annotations
All annotations remain editable until you copy or save. Click an existing shape, line, pen stroke, mosaic or emoji to select it, then change its color, width or size. Use the eight handles to resize, or drag its border or drawing to move it. Start a new annotation in empty space. Escape cancels the current edit or selection.

Click text to type directly or edit its content, color and size again. Delete / Backspace or the options trash button removes the selected annotation. Undo and redo include moves, resizing, changes and deletion. Adjust selection, the green border or Space-drag changes the final crop. Object handles and text input are excluded from export.

## Permission and limits
First use requests Screen Recording permission. Choose Open System Settings and allow Sage under Privacy & Security → Screen & System Audio Recording (or Screen Recording), then retake. Quit and reopen if macOS asks.

Images are limited to 24 MiB, 24 × 1024 × 1024 pixels and 16384 pixels per edge. Typical Retina displays retain native pixels. Very large or numerous displays may be proportionally reduced to stay within memory limits; the dimension label always reports output pixels. Estimated total thumbnail allocation is capped at 48 × 1024 × 1024 pixels. Capturing creates no temporary image file; closing releases the image and history. Pasting into chat still follows chat attachment limits and model vision capabilities.

## Duplicate Sage entries
Older versions changed the identifier from dev.sage.app to sage.app. Historical signatures or multiple installed copies may also leave matching names. Display order alone cannot identify the current copy. Open Sage from Applications, then check its current identity and actual status in Settings → Security & Authorization → System permissions. Updating does not merge old system records. Development Electron and installed Sage use separate permission identities; an unknown host will not reset another instance's permissions.

## No response or failure
Check foreground focus, modal windows, conflicting shortcuts and an active capture. A screen-read timeout allows retrying later without accumulating unfinished native requests. Repeating capture while an editor is open returns to it. Archived chats, input optimization and dictation disable capture. Interactive capture currently targets macOS.

Tab navigates controls; arrow keys navigate tools and options. Control + Shift + Tab switches displays in reverse. The background is drawn before the editor appears.

<a id="shortcuts"></a>

# Keyboard shortcuts

Settings → Keyboard shortcuts manages app key bindings with search, rebind, reset and conflict detection.

## Groups and search
Shortcuts are categorized into Window & Terminal, Chat, Editor and Preview & View. The search box filters by name, description or default key.

## Rebind and reset
Click the pencil icon to enter recording mode; press the desired key combination to rebind, Esc to cancel. Each shortcut can be individually restored to default, or all at once with Reset All. Non-rebindable shortcuts show a lock icon.

## Conflict detection
When the same combination is used by multiple shortcuts, conflicts are highlighted in red with a hover tooltip showing the other shortcut. Bare keys are allowed for arrows, function keys and page navigation; Fn and Fn combinations are reserved for the two voice actions.

## Limits
Shortcut changes apply immediately and are saved with settings. macOS shows symbols (⌘⌃⌥⇧); other platforms show text.


## Voice and screenshots
Hold to talk defaults to Fn, manual dictation to Fn + Control, and capture to Cmd + Shift + A. All are Sage-window shortcuts. Recording a new binding intercepts keys instead of invoking existing actions; Escape cancels recording. Releasing or blurring ends a held recording, including cancellation while system authorization is pending.

## Conflicts
Cmd + A and Cmd + Shift + A are distinct. Clear or reassign duplicate bindings. Fn uses native events. System or other applications’ global shortcuts can still take precedence; remove conflicting bindings in those applications.

## Related topics
- Terminal panel
- Multi-window workspace
- Appearance and themes
