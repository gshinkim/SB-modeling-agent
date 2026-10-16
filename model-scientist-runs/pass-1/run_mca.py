"""Stage 3 execution: MCA of X0 -> S -> X1, irreversible (A) and reversible (B).

Runs the stage-2 plan as written. Writes everything it prints to output.txt
next to this script. Sections that fail are recorded as SECTION-ERROR lines
rather than replaced by another method.
"""
import os
import sys
import traceback

import numpy as np
import tellurium as te

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output.txt")
_fh = open(OUT, "w")
ERRORS = []


def p(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    _fh.write(s + "\n")
    _fh.flush()


def section(name, fn):
    try:
        return fn()
    except Exception as e:  # recorded, not hidden
        msg = "SECTION-ERROR [%s]: %s: %s" % (name, type(e).__name__, e)
        ERRORS.append(msg)
        p(msg)
        p(traceback.format_exc())
        return None


def ant_A(k1=0.3, k2=0.1, X0=10, X1=0):
    return """
model A()
  J1: $X0 -> S;  k1*X0
  J2: S -> $X1;  k2*S
  X0 = %r; X1 = %r; S = 0
  k1 = %r; k2 = %r
end
""" % (X0, X1, k1, k2)


def ant_B(k1=0.3, k1r=0.2, k2=0.1, k2r=0.05, X0=10, X1=1):
    return """
model B()
  J1: $X0 -> S;  e1*(k1*X0 - k1r*S)
  J2: S -> $X1;  e2*(k2*S - k2r*X1)
  X0 = %r; X1 = %r; S = 0
  k1 = %r; k1r = %r; k2 = %r; k2r = %r
  e1 = 1; e2 = 1
end
""" % (X0, X1, k1, k1r, k2, k2r)


def labelled(mat, rows, cols):
    m = np.array(mat, dtype=float)
    return {(r_, c_): m[i, j] for i, r_ in enumerate(rows) for j, c_ in enumerate(cols)}


def core(r, tag, verbose=True):
    """steady state -> evidence -> E -> FCC -> residuals. Returns dict."""
    out = {}
    rxn = list(r.getReactionIds())
    flo = list(r.getFloatingSpeciesIds())
    out["rxn"], out["flo"] = rxn, flo
    res = r.steadyState()
    out["ss_return"] = res
    roc = np.array(r.getRatesOfChange(), dtype=float)
    rates = np.array(r.getReactionRates(), dtype=float)
    out["roc"] = dict(zip(flo, roc))
    out["rates"] = dict(zip(rxn, rates))
    out["S"] = r["[S]"]
    if verbose:
        p("[%s] steadyState() return value (sum of squares of rates of change): %r" % (tag, res))
        p("[%s] getRatesOfChange() labelled by getFloatingSpeciesIds(): %r" % (tag, out["roc"]))
        p("[%s] getReactionRates() labelled by getReactionIds(): %r" % (tag, out["rates"]))
        p("[%s] r['[S]'] = %r" % (tag, out["S"]))
    E = labelled(r.getScaledElasticityMatrix(), rxn, flo)
    F = labelled(r.getScaledFluxControlCoefficientMatrix(), rxn, rxn)
    out["E"], out["F"] = E, F
    roc2 = np.array(r.getRatesOfChange(), dtype=float)
    out["roc_after"] = dict(zip(flo, roc2))
    row = "J1"
    out["row"] = row
    c1, c2 = F[(row, "J1")], F[(row, "J2")]
    out["C1"], out["C2"] = c1, c2
    out["summ"] = c1 + c2 - 1.0
    out["conn"] = c1 * E[("J1", "S")] + c2 * E[("J2", "S")]
    return out


def show_core(o, tag):
    p("[%s] E (scaled elasticity, reaction x floating species):" % tag)
    for k, v in o["E"].items():
        p("    E[%s,%s] = %r" % (k[0], k[1], v))
    p("[%s] FCC (scaled, flux x reaction):" % tag)
    for k, v in o["F"].items():
        p("    FCC[%s,%s] = %r" % (k[0], k[1], v))
    p("[%s] row used for (C^J_e1, C^J_e2): %s" % (tag, o["row"]))
    p("[%s] row difference FCC[J1,.]-FCC[J2,.]: %r, %r" % (
        tag, o["F"][("J1", "J1")] - o["F"][("J2", "J1")], o["F"][("J1", "J2")] - o["F"][("J2", "J2")]))
    p("[%s] summation residual  C1+C2-1            = %r" % (tag, o["summ"]))
    p("[%s] connectivity residual C1*E1S + C2*E2S   = %r" % (tag, o["conn"]))
    p("[%s] getRatesOfChange() after matrix calls: %r" % (tag, o["roc_after"]))


def full(tag, ant, expect_params, fcc_params):
    p("=" * 78)
    p("MODEL %s" % tag)
    p("=" * 78)
    p(ant)
    r = te.loada(ant)

    def verify():
        p("[%s] getFloatingSpeciesIds(): %r" % (tag, list(r.getFloatingSpeciesIds())))
        p("[%s] getBoundarySpeciesIds(): %r" % (tag, list(r.getBoundarySpeciesIds())))
        p("[%s] getReactionIds(): %r" % (tag, list(r.getReactionIds())))
        gp = list(r.getGlobalParameterIds())
        p("[%s] getGlobalParameterIds(): %r (expected set %r; match=%r)" % (
            tag, gp, expect_params, sorted(gp) == sorted(expect_params)))
        p("[%s] global parameter values: %r" % (tag, {g: r.getValue(g) for g in gp}))
        p("[%s] boundary values: %r" % (tag, {b: r.getValue("[%s]" % b) for b in r.getBoundarySpeciesIds()}))
        p("[%s] getFullStoichiometryMatrix():\n%s" % (tag, r.getFullStoichiometryMatrix()))
        p("[%s] te.getODEsFromModel(r):\n%s" % (tag, te.getODEsFromModel(r)))
        p("[%s] getNumConservedMoieties(): %r ; conservedMoietyAnalysis=%r" % (
            tag, r.getNumConservedMoieties(), r.conservedMoietyAnalysis))
    section(tag + " verify", verify)

    section(tag + " solver", lambda: p("[%s] getSteadyStateSolver(): %r" % (tag, r.getSteadyStateSolver())))

    o = section(tag + " core", lambda: core(r, tag))
    if o is None:
        return None, None
    show_core(o, tag)

    def named():
        r.steadyStateSelections = ["[S]", "J1", "J2"]
        na = r.getSteadyStateValuesNamedArray()
        p("[%s] steadyStateSelections=['[S]','J1','J2']; getSteadyStateValuesNamedArray():\n%s" % (tag, na))
        p("[%s] getRatesOfChange() after named-array call: %r" % (tag, list(r.getRatesOfChange())))
    section(tag + " named ss", named)

    def stab():
        r.steadyState()
        Jac = r.getFullJacobian()
        ev = np.asarray(r.getFullEigenValues())
        p("[%s] getFullJacobian():\n%s" % (tag, Jac))
        p("[%s] getFullEigenValues(): raw=%r shape=%r real=%r imag=%r" % (
            tag, ev, ev.shape, np.real(ev).tolist(), np.imag(ev).tolist()))
    section(tag + " stability", stab)

    def single():
        vals = {
            "getScaledFloatingSpeciesElasticity('J1','S')": r.getScaledFloatingSpeciesElasticity("J1", "S"),
            "getScaledFloatingSpeciesElasticity('J2','S')": r.getScaledFloatingSpeciesElasticity("J2", "S"),
            "getEE('J1','S')": r.getEE("J1", "S"),
            "getEE('J2','S')": r.getEE("J2", "S"),
            "getEE('J1','%s')" % fcc_params[0]: r.getEE("J1", fcc_params[0]),
            "getEE('J2','%s')" % fcc_params[1]: r.getEE("J2", fcc_params[1]),
        }
        for k, v in vals.items():
            p("[%s] %s = %r" % (tag, k, v))
        p("[%s] getRatesOfChange() after getEE calls: %r" % (tag, list(r.getRatesOfChange())))
    section(tag + " single elasticities", single)

    def cc():
        a = r.getCC("J1", fcc_params[0])
        b = r.getCC("J1", fcc_params[1])
        p("[%s] getCC('J1','%s') = %r" % (tag, fcc_params[0], a))
        p("[%s] getCC('J1','%s') = %r" % (tag, fcc_params[1], b))
        p("[%s] getCC summation residual = %r" % (tag, a + b - 1.0))
        p("[%s] getCC connectivity residual (with matrix E) = %r" % (
            tag, a * o["E"][("J1", "S")] + b * o["E"][("J2", "S")]))
        p("[%s] getCC minus matrix FCC: %r, %r" % (tag, a - o["C1"], b - o["C2"]))
        p("[%s] getRatesOfChange() after getCC calls: %r" % (tag, list(r.getRatesOfChange())))
        p("[%s] steadyState() re-read after getCC: %r" % (tag, r.steadyState()))
    section(tag + " getCC", cc)

    def steps():
        h0 = r.getDiffStepSize()
        p("[%s] getDiffStepSize() = %r ; getSteadyStateThreshold() = %r" % (tag, h0, r.getSteadyStateThreshold()))
        rows = []
        for h in (h0 / 10, h0, h0 * 10):
            r.setDiffStepSize(h)
            oo = core(r, tag, verbose=False)
            rows.append(oo)
            p("[%s] h=%r ss_return=%r roc=%r C1=%r C2=%r E1S=%r E2S=%r summ=%r conn=%r" % (
                tag, h, oo["ss_return"], oo["roc"], oo["C1"], oo["C2"],
                oo["E"][("J1", "S")], oo["E"][("J2", "S")], oo["summ"], oo["conn"]))
        r.setDiffStepSize(h0)
        for key, f in (("C1", lambda x: x["C1"]), ("C2", lambda x: x["C2"]),
                       ("E1S", lambda x: x["E"][("J1", "S")]), ("E2S", lambda x: x["E"][("J2", "S")]),
                       ("summ", lambda x: x["summ"]), ("conn", lambda x: x["conn"])):
            v = [f(x) for x in rows]
            p("[%s] spread over h (max-min) of %s = %r" % (tag, key, max(v) - min(v)))
        p("[%s] DiffStepSize restored to %r" % (tag, r.getDiffStepSize()))
    section(tag + " step size", steps)
    return r, o


# ---------------------------------------------------------------- versions
section("versions", lambda: p("te.getVersionInfo(): %r" % (te.getVersionInfo(),)))
p("python %s ; numpy %s" % (sys.version.split()[0], np.__version__))

# ---------------------------------------------------------------- Model A
rA, oA = full("A", ant_A(), ["k1", "k2"], ("k1", "k2"))

# ---------------------------------------------------------------- Model B
p("ASSUMPTION: Model B keeps k1=0.3, k2=0.1, X0=10 from the base model, S starts at 0; "
  "only k1r=0.2, k2r=0.05, X1=1 (and multipliers e1=e2=1) are new.")
rB, oB = full("B", ant_B(), ["k1", "k1r", "k2", "k2r", "e1", "e2"], ("e1", "e2"))


def rho_B():
    rB.steadyState()
    S = rB["[S]"]
    k1, k1r, k2, k2r = (rB.getValue(x) for x in ("k1", "k1r", "k2", "k2r"))
    X0, X1 = rB.getValue("[X0]"), rB.getValue("[X1]")
    q1, q2 = k1 / k1r, k2 / k2r
    rho1 = k1r * S / (k1 * X0)
    rho2 = k2r * X1 / (k2 * S)
    p("[B] values read: [S]=%r k1=%r k1r=%r k2=%r k2r=%r [X0]=%r [X1]=%r" % (S, k1, k1r, k2, k2r, X0, X1))
    p("[B] q1=%r q2=%r ; X0*q1*q2=%r vs X1=%r ; forward condition X0*q1*q2>X1: %r" % (
        q1, q2, X0 * q1 * q2, X1, X0 * q1 * q2 > X1))
    p("[B] rho1 = k1r*[S]/(k1*[X0]) = %r ; rho2 = k2r*[X1]/(k2*[S]) = %r" % (rho1, rho2))
    e1f, e2f = -rho1 / (1 - rho1), 1 / (1 - rho2)
    p("[B] -rho1/(1-rho1) = %r ; matrix E[J1,S] = %r ; difference = %r" % (
        e1f, oB["E"][("J1", "S")], oB["E"][("J1", "S")] - e1f))
    p("[B] 1/(1-rho2)     = %r ; matrix E[J2,S] = %r ; difference = %r" % (
        e2f, oB["E"][("J2", "S")], oB["E"][("J2", "S")] - e2f))
    a, b = (1 - rho1), rho1 * (1 - rho2)
    p("[B] eq 6.9 form (1-rho1) : rho1*(1-rho2) = %r : %r -> normalised %r, %r" % (a, b, a / (a + b), b / (a + b)))
    a2, b2 = q1 * q2 / k1, q2 / k2
    p("[B] eq 6.6 form q1*q2/k1 : q2/k2 = %r : %r -> normalised %r, %r" % (a2, b2, a2 / (a2 + b2), b2 / (a2 + b2)))
    p("[B] matrix C1/C2 = %r ; -E2S/E1S = %r" % (
        oB["C1"] / oB["C2"], -oB["E"][("J2", "S")] / oB["E"][("J1", "S")]))
    p("[B] bounds: step1 eps_substrate(X0)=getEE('J1','X0')=%r, eps_product(S)=%r, sum=%r" % (
        rB.getEE("J1", "X0"), rB.getEE("J1", "S"), rB.getEE("J1", "X0") + rB.getEE("J1", "S")))
    p("[B] bounds: step2 eps_substrate(S)=%r, eps_product(X1)=getEE('J2','X1')=%r, sum=%r" % (
        rB.getEE("J2", "S"), rB.getEE("J2", "X1"), rB.getEE("J2", "S") + rB.getEE("J2", "X1")))


if oB is not None:
    section("B rho", rho_B)


def fd_B():
    for d in (1e-3, 1e-4):
        for step, names in (("step1", ("k1", "k1r")), ("step2", ("k2", "k2r"))):
            rB.resetToOrigin()
            r0 = rB.steadyState()
            J0 = dict(zip(rB.getReactionIds(), rB.getReactionRates()))["J1"]
            rB.setValues({n: rB.getValue(n) * (1 + d) for n in names})
            r1 = rB.steadyState()
            J1 = dict(zip(rB.getReactionIds(), rB.getReactionRates()))["J1"]
            c = (np.log(J1) - np.log(J0)) / np.log(1 + d)
            p("[B] joint scaling %s %r by (1+%g): ss_return base=%r pert=%r J0=%r J=%r dlnJ/dln = %r" % (
                step, names, d, r0, r1, J0, J1, c))
    rB.resetToOrigin()
    p("[B] resetToOrigin() used; values after: %r ; steadyState()=%r" % (
        {g: rB.getValue(g) for g in rB.getGlobalParameterIds()}, rB.steadyState()))


if oB is not None:
    section("B joint-scaling finite difference", fd_B)

# ---------------------------------------------------------------- parameter dependence
p("=" * 78)
p("PARAMETER DEPENDENCE (fresh te.loada per variant)")
p("=" * 78)


def variants(tag, builder, base, changes):
    for label, kw in [("base", {})] + changes:
        def one(label=label, kw=kw):
            args = dict(base)
            args.update(kw)
            r = te.loada(builder(**args))
            o = core(r, tag, verbose=False)
            p("[%s] %-10s ss_return=%r dS/dt=%r [S]=%r J1=%r J2=%r E1S=%r E2S=%r C1=%r C2=%r summ=%r conn=%r" % (
                tag, label, o["ss_return"], o["roc"]["S"], o["S"], o["rates"]["J1"], o["rates"]["J2"],
                o["E"][("J1", "S")], o["E"][("J2", "S")], o["C1"], o["C2"], o["summ"], o["conn"]))
            if tag == "B":
                q1, q2 = args["k1"] / args["k1r"], args["k2"] / args["k2r"]
                a, b = q1 * q2 / args["k1"], q2 / args["k2"]
                p("[%s] %-10s forward cond X0*q1*q2=%r > X1=%r ; eq6.6 normalised: %r, %r" % (
                    tag, label, args["X0"] * q1 * q2, args["X1"], a / (a + b), b / (a + b)))
        section("%s variant %s" % (tag, label), one)


variants("A", ant_A, dict(k1=0.3, k2=0.1, X0=10, X1=0),
         [("k1=0.03", dict(k1=0.03)), ("k1=3", dict(k1=3.0)),
          ("k2=0.01", dict(k2=0.01)), ("k2=1", dict(k2=1.0)),
          ("X0=1", dict(X0=1)), ("X0=100", dict(X0=100))])
variants("B", ant_B, dict(k1=0.3, k1r=0.2, k2=0.1, k2r=0.05, X0=10, X1=1),
         [("k1=0.6", dict(k1=0.6)), ("k1r=0.4", dict(k1r=0.4)),
          ("k2=0.2", dict(k2=0.2)), ("k2r=0.1", dict(k2r=0.1)),
          ("X0=20", dict(X0=20)), ("X1=2", dict(X1=2))])

p("=" * 78)
p("ERRORS: %d" % len(ERRORS))
for e in ERRORS:
    p(e)
p("output written to %s" % OUT)
_fh.close()
