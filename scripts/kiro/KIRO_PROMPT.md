Run the scripts in `scripts/kiro/` in numeric order, exactly as listed in
`RUNBOOK.md`. Stop at the first `RESULT: FAIL` line, or at any step marked
"approval required" in the runbook. Report back only:

1. The `RESULT:` line from each script that ran.
2. On any failure, also the last 30 lines of that script's output.

Do not explore the repo, do not refactor anything, do not run commands that
aren't listed in the runbook.
