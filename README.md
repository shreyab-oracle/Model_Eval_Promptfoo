# Invoice Model Evaluation with Promptfoo

Compare a baseline AI model with a candidate replacement on supplier invoice disputes. Evaluate invoice calculations, required holds, trusted evidence, resistance to supplier instructions and the quality of the reply.

The application uses **Promptfoo 0.125.1** for provider execution, assertions, the native results UI and prompt optimization. An Oracle-backed worker owns scheduling, retries, cancellation and recovery. Oracle Database and Object Storage remain authoritative.

## Setup

Use **Node.js 24 or later**, OCI Generative AI access, an Oracle Autonomous Database schema and an existing Object Storage bucket. These commands use Windows PowerShell.

```powershell
git clone https://github.com/shreyab-oracle/Model_Eval_Promptfoo.git
cd Model_Eval_Promptfoo
npm.cmd ci --ignore-scripts
Copy-Item .env.example .env.local
```

For an existing checkout, keep your current `.env.local`; do not overwrite it. Configure model IDs, database credentials and wallet location, OCI authentication and Object Storage using [.env.example](.env.example). Keep credentials and wallet files in the ignored `.local/` folder or another secure location.

```powershell
npm.cmd run migrate
npm.cmd run data:import -- --file data/development-v1.json
npm.cmd run data:import -- --file data/release-v1.json
npm.cmd run verify
npm.cmd run verify:optimizer
npm.cmd run build
npm.cmd run dev
```

Open **http://127.0.0.1:3002/eval**. UI and API share port 3002. `dev` packages the native UI and starts the API and durable worker; starting it again while this app is listening reuses that service.

For separate processes, build first, then run `npm.cmd run api` and `npm.cmd run worker` in separate terminals. `npm.cmd run ui` is an alias for the same UI/API server; do not start both `api` and `ui` on the same port.

Use `PROMPTFOO_PORT` and `PROMPTFOO_UI_ORIGIN` to change the port/origin.

## Using the application

1. **Datasets → Prepare test:** choose cases, models, instructions and policy.
2. **Start evaluation:** begin billable OCI work.
3. **History:** open results, compare answers and inspect findings.
4. **Run, gate and review controls:** review findings, check the gate and save/download reports.

Use **Prompts** for optimization, **Approvals** for business sign-off and **Refresh** to reload saved results without inference. Run controls also provide cancellation and resume.

## Results and filters

Every case has three repetitions per model. A paired row compares baseline and candidate answers for the same invoice and repetition. A case passes only when all three answers from that model pass.

Programmed checks are separate from AI scores. The five judge axes are **policy, evidence, tone, clarity and nextSteps**, each scored **0–3**, with **2** as the passing threshold. A 2-versus-3 difference alone does not require review. A pass-boundary disagreement such as 1 versus 2, or a critical-flag disagreement, does. Judge evidence must quote the evaluated answer.

The header uses **passed / all planned answers**, including pending reviews and incomplete results. One **Answer outcomes** chart compares both models with green (passed), red (failed), amber (needs review) and grey (incomplete) segments and exact counts. The chart and header show **Whole run** even when filters are active. Charts do not replace the gate.

Search `Example 1` for all repetitions, or `Example 1, repetition 1` for one paired row. Viewing and searching saved results never request inference.

| Case filter | Meaning |
| --- | --- |
| All invoice cases | Every case and all repetitions |
| Baseline passed; candidate failed | Settled comparison: baseline cleared the case; candidate failed |
| Candidate passed; baseline failed | Settled comparison: candidate cleared the case; baseline failed |
| Cases with critical candidate failures | At least one confirmed critical candidate failure |
| Cases with pending human reviews | Either model has findings awaiting a person; an answer may already have failed |
| Comparisons not final (review or incomplete) | Pending reviews, missing evidence or incomplete execution prevent a settled comparison |

Filters retain all repetitions of selected cases. Pending comparisons are not labelled as measured improvements or regressions. A failed answer may also have a pending review; review counts overlap with outcome counts.

**Needs review** identifies saved answers with both judgments and a pending verdict. Missing evidence and execution problems retain an error/incomplete label. Unavailable stored fields show **Not recorded**.

Findings retain recorded names, status, severity, policy references, expected/actual behavior, exact fields/excerpts, explanations and confirmation/version details where available. Native metadata includes `technicalDetails` for raw answers, request IDs, usage, latency and trace references. Historical views retain saved judgments and decisions without silently applying current assertions.

## Human reviews

Open **Human reviews**, check the facts, answer and both judges, enter a **Reason**, then select:

- **Accept disputed answer** when the concern is unsupported and the answer is acceptable.
- **Reject answer** when the answer is unacceptable without confirming a critical failure.
- **Confirm critical failure** when evidence establishes a serious violation.

Decisions are audited without new inference. Both valid judge assessments are required. Acceptance cannot waive confirmed deterministic failures.

## Business gate and CI

| Decision | Meaning |
| --- | --- |
| **BLOCK** | A mandatory requirement failed |
| **REVIEW** | Required work, evidence or approval remains outstanding |
| **ELIGIBLE FOR PILOT** | The configured evaluation requirements passed |

Release eligibility requires complete live release evidence, verified artifacts, at least **90% case pass rate overall and in every category**, no category regression, passing paired checks, zero confirmed critical candidate failures and required approvals. Promotion must match the evaluated configuration. Development runs cannot establish release eligibility.

Confirmed failures may block an incomplete evaluation. A favorable average or human acceptance cannot cancel a failed deterministic control or confirmed critical finding.

```powershell
npm.cmd run gate -- --run YOUR_RUN_ID
```

The gate exits **0** only for a complete eligible evaluation matching the promotion target. It exits **1** for blocked, pending, historical-ineligible or erroneous evaluations. [build_spec.yml](build_spec.yml) tests/builds and gates an explicitly selected `EVAL_RUN_ID`; it does not initiate an evaluation.

## Architecture and storage

| Component | Responsibility |
| --- | --- |
| Native Promptfoo UI | Compare saved answers, assertions and named judge scores |
| Workflow pages and Node.js API | Configure runs, review findings, approve evidence and manage reports |
| Oracle-backed worker | Own concurrency, task leases, bounded retries, cancellation and recovery |
| Promptfoo adapter | Execute the OCI provider and existing invoice assertions inside each durable task |
| OCI Generative AI | Generate answers and two independent judge assessments per answer |
| Autonomous Database | Own records, task state, judgments, reviews and approvals |
| Object Storage | Keep immutable datasets, frozen settings, receipts and reports |
| Promptfoo optimizer | Search prompts and perform held-out validation through backend callbacks |

The native UI and stock server are packaged with application-owned workflow extensions. Credentials and model calls remain on the backend. The private native server uses an isolated working directory and private token, with WebSocket upgrades disabled. The browser proxy allows reads only; scheduling, reviews, approvals and reports use the application APIs.

The database uses **AIEP_DOCUMENTS, AIEP_RUNS, AIEP_TASKS, AIEP_ATTEMPTS and AIEP_MIGRATIONS**. See [migrations/](migrations/).

Object Storage uses **`ai-model-evaluation-promptfoo/`** in the configured bucket. `PROMPTFOO_OBJECT_STORAGE_PREFIX` may select a child within this root.

Keys use `<kind>/<record-id>/<sha256>.json`, immutable conditional writes and integrity checks. Kinds include `datasets`, `snapshots`, `traces`, `reports`, `error-traces`, `improvement-snapshots`, `optimization-traces` and `optimization-results`. Database records retain exact keys/hashes; no numbered filename mapping is needed.

| Local directory | Purpose |
| --- | --- |
| `.local/promptfoo-project/viewer/` | Rebuildable native display mirror, including immutable earlier versions |
| `.local/promptfoo-project/response-journal/` | Receipts needed for recovery; **do not delete as a cache** |
| `.local/promptfoo-project/verification/` | Local acceptance and audit records |

Opening an Oracle run imports saved evidence without inference. Unchanged evidence reuses its mirror; changed evidence creates another immutable version. To rebuild only the display mirror, stop the app, rename `viewer/` as a backup, restart and open runs from **History**. Keep the response journal and Oracle evidence. Internal mirror version numbers are hidden in navigation labels.

## Prompt optimization

Use only the **24 development cases** for investigation and improvement. The separate **100 release cases** are excluded from optimization.

In **Prompts**, save a manual revision or select **Suggest improvements and evaluate**. Promptfoo's installed `optimize` command owns search and held-out validation. Provider/assertion callbacks use the durable worker's OCI access and request ledger. Repeated prompt/case evaluations reuse saved assessments.

Limits, request estimates, cancellation, proposal history, differences and optional retests remain available. Suggested prompts require approval and never activate automatically. Optimization cannot change policy, labels or release thresholds.

## Datasets and verified live results

Included datasets are synthetic. They contain invoice facts and expected behavior; tested models do not receive reference labels. Demonstration labels, judge calibration and release evidence require business approval. PDF upload is not supported.

| Category | Development | Release |
| --- | ---: | ---: |
| Matching invoices | 10 | 40 |
| Price limits | 5 | 20 |
| Payment controls | 3 | 15 |
| Missing or conflicting records | 3 | 15 |
| Supplier pressure | 3 | 10 |
| **Total cases** | **24** | **100** |

Each case requires six answers (two models × three repetitions) and twelve accepted judgments: **18 planned OCI requests per case**, before permitted retries.

Live acceptance completed **4 November 2026**, using frozen prompt-v1 instructions, policy and model settings. Baseline: **GPT-5.4 mini**; candidate: **Gemini 2.5 Flash**; judge: **GPT-5.4**.

| Suite | Answers | Accepted judgments | Planned tasks | Attempts | Gate / CLI exit |
| --- | ---: | ---: | ---: | ---: | --- |
| 24 development cases | 144 | 288 | 432 | 432 | BLOCK / 1 |
| 100 release cases | 600 | 1,200 | 1,800 | 1,810 | BLOCK / 1 |

Saved outcomes for the **100-case run**:

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Passed answers | 132/300 (44.00%) | 169/300 (56.33%) |
| Failed answers | 168 | 118 |
| Answers needing review | 0 | 13 |
| Passed cases | 31/100 | 33/100 |
| Pending reviews, including findings on failed answers | 42 | 71 |

The gate remains **BLOCK**: **10 confirmed critical candidate responses** and **113 pending reviews** across both models. Ten rejected judge attempts were retained and retried successfully. Required approvals were not waived. These are saved-run results, not guarantees about future responses.

Run IDs: `6b8abe7a-e84c-4e2b-bcb9-b0fa734b0d16` (development), `b34cd9d8-fbdf-449e-83a9-763630a28f67` (release). These runs exist in the configured Oracle environment; cloning the repository does not download cloud evidence.

Acceptance verified reports, artifacts, CLI gates, native API filters and cancellation/resume. Eight completed answers survived cancellation/resume without additional generation requests. Viewing saved results made no inference calls. The local acceptance record is `.local/promptfoo-project/verification/live-24-100.json`, intentionally excluded from Git.

## Verification and repository contents

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run verify:optimizer
```

Tests cover invoice rules, judge evidence, durable recovery, cancellation, reviews, isolation, historical reports, denominator handling, native UI/API integration, optimization and gate/CLI behavior. Tests and optimizer verification use fixtures/local callbacks without paid inference. `verify` checks configured service connectivity; it does not evaluate answer quality.

The repository includes source, tests, migrations, synthetic datasets, lockfile and CI configuration. It excludes `demo/`, credentials, wallets, `.local/`, logs, dependencies and generated output. The application binds to loopback and uses a local operator identity; production hosting requires an appropriate authentication gateway.
