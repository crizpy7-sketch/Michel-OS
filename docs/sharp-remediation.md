# Bounded sharp remediation in draft PR #20

This separate task starts at `f8a65d6bb685f96c8eff01c57da0497797da4117` and follows
the [retained lint-remediation stop](https://github.com/crizpy7-sketch/Michel-OS/pull/20#issuecomment-5572535918).
The [current authorization](https://github.com/crizpy7-sketch/Michel-OS/pull/20#issuecomment-5573106081)
permits one implementation pass and verification, with zero automatic post-review
repairs. It grants no merge or deployment authority.

The only application importer remains `tools/assets/icons.ts`. sharp is a development
dependency used explicitly for repository icon generation/checking; `npm start`
does not load it, and the production image installs with `--omit=dev`. This usage
assessment does not treat filename extensions as a security boundary.

| Evidence observed on 2026-09-07 | Before | Patched installation |
| --- | --- | --- |
| Resolved sharp | 0.34.5 | 0.35.4, exact package pin |
| Loaded libvips | 8.17.3 | 8.18.6 |
| Full `npm audit --json` | exit 1; one high finding | exit 0; zero findings |
| `npm audit --omit=dev --json` | exit 0; zero findings | exit 0; zero findings |

The [maintainer advisory GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
affects sharp before 0.35.0. The selected
[0.35.4 release](https://sharp.pixelplumbing.com/changelog/v0.35.4/)
was published on 2026-08-26 and is the current registry release observed for this
task. Its prebuilt libvips 8.18.6 exceeds the advisory's patched 8.18.3 floor.
The [0.35 upgrade notes](https://sharp.pixelplumbing.com/changelog/v0.35.0/)
require Node 20.9 or newer; the existing Node 22 CI runtime satisfies this.
Optional platform dependencies are retained as required by the
[installation guidance](https://sharp.pixelplumbing.com/install/).

The lockfile delta is confined to root sharp metadata, sharp itself and 26
`@img/sharp-*` platform/libvips entries. Two optional platform packages are added
by sharp's manifest: FreeBSD and WebContainers WASM wrappers. Existing unrelated
package records, production dependencies, lint rules and coverage are unchanged.
No broad audit fix, decoder blocking, unsafe limit override or risk waiver is used.
The upstream default input-channel limit is now five; existing PNG artwork uses
four channels. Input selection and processing options in the icon generation path
are unchanged. Compatibility evidence covers repository PNG artwork, not arbitrary
mislabeled uploads or every format supported by libvips.

The unmodified tool was run with old and patched dependencies in separate directory
copies containing the existing thirteen 1024×1024 PNG sources. Across all five
sizes (88, 176, 256, 192 and 512), the 130 output images have identical filenames,
formats, dimensions, decoded RGBA pixels and alpha values. The manifest is byte
identical. All 65 WebP files are byte identical. Fourteen PNGs differ only in
compressed IDAT bytes: their inflated scanlines and every other PNG chunk match.
These are the thirteen 88-pixel PNGs and the 512-pixel `shia-baby` PNG.

The compatibility helper retains existing PNG bytes only when all sharp-exposed
metadata except encoded size agrees and decoded RGBA bytes match exactly. It
reports these encoding differences explicitly. Different pixels, alpha, dimensions,
metadata, formats or unreadable derivatives still count as drift. WebP and manifest
checks remain byte comparisons. Neither source artwork nor committed derivatives
are replaced. This avoids changing immutable URLs merely to accommodate a new
compression library.

`tests/integration/icon-tool.test.ts` exercises an independently recompressed PNG,
pixel/alpha/geometry/metadata/format/decode differences, and the actual CLI using
existing artwork and derivatives in a disposable directory. It verifies that both
generation and checking retain compatible bytes, and that a failed check leaves
damaged image/manifest files untouched. It runs through the existing full test
suite and gauntlet without workflow changes.

Task evidence is retained on PR #20 and in the task's ignored evidence directory:
full/production audits, dependency records, loaded versions, command stdout/stderr
and exits, per-file image hashes/metadata, exact-candidate lint/TypeScript/gauntlet,
disposable CI artifacts, fresh independent review and actual pinned Factory
receipts. An initial unchanged baseline icon check timed out at 180 seconds; its
timeout and subsequent successful longer run are retained. The unchanged patched
tool's initial byte check failed on the fourteen encoding differences; that report
is retained alongside the compatibility verification. Final candidate SHA/tree,
CI identities and Quality verdict are recorded in the stop checkpoint rather than
predicted here.

The new task uses the unchanged pinned Factory/BORIS governance APIs and a distinct
ledger linked to the previous stop. The actual available lint ledger remains
unchanged. The old `/tmp/shia-pr19-merge/governance.sqlite` database and historical
closeout remain unavailable; serialized snapshots are audit context, never
reconstructed approval authority. Consumed budgets remain: Factory architecture
two repairs, persistence one; artifact retention 1/1; lint enablement zero automatic
post-review repairs; lint remediation implementation 1/1 and zero post-review
repairs. This task adds one implementation pass, with no automatic further repair.

Factory source/policy/pin, receipt validation and deployment safeguards are unchanged.
Factory remains `d380dfbd4cc65466f6757c680e654a967d2749e0`; Michel main remains
`50403bcd52425d3f49788905ebd81962647e2d39`. Browser/visual/accessibility evidence,
release-consumer policy requirements and production lifecycle/approval evidence
remain separate requirements. Image equivalence, clean audits and disposable CI
do not constitute full application certification. Phase 7 remains 1/4 and Core v2
remains 31/41 = 75.61%; no production, publication, Shelf or Phase 8 work is authorized.
