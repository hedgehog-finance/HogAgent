---
name: skill-creator
description: >
    Create or update HogAgent skills with focused SKILL.md instructions and only the supporting scripts, references, or assets the workflow needs. Use for skill design, scaffolding, revision, and validation. Do not use for installing remote skills or creating runtime tools/extensions unless the user explicitly asks for those separate changes.
version: 1.0.1
---

# Skill Creator

Create skills that add useful, non-obvious guidance without constraining unrelated work.

## Core principles

- Assume HogAgent is already capable. Keep only instructions that change decisions, preserve operational invariants, or improve reliability.
- Preserve the user's chosen scope and authorization. A skill must not expand the task, edit unrelated configuration, or imply permission for external mutations.
- Match specificity to risk. Use deterministic scripts and strict sequences only when deviation creates a concrete correctness, safety, or permission problem.
- Keep discovery cheap. Make `name` and `description` concise and discriminating because they are visible before the body is read.
- Disclose detail progressively. Keep shared guidance in `SKILL.md`; put substantial conditional procedures in `references/` and reusable deterministic work in `scripts/`.

## HogAgent skill structure

```text
skill-name/
|-- SKILL.md        Required; YAML frontmatter plus instructions
|-- scripts/        Optional executable helpers
|-- references/     Optional documentation read only when relevant
`-- assets/         Optional files copied or adapted into outputs
```

Do not create empty or placeholder resources without a concrete use. HogAgent does not consume Codex-specific `agents/openai.yaml` metadata.

`SKILL.md` frontmatter requires `name` and `description`. `version` and `workflow_based` are optional. The directory and frontmatter name must use the same lowercase kebab-case identifier.

## Create or update

1. Inspect the target scope and nearby skills before editing. Reuse an existing skill when its capability already covers the request.
2. Respect a user-specified location. Otherwise create user/project-specific skills under `<workspace>/skills`; change HogAgent's bundled `<hogagent_root>/skills` only when the user explicitly requests a system skill.
3. For a new skill, initialize a minimal scaffold when useful:

```bash
node <this_skill_dir>/scripts/init-skill.mjs <skill-name> --path <output-parent> [--resources scripts,references,assets] [--examples]
```

4. Write the description to say what the skill does and when it applies. Add a boundary only when it prevents likely misrouting.
5. Put the desired outcome, non-obvious constraints, relevant tools, and resource-routing instructions in the body. Avoid generic advice, copied manuals, speculative edge cases, and examples that do not clarify the workflow.
6. When updating a skill, inspect its callers and resources first. Preserve supported frontmatter and unrelated behavior; prefer a narrow correction over accumulating universal rules.
7. If the skill calls an authenticated API, add an `API configuration` section following the rules below.
8. Validate the finished skill:

```bash
node <this_skill_dir>/scripts/validate-skill.mjs <path/to/skill-folder>
```

9. Run every new or changed helper script with representative input. After filesystem changes, reload HogAgent configuration when that control is available; otherwise tell the user that `reload_config` or a restart is required.

## API configuration

For every skill that requires an API key, its `SKILL.md` must document:

- the exact skill entry and field names in `$HOGAGENT_USER_DIR/skills_config.json` when that variable is set, otherwise `~/.hogagent/skills_config.json`; the standard on-disk key field is `"api-key"`;
- the supported configuration entry point, such as Web UI skill settings or RPC `{"type":"configure_skill","name":"<skill-name>","apiKey":"..."}`;
- any endpoint, account scope, permissions, or optional environment-variable fallback, including precedence;
- whether a missing key disables an optional path or causes a clear preflight error;
- the authentication scheme used by the script, without exposing a real credential.

Use placeholders such as `"your-api-key"`; never write, echo, log, commit, or copy a real key into `SKILL.md`, scripts, fixtures, examples, or generated artifacts. Read only the current skill's config entry. Do not silently reuse the main LLM key or another skill's key.

Gateway automatically seeds `"api-key"` only for intentionally named `hedgehog-*` skills. Document that behavior when it is part of the integration, but do not adopt the prefix merely to obtain credentials.

## Resource guidance

- Use `scripts/` when repeated logic would otherwise be rewritten or deterministic execution materially improves reliability.
- Use `references/` for maintained schemas, policies, API details, or mode-specific procedures. Link each reference from the place in `SKILL.md` where it becomes relevant.
- Use `assets/` for templates, images, fonts, or boilerplate that belongs in generated output. Do not load assets as instructions unless inspection is required.
- Keep dependencies explicit. A Node-based built-in skill that imports packages must declare them in its own `package.json` and keep the HogAgent root dependency aggregation in sync.

The validator accepts LF or CRLF files and checks HogAgent-compatible frontmatter, duplicate keys, naming, versions, unfinished scaffold markers, and local Markdown resource links. It is a structural gate, not proof that the skill makes good decisions; review the actual instructions against realistic requests before delivery.
