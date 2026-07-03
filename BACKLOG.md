# Backlog

Deferred items surfaced during implementation. Remove an entry once it's resolved —
this file should only ever reflect what's still outstanding.

## parseFailed handling

`ParseResume` worker throws on parse failure but there's no `parseFailed` state
surfaced to the frontend. Needs a coordinated `domain.ts` change (frontend has no
field for it yet) before this can be picked up.

## Resume-structure prompt polish

Both are prompt tweaks in `src/ai/resume-structure.ts`; low priority. Worth waiting to
see how the matching scorecard actually consumes these fields before tuning.

- **Skills near-duplicates.** A real parse returned both `React` and `ReactJS` (also
  variant/abbreviation pairs generally). The tool schema says "deduplicated" but the
  model splits synonyms — tighten the `skills` description to "merge synonymous skills;
  don't list both a technology and its abbreviation/variant."
- **Third-person `experience`.** Output is written in third person using the
  candidate's name ("Max is a full-stack developer…"). If the UI renders it as the
  candidate's own summary, switch the prompt to first-person or name-agnostic phrasing.
