# PatchWarden Demo

This is a privacy-safe demo flow for GitHub. It uses placeholder workspace
names and avoids real tunnel IDs, account names, API keys, or local user paths.

## Demo: ChatGPT Lists A Workspace

Prompt in ChatGPT with the PatchWarden connector selected:

```text
Use the patchwarden tool list_workspace to list the configured workspace.
```

Expected response shape:

```text
Workspace files:

| Name         | Type | Size |
|--------------|------|------|
| README.md    | file | ...  |
| package.json | file | ...  |
```

![PatchWarden ChatGPT connector demo](assets/patchwarden-chatgpt-demo.svg)

## Demo: Plan And Execute

Prompt in ChatGPT:

```text
Use patchwarden to:
1. read README.md
2. save a plan that appends a Usage section
3. create a task with an explicit repo_path and verify_commands
4. call wait_for_task repeatedly while continuation_required is true
5. review get_task_summary, audit_task, result, diff, and verification logs
```

Expected artifacts under the configured workspace:

```text
.patchwarden/tasks/<task_id>/status.json
.patchwarden/tasks/<task_id>/result.md
.patchwarden/tasks/<task_id>/result.json
.patchwarden/tasks/<task_id>/artifact_manifest.json
.patchwarden/tasks/<task_id>/git.diff
.patchwarden/tasks/<task_id>/verify.json
.patchwarden/tasks/<task_id>/test.log
```

## Privacy Notes

Do not publish:

- real API keys or runtime keys
- real tunnel IDs
- ChatGPT account names or workspace IDs
- screenshots containing sidebars with private chat/project names
- `patchwarden.config.json`
- `.patchwarden/` task history from private workspaces
