# Manual release checklist

PatchWarden releases remain confirmation-gated. Creating a tag or GitHub Release does not publish npm automatically.

1. Work on a release branch and update `package.json`, changelog/release notes, README, examples, and tool manifests together.
2. Run the complete local quality gates from `AGENTS.md`.
3. Open a pull request, wait for `CI gate`, review the diff and package contents, then merge.
4. Create the version tag from the verified merge commit.
5. Create the GitHub Release and attach only reviewed release artifacts and checksums.
6. Publish `patchwarden` to npm using process-scoped authentication; never store the raw token in the repository.
7. Verify `gh release view`, the remote tag, `npm.cmd view patchwarden version`, and `dist-tags.latest`.
8. Update or close the associated issue only after remote verification succeeds.

Do not publish new versions under the frozen pre-rename package name.
