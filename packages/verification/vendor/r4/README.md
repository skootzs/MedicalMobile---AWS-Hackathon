# Vendored R4 evaluator

Vendored copy of R4's evaluator from a zip, **NOT pinned to a commit**. Replace
with the pinned R4 commit when pushed. **Do not edit** these files.

Layout (required by R4's imports):

```
packages/schema/validate.py
packages/schema/src/logic-model.schema.json
packages/evaluator/evaluate.py
packages/evaluator/condition_evaluator.py
packages/checker/check_model.py
```

`MANIFEST.json` records a sha256 per file and `evaluatorHash` (sha256 over the
sorted `path<TAB>sha256\n` lines). The runner records which evaluator root it
used and recomputes the hash over the files actually loaded.
