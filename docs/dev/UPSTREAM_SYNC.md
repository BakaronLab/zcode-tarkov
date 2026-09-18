# Upstream sync ledger

This file is the record of which upstream revisions have been reviewed and what
happened to each one: what was already equivalent in this project, what was
ported, and what was deliberately not taken. It is updated on **every** upstream
review — a review that changes this repository but not this file is incomplete.

## Code upstream

- **Upstream:** `Logocceai/zcode-beautify` —
  https://github.com/Logocceai/zcode-beautify
- **Review base:** `8639446a4534be667a8fa76ea7757c139ee9df71` (tag `v0.3.1`)
- **Last reviewed upstream tag:** `v0.3.3`
- **Last reviewed upstream commit:** `a98bb9ef161b08937dfe724316ba893855db07c9`

The base and the reviewed commit are different things and both are stated: the
base is what this fork starts from, and the commits between the two were
classified one by one rather than merged. The base is still `v0.3.1`; `v0.3.3`
is only the latest revision whose commits have been reviewed.

## Reviewed commits

| Upstream SHA | Summary | Classification | Local implementation | Local commit / test |
|---|---|---|---|---|
| `9145fe731165f0bdf80850877c72e0013392c74b` | `fix(zcode-beautify): hide the child console when probing for the ZCode process` | `ALREADY_EQUIVALENT` | The product spawn sites already passed `windowsHide: true` (`src/core/launch.ts` — `isZcodeProcessRunning` and `killZcode` — and `src/core/launchers.ts` — the launcher-repair `powershell` spawn). The one remaining gap, the `tasklist` probe in the shipped `skill-pack/references/cdp-minimal.mjs` snippet, was ported | `79174e9d2500fc99aa48ac57a39a2e78648a3d2c` — no dedicated test (a spawn option in a shipped snippet) |
| `326953d41a87ae7b0bd8f983673d3f5624366c99` | `chore(release): 0.3.2` | `RELEASE_METADATA_ONLY` | None — version bumps, CHANGELOG text and rebuilt bundles, with no behavioural source change | — (nothing to port: no behavioural change upstream) |
| `4099c2d753f757f7b97e78b2e510ef6093fe8f2f` | `feat(zcode-beautify): repair launch entries at startup and cover pinned taskbar` | `PORT_REQUIRED` | `src/core/launchers.ts` (`DEFAULT_SHORTCUT_DIRS` with the pinned taskbar as a user entry, `buildRepairScript` and its machine-scope refusal, `repairLaunchers`), `src/core/startupRepair.ts` (`repairLaunchersIfZcodeLostTheFlag`, `describeStartupRepair`), `src/mcp/server.ts` (after the theme-restore retries), `src/core/server.ts` (once per process, on first poll), `src/cli.ts` (`cdpRepairHint`) | `79174e9d2500fc99aa48ac57a39a2e78648a3d2c` — `tests/startupRepair.test.mjs`, `tests/launcherScript.test.mjs`, `tools/test-launcher-repair.ps1` (`npm run test:launcher-repair`) |
| `a98bb9ef161b08937dfe724316ba893855db07c9` | `chore(release): 0.3.3` | `RELEASE_METADATA_ONLY` | None — version bumps, CHANGELOG text and rebuilt bundles, with no behavioural source change | — (nothing to port: no behavioural change upstream) |

The **Local commit / test** column names the commit that carries each change.
While a review is being written it holds the literal token `TBD_LOCAL_COMMIT`;
the release step replaces it with the commit's SHA, so a published ledger that
still contains the token is stale. A `RELEASE_METADATA_ONLY` row carries no
commit, because there was nothing to port.

Classifications used: `ALREADY_EQUIVALENT` (this project already has the
behaviour), `PORT_REQUIRED` (the delta was ported), `NOT_APPLICABLE` (the commit
concerns something this project does not have) and `RELEASE_METADATA_ONLY` (no
behavioural source change).

## Design / reference upstream

- **Upstream:** `ZHIGENGNIAO258/dsh-theme-tarkov` —
  https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov
- **Role:** design and product reference only. It is **deliberately never
  merged**: it targets a different host (DeepSeek Harness / Cordis), and no DSH,
  Cordis or `schemastery` code exists in this repository.
- **Last deliberately reviewed reference revision:**
  `be1123c1c158e58ba0aa1c311c22d793b09f9c0d` (upstream v0.2.0). This is the
  revision pinned in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)
  §2, in `README.md` / `README.zh-CN.md`, and in
  [`evidence/owner-playtest-prep/README.md`](../../evidence/owner-playtest-prep/README.md).
  Its MIT licence text is kept in
  [`licenses/dsh-theme-tarkov.LICENSE`](../../licenses/dsh-theme-tarkov.LICENSE).
  No later reference revision has been deliberately reviewed, and the licence
  file itself carries no revision marker.

## How to run a review

1. Fetch the new upstream revision without letting upstream's tags land in this
   project's release namespace. The worked example is the v0.3.3 review:

   ```bash
   git fetch --no-tags upstream-beautify refs/tags/v0.3.3:refs/tags/upstream-v0.3.3
   git log --oneline 8639446a4534be667a8fa76ea7757c139ee9df71..upstream-v0.3.3
   ```

   The `upstream-` prefix keeps upstream's tag from being mistaken for a tag of
   this project, and `--no-tags` stops the fetch from auto-following the rest of
   upstream's tags into the local namespace. A clone that reviews upstream
   repeatedly can make that the default for the remote, which is what the v0.3.3
   review did:

   ```bash
   git config --local remote.upstream-beautify.tagOpt --no-tags
   ```
2. Classify every commit in the range using the four classifications above. A
   `RELEASE_METADATA_ONLY` commit normally needs nothing beyond the ledger row.
3. Port only what is missing. Read the upstream change against this project's
   own code first: several upstream fixes are already present here, and the port
   is the delta, not the commit.
4. Add or extend a regression test for every ported behaviour. A port with no
   test is not finished.
5. Update this ledger — one row per reviewed commit, naming the local files and
   the tests that pin them — and add the change to `CHANGELOG.md`.
6. Never rewrite a published tag, and never push upstream's tags into this
   repository's release namespace.

### Upstream radar

`.github/workflows/upstream-radar.yml` runs every Monday at 05:37 UTC (and can
be dispatched manually with `force: true`, which reports the comparison even
when nothing moved). It reads the three recorded values above, asks `gh api`
for the code upstream's latest release tag and default-branch head and for the
reference upstream's default-branch head, and writes its result to the job
summary. It never merges, pulls, pushes or writes to this repository.

- **Nothing moved:** no issue is touched.
- **Something moved:** exactly one issue titled `Upstream update available` is
  opened, or its body is updated if that issue is already open. The body names
  each moved upstream, the recorded and observed revisions, the `git log`
  command and the upstream compare link, and points back to this file.

Act on such an issue by running the review above: classify every commit in the
range, port only the delta with a regression test, then update the recorded
values in this file (and `CHANGELOG.md`). The radar is a reminder only — it
never edits this ledger and never makes the change itself.

## Deliberate divergences from upstream

- **Machine-wide launch entries are reported, never written.** Upstream's
  generated repair script attempts to rewrite the `%PUBLIC%\Desktop` and
  `%ProgramData%\...\Start Menu\Programs` shortcuts and reports the OS error
  when the write fails. This project refuses the attempt outright: those two
  directories are scanned with `scope = 'machine'` and answered with `failed` —
  "machine-wide entry needs administrator rights; not modified" — while the
  user-scope entries are the only ones written. There is no elevation path
  anywhere in the generated script, and `tests/launcherScript.test.mjs` pins
  the refusal and the absence of `HKLM`.
- **The automatic repair triggers more narrowly.** This project repairs only
  when ZCode is running **and** the CDP endpoint does not answer, decided in
  `src/core/startupRepair.ts` before any location is scanned. A closed app and a
  healthy endpoint both produce zero launcher writes, and only "running with the
  port closed" reaches the repair — pinned by `tests/startupRepair.test.mjs`.
