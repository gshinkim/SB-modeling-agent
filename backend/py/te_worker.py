"""Warm Tellurium worker: one JSON request per stdin line, one JSON reply per stdout line.

Kept warm because `import tellurium` costs seconds and every keystroke in the UI
triggers a run. Every reply carries `ok`; errors come back as data, never a crash.
"""
import json, math, re, sys, time, traceback

import tellurium as te
import roadrunner

CACHE = {}          # antimony source -> loaded model (reloading is the slow part)


MAX_STEPS = 500000          # CVODE's 20k default gives up on ordinary stiff models


def clean(o):
    """Replace non-finite floats with null so json.dumps(allow_nan=False) never raises
    and the reply line stays valid JSON for Node to parse."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o


def load(src):
    if src not in CACHE:
        CACHE.clear()               # one model at a time; the UI only ever shows one
        CACHE[src] = te.loada(src)
    r = CACHE[src]
    r.resetToOrigin()
    if r.conservedMoietyAnalysis:
        r.conservedMoietyAnalysis = False   # no leak between ops on the cached model
    try:
        r.integrator.setValue("maximum_num_steps", MAX_STEPS)
    except Exception:
        pass                        # older integrators do not expose it; not fatal
    return r


def _matrix(res):
    names = [c[1:-1] if c.startswith("[") and c.endswith("]") else c for c in res.colnames]
    return names, [[float(v) for v in res[:, i]] for i in range(len(names))]


def simulate_safe(r, over, start, end, points, selections=None):
    """Integrate, and if the solver gives up, return how far it got.

    A stiff, singular or blowing-up model makes CVODE bail (CV_TOO_MUCH_WORK,
    CV_CONV_FAILURE). That is information about the model, not a reason to show the
    user nothing - so the reachable horizon is bisected and the trajectory up to it
    is returned with a note.
    """
    def run(a, b, n):
        r.resetToOrigin()
        apply_overrides(r, over)
        return r.simulate(a, b, n, selections=selections) if selections else r.simulate(a, b, n)

    try:
        names, cols = _matrix(run(start, end, points))
        return names, cols, None
    except Exception as e:
        first = str(e).split(";")[0]

    span = end - start
    lo, hi, best = start, end, None
    for _ in range(14):
        mid = (lo + hi) / 2.0
        if mid <= start:
            break
        try:
            best = (mid, _matrix(run(start, mid, points)))
            lo = mid
        except Exception:
            hi = mid
        if (hi - lo) < span * 1e-3:
            break

    if best is None:
        raise ValueError("the solver could not integrate this model at all - %s" % first[:200])
    reached, (names, cols) = best
    return names, cols, ("solver stopped at t=%.6g of %.6g - the model is stiff, "
                         "singular or diverging there; showing the trajectory up to "
                         "that point" % (reached, end))


def apply_overrides(r, over):
    for k, v in (over or {}).items():
        try:
            r[k] = float(v)
        except Exception:
            pass                     # an id the model dropped is not fatal


def init_concentrations(r):
    """Initial concentrations, keyed init:<id>. Read through the model's own
    `init([S])` selection ids — after a simulate, r[S] is the FINAL value, and the
    initial-condition sliders must not drift to it."""
    out = {}
    try:
        for sel in r.getFloatingSpeciesInitialConcentrationIds():
            m = re.match(r"init\(\[?(.+?)\]?\)$", sel)
            if m:
                out["init:" + m.group(1)] = float(r[sel])
    except Exception:
        pass                       # an API rename must never break a simulation
    return out


def info(r):
    return {
        "floatingSpecies": list(r.getFloatingSpeciesIds()),
        "boundarySpecies": list(r.getBoundarySpeciesIds()),
        "reactions": list(r.getReactionIds()),
        "globalParameters": list(r.getGlobalParameterIds()),
        # current values, plus the *initial* concentrations the IC sliders bind to
        "values": {
            **{k: r[k] for k in list(r.getGlobalParameterIds())
               + list(r.getBoundarySpeciesIds()) + list(r.getFloatingSpeciesIds())},
            **init_concentrations(r),
        },
    }


def do_simulate(q):
    r = load(q["model"])
    over = q.get("overrides")
    apply_overrides(r, over)
    start = float(q.get("start", 0)); end = float(q.get("end", 100))
    points = max(2, min(20000, int(q.get("points", 50))))
    names, cols, note = simulate_safe(r, over, start, end, points, q.get("selections"))
    return {"t": cols[0], "names": names[1:], "cols": cols[1:],
            "note": note, "truncated": note is not None, **info(r)}


def _stability(r):
    """Eigenvalues of the Jacobian AT THE CURRENT STATE. Call straight after
    steadyState(): stability is a property of the fixed point, not of the origin."""
    try:
        vals = [complex(v) for v in r.getFullEigenValues()]
    except Exception as e:
        return {"error": str(e)[:200]}
    hi = max(v.real for v in vals)
    # A conserved quantity gives an eigenvalue of exactly zero. That is marginal,
    # not unstable - calling it unstable made a plain A -> B look divergent.
    tol = 1e-9
    return {
        "eigenvalues": [[v.real, v.imag] for v in vals],
        "maxRealPart": hi,
        "stable": hi < tol,
        "marginal": abs(hi) <= tol,
        "oscillatory": any(abs(v.imag) > 1e-9 for v in vals),
    }


def _settle_index(cols, ss, tol):
    """First sample where every species is within tol (relative) of the steady state."""
    n = len(cols[0])
    scale = [max(abs(v), 1e-9) for v in ss]
    for i in range(n):
        if all(abs(cols[j][i] - ss[j]) / scale[j] <= tol for j in range(len(ss))):
            return i
    return None


def do_settle(q):
    """Simulate up to the steady state and return the approach to it.

    The target comes from RoadRunner's own steady-state solver, not from watching
    the trajectory flatten - a slow transient must not be mistaken for convergence.
    """
    r = load(q["model"])
    over = q.get("overrides")
    apply_overrides(r, over)
    tol = float(q.get("tol", 1e-4))
    points = max(2, min(20000, int(q.get("points", 200))))
    max_time = float(q.get("maxTime", 1e6))
    names = list(r.getFloatingSpeciesIds())
    if not names:
        raise ValueError("model has no floating species to settle")

    try:
        distance = float(r.steadyState())
    except Exception as e:
        raise ValueError("no steady state found: %s" % e)
    ss = [float(v) for v in r.getFloatingSpeciesConcentrations()]
    ss_map = dict(zip(names, ss))
    fluxes = dict(zip(r.getReactionIds(), [float(v) for v in r.getReactionRates()]))
    stability = _stability(r)          # must be read at the fixed point, before any reset
    if distance > 1e-4:
        raise ValueError(
            "steady-state solver did not converge (residual %.3g); the model may "
            "oscillate or be unstable" % distance)

    requested_end = float(q.get("end", 100)) or 100.0

    # An unstable fixed point is never reached by integrating, however far you go -
    # that is what used to run the horizon out to 1e6 and kill CVODE. Say so, and
    # show the behaviour the system actually has instead.
    if stability.get("stable") is False:   # genuinely unstable, not merely marginal
        r.resetToOrigin()
        apply_overrides(r, over)
        out_names, cols, _ = simulate_safe(r, over, 0, requested_end, points)
        return {
            "t": cols[0], "names": out_names[1:], "cols": cols[1:],
            "settled": False, "unstable": True, "settleTime": None,
            "horizon": requested_end, "tolerance": tol,
            "steadyStateDistance": distance, "steadyState": ss_map,
            "fluxes": fluxes, "stability": stability,
            "note": ("the steady state exists but is unstable (max Re(lambda) = %.4g%s); "
                     "the trajectory does not converge to it"
                     % (stability["maxRealPart"],
                        ", complex pair -> oscillatory" if stability["oscillatory"] else "")),
            **info(r),
        }

    # stable: widen the horizon until the trajectory actually reaches the fixed point
    end = requested_end
    settled_at, probe = None, None
    deadline = time.monotonic() + float(q.get("budgetSeconds", 20))
    for _ in range(40):
        r.resetToOrigin()
        apply_overrides(r, over)
        try:
            _, probe_cols, _ = simulate_safe(r, over, 0, end, 1024)
        except Exception as e:                      # could not integrate at all
            if settled_at is None and end == requested_end:
                raise ValueError("could not integrate to t=%g: %s" % (end, str(e)[:160]))
            break
        probe = probe_cols
        cols = probe_cols[1:]
        idx = _settle_index(cols, ss, tol)
        if idx is not None:
            settled_at = float(probe[0][idx])
            break
        if end >= max_time or time.monotonic() > deadline:
            break
        end *= 2

    # final curve: the approach, with a little room past the settling point
    horizon = (settled_at * 1.15) if settled_at and settled_at > 0 else end
    r.resetToOrigin()
    apply_overrides(r, over)
    names_out, cols, note = simulate_safe(r, over, 0, horizon, points)
    return {
        "t": cols[0], "names": names_out[1:], "cols": cols[1:], "note": note,
        "settled": settled_at is not None,
        "settleTime": settled_at,
        "horizon": horizon,
        "tolerance": tol,
        "steadyStateDistance": distance,
        "steadyState": ss_map,
        "fluxes": fluxes,
        "stability": stability,
        **info(r),
    }


def do_steady_state(q):
    r = load(q["model"])
    apply_overrides(r, q.get("overrides"))
    r.conservedMoietyAnalysis = bool(q.get("conservedMoieties", False))
    dist = float(r.steadyState())
    return {"distance": dist, "stability": _stability(r),
            "concentrations": dict(zip(r.getFloatingSpeciesIds(),
                                       [float(v) for v in r.getFloatingSpeciesConcentrations()])),
            "fluxes": dict(zip(r.getReactionIds(),
                               [float(v) for v in r.getReactionRates()])),
            # dX/dt at the solution: the residual per species, not just its norm
            "rates": dict(zip(r.getFloatingSpeciesIds(),
                              [float(v) for v in r.getRatesOfChange()])),
            **info(r)}


def do_mca(q):
    r = load(q["model"])
    # roadrunner crashes the whole worker computing control coefficients with no reactions
    if not r.getNumReactions():
        raise ValueError("this model has no reactions (rate rules only); control "
                         "coefficients are defined for reaction steps")
    apply_overrides(r, q.get("overrides"))
    r.conservedMoietyAnalysis = True
    dist = float(r.steadyState())
    if dist > 1e-4:
        raise ValueError(
            "steady-state solver did not converge (residual %.3g); control "
            "coefficients are only defined at a steady state" % dist)

    def mat(m):
        data = [[float(v) for v in row] for row in m]
        # row sums of Tellurium's own numbers (the summation theorems), so the page adds nothing itself
        return {"rows": list(m.rownames), "cols": list(m.colnames), "data": data,
                "sums": [sum(v for v in row if math.isfinite(v)) for row in data]}

    out = {"steadyStateDistance": dist,
           "fluxControl": mat(r.getScaledFluxControlCoefficientMatrix()),
           "concentrationControl": mat(r.getScaledConcentrationControlCoefficientMatrix()),
           "elasticities": mat(r.getScaledElasticityMatrix()),
           **info(r)}
    # summation theorem residual — the cheapest evidence that the result is trustworthy
    fc = out["fluxControl"]
    out["fluxSummation"] = dict(zip(fc["rows"], fc["sums"]))
    return out


def do_antimony(q):
    """SBML in, Antimony out; Antimony passes through. The editor only holds Antimony."""
    src = q["src"]
    return {"antimony": te.sbmlToAntimony(src) if re.match(r"\s*<(\?xml|sbml)", src) else src}


HANDLERS = {"simulate": do_simulate, "steadyState": do_steady_state,
            "settle": do_settle,
            "mca": do_mca,
            "antimony": do_antimony,
            "info": lambda q: info(load(q["model"])),
            "version": lambda q: {"tellurium": te.__version__,
                                  "roadrunner": roadrunner.__version__,
                                  "python": sys.version.split()[0]}}


def main():
    sys.stderr.write("READY\n"); sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            q = json.loads(line)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "bad request: %s" % e}), flush=True)
            continue
        try:
            fn = HANDLERS.get(q.get("op"))
            if not fn:
                raise ValueError("unknown op %r" % q.get("op"))
            result = fn(q)
            if isinstance(result, dict):
                result["source"] = "tellurium"          # the UI refuses to plot without this
                result["engine"] = {"tellurium": te.__version__,
                                    "roadrunner": roadrunner.__version__}
            print(json.dumps(clean({"ok": True, "id": q.get("id"), "result": result}),
                             allow_nan=False), flush=True)
        except Exception as e:
            sys.stderr.write(traceback.format_exc()); sys.stderr.flush()
            print(json.dumps(clean({"ok": False, "id": q.get("id"), "error": str(e)}),
                             allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
