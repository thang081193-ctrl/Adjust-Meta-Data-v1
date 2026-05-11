---
name: Always render pipeline-state UI, don't hide on partial data
description: When a numeric pill/widget can't compute its final value, render it with placeholder values (e.g. "Today: –/0.76") rather than hiding it. Hidden UI looks identical to broken UI.
type: feedback
---

# Always render pipeline-state UI, don't hide on partial data

When designing pills/widgets that show a computed metric (ROAS, ratio, %, etc.), **never hide the element just because one input is missing or zero**. Always render with a placeholder for the missing piece so the user can see the pipeline is alive and which side is missing.

**Why:** Hidden UI is indistinguishable from broken UI. When the user looks at a row with no today pill, they can't tell whether (a) the extension is broken, (b) the column isn't enabled, (c) Adjust returned no data, or (d) spend is zero. A pill showing `Today: –/0.76` immediately answers: pipeline works, Meta spend is read, but Adjust has no revenue for this row yet. That's actionable.

**How to apply:**
- For the Today pill specifically: render `Today: ${rev}/${spend}` always, even when one or both are `–`. Add the ROAS `(NN%)` only when both are present and spend > 0.
- Counters that USED to gate render (zero-spend / no-Adjust-data) are removed entirely — the render always proceeds and the missing side shows as `–`.
- Only truly skip render when: ambiguous row (today not meaningful on aggregate), or the column locator failed (nothing to anchor against).
- Currency mismatch is a special case — still render but show both numbers + the mismatch direction (`Today: 5.20/100,000 (USD→VND)`) so the user understands why the % is omitted.

This is a general principle, not Today-pill-specific. Apply to any future computed widget in this extension.
