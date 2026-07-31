---
'@finalrun/common': patch
---

`REASONING_LEVELS_LABEL` is now exported from the package root. Moving it
(with `parseReasoningLevel`) from `env.ts` into `constants.ts` placed it
under the pre-existing `export * from './constants.js'` in `index.ts`, so
the root surface gains one symbol. Purely additive: nothing was removed,
and every pre-existing export binding is unchanged.
