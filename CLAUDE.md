# Coffeegrinder Backend — Working Notes

When a fast-follow or deferred item is identified during implementation (a known
gap, a fix intentionally postponed, a coordinated change blocked on another repo),
append it to [BACKLOG.md](./BACKLOG.md) with enough context to pick it up cold in a
future session.

When a backlog item is resolved, remove its entry from BACKLOG.md rather than
marking it done — the file should only ever list what's still outstanding.

A slice is not done until [ARCHITECTURE.md](./ARCHITECTURE.md) is true again. If a change
overturns a decision recorded there, update the doc in the same commit as the change.
ARCHITECTURE.md has two layers — the top-of-doc design (stack table §2, components §3,
end-to-end flow §4) and the as-built build-phase notes (§9). When a decision changes, fix
BOTH: a §9 note that contradicts the design sections above it is itself the drift (this is
how the "Distributed Map" and "webhook" lines went stale after we shipped the inline Map and
the Apify poll loop). After shipping, ask "what did I just make untrue?" and grep the doc for
it.

Comments come in two registers, and the register must match the audience. Use JSDoc
(`/** ... */`) for the consumer-facing contract — put it directly above an exported (or
module-level) function, class, type, interface, or schema so it surfaces in IDE hover: what
it is, params/units, return shape, architectural summary. Use inline `//` inside a body for
the maintainer-facing why — the non-obvious hazards (billing traps like "never retried, would
pay for a second run", IAM-scope justifications, concurrency races, timeout/cross-stack
coupling, the "why this value" behind a constant). Cut the property-echo: a comment that just
English-translates the code it sits on (`// create the bucket`, restating `versioned: true`)
is noise — delete it, or if it is a real architectural summary on an export, promote it to
JSDoc rather than dropping it. When a change alters behavior a comment describes (a cache
percentage, "at-least-once", a timeout), the comment rides in the same diff — a stale comment
is drift, same as a stale doc.
