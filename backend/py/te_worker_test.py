"""Scientific regression tests using the installed Tellurium engine and small models."""
import unittest
import te_worker as w

LINEAR = """model test()
J0: -> S; k0;
J1: S ->; k1*S;
k0=1; k1=1; S=2;
end"""


class WorkerTests(unittest.TestCase):
    def test_settling_requires_remaining_in_tolerance(self):
        self.assertIsNone(w._settle_index([[2, 1, 2]], [1], 0.1))
        self.assertIsNone(w._settle_index([[2, 2, 1]], [1], 0.1))
        self.assertEqual(w._settle_index([[2, 1.01, 1]], [1], 0.1), 1)
        self.assertEqual(w._settle_index([[1, 1, 1]], [1], 0.1), 0)

    def test_selection_order_always_has_time_first(self):
        for selections in [["S"], ["S", "time"], ["time", "S"]]:
            r = w.do_simulate({"model": LINEAR, "points": 3, "end": 2, "selections": selections})
            self.assertEqual(r["t"], [0, 1, 2])
            self.assertEqual(r["names"], ["S"])
            self.assertAlmostEqual(r["cols"][0][0], 2)

    def test_nonfinite_or_reversed_simulation_interval_is_rejected(self):
        for start, end in [(3, 1), (1, 1), (0, float("nan")), (float("inf"), 5)]:
            with self.assertRaises(ValueError):
                w.do_simulate({"model": LINEAR, "start": start, "end": end})

    def test_requested_settling_horizon_cannot_exceed_maximum(self):
        r = w.do_settle({"model": LINEAR, "end": 100, "maxTime": 1, "points": 30})
        self.assertFalse(r["settled"])
        self.assertLessEqual(r["horizon"], 1)
        self.assertLessEqual(r["t"][-1], 1)

    def test_linear_model_actually_settles(self):
        for points in [2, 100]:
            r = w.do_settle({"model": LINEAR, "end": 2, "points": points})
            self.assertTrue(r["settled"])
            self.assertAlmostEqual(r["steadyState"]["S"], 1)
            self.assertLess(abs(r["cols"][0][-1] - 1), r["tolerance"])

    def test_zero_scaled_reference_does_not_pass_a_summation_check(self):
        r = w.clean(w.do_mca({"model": LINEAR.replace("k0=1", "k0=0").replace("S=2", "S=0")}))
        self.assertEqual(r["concentrationControl"]["data"], [[None, None]])
        self.assertEqual(r["concentrationControl"]["sums"], [None])
        self.assertEqual(r["fluxControl"]["data"], [[None, None], [None, None]])
        self.assertEqual(r["fluxSummation"], {"J0": None, "J1": None})

    def test_nonzero_mca_theorems_still_hold(self):
        r = w.do_mca({"model": LINEAR})
        for v in r["fluxControl"]["sums"]:
            self.assertAlmostEqual(v, 1)
        for v in r["concentrationControl"]["sums"]:
            self.assertAlmostEqual(v, 0)


if __name__ == "__main__":
    unittest.main()
