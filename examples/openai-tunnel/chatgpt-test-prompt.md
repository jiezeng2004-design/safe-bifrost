# Safe-Bifrost ChatGPT Test Prompt

Paste this into a ChatGPT conversation where the Safe-Bifrost Connector is
selected.

```text
Use the safe-bifrost connector tools to verify the workflow.

Step 1:
Call list_workspace for the configured workspace.

Step 2:
Call read_workspace_file for README.md.

Step 3:
Call save_plan with:

title: Add Usage Section

content:
Add a "## Usage" section to the end of README.md. The section should include
one sentence: "This repository was updated through Safe-Bifrost."
Do not modify other files. After the change, run the configured test command.

Step 4:
Call create_task with the returned plan_id, agent "opencode", and test_command
"npm test".

Step 5:
Wait for the watcher to execute the task. Then call get_task_status. If the
task is still running, wait and retry.

Step 6:
When the task is done or failed, call get_diff, get_test_log, and get_result.

Step 7:
Summarize:
- final task status
- files changed
- whether tests passed
- whether the diff is acceptable
```
