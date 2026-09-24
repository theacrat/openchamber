# Session retention policies

## Problem

[Discussion 3876](https://github.com/openchamber/openchamber/discussions/3876) asks for sessions to leave the active list when their work is finished and return when prompted. Archiving is reversible. Deletion is not. The existing retention runner already owns complete-session loading, runtime isolation, child-first deletion, and the five-session safety reserve.

## Caller experience

Settings offers independent switches for archiving after inactivity, archiving sessions whose branch PR has merged, restoring on prompt, excluding pinned sessions, and deleting old archived sessions. Each age policy has its own period. New automatic actions default off.

Automatic checks run while the main application is open, not while every client is closed. The settings explain this boundary. Manual archive, restore, and delete remain available regardless of these preferences.

## Data and ownership

The settings registry owns these instance preferences:

| Key | Default |
| --- | --- |
| `sessionAutoArchiveOnMerge` | `false` |
| `sessionAutoArchiveEnabled` | `false` |
| `sessionAutoArchiveAfterDays` | `30` |
| `sessionAutoUnarchiveOnPrompt` | `false` |
| `sessionRetentionExcludePinned` | `true` |
| `sessionAutoDeleteArchivedEnabled` | `false` |
| `sessionAutoDeleteArchivedAfterDays` | `30` |

Periods accept whole days from 1 through 365. The old cleanup controls are removed. Migration maps an enabled active-session archive to `sessionAutoArchiveEnabled` and its period. A missing old action uses the old default of archive. It maps an enabled archived-only cleanup to `sessionAutoDeleteArchivedEnabled` and its period. An old active-session delete policy has no safe equivalent and is discarded without enabling deletion. Existing new values always win. The migration removes all old keys and is idempotent.

`session-retention.ts` remains the owner of candidate selection and execution. Policies become named variants rather than combinations of action and archive flags. The main application supplies its runtime GitHub and Git APIs to the runner. The runner returns completed and failed IDs and never converts failed discovery into an empty authoritative result.

```ts
type AutomaticRetentionPolicy =
  | { kind: 'inactive'; days: number }
  | { kind: 'merged' }
  | { kind: 'archived'; days: number };

type AutomaticRetentionResult = {
  archivedIds: string[];
  deletedIds: string[];
  failedIds: string[];
};

runAutomaticSessionRetention({ github, git }): Promise<AutomaticRetentionResult>;
```

The policy owner handles session loading, activity checks, pin protection, merge checks, runtime changes, and action ordering. The hook owns wakeups and disposal only. Unknown or failed PR status remains distinct from merged status.

## Eligibility and safety

- Inactivity uses session activity time. Archived deletion uses the archive timestamp.
- Current, running, queued, blocked, and temporary side-conversation sessions stay protected. A successful authoritative active-status read is required before automatic mutation.
- OpenCode 2.x currently exposes no authoritative shared/public-session field in the session model. Until that upstream contract exists, the runner cannot identify shared sessions safely and does not claim protection based on metadata or URL heuristics.
- Pin exclusion uses the existing runtime, directory, and session pin identity. Pins are device-local today. The settings must not imply a server-wide pin policy.
- The five most recent sessions in each age-policy scope remain protected, as with existing cleanup.
- Merge archiving uses the existing thread-list branch PR status through the runtime Git and GitHub APIs. Explicit PR links are not required. This reversible action accepts the same branch association and status caching as the thread list; it does not add forced GitHub reads or require every linked PR to be merged. Missing, failed, or non-merged branch status grants no merge eligibility.
- Session activity after the reported merge prevents archiving for that merge. A restore watermark excludes an earlier PR1 merge while allowing a later PR2 merge on the same branch, provided the session has no activity after PR2 merged. Invalid or missing merge timestamps cannot establish that ordering.
- Deletion never reaches an active descendant through its parent. Children run first. A failed or newly protected child blocks its ancestors but not unrelated sessions.
- Settings and session state are rechecked before mutation. A runtime switch cancels the old run. Unknown activity, missing directories, failed reads, and incomplete session lists prevent mutation.
- These checks are reads followed by a separate mutation, not atomic admission. A prompt, restore, queue change, or another client's mutation can occur after the last read. Restore watermarks and rechecks reject observed stale candidates but do not guarantee that a concurrent prompt always wins. The runner lock serializes retention in one client only.
- Prompt restoration belongs to the delivery owners, including server-owned queue delivery. The restore contract requires persisting the watermark before clearing the archive state. Restoring in the composer alone is insufficient.

## Alternatives and synthesis

A server scheduler would run with every client closed and could serialise mutations centrally. It cannot honour the existing browser-local pins or selected-session protection without introducing new persistence and presence contracts. It would also duplicate the VS Code retention owner. Extending the shared runner preserves those contracts and keeps the feature available in every existing client.

A requirement for explicit PR links and fresh redundant GitHub checks was considered and superseded. The agreed policy uses the branch PR status already used by the thread list because archive is reversible. Session activity, restore ordering, settings, pins, queues, and blocking requests still govern eligibility.

Deletion retains its stricter age, complete-list, activity, and child-first checks. A merged branch PR alone never authorizes deletion. Prompt restoration belongs to delivery owners.

## Runtime coverage

| Runtime | Behaviour |
| --- | --- |
| Web | Shared settings and foreground retention. Server prompt delivery restores archived sessions when enabled. |
| Electron | Shared settings and foreground retention against the selected backend. Backend owns prompt restoration. |
| VS Code | Shared settings and foreground merge retention use branch `prStatus` from the existing web GitHub resolver bundled into the extension. It uses saved OpenChamber GitHub credentials or the `gh` fallback on the extension host, without VS Code authentication sessions. Extension and shared delivery paths own prompt restoration. |
| Hosted mobile | Same backend and settings. Retention runs only while the main application is active. |
| Capacitor mobile | Same remote-backend contract. Suspension does not promise background retention. |

VS Code branch status includes `mergedAt` and retains the shared resolver's fork
matching and checkout-ancestry checks for historical PRs. Missing credentials
return `connected: false`; request failures remain bridge errors. Both skip
merge archiving. The response reports `checks: null` and `canMerge: false`;
the full PR panel is not mounted in VS Code, and merge actions remain unsupported.

## Verification plan

1. Preserve the existing retention baseline and run its focused tests.
2. Test independent policy periods, defaults, settings round trips, pins, hierarchy protection, and malformed records.
3. Test branch-status eligibility without explicit links, failed PR reads, post-merge activity, PR1 restore followed by PR2 on the same branch, observed concurrent prompts, failed status reads, runtime switches, queue protection, and overlapping cleanup. Exercise the documented read/mutation race without claiming atomic exclusion.
4. Test prompt restoration through immediate and queued delivery, including failed restoration and disabled behaviour.
5. Run settings registry generation, affected package checks, focused tests, dead-code analysis, and a browser check of the actual settings controls.
