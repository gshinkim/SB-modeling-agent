---
name: tellurium
description: >
  Model, simulate, inspect, manipulate and analyse biochemical systems with
  Tellurium. Use for Antimony model building, te.loada / loadSBMLModel,
  RoadRunner simulate and integrator settings, stochastic (gillespie)
  simulation, steadyState and steady-state solvers, selections and
  amounts-vs-concentrations, reset / resetAll / resetToOrigin, computing metabolic
  control analysis quantities (getCC, getEE, elasticity and control-coefficient
  matrices; the MCA concepts, theorems and interpretation are in the mca Skill),
  stoichiometric and structural analysis (link matrix, conserved moieties),
  Jacobian and eigenvalues, parameter scans, plotting and r.draw, SBML / CellML /
  MATLAB conversion, and SED-ML / phraSED-ML / COMBINE inline-OMEX archives -
  or when debugging Tellurium code, output or install problems.
---

# Tellurium

## Read the reference files, every time

This file is the **index** of the Skill, not the Skill. On its own it is never enough
to answer from, and reading it is not the end of the job.

- For every question, open the reference, workflow and example files listed below that
  cover it, with your file-reading tool, **before** you answer, compute or write a model.
- **There is no limit** on how many you may open. Read every one that is relevant. If
  you are unsure whether a file applies, open it and find out.
- Still have a question? Open another file. That is the rule every time: a question
  means a file to read, not something to reason out.
- Never answer from this summary, from memory, or by going round the same reasoning
  again. If you notice you are repeating yourself, stop and read a file you have not read.
- **Then stop and answer.** Once the files you have read answer the question, write the
  answer. Reading on after that is as much a mistake as not reading: every extra file
  costs the user minutes (measured: eight files and 14 minutes on a question two answered).

"Model, simulate, and analyse biochemical systems using a single tool."
`[T:index]`

## Source-of-truth rule for this Skill

Every technical claim here traces to the official Tellurium documentation
(`https://tellurium.readthedocs.io/en/latest/`) or to a resource that
documentation links directly. The complete allowed-source graph, the provenance
tag convention, and the sources deliberately not used are in
`references/source_registry.md`.

Tags used throughout: `[T:page]` = a Tellurium documentation page,
`[L:rr/...]` = libRoadRunner documentation (linked from the Tellurium index
toctree), `[L:faq]` = the Tellurium FAQ wiki (same toctree),
`[L:simplesbml]`, `[L:sedml]`, `[L:antimony-sf]`.

**If a call, argument, setting or behaviour is not in `references/api_index.md`
or a reference file here, do not assert it.** Say the documentation does not
establish it, and offer the runtime check instead
(`getAvailableIntegrators()`, `getIntegrator().getSettings()`, `getIds()`,
`printVersionInfo()`). `references/limits_and_discrepancies.md` lists both the
documented non-capabilities and the places where two permitted sources disagree.

## What Tellurium is

Tellurium is a Python module that integrates a set of packages: **libroadrunner**
(the SBML ODE/stochastic simulator), **antimony** (human-readable SBML),
**phrasedml** (human-readable SED-ML), **libcombine**, **libsbml**, **libsedml**,
**simplesbml**, **sbml2matlab** `[T:appendix]`.

The practical consequence, and the single most useful thing to internalise:

```
te.loada(antimony_string)  ->  an ExtendedRoadRunner instance
                               = RoadRunner  +  Tellurium's additions
```

So a question about Tellurium is usually a question about **RoadRunner** (the
simulator API: `simulate`, `steadyState`, `getCC`, Jacobian, selections) wearing
Tellurium's conveniences (loading, conversion, plotting, jarnac shortcuts)
`[T:tellurium_methods]`. Tellurium's own docs point to the libRoadRunner
documentation for the simulator API `[T:index]`, and this Skill follows that
split.

## Activate this Skill when

- Any of: `tellurium`, `te.loada`, Antimony, `roadrunner`, `RoadRunner`,
  `libroadrunner`, `simulate(`, `steadyState`, `getCC`, `getEE`, `getFullJacobian`,
  `conservedMoietyAnalysis`, `getFullStoichiometryMatrix`, `phrasedml`,
  inline OMEX, `.omex`, `executeInlineOmex`, `ParameterScan`, `te.plot`,
  `r.draw()`, `tesbml`/`tesedml`/`tecombine`, `simplesbml`.
- Building, converting, simulating, scanning, analysing or packaging an SBML /
  Antimony / CellML biochemical model.
- Reading Tellurium or RoadRunner output: a simulation array, a steady-state
  residual, a control-coefficient or elasticity matrix, a stoichiometry or link
  matrix, eigenvalues.
- Computing MCA quantities (`getCC`, `getEE`, `getScaledFluxControlCoefficientMatrix`,
  `getScaledElasticityMatrix`). This Skill covers the calls and the numerics only.
  What a coefficient means, the summation and connectivity theorems, whether the
  numbers make sense, and control-distribution or rate-limiting claims are **not**
  here: load the `mca` Skill as well.
- Debugging Tellurium code, an integrator exception, a non-converging steady
  state, a suspicious coefficient, or a Tellurium install problem.

Do **not** activate for: MCA *theory* with no Tellurium/computational component
(use the `mca` Skill alone); pure libSBML programming with no Tellurium involvement;
general Python plotting questions.

## Default pipeline

Run only the stages the question needs; the routing tables pick the entry point.

```
Understand the request (which quantity is actually wanted?)
  -> Build or load the model
  -> VERIFY the loaded model is the intended model
     (species vs parameters, boundary vs floating, ids, stoichiometry, ODEs)
  -> Choose the operating regime: time course / steady state / stochastic
  -> Configure deliberately (integrator, tolerances, step size, selections, reset)
  -> Compute
  -> VALIDATE numerically (residuals, rates of change, step-size sensitivity)
  -> Label every row, column and axis from the model's own id lists
  -> Interpret - marked as interpretation, separate from the numbers
  -> State assumptions, versions, and the limits of what was established
```

Two stages are never skipped: **verify the loaded model** and **validate
numerically**. Most wrong Tellurium answers come from one of those two, not from
the science.

## Routing table — references

| The question is about | Load |
|---|---|
| installing, versions, front ends, notices, extra packages, environment errors | `references/setup_and_environment.md` |
| getting a model into Tellurium (`loada`, SBML/CellML, BioModels, test models) | `references/model_loading.md` |
| Antimony syntax: reactions, species, compartments, rules, events, signals | `references/antimony_basics.md` |
| Antimony beyond the basics: modules, imports, units, annotation, FBC, DNA strands, layout, SBML round-trip differences, supported SBML packages | `references/antimony_reference.md` |
| `simulate`, integrators, tolerances, step size, selections, stepping, sequential runs | `references/simulation.md` |
| gillespie, seeds, repeats, ensembles, deterministic-vs-stochastic comparison | `references/stochastic_simulation.md` |
| `steadyState`, residuals, solvers and their settings, non-convergence | `references/steady_state.md` |
| ids and values, amounts vs concentrations, selection grammar, ODE extraction, model editing, `saveState`, SimpleSBML | `references/model_access_and_editing.md` |
| stoichiometry matrices, link/L0/K matrices, conservation laws, conserved moieties | `references/structural_analysis.md` |
| `getCC`, `getEE`, elasticity and control-coefficient matrices, `DiffStepSize`, frequency response | `references/metabolic_control_analysis.md` |
| Jacobian, eigenvalues, multiple steady states, oscillation, bifurcation | `references/stability_and_dynamics.md` |
| `reset` / `resetAll` / `resetParameter` / `resetToOrigin`, `init(...)`, current vs loaded state | `references/reset_and_state.md` |
| parameter scans, `ParameterScan`, `SteadyStateScan`, uncertainty sweeps | `references/parameter_scans.md` |
| `r.plot` vs `te.plot` vs `te.plotArray`, overlays, tags, saving, `r.draw` | `references/plotting.md` |
| Antimony ↔ SBML ↔ CellML ↔ MATLAB conversion, export, current vs loaded | `references/format_conversion.md` |
| SED-ML, phraSED-ML, COMBINE archives, inline OMEX, notebook cells | `references/sedml_and_omex.md` |
| "does this function exist / what are its arguments?" | `references/api_index.md` |
| "is this supported?", conflicting docs, dead links, gaps in the source set | `references/limits_and_discrepancies.md` |
| "where did this claim come from?" | `references/source_registry.md` |

## Routing table — workflows

| The task is | Load workflow |
|---|---|
| build a model and simulate it | `workflows/build_and_simulate.md` |
| find / characterise a steady state, or its parameter dependence | `workflows/analyze_steady_state.md` |
| compute and report control coefficients or elasticities | `workflows/run_control_analysis.md` for the computation; also load the `mca` Skill to validate and interpret |
| scan one or two parameters, or assess sensitivity | `workflows/scan_parameters.md` |
| export, package for exchange, or reproduce an experiment | `workflows/package_and_exchange.md` |
| something failed, errored, or looks wrong | `workflows/diagnose_failure.md` |

Worked reasoning patterns: `examples/linear_pathway.md` (build → simulate →
steady state → control), `examples/feedback_oscillator.md` (oscillation, scan,
stability guards), `examples/inline_omex_scan.md` (a scan as a COMBINE archive).

## The distinctions you must never blur

| | Not the same as | Why it matters |
|---|---|---|
| `S1` as a **selection string** = amount | `r.S1` as an **attribute** = concentration `[L:rr/selecting_values]` | wrong by exactly the compartment volume |
| **elasticity** (local: one reaction, other effectors unchanged) | **control coefficient** (systemic: whole network at a steady state) `[L:rr/metabolic]` | different quantities, different questions |
| **scaled** coefficients | **unscaled** coefficients `[L:rr/cls_RoadRunner]` | never in one table or one sum |
| `getCC('J..', p)` flux control | `getCC('S..', p)` concentration control `[L:rr/cls_RoadRunner]` | only the first argument tells them apart |
| **full** stoichiometry / Jacobian / eigenvalues | **reduced** ones `[L:rr/stoichiometric]`, `[L:rr/stability]` | different row counts; reduced needs moiety conversion |
| `reset()` (species only) | `resetAll()` (also parameters, to *current* initials) / `resetToOrigin()` (everything, to load time) `[L:rr/cls_RoadRunner]` | silently corrupts scans and ensembles |
| `getAntimony()` / `getSBML()` = loaded model | `getCurrentAntimony()` / `getCurrentSBML()` = current state `[T:tellurium_methods]` | differ after any simulation or event |
| the **last point of a time course** | a **steady state** `[L:rr/steady_state]` | one is a sample, the other has a residual |
| `res[0]` = first **row** (one time point) | `res['time']` / `res[:, 0]` = time **column**; `res['[S1]']` = a species `[T:tellurium_methods]` | `simulate` returns one row per time point |
| `getFullEigenValues()` as documented (two real columns) `[L:rr/cls_RoadRunner]` | what it returns: a 1-D complex array | use `ev.real` / `ev.imag`, not `ev[:, 0]` |
| **spread of an output** under a parameter sweep | a **control coefficient** | different definitions entirely |

## Non-negotiable behavioural rules

1. **Verify the loaded model before trusting any number from it.** Print
   `getFloatingSpeciesIds()`, `getBoundarySpeciesIds()`, `getReactionIds()`,
   `getGlobalParameterIds()`, and `te.getODEsFromModel(r)`. A symbol silently
   typed as a parameter instead of a species invalidates everything downstream.
2. **Never report a steady state without the value `steadyState()` returned.**
   It is the sum of squares of the rates of change; < 1e-6 "usually" indicates
   success `[L:rr/steady_state]`. Confirm with `getRatesOfChange()`.
3. **Never compute control coefficients, a Jacobian or eigenvalues for
   interpretation before a verified steady state.**
4. **Never read a matrix or vector element without fetching the id list that
   labels it.** Every value vector is ordered by its corresponding `...Ids()`
   list `[T:tellurium_methods]`, `[L:rr/cls_ExecutableModel]`.
5. **Always state which reset ran in a loop**, and never assume `reset()`
   restores parameters — it does not `[L:rr/cls_RoadRunner]`.
6. **Always name the integrator and the step-size regime** behind a trace.
7. **Treat a numerically derived coefficient as provisional until it survives a
   change of `setDiffStepSize`** `[L:rr/metabolic]`.
8. **Never present one stochastic trace as the model's behaviour.** Repeat, state
   the number of repeats and the seed, and fix the grid before averaging.
9. **Say whether an exported artefact is the current or the loaded model state.**
   `exportTo*` defaults to `current=True`; `get*` defaults to `current=False`
   `[T:tellurium_methods]`.
10. **Separate the numbers from the interpretation**, and label both.
11. **Do not fabricate API.** Check `references/api_index.md`; when in doubt,
    query the model at runtime instead of asserting.
12. **When two permitted sources disagree, present both with their pages** and
    prefer the runtime check `references/limits_and_discrepancies.md`.
13. **Do not silence warnings and leave them silenced** — `te.noticesOff()` has a
    matching `te.noticesOn()` `[T:tellurium_methods]`.
14. **Debug the setup before inventing biology.** Run
    `workflows/diagnose_failure.md` in order.

## Minimum viable session

```python
import tellurium as te
r = te.loada('S1 -> S2; k1*S1; k1 = 0.1; S1 = 10')
r.simulate(0, 50, 100)
r.plot()
```
`[T:quickstart]` — everything else in this Skill is an elaboration of these four
lines.

## When you cannot answer

Say so, and say which of these is missing:

- the model (topology, rate laws, which species are fixed);
- initial values and parameter values, or the operating point;
- which quantity is actually wanted (time course? steady state? control? spread?);
- for stochastic work: how many repeats, and the seed;
- whether reported numbers are scaled or unscaled, amounts or concentrations;
- whether the system has conserved cycles (`getNumConservedMoieties()`);
- the installed versions (`te.printVersionInfo()`).

If the topic is outside what the permitted sources establish, use the wording
from `references/limits_and_discrepancies.md`:

> The Tellurium documentation and the sources it links do not establish this.

and, where relevant, name the runtime check or the other Skill that would.
