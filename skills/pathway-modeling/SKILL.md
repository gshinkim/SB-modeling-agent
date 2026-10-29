---
name: pathway-modeling
description: >
  Biochemical pathway modeling from Sauro's "Systems Biology: An Introduction to Pathway
  Modeling". Use when a question involves building or analysing a kinetic model of a
  cellular network: mass-action and enzyme rate laws, stoichiometry matrices and
  mass-balance equations, ODE models and solvers, stochastic (Gillespie) models, bursting,
  stochastic focusing and chatter, steady-state computation, Jacobians, stability,
  bifurcation and phase portraits, bistability, parameter estimation and model fitting,
  Bayesian inference and MCMC, confidence intervals and identifiability, multicompartment
  and transport models, feedforward network motifs, moiety conserved cycles and
  ultrasensitivity, SBML/Antimony/Tellurium/libRoadRunner practice, or modeling standards
  and databases (SBML, SBGN, MIRIAM, SBO).
---

# Pathway Modeling

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

Canonical source for everything in this Skill: Herbert M. Sauro, *Systems Biology: An
Introduction to Pathway Modeling*, First Python Edition v1.22 (Ambrosius Publishing,
ISBN 978-0-9824773-7-3). The reference files are a **complete, verbatim conversion of the
book's LaTeX source** — one `.md` per source `.tex` file, nothing removed.

**If a claim is not traceable to that book, do not assert it as fact from this Skill.**
Say the source does not cover it, and switch to a Skill that does (see "Neighbouring
Skills" below).

## What this Skill covers, in one paragraph

This book is the *modeling* counterpart to the MCA book. It teaches how to get from a
biological network to a working quantitative model and back again: how cellular networks
are organised and drawn, how to write rate laws, how stoichiometry produces the system
equation `dS/dt = N v(S, p)`, how to solve that equation deterministically or
stochastically, how to find and characterise a steady state, how to decide whether that
steady state is stable, how to fit the model's parameters to data and say how confident
you are in them, and how to exchange the model with the rest of the world in SBML. Control
analysis proper (elasticities, control coefficients, the theorems) is the subject of the
companion `mca` Skill.

## Wiki conventions

- Full hub with every file and its sections: [[index]]
- Cross-references inside the book (`\ref`) became wiki links carrying a readable name; a
  reference within the same file became an in-page anchor link.
- Figures and tables keep their caption as prose **and** their full LaTeX/TikZ/pgfplots
  source in a fenced block, so the actual plotted data and diagram geometry survive.
  The bitmap graphics themselves are *not* in the source archive; the referenced file
  name is recorded instead.
- Code listings became fenced `python` blocks. LaTeX comments became HTML comments.
  Each chapter ends with the index terms the book records for it.

## Activate this Skill when

- Building, writing or debugging a kinetic model of a pathway, signaling network or gene
  circuit; choosing rate laws; deciding what is a variable and what is a parameter.
- Stoichiometry matrices, mass-balance equations, the system equation, conserved moieties
  as a modeling (not control-analysis) question.
- Running or interpreting a simulation: ODE solvers, stiff systems, fast processes,
  transients, events, Gillespie/stochastic trajectories.
- Steady state: how to compute it, Newton-Raphson, what perturbations do to it.
- Stability, eigenvalues, phase portraits, bifurcation diagrams, bistability, hysteresis,
  oscillation onset.
- Fitting a model to data: optimisation algorithms, residual analysis, chi-squared,
  confidence intervals, cross-validation, identifiability, MCMC and priors.
- Multicompartment systems, diffusion, membrane transporters.
- Network motifs, coherent/incoherent feedforward loops.
- Tellurium, Antimony, libRoadRunner, SBML, SBGN, MIRIAM, SBO, model databases.

Do **not** activate for pure control analysis questions (use `mca`), or for Tellurium API
mechanics with no book question attached (use `tellurium`).

## Routing table

| The question is about | Load |
|---|---|
| how cellular networks are organised, drawn, and what the network classes are; network motifs; genome sizes | [[01_cellular_networks]] |
| mass-action kinetics, rate constants, chemical equilibrium, disequilibrium ratio, modified rate laws | [[02_kinetics_in_a_nutshell]] (short version: [[appendix_d_kinetics_in_a_nutshell]]) |
| stoichiometry matrix, mass-balance equations, visual notation, signaling and gene networks, the system equation, moiety cycles, first Tellurium use | [[03_stoichiometric_networks]] |
| what a model *is*, open/closed/isolated systems, variables vs parameters, units and dimensions, model classification, linear vs nonlinear, linearization, where model data comes from | [[04_introduction_to_modeling]] |
| writing and solving ODE models, Matlab/Python solvers, reduced models from conserved moieties, exploiting fast processes | [[05_differential_equation_models]] |
| stochastic kinetics, propensities, time to next reaction, running Gillespie simulations, events at intervals, trajectories | [[06_stochastic_models]] |
| equilibrium vs steady state vs transient; robustness and homeostasis; setting a model up in software | [[07_how_systems_behave]] |
| diffusion, membrane transporters, multi-compartment models | [[08_multicompartmental_systems]] |
| optimisation algorithms, fitting software, fitting data with Python/scipy | [[09_fitting_models]] |
| residual analysis, chi-squared goodness of fit, confidence intervals, cross-validation, identifiability case studies | [[10_parameter_estimation]] |
| Bayesian inference, posteriors, priors, MCMC, uncertainty quantification | [[11_bayesian_inference]] |
| computing the steady state, Newton-Raphson, effect of different perturbations, sensitivity analysis | [[12_the_steady_state]] |
| Jacobian for biochemical systems, eigenvalues, external stability, phase portraits, bifurcation plots, bistability | [[13_stability]] |
| coherent and incoherent type-I feedforward motifs | [[14_modeling_feedforward_networks]] |
| stochastic bursting, stochastic focusing, chatter | [[15_behavior_of_stochastic_models]] |
| what metabolism is "for", bottlenecks, excess enzymes, why regulated enzymes are regulated | [[16_understanding_metabolism]] |
| moiety conserved cycles, species limits, saturation, sequestration, zero-order ultrasensitivity | [[17_moiety_conserved_cycles]] |
| symbols and abbreviations used by the book | [[appendix_a_list_of_symbols]] |
| physical constants, cell sizes, typical concentrations and rates | [[appendix_b_useful_numbers]] |
| worked answers to the book's exercises | [[appendix_c_answers_to_questions]] |
| Michaelis-Menten, reversible rate laws, Haldane, inhibition, cooperativity, allostery, elasticities | [[appendix_e_enzyme_kinetics_in_a_nutshell]] |
| derivatives, logarithms, partial derivatives, Taylor series, total derivative, eigenvalues | [[appendix_f_math_fundamentals]] |
| mean, deviation, covariance, normal and chi-squared distributions, F-test, bootstrapping, maximum likelihood | [[appendix_g_statistics_reminder]] |
| SBML, graphical layout/SBGN, MIRIAM, SBO, human-readable formats, model databases | [[appendix_h_modeling_standards_and_databases]] |
| Python basics, Antimony syntax, libRoadRunner usage, generating SBML and Matlab files | [[appendix_i_modeling_with_python]] |
| numerical methods behind the solvers: Euler, Runge-Kutta, root finding, steady-state algorithms | [[supplement_computer_simulation_methods]] |
| older simulation-software walkthrough (Scilab/Matlab/Octave, Jarnac) | [[supplement_simulation_software]] |
| branched pathways and futile/substrate cycles as the book drafted them | [[draft_branched_and_cyclic_systems]] |
| the earlier draft of the kinetics chapter | [[draft_kinetics_in_a_nutshell_old]] |
| the raw simulation sources behind the stochastic figures | [[notes_bursting_model]], [[notes_stochastic_chatter_a]], [[notes_stochastic_chatter_b]], [[notes_stochastic_focusing]] |
| book structure, edition, revision history, cover | [[book_structure_and_history]], [[front_matter_cover_image]] |

## Default reasoning pipeline

Run only the stages the question needs.

```
Understand the biological question, and what the model has to answer
   -> Fix the network: species, reactions, stoichiometries, compartments
   -> Decide boundary (fixed) vs floating species; variables vs parameters
   -> Choose rate laws appropriate to the evidence (mass-action / MM / reversible)
   -> Write the system equation dS/dt = N v(S, p); reduce by conservation if needed
   -> Choose the regime: deterministic ODE, or stochastic if molecule numbers are small
   -> Simulate and/or solve for the steady state
   -> Check the steady state exists, is the one you want, and is stable (Jacobian)
   -> If fitting: optimise, then analyse residuals and quantify uncertainty
   -> Validate against data and against known limits
   -> State assumptions and limitations
```

## Non-negotiable behavioural rules

1. **Never present a simulated number as a measurement.** Say which it is.
2. **Never assume a steady state exists or is unique.** Compute it; check stability by the
   Jacobian's eigenvalues before calling a system stable.
3. **Never use a deterministic ODE when molecule counts are small.** The book's stochastic
   chapters exist because the continuous approximation fails there — bursting, focusing
   and chatter are the named failure modes.
4. **Never fit without inspecting residuals.** A low objective value is not a fit.
5. **Never quote a fitted parameter without an uncertainty**, and never quote an
   uncertainty without saying how it was obtained (covariance, bootstrap, profile, MCMC).
6. **Never ignore units and dimensions**, or compartment volumes in multicompartment models.
7. **Never silently drop a conserved moiety.** It makes the full Jacobian singular; either
   reduce the model or say you did not.
8. **Never extrapolate a linearised model beyond the neighbourhood it was linearised in.**
9. **Separate the mathematics from the biology.** State the equation, then the
   interpretation, labelled.
10. **State assumptions** (well-stirred, constant volume, fixed boundary species, rapid
    equilibrium, mass-action where a real mechanism is unknown).
11. **When uncertain, go back to the chapter** rather than importing outside theory.

## Notation used throughout

- `S`, `X` species; `S1..Sm` floating species, `X0`, `X1` boundary (fixed) species.
- `v_i` rate of reaction i; `v` the rate vector; `J` a steady-state flux.
- `N` stoichiometry matrix; `dS/dt = N v(S, p)` the system equation.
- `p` parameter vector; `E`/`e` enzyme name and concentration.
- `Γ` mass-action ratio, `Keq` equilibrium constant, `ρ = Γ/Keq` disequilibrium ratio.
- `J` is also used for the Jacobian matrix in the stability chapters — disambiguate by
  context (flux in Ch 12, Jacobian in Ch 13).
- `χ²` goodness of fit; `θ` parameter vector in the fitting and Bayesian chapters.
- Full list: [[appendix_a_list_of_symbols]].

## Neighbouring Skills

| If the question is really about | Use |
|---|---|
| control coefficients, elasticities, summation/connectivity theorems, how control is distributed | `mca` |
| computing and validating MCA numbers end to end | `mca` to frame and validate, `tellurium` to run |
| Tellurium/RoadRunner/Antimony API mechanics, debugging code and installs | `tellurium` |

## When you cannot answer

Say so explicitly, and say which of these is missing:

- the network topology, stoichiometries and compartments;
- which species are fixed and which float;
- rate laws, parameter values, and initial conditions;
- the data being fitted, and its error model;
- which regime is intended (deterministic or stochastic);
- whether a steady state or a time course is being asked about.

If the topic is one the book does not treat, say: *"The primary source used by this Skill
does not cover this topic"* — and name the Skill that does, if one applies.
