# Session retention policies

## Problem

[Discussion 3876](https://github.com/openchamber/openchamber/discussions/3876) asks for sessions to leave the active list when their work is finished and return when prompted. Archiving is reversible. Deletion is not. The existing retention runner already owns complete-session loading, runtime isolation, child-first deletion, and the five-session safety reserve.

## Caller experience

Settings offers independent switches for archiving after inactivity, archiving merged linked pull requests, restoring on prompt, excluding pinned sessions, and deleting old archived sessions. Each age policy has its own period. New automatic actions default off. Existing cleanup preferences keep their meaning.

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

Periods accept whole days from 1 through 365. The existing legacy cleanup controls remain separate so an upgrade cannot silently enable deletion or change a saved policy.

`session-retention.ts` remains the owner of candidate selection and execution. Policies become named variants rather than combinations of action and archive flags. The main application supplies its runtime GitHub API to the runner. The runner returns completed and failed IDs and never converts failed discovery into an empty authoritative result.

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

runAutomaticSessionRetention({ github }): Promise<AutomaticRetentionResult>;
```

The policy owner hides session loading, activity checks, pin protection, merge checks, runtime changes, and action ordering from the hook. The hook owns wakeups and disposal only. Model the Domain motivates the policy union. Type System Discipline keeps unknown or failed PR status distinct from merged status.

## Eligibility and safety

- Inactivity uses session activity time. Archived deletion uses the archive timestamp.
- Current, running, queued, blocked, shared, and temporary side-conversation sessions stay protected. A successful authoritative active-status read is required before automatic mutation.
- Pin exclusion uses the existing runtime, directory, and session pin identity. Pins are device-local today. The settings must not imply a server-wide pin policy.
- The five most recent sessions in each age-policy scope remain protected, as with existing cleanup.
- Merge archiving uses explicitly linked GitHub PR identities, not a branch-name guess or persisted PR cache. All linked PRs must have a confirmed merge timestamp. Guest PR links without an authoritative merge API block this policy.
- Activity after a PR merge prevents that merge from archiving the session again. A prompt or restore that races a merge read must win.
- Deletion never reaches an active descendant through its parent. Children run first. A failed or newly protected child blocks its ancestors but not unrelated sessions.
- Settings and session state are rechecked before mutation. A runtime switch cancels the old run. Unknown activity, missing directories, failed reads, and incomplete session lists prevent mutation.
- Prompt restoration belongs to the delivery owners, including server-owned queue delivery. Restoring in the composer alone is insufficient.

## Alternatives and synthesis

A server scheduler would run with every client closed and could serialise mutations centrally. It cannot honour the existing browser-local pins or selected-session protection without introducing new persistence and presence contracts. It would also duplicate the VS Code retention owner. Extending the shared runner preserves those contracts and keeps the feature available in every existing client.

A passive subscriber to cached branch PR status avoids new reads but cannot distinguish explicit linked PRs, fork identities, stale data, or later session activity. It is not sufficient authority for archiving.

The chosen base is the shared runner with fresh explicit PR reads and delivery-owned restoration.

## Runtime coverage

| Runtime | Behaviour |
| --- | --- |
| Web | Shared settings and foreground retention. Server prompt delivery restores archived sessions when enabled. |
| Electron | Shared settings and foreground retention against the selected backend. Backend owns prompt restoration. |
| VS Code | Shared settings and foreground retention. Extension and shared delivery paths preserve restoration semantics without a web server. |
| Hosted mobile | Same backend and settings. Retention runs only while the main application is active. |
| Capacitor mobile | Same remote-backend contract. Suspension does not promise background retention. |

## Verification plan

1. Preserve the existing retention baseline. All 23 existing tests pass before changes.
2. Test independent policy periods, defaults, settings round trips, pins, hierarchy protection, and malformed records.
3. Test fresh merge identity, partial PR failures, post-merge activity, concurrent prompts, failed status reads, runtime switches, queue protection, and overlapping cleanup.
4. Test prompt restoration through immediate and queued delivery, including failed restoration and disabled behaviour.
5. Run settings registry generation, affected package checks, focused tests, dead-code analysis, and a browser check of the actual settings controls.
