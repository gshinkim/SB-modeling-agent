export const meta = {
  name: 'mca-tellurium',
  description: 'Enforced MCA + Tellurium analysis: MCA frames the science, Tellurium frames the implementation, execute, MCA validates, MCA interprets, Tellurium audits every software claim.',
  whenToUse:
    'Any task involving metabolic control analysis, pathway control or control distribution, elasticities, flux/concentration control coefficients, response coefficients, summation or connectivity relationships, rate-limiting-step claims, MCA validation or interpretation, or Tellurium/Antimony/RoadRunner used to model, simulate or analyse a biochemical pathway.',
  phases: [
    { title: 'MCA frame', detail: 'the mca Skill decides what is scientifically being asked' },
    { title: 'Tellurium plan', detail: 'the tellurium Skill decides the documented implementation' },
    { title: 'Execute', detail: 'run it; only when the task needs numbers' },
    { title: 'MCA validate', detail: 'the mca Skill checks the result; failure routes to diagnosis' },
    { title: 'Diagnose', detail: 'only on a failed validation; then execution is repeated' },
    { title: 'MCA interpret', detail: 'the mca Skill reads the validated result' },
    { title: 'Tellurium audit', detail: 'every software claim traced before answering' },
  ],
}

// This script owns ORDER ONLY. It contains no MCA theory and no Tellurium API
// facts. Every stage gets its knowledge by loading the Skill named in its
// prompt and following that Skill's own routing table.

const IN = typeof args === 'string' ? { question: args } : (args ?? {})
const question = (IN.question ?? '').trim()
const model = (IN.model ?? '').trim()
const workdir = (IN.workdir ?? './mca-tellurium-runs/current').trim()
/* How THIS runtime executes a computation. Claude Code writes a script and runs it
   with Bash; the local server runtime has run_python; the browser has typed
   Tellurium tools and no shell at all. Hard-coding "run it with Bash" ordered two
   of the three to call a tool they do not have, in the one stage they cannot skip. */
const execNote = (IN.exec ?? '').trim() ||
  `Write a single runnable script into ${workdir} (create it if needed), run it with ` +
  `Bash, and keep both the script and its output on disk — they are the reproducibility record.`
const needsNumbers = IN.needsNumbers !== false
const maxRepairs = Number.isInteger(IN.maxRepairs) ? IN.maxRepairs : 2

if (!question) {
  return {
    error:
      'mca-tellurium requires args.question. Call it as Workflow({name:"mca-tellurium", args:{question:"...", model:"<path or antimony string>", workdir:"./..."}}).',
  }
}

const SKILL = (name) =>
  `Load the \`${name}\` Skill first, with whichever tool this runtime gives you for that. Its SKILL.md is only the index: use its routing table to open every reference file this question touches, with no limit on how many, before you answer. Stopping at SKILL.md is a defect; a question means a file to open. Once what you have read answers the question, stop reading and answer. Never assert anything this Skill is the authority on from your own memory.`

const CONTEXT = `
QUESTION FOR THIS INVOCATION:
${question}

MODEL: ${model || '(none supplied by the caller — say so rather than inventing one)'}
WORKING DIRECTORY: ${workdir}
`

const FRAME = {
  type: 'object',
  properties: {
    quantity: { type: 'string', description: 'which quantity is actually being asked for, fully mapped' },
    topology: { type: 'string', description: 'topology class, and which theorem set is therefore legal' },
    variables_vs_parameters: { type: 'string' },
    steady_state_required: { type: 'boolean' },
    references_loaded: { type: 'array', items: { type: 'string' } },
    missing_from_user: {
      type: 'array', items: { type: 'string' },
      description: 'ONLY things no computation can supply and the user must state. Empty if nothing.',
    },
    to_establish: {
      type: 'array', items: { type: 'string' },
      description: 'things not yet known but obtainable by the later stages of this workflow. Never blocking.',
    },
    brief: { type: 'string', description: 'what stage 2 must implement, stated scientifically' },
  },
  required: ['quantity', 'topology', 'steady_state_required', 'references_loaded', 'missing_from_user', 'to_establish', 'brief'],
  additionalProperties: false,
}

const PLAN = {
  type: 'object',
  properties: {
    calls: { type: 'array', items: { type: 'string' }, description: 'documented calls and arguments, each traceable' },
    traps: { type: 'array', items: { type: 'string' } },
    build_path: { type: 'string', description: 'how the model is obtained/built, or "already supplied"' },
    references_loaded: { type: 'array', items: { type: 'string' } },
    unestablished: { type: 'array', items: { type: 'string' }, description: 'anything the documentation does not establish' },
  },
  required: ['calls', 'traps', 'build_path', 'references_loaded', 'unestablished'],
  additionalProperties: false,
}

const EXEC = {
  type: 'object',
  properties: {
    ran: { type: 'boolean' },
    script_path: { type: 'string' },
    output_path: { type: 'string' },
    results: { type: 'string', description: 'the numbers, labelled from the model own id lists' },
    steady_state_evidence: { type: 'string', description: 'the value the solver returned, verbatim, or why none applies' },
    versions: { type: 'string' },
    error: { type: 'string', description: 'empty when it ran clean' },
  },
  required: ['ran', 'script_path', 'results', 'steady_state_evidence', 'error'],
  additionalProperties: false,
}

const VALIDATE = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    first_failing_check: { type: 'string', description: 'empty on pass' },
    checks_run: { type: 'array', items: { type: 'string' } },
    residuals: { type: 'string' },
    tolerance_and_basis: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['verdict', 'first_failing_check', 'checks_run', 'residuals', 'tolerance_and_basis', 'report'],
  additionalProperties: false,
}

const DIAGNOSE = {
  type: 'object',
  properties: {
    cause: { type: 'string', description: 'the cause, or the shortest list of remaining candidates' },
    checks_ruled_out: { type: 'array', items: { type: 'string' } },
    fix: { type: 'string', description: 'the concrete correction the next execution must apply' },
    repairable: { type: 'boolean', description: 'false when no re-run can fix it' },
    not_ruled_out: { type: 'string' },
  },
  required: ['cause', 'checks_ruled_out', 'fix', 'repairable', 'not_ruled_out'],
  additionalProperties: false,
}

const INTERPRET = {
  type: 'object',
  properties: {
    mathematics: { type: 'string', description: 'what the formalism entails, stated as mathematics' },
    biology: { type: 'string', description: 'the biological reading, labelled as interpretation' },
    assumptions: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
  required: ['mathematics', 'biology', 'assumptions', 'unresolved'],
  additionalProperties: false,
}

const AUDIT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true when every software claim traced to the permitted sources' },
    unsupported: { type: 'array', items: { type: 'string' }, description: 'claims the documentation does not establish' },
    corrections: { type: 'string' },
    runtime_checks_offered: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'unsupported', 'corrections', 'runtime_checks_offered'],
  additionalProperties: false,
}

// ---------------------------------------------------------------- 1. MCA first

phase('MCA frame')
const frame = await agent(
  `${SKILL('mca')}
${CONTEXT}
You are stage 1 of a fixed sequence. Your job is to frame the SCIENCE, and nothing else.
Do not choose a tool, do not write code, do not compute. Do not let a convenient
software call decide what should be computed.

Come out of this stage with the fields in your output schema.

Two different things must not be conflated, because one halts this workflow and
the other is simply its job:

  missing_from_user - the question cannot be framed at all until a human says
      something no computation can supply: no model, an ambiguous topology, no
      statement of which flux or species is meant, a regime the model does not
      cover. This HALTS the workflow. Use it sparingly and only when true.

  to_establish - not yet known, but obtainable downstream: the steady state and
      whether one exists, which parameter is perturbed, scaled versus unscaled,
      the operating point, conserved totals, whether the flux is non-zero. These
      are what stages 2 to 4 are for. Put them here and let the workflow proceed.
      Anything you would describe as "resolvable by computation" belongs here,
      never in missing_from_user.

A wrongly framed question cannot be recovered later, so frame it carefully — but
do not halt a workflow whose whole purpose is to establish what is not yet known.`,
  { label: 'mca:frame', phase: 'MCA frame', schema: FRAME },
)

if (!frame) return { error: 'stage 1 (MCA frame) returned nothing; the sequence cannot continue' }
if (frame.missing_from_user && frame.missing_from_user.length > 0) {
  log(`stopped at stage 1 — only the user can supply: ${frame.missing_from_user.join('; ')}`)
  return {
    status: 'UNDERSPECIFIED',
    stoppedAt: 'MCA frame',
    missing_from_user: frame.missing_from_user,
    frame,
  }
}
const toEstablish = (frame.to_establish ?? []).join(' | ') || '(nothing outstanding)'
if (frame.to_establish && frame.to_establish.length > 0) {
  log(`stage 1 framed it; ${frame.to_establish.length} quantity/quantities left for the later stages to establish`)
}

// ----------------------------------------------------------- 2. Tellurium second

phase('Tellurium plan')
const plan = await agent(
  `${SKILL('tellurium')}
${CONTEXT}
You are stage 2. Stage 1 has already decided the science. Implement THAT, not
something adjacent that is easier to call.

STAGE 1 BRIEF (authoritative — do not renegotiate it):
quantity: ${frame.quantity}
topology: ${frame.topology}
steady state required: ${frame.steady_state_required}
brief: ${frame.brief}
STILL TO BE ESTABLISHED (your plan must obtain every one of these): ${toEstablish}

Produce the documented calls and arguments — never a remembered signature — the
model-building path if a model must be written, and the traps that apply to this
analysis. Anything the documentation does not establish goes in "unestablished",
with the runtime check that would settle it. Do not execute anything yet.`,
  { label: 'tellurium:plan', phase: 'Tellurium plan', schema: PLAN },
)

if (!plan) return { error: 'stage 2 (Tellurium plan) returned nothing; the sequence cannot continue' }

// -------------------------------------------------- 3-5. execute / validate / repair

const runExecute = (attempt, correction) =>
  agent(
    `${CONTEXT}
You are stage 3: execution. Stages 1 and 2 have decided what to compute and how.
Do not redesign either. If stage 2's plan cannot be run as written, say so in
"error" rather than substituting your own approach.

WHAT TO COMPUTE: ${frame.brief}
STEADY STATE REQUIRED: ${frame.steady_state_required}
MUST ALSO BE ESTABLISHED BY THIS RUN: ${toEstablish}
DOCUMENTED CALLS: ${plan.calls.join(' | ')}
TRAPS TO AVOID: ${plan.traps.join(' | ')}
MODEL PATH: ${plan.build_path}
${correction ? `\nTHIS IS ATTEMPT ${attempt}. A previous run failed validation. Apply exactly this correction and change nothing else:\n${correction}\n` : ''}
${execNote}
Report the numbers labelled from the model's own id
lists, and report the steady-state evidence verbatim as the software returned it.
Report what happened, including a failure. Do not interpret anything.`,
    { label: attempt > 1 ? `execute:retry-${attempt}` : 'execute', phase: 'Execute', schema: EXEC },
  )

const runValidate = (exec) =>
  agent(
    `${SKILL('mca')}
${CONTEXT}
You are stage 4: validation. Run the mca Skill's validation workflow
(workflows/validate_mca_results.md) in order and stop at the first failure.
You are checking whether this result is self-consistent and correctly computed.
You are NOT deciding whether it is interesting, and you are NOT interpreting it.

WHAT WAS COMPUTED: ${frame.quantity}
TOPOLOGY (decides which checks are legal): ${frame.topology}
RESULTS: ${exec.results}
STEADY-STATE EVIDENCE: ${exec.steady_state_evidence}
SCRIPT: ${exec.script_path}

Report every residual and the tolerance you judged it against, plus the basis for
that tolerance. Never call approximate numerical equality exact. A result that
fails any check is "fail" with the first failing check named — do not soften it.`,
    { label: 'mca:validate', phase: 'MCA validate', schema: VALIDATE },
  )

let exec = null
let validation = null
let correction = null
let repairs = 0
const attempts = []

if (needsNumbers) {
  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    phase('Execute')
    exec = await runExecute(attempt, correction)
    if (!exec) return { error: 'stage 3 (execute) returned nothing', frame, plan }

    if (!exec.ran || exec.error) {
      log(`attempt ${attempt}: execution failed — ${exec.error || 'did not run'}`)
      validation = { verdict: 'fail', first_failing_check: `execution failed: ${exec.error || 'did not run'}`, checks_run: [], residuals: '', tolerance_and_basis: '', report: '' }
    } else {
      phase('MCA validate')
      validation = await runValidate(exec)
      if (!validation) return { error: 'stage 4 (validate) returned nothing', frame, plan, exec }
    }

    attempts.push({ attempt, ran: exec.ran, verdict: validation.verdict, failed: validation.first_failing_check })
    if (validation.verdict === 'pass') break

    if (attempt > maxRepairs) {
      log(`validation still failing after ${maxRepairs} repair attempt(s) — stopping rather than reporting an unvalidated number`)
      break
    }

    // A number that fails validation is not a result. It is diagnosed.
    phase('Diagnose')
    const dx = await agent(
      `${SKILL('mca')}
${CONTEXT}
You are the diagnosis stage. A computed result failed validation. Work the mca
Skill's workflows/diagnose_unexpected_result.md in order, then — if and only if
the cause looks like setup, software or numerics rather than science — continue
into the tellurium Skill's workflows/diagnose_failure.md (load that Skill the
same way).

Debug the assumptions and the calculation before inventing any explanation.

FIRST FAILING CHECK: ${validation.first_failing_check}
VALIDATION REPORT: ${validation.report}
RESULTS: ${exec.results}
STEADY-STATE EVIDENCE: ${exec.steady_state_evidence}
SCRIPT: ${exec.script_path}

Return the cause (or the shortest list of remaining candidates), which checks you
ruled out, and a concrete correction the next execution must apply. If no re-run
could fix it, set repairable false and say why.`,
      { label: `diagnose:${attempt}`, phase: 'Diagnose', schema: DIAGNOSE },
    )

    if (!dx || !dx.repairable) {
      log(`not repairable by re-running: ${dx ? dx.cause : 'diagnosis returned nothing'}`)
      validation = { ...validation, report: `${validation.report}\n\nDIAGNOSIS (not repairable): ${dx ? dx.cause : 'none'}` }
      break
    }
    repairs++
    correction = dx.fix
    log(`repair ${repairs}: ${dx.cause} -> ${dx.fix}`)
  }

  if (!validation || validation.verdict !== 'pass') {
    // Non-negotiable: an unvalidated number is never handed back as a result.
    return {
      status: 'UNVALIDATED',
      note: 'Execution did not produce a result that passed MCA validation. Nothing here may be reported as a finding.',
      frame,
      plan,
      exec,
      validation,
      attempts,
      repairs,
    }
  }
}

// -------------------------------------------------------------- 6. MCA interpret

phase('MCA interpret')
const interpretation = await agent(
  `${SKILL('mca')}
${CONTEXT}
You are stage 5: interpretation. ${needsNumbers ? 'You are reading a result that has ALREADY passed validation — do not re-validate it.' : 'This invocation requested no numbers, so you are interpreting the FRAMING from stages 1 and 2, not a computed result. Say so, and do not supply the numbers yourself.'}
Load the mca Skill's interpretation guardrails and read it.

QUANTITY: ${frame.quantity}
TOPOLOGY: ${frame.topology}
${needsNumbers ? `VALIDATED RESULTS: ${exec.results}\nVALIDATION: ${validation.report}` : 'This invocation needed no numbers; interpret the framing from stage 1.'}

Keep the mathematics and the biological reading visibly separate and labelled.
State every assumption you relied on. Anything you could not determine goes in
"unresolved" — do not fill a gap with a plausible invention, and never generalise
a result beyond the topology it was computed for.`,
  { label: 'mca:interpret', phase: 'MCA interpret', schema: INTERPRET },
)

if (!interpretation) return { error: 'stage 5 (interpret) returned nothing', frame, plan, exec, validation }

// --------------------------------------------------------- 7. Tellurium audit

phase('Tellurium audit')
const audit = await agent(
  `${SKILL('tellurium')}
${CONTEXT}
You are stage 6, the last gate before an answer leaves this workflow. Re-check
every software-specific claim made anywhere below against the tellurium Skill's
permitted sources. This is adversarial: your default is that a claim is
unsupported until you have traced it.

CALLS USED: ${plan.calls.join(' | ')}
FLAGGED AS UNESTABLISHED AT PLANNING TIME: ${plan.unestablished.join(' | ') || '(none)'}
${needsNumbers ? `EXECUTION REPORT: ${exec.results}\nSTEADY-STATE EVIDENCE: ${exec.steady_state_evidence}\nVERSIONS: ${exec.versions ?? '(not reported)'}` : ''}
INTERPRETATION (mathematics): ${interpretation.mathematics}
INTERPRETATION (biology): ${interpretation.biology}

Anything the documentation does not establish is listed in "unsupported" and
stated as not established, with the runtime check that would settle it offered
instead. Do not repair a claim by inventing a source.`,
  { label: 'tellurium:audit', phase: 'Tellurium audit', schema: AUDIT },
)

return {
  status: needsNumbers ? 'VALIDATED' : 'FRAMED',
  question,
  model: model || null,
  workdir,
  frame,
  plan,
  execution: exec,
  validation,
  interpretation,
  audit,
  attempts,
  repairs,
  sequence: ['MCA frame', 'Tellurium plan', 'Execute', 'MCA validate', 'MCA interpret', 'Tellurium audit'],
}
