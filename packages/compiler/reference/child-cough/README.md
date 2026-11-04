# Child cough reference form (Role 5, step 1)

> **TECHNICAL DEMONSTRATION ONLY. NOT CLINICIAN-APPROVED. NOT FOR PATIENT CARE.**
> The rules below are transcribed from a public WHO guideline to give the compiler a realistic target.
> No clinician has reviewed them, and the ambiguities listed below are still open.
> Clinician-approved logic will only exist after the content approval step (Vision Document, "Content approval").

This is a handwritten CHT app form: the exact kind of output the Role 5 compiler must later produce from an approved `LogicModel`.
It exists so that:

1. the compiler has a known-valid target to reproduce and diff against;
2. Role 4 can see which XLSForm constructs the `LogicModel` must be able to express (see `../../docs/logic-model-v1-proposal.md`);
3. Role 6 can start harness tests against a real form before the compiler exists.

## Files

| File | What it is |
|---|---|
| `child_cough.rows.json` | Handwritten survey, choices and settings rows. Keys starting with `_` are review notes (source, convention, ambiguity) and are not written to the form. |
| `cht-project/forms/app/child_cough.xlsx` | The XLSForm written from the rows file by `../write_reference_xlsx.py` (a cell copier, no logic). |
| `cht-project/forms/app/child_cough.properties.json` | Form title, icon and where the form appears in the app. |
| `../check_reference.sh` | Rebuilds the `.xlsx` and runs cht-conf conversion and validation. |

The converted `child_cough.xml` is build output and is git-ignored.

## How to run

```bash
# From the repository root. Needs cht-conf, Python 3.10+ with openpyxl, and xsltproc.
CHT=cht PYTHON=python3 packages/compiler/reference/check_reference.sh
```

The commands the script runs:

```bash
python3 packages/compiler/reference/write_reference_xlsx.py \
  packages/compiler/reference/child-cough/child_cough.rows.json \
  packages/compiler/reference/child-cough/cht-project/forms/app/child_cough.xlsx
cd packages/compiler/reference/child-cough/cht-project
cht --local --skip-dependency-check --skip-git-check convert-app-forms validate-app-forms -- child_cough
```

On macOS, cht-conf's bundled form converter unpacks itself into `~/.shiv`; set `SHIV_ROOT` to a writable folder if that location is blocked.

## Results (3 November 2026)

Environment: macOS arm64, Node.js 24.14.1, Python 3.13.5, cht-conf **6.6.1** (installed locally with `npm install cht-conf@6.6.1`), libxslt 1.1.35 (`xsltproc`).
This has **not** yet been run inside the pinned `medicmobile/cht-app-ide:v6.6.1` image (see "Depends on Role 7").

| Check | Command | Result |
|---|---|---|
| Toolchain baseline: Medic's own `pregnancy_danger_sign.xlsx` from cht-core `config/default` | `convert-app-forms validate-app-forms -- pregnancy_danger_sign` | Pass, exit 0 (warnings only: missing image columns, deprecated `NO_LABEL`) |
| This form | `check_reference.sh` | **Pass, exit 0.** Two warnings: "Group has no label" for the `contact` and `parent` groups inside `inputs`. cht-conf says group labels are not required, and the `NO_LABEL` alternative is deprecated |
| Negative 1: a `${...}` reference to a field that does not exist | same | **Fails as it should**, exit 1: "There is no survey element with this name" |
| Negative 2: a calculation with an unbalanced bracket | same | **Passes, exit 0.** The broken expression is copied into the XML unchanged |
| Negative 3: brackets dropped from `(chest_indrawing or fast_breathing)`, still valid XPath but different meaning | same | Passes, exit 0, as expected: conversion cannot know intent |
| Reproducibility: write the `.xlsx` twice from the same rows | `shasum` | `.xlsx` bytes differ (openpyxl stamps the save time into `docProps/core.xml`); the converted XML is **byte-identical** across runs (sha256 `8f9dc185…`) |

What this means for the compiler:

- cht-conf's offline conversion and validation is a necessary gate but **does not parse XPath expressions**. Negative 2 shows a syntax error passing.
  The compiler must therefore generate expressions from a structured condition tree, so brackets are balanced by construction, and Role 6's harness run (which executes the form in a browser) is the check that actually evaluates them.
- Negative 3 is the Vision Document's bracket bug in miniature: only running synthetic patients through the compiled form catches it.
- Artifact hashes should be computed from the rows and the converted XML, not from `.xlsx` bytes.
- Form behaviour (what each answer combination produces) has **not** been tested yet. That needs cht-conf-test-harness (Role 6).

## What CHT requires from the form, and where each convention comes from

| Requirement | How this form meets it | Source |
|---|---|---|
| App forms live in `forms/app/` as `<id>.xlsx` plus `<id>.properties.json`; cht-conf converts the XLSForm to `<id>.xml` | `cht-project/forms/app/child_cough.*` | cht-ai-tools `skills/cht-form-builder/references/cht-forms.md` §1 and §10 |
| Three sheets: `survey`, `choices`, `settings`; settings carries `form_title`, `form_id`, `version`, `style` | As written; `style: pages`, `default_language: en` | Same §2; cht-core `config/default/forms/app/pregnancy_danger_sign.xlsx` |
| An `inputs` group, relevant only when `./source = 'user'`, with `source`, `source_id`, and a `contact` group whose `_id` uses `select-contact type-person` | Copied structure from the reference form | `pregnancy_danger_sign.xlsx`; cht-forms.md §2 and §3 |
| Top-level `patient_uuid` / `patient_id` so the report links to the contact | `calculate` rows reading `../inputs/contact/...` | cht-forms.md §6 "CHT Special Top-Level Fields" |
| Pages as `begin group` with `field-list`; final page with `field-list summary` | `intro`, `danger_signs`, `breathing`, `summary` | cht-forms.md §2 and §8 |
| Hidden logic as `calculate` rows; yes / no / empty "unknown" pattern for derived flags | `any_general_danger_sign`, `classification`, etc. | `r_danger_sign_present` in `pregnancy_danger_sign.xlsx` |
| A follow-up date as a calculate with a `t_` prefix, for a task to read later | `t_follow_up_date` | `t_danger_signs_referral_follow_up_date` in `pregnancy_danger_sign.xlsx`; team registry `reference/reference_file.json` warm-up section |
| Do not use `NO_LABEL` | Omitted; unlabeled groups give a harmless warning | cht-conf 6.6.1 warning text |
| `icon` must be a key in the project's `resources.json` | `icon-child` | cht-core `config/default/resources.json` |
| Version fixed, not `=NOW()` | `reference-1` | Team requirement that the same input gives the same artifact (Role 5 milestone) |

Reference sources were read from: cht-core `config/default` (sparse clone of `master`, 3 November 2026) and cht-ai-tools branch `feat/add-cht-form-builder` at commit `d24c96e`.

## Source trace (clinical content)

Source: WHO, *Integrated Management of Childhood Illness Chart Booklet*, March 2014. PDF sha256 `d10fd1d0…a6959f`. Page numbers are PDF pages.

| Form element | Guideline passage |
|---|---|
| Applies to ages 2 months up to 5 years | p.5–6 "SICK CHILD AGE 2 MONTHS UP TO 5 YEARS" |
| Cough or difficult breathing question | p.6 "Does the child have cough or difficult breathing?" |
| Five general danger signs | p.5 "CHECK FOR GENERAL DANGER SIGNS"; p.64 "NOT ABLE TO DRINK OR BREASTFEED" |
| Count breaths for one minute; child must be calm | p.6 |
| Fast breathing: 50 or more per minute from 2 up to 12 months; 40 or more from 12 months up to 5 years | p.6 |
| Chest indrawing; stridor in a calm child | p.6 |
| SEVERE PNEUMONIA OR VERY SEVERE DISEASE (any general danger sign, or stridor in a calm child): refer urgently | p.6 |
| PNEUMONIA (chest indrawing or fast breathing): follow up in 3 days | p.6 |
| COUGH OR COLD (no signs of pneumonia or very severe disease): follow up in 5 days if not improving | p.6 |

## Open ambiguities (need a clinician or Medic; none are resolved in the logic)

| ID | Ambiguity | What the demo form does for now |
|---|---|---|
| A1 | "2 months up to 12 months" and "12 months up to 5 years": is 12 months in the first or second band, and is age measured in completed months? | Uses completed months from date of birth: 2 ≤ age < 12 → 50; 12 ≤ age < 60 → 40 |
| A2 | What a community health worker should do for a child outside the age range (under 2 months uses a separate young-infant chart) | Shows a "do not use this form" note and classifies nothing |
| A3 | WHO checks general danger signs for every sick child; this pathway only asks them when cough is present | Asks them only when cough or difficult breathing is "yes" |
| A4 | p.6: if wheezing with fast breathing or chest indrawing, give a bronchodilator trial, re-count, then classify | Not modelled; classifies on the first count. Wheeze is not asked |
| A5 | COUGH OR COLD follow-up is "in 5 days if not improving"; the form does not know whether the child improved | Sets a 5-day follow-up date unconditionally |
| A6 | No plausible upper bound for breaths per minute is given | Only checks `. >= 0` (a data-entry check, not a clinical rule) |
| A7 | The chart booklet is written for first-level facility health workers. Whether chest indrawing and stridor are appropriate for a CHW to assess is a clinical and programme decision | Asks them as written |
| A8 | Age comes from the contact's date of birth; if missing, the form stops | Shows "no date of birth recorded"; classification `age_unknown` |

## Deliberately omitted (listed so nothing is silently dropped)

| ID | Guideline content not in this form | Why |
|---|---|---|
| O1 | All treatment and medicines: first antibiotic dose, oral amoxicillin, inhaled bronchodilator, diazepam, safe cough remedy | The system does not dispense medication (team architecture document, "Purpose and output"); would need clinician approval |
| O2 | HIV exposed or infected child with chest indrawing: give amoxicillin and refer | Needs HIV status, which this form does not collect |
| O3 | Cough more than 14 days or recurrent wheeze: refer for possible TB or asthma assessment | Needs cough duration; kept out to keep the demo to one decision table |
| O4 | Pulse oximeter: refer if oxygen saturation below 90% | Device may not be available; optional in the guideline |
| O5 | "Advise mother when to return immediately" | Counselling content, not logic |
| O6 | The follow-up task itself (`tasks.js`) | Only the follow-up date is calculated; the task is later compiler work |
| O7 | Languages other than English | MVP is one language (Vision Document, Journey 1 limitation) |

## Depends on other roles

- **Role 4:** the `LogicModel` v1 grammar. The proposal is in `../../docs/logic-model-v1-proposal.md`; nothing in `packages/schema` was changed.
- **Role 6:** harness tests of form behaviour. The `classification`, `referral_urgent`, `follow_up_days` and `t_follow_up_date` fields are the proposed assertion points.
- **Role 7:** re-run `check_reference.sh` inside the pinned `medicmobile/cht-app-ide:v6.6.1` image on x86_64. The image is published for amd64 only. Also add Python with openpyxl to the build image if the team keeps a Python XLSForm writer.
