# HDR profile style cleanup

## Scope

Authorized fix: apply `C:\mods\renodx\docs\CXX_STYLE.md` to the ICC generator and
AVIF metadata insertion formerly in `native/hdr-avif/profile.h`. Inspected the
entire former header, `bridge.cpp` caller and exception paths, CMake target,
native conversion tests, and RenoDX formatting configuration/review procedure.
The existing PNG decoder, encoder and CLI are inspected as caller contracts, not
included in a wholesale style rewrite. Existing unrelated changes are preserved.

## Implementation

- Inline both single-use header functions at their sole caller in `Convert`.
- Delete the implementation header instead of retaining a one-consumer `.hpp`.
- Remove the container-shortening alias; use explicit container types.
- Use descriptive snake_case locals, uppercase constants, explicit casts,
  braced work statements and declaration-order designated initializers.
- Use C++20 for standard designated initializers.
- Keep profile data and AVIF offset handling unchanged.

## Helper and entry-point inventory

All remaining profile/tagging lambdas are local to `Convert`:

| Definition | Actual callers | Disposition |
|---|---|---|
| `put_profile_integer` | `make_xyz_tag`; curve, description, adaptation, directory and header serialization in `Convert` | Reused local serializer |
| `put_profile_text` | `make_xyz_tag`; curve, description, adaptation, directory and header serialization in `Convert` | Reused local serializer |
| `make_xyz_tag` | white-point, luminance, three primary tags and header illuminant in `Convert` | Reused local tag builder |
| `read_integer` | scanner; color validation; ancestor sizing; item-location parsing in `Convert` | Reused local reader |
| `put_integer` | ancestor sizing; base relocation; extent relocation in `Convert` | Reused local writer |
| `scan_boxes` | initial scan in `Convert` and recursive container traversal | Recursive callable; deferred declaration documented |
| Former `buildHdrProfile`, `embedProfile` | Previously one call each | Removed/inlined |
| `Convert` | Three branches of staged `main`: stdio, explicit output and dropped files | Multiple call sites; experimental quality/speed options remain unstaged |

## Failure-path audit

| Condition | Classification and Release handling |
|---|---|
| Invalid/out-of-range AVIF integer reads, writes or overflow | Required metadata operation failure: throw descriptive exception |
| Truncated/unsupported boxes, unexpected primary color property | Required metadata operation failure: throw rather than emit invalid output |
| Unsupported item-location version/storage or truncated locations | Unsupported encoding with no valid fallback: reject with exception |
| Allocation/serialization exception | Free libavif output in catch and rethrow |
| Exception propagated from profile block | All three staged `main` invocation paths catch standard exceptions, print concrete diagnostics and return/set failure status |
| Scanner completion and box search `break`; non-iloc `continue` | Normal traversal control flow, no silent failed operation |

## RenoDX review checklist

| Check | Status | Evidence |
|---|---|---|
| Scope/final-source coverage | Pass | Profile implementation and insertion block inspected; caller paths inspected separately |
| Helper reuse | Pass | Inventory above; no single-use extracted profile helpers remain |
| Failure policy/Release behavior | Pass | Throw/free/rethrow/CLI diagnostic path remains active without assertions |
| DRY/local readability | Pass | One native generator; no JS oracle, byte header or forwarding helpers |
| Naming/initialization/boundaries | Pass | Scoped code uses local lambdas, snake_case, ordered designated initializers and no implementation header |
| Formatting | Pass | Full `bridge.cpp` passes `clang-format --style=file:C:/mods/renodx/.clang-format --dry-run --Werror` after the authorized broader formatting pass |
| Parameters/ownership/lifecycle | Pass | Mutated byte vectors use pointers; observed XYZ input uses const reference; color pointer retained only while box vector is unchanged; output freed on exception |
| Concurrency/cross-addon ABI | N/A | CLI-local state, no shared module data or registration |
| API compatibility | Pass | CLI modes, profile fields and metadata layout preserved; target now requires C++20 |
| Graphics-domain integration | N/A | No ReShade, GPU resources or hooks |

## Validation

Final C++20 native build succeeded. All six focused conversion tests passed,
including native ICC metadata/curve assertions, one-pixel dimensions, file/pipe
identity, malformed input, output limit and no-overwrite checks. `git diff
--check` passed. `npm run check` was rerun and remains blocked by the three
unrelated no-undef diagnostics in `.private/import-historical-csv.mjs`.
Editor diagnostics still lack the libavif include path; the actual native build
resolves that header successfully. No claim of clean editor diagnostics.

## Limitations

No blanket claim of whole-file RenoDX compliance: pre-existing encoder/PNG/CLI
style remains outside the profile cleanup. The broader formatting pass resolves
all formatter findings; it does not establish whole-file naming, helper or failure-policy compliance. Final migrated
source was reread after inlining to verify helper callers, box pointer lifetime,
exception cleanup and unchanged profile fields.