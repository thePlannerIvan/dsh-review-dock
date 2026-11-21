# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent>`, or `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.
- **Blocking**: GitHub's native issue dependencies. `gh issue edit <child> --add-blocked-by <blocker>`, or `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. A ticket is unblocked when every blocker is closed (`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by` returns 0).
- **Comment**: `gh issue comment <n> --body "..."`.
- **Labels**: `gh issue edit <n> --add-label/--remove-label`.
- **Close**: comment with the explanation, then `gh issue close <n>`.

## Pull requests as a triage surface

**PRs as a request surface: no.**
