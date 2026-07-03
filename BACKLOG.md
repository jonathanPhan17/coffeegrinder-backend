# Backlog

Deferred items surfaced during implementation. Remove an entry once it's resolved —
this file should only ever reflect what's still outstanding.

## parseFailed handling

`ParseResume` worker throws on parse failure but there's no `parseFailed` state
surfaced to the frontend. Needs a coordinated `domain.ts` change (frontend has no
field for it yet) before this can be picked up.
