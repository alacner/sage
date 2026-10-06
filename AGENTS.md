# Project Delivery Rules

- For every completed requirement change, increment the patch version, commit the changes to Git, and build a DMG package before reporting completion.
- Keep release versions in the `0.6.x` series. Increment `x` for every new DMG release; never reuse a released version or change the major/minor version unless the user explicitly requests it.
- Keep `package.json` and `package-lock.json` versions in sync.
- Run checks appropriate to the change, commit the relevant source and version changes, then build with `npm run dist:dmg` and verify the resulting package.
- Report the release version, Git commit, and absolute path to the DMG. If a step fails, report the failure accurately and do not claim delivery is complete.
- Preserve unrelated work in the working tree; do not include unrelated changes in a commit.
- Put new project documentation under `docs/`, grouped by topic when useful. Update its index and relative links. Archive outdated historical documents with a clear notice instead of presenting them as current instructions. Runtime-required package files such as `skills/SKILL.md` and generated SDK documentation copies are distribution artifacts, not alternate documentation sources.
