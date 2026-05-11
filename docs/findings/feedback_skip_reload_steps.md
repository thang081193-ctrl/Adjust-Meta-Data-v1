---
name: List reload steps when needed, but never re-question them
description: Include extension reload / page F5 in test instructions when the code change requires them. Do NOT ask back to confirm they did it, and do NOT diagnose unexpected behavior as "you probably forgot to reload".
type: feedback
---

# List reload steps when needed, but never re-question them

When a code change needs an extension reload or page refresh to take effect, list those steps as part of the test plan so the procedure is fully spec'd. The user does the reloads themselves automatically — treat them as done.

**Don't:**
- Ask "did you reload the extension?" / "did you F5?" after a result is reported.
- Re-list reload steps in follow-up turns when behavior is unexpected — assume they happened.
- Suggest "maybe the bug is because the extension wasn't reloaded" as a diagnosis — they'd mention if unsure.

**Why:** user corrected me explicitly: tell me the steps to standardize the extension once (so I know what's needed), then trust I did them. Don't loop back on it.

**How to apply:** when handing off a code change, write the full test plan including any required reload action, then jump straight to verifying results. If a test seems to fail due to staleness, prefer re-examining the code over questioning whether they reloaded.
