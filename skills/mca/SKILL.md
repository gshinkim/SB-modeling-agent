---
name: mca
description: >
  Metabolic Control Analysis for biochemical pathways. Use when a question involves
  elasticity coefficients, flux or concentration control coefficients, response
  coefficients, summation/connectivity/branch-point theorems, how control is
  distributed across a pathway, rate-limiting steps, front loading, negative
  feedback and loop gain, steady-state stability and the Jacobian, moiety
  conservation laws, conserved cycles, ultrasensitivity or cascades - or when
  interpreting, validating or debugging MCA numbers, tables and simulation output
  (Tellurium/roadrunner getCC, getEE, conservation matrices).
---

# Metabolic Control Analysis (MCA)

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

Canonical source for everything in this Skill: Herbert M. Sauro, *Systems Biology:
Introduction to Metabolic Control Analysis*, 1st ed. v1.02 (`MCA_1_02.pdf`).
Every reference file carries chapter / section / page citations. Book page = PDF page - 8.

**If a claim is not traceable to that book, do not assert it as MCA fact.** Say the
source does not cover it (see `references/source_map.md` -> "Known limitations of the source").

## What MCA is, in one paragraph

MCA quantifies how much influence each reaction step has over the steady state of a
biochemical network. It has two levels of description. **Local** properties are the
*elasticities*: how a single reaction rate responds to its own reactants, products,
effectors and enzyme. **Global** (system) properties are the *control coefficients*:
how the whole system's steady-state fluxes and concentrations respond to a perturbation
at one step. Theorems (summation, connectivity, branch point, cycle) link the two.
The central claim of the book: control is a **systemic** property, shared across steps,
and cannot be read off a single enzyme (Ch 4.2, book p60; Ch 3.5, book p48).

## Activate this Skill when

- Any of: elasticity, kinetic order (BST sense), control coefficient, FCC, CCC,
  response coefficient, summation theorem, connectivity theorem, branch point theorem,
  loop gain, disequilibrium ratio, front loading, moiety conservation, conserved cycle,
  ultrasensitivity, zero-order/first-order ultrasensitivity, link matrix, L0.
- "Which step controls this flux?", "Is X rate-limiting?", "What happens to the flux if
  I overexpress enzyme 3?", "Why is this control coefficient negative / greater than one?"
- A user pastes an FCC/CCC table, an elasticity matrix, or Tellurium `getCC`/`getEE` output.
- Metabolic-engineering targeting, drug-target reasoning via response coefficients.
- Steady-state stability of a pathway, oscillation onset in a feedback loop.

Do **not** activate for pure enzyme kinetics with no system context, pure FBA/stoichiometric
flux optimisation, or thermodynamics questions with no control question attached.

## Default reasoning pipeline

Run only the stages the question needs; the routing table below picks the entry point.

```
Understand the question (which quantity is actually being asked for?)
   -> Identify topology (linear / branched / cyclic / feedback / moiety-conserved)
   -> Identify variables vs parameters (floating species & fluxes vs boundary species,
      enzyme levels, rate constants, cycle totals T)
   -> Decide whether a steady state is required, and whether one exists / is stable
   -> Identify the local properties needed (which elasticities, at which operating point)
   -> Compute or inspect elasticities
   -> Compute or inspect control coefficients
   -> Apply the theorems that hold for THIS topology
   -> Validate (summation, connectivity, branch, cycle, conservation, sign, magnitude)
   -> Interpret biologically
   -> State assumptions and limitations
```

## Routing table

| The question is about | Load |
|---|---|
| how one rate responds to a metabolite / effector / enzyme | `references/elasticities.md` |
| FCC / CCC definition, sign, magnitude, what a value means | `references/control_coefficients.md` |
| effect of a drug, inhibitor, nutrient, boundary species | `references/response_coefficients.md` |
| "do these coefficients add up?" | `references/summation_theorems.md` |
| linking elasticities to control coefficients | `references/connectivity_theorems.md` |
| deriving control equations by hand, matrix or implicit differentiation; ready-made equations | `references/deriving_control_equations.md` |
| measuring control coefficients in the lab | `references/experimental_mca.md` |
| computing MCA with Tellurium / roadrunner | `references/computational_mca.md` |
| unbranched chains, front loading, near-equilibrium steps, protein allocation | `references/linear_pathways.md` |
| branch points, flux competition, coefficients > 1 or < 0, futile/substrate cycles | `references/branched_and_cyclic_systems.md` |
| feedback inhibition, allosteric regulation, PFK paradox, loop gain, supply/demand | `references/negative_feedback.md` |
| Jacobian, eigenvalues, phase portraits, bistability, oscillation thresholds | `references/stability.md` |
| detecting conservation laws, link matrix, reduced models, dependent species | `references/moiety_conservation.md` |
| covalent-modification cycles, ultrasensitivity, cascades, sequestration | `references/conserved_cycles.md` |
| the user's confusion looks like a missing prerequisite | `references/prerequisites.md` |
| history, what "control" means, rate-limiting-step doctrine | `references/conceptual_foundations.md` |
| where in the book something comes from; what the book does NOT cover | `references/source_map.md` |

| The task is | Load workflow |
|---|---|
| analyse a model / pathway end to end | `workflows/analyze_model.md` |
| the user supplied MCA numbers or tables | `workflows/interpret_mca_results.md` |
| derive a control equation symbolically | `workflows/derive_control_relationship.md` |
| check computed coefficients for consistency | `workflows/validate_mca_results.md` |
| a result looks wrong, impossible or surprising | `workflows/diagnose_unexpected_result.md` |

Worked reasoning patterns: `examples/linear_pathway.md`, `examples/feedback_pathway.md`,
`examples/conserved_cycle.md`.

Always-relevant guardrails (load whenever you are about to state a conclusion):
`references/interpretation_rules.md`, `references/validation_rules.md`,
`references/common_failure_modes.md`.

## Local vs global - the distinction you must never blur

| | Local | Global (systemic) |
|---|---|---|
| Quantities | rate laws, kinetic constants, elasticity `ε^v_s`, unscaled `E^v_s` | `C^J_ei`, `C^s_ei`, `R^J_x`, `R^s_x` |
| Measured on | one isolated reaction, other effectors clamped | the intact system at a steady state |
| Requires steady state | no | yes |
| Determined by | that enzyme's kinetics + current effector concentrations | the whole network |

The book's flat statement: *"The examination of a single enzyme will not give an indication
of the ability of that enzyme to control the flux or species concentrations."* (Ch 4.2, book p60).
The connectivity theorems say a large elasticity tends to go with a **small** flux control
coefficient, not a large one - it is the *ratio* of flanking elasticities that matters,
and only together with the summation theorem does a ratio fix an absolute value.

**Never** substitute an elasticity for a control coefficient, or infer one from the other
without writing down the theorem that connects them.

## Non-negotiable behavioural rules

1. **Never guess a number computation can settle.** If a model is available, compute.
2. **Never claim control from pathway position, slowness, irreversibility, distance from
   equilibrium, or being "the regulated step".** See `common_failure_modes.md` #1.
3. **Never treat a large elasticity as a large control coefficient.**
4. **Never assume steady state without evidence.** Control coefficients are defined only
   at a steady state (Ch 3.1, book p31).
5. **Never interpret a coefficient before establishing its mapping** (which flux, which
   species, which enzyme, scaled or unscaled).
6. **Never ignore conservation constraints.** They change the connectivity theorems
   (Ch 12.4) and make the full Jacobian singular (Ch 11.7).
7. **Never generalise a linear-pathway result to a branch, cycle or feedback loop.**
   Bounds like `0 <= C^J_i <= 1` are a linear-pathway result, not a general one (Ch 6.1 vs Ch 7.1).
8. **Never call approximate numerical equality exact.** Tolerance depends on the numerical
   method and precision; the book specifies no universal tolerance.
9. **Separate mathematics from biology.** State the equation, then the interpretation, labelled.
10. **State assumptions** (steady state, `ε^v_e = 1`, irreversibility, product insensitivity,
    negligible sequestration, unit volumes, constant cycle total `T`).
11. **Validate before interpreting.**
12. **When uncertain, go back to the source map** rather than importing outside MCA theory.

## Notation used throughout (Ch 3.2 book p32; Appendix A book p255)

- `S`, `X` species name; `s`, `x` its concentration. `E` enzyme name, `e` its concentration.
- `X0`, `X1` boundary (fixed) species; `S1..Sm` floating species.
- `v_i` rate of reaction i; `J` steady-state flux.
- `Δ` a change, `δ` a small change.
- `ε^v_s = (∂v/∂s)(s/v)` scaled elasticity; `E^v_s = ∂v/∂s` unscaled.
- Shorthand from Ch 4 onward: `ε^i_j` = elasticity of reaction `v_i` w.r.t. species `s_j`.
- `C^J_ei`, `C^sj_ei` control coefficients; `R^J_x`, `R^s_x` response coefficients.
- `Γ` mass-action ratio, `Keq` (also `q`) equilibrium constant, `ρ = Γ/Keq` disequilibrium ratio.
- `T` total moles in a conserved cycle; `M_i = s_i/T` fractional molar amount.
- `N` stoichiometry matrix, `L` link matrix, `L0` its lower block, `Γ` also used as the
  conservation matrix in Ch 11.5 (the book reuses the symbol - disambiguate by context).

## When you cannot answer

Say so explicitly, and say which of these is missing:

- the network topology (which species feed which reactions, and the regulatory arrows);
- which species are boundary/fixed and which are floating;
- rate laws or elasticity values at the operating point;
- evidence that the system is at a steady state, and which steady state;
- for cycles: the conserved totals `T`;
- whether reported quantities are scaled or unscaled.

If the topic is one the book itself declares out of scope, use the wording in
`references/source_map.md`: *"The primary MCA source used by this Skill does not provide a
complete treatment of this topic."*
