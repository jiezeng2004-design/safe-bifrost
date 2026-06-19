# Safe-Bifrost Demo

This is a privacy-safe demo flow for GitHub. It uses placeholder workspace
names and avoids real tunnel IDs, account names, API keys, or local user paths.

## Demo: ChatGPT Lists A Workspace

Prompt in ChatGPT with the Safe-Bifrost connector selected:

```text
Use the safe-bifrost tool list_workspace to list the configured workspace.
```

Expected response shape:

```text
Workspace files:

| Name         | Type | Size |
|--------------|------|------|
| README.md    | file | ...  |
| package.json | file | ...  |
```

![Safe-Bifrost ChatGPT connector demo](assets/safe-bifrost-chatgpt-demo.svg)

## Demo: Plan And Execute

Prompt in ChatGPT:

```text
Use safe-bifrost to:
1. read README.md
2. save a plan that appends a Usage section
3. create a task for the configured local agent
4. wait for the watcher
5. read result, diff, and test log
```

Expected artifacts under the configured workspace:

```text
.safe-bifrost/tasks/<task_id>/status.json
.safe-bifrost/tasks/<task_id>/result.md
.safe-bifrost/tasks/<task_id>/git.diff
.safe-bifrost/tasks/<task_id>/test.log
```

## Privacy Notes

Do not publish:

- real API keys or runtime keys
- real tunnel IDs
- ChatGPT account names or workspace IDs
- screenshots containing sidebars with private chat/project names
- `safe-bifrost.config.json`
- `.safe-bifrost/` task history from private workspaces
