"""Behavioral checks for the research calculation, not the deployed application."""
import itertools
import math

import numpy as np
import pytest
from scipy.integrate import quad

from reference import MotionBin, Series, Stream, confidence_boundary, log_mixture, motion_balance


def test_balance_units_zero_and_common_scale():
    assert motion_balance(0, 0) == 0
    assert motion_balance(3, 1) == pytest.approx(.5)
    assert motion_balance(300, 100) == pytest.approx(.5)
    assert (motion_balance(1.25, 1) - motion_balance(1, 1)) / 2 == pytest.approx(1 / 18)


def test_qualified_outcome_and_retained_raw_prefix_motion_are_separate_inputs():
    first = MotionBin(1, 1, 3, raw_motion=(100, 1))
    assert first.bounds() == pytest.approx((-.5, -.5))
    assert first.prediction_value() == motion_balance(100, 1)
    series = Series()
    series.add_target('run', 0, 1, [first])
    assert series.streams[0].effect_lower == pytest.approx(-.5)
    assert series.streams[0].run_prediction_total == first.prediction_value()
    series.add_target('run', 1, 1, [MotionBin(1, 3, 1, raw_motion=(3, 1))])
    assert series.streams[0].effect_lower == 0
    assert series.streams[0].evidence_total == pytest.approx(-99 / 101)
    assert MotionBin(1, 3, 1, raw_motion=(None, None)).prediction_value() == 0


@pytest.mark.parametrize('a,b', [(-1, 1), (1, float('nan')), (float('inf'), 1)])
def test_invalid_motion_is_not_a_zero_measurement(a, b):
    with pytest.raises(ValueError):
        motion_balance(a, b)


@pytest.mark.parametrize('total,variance', [(0, 0), (1.4, 2), (-8, 4), (8, 5)])
def test_closed_form_equals_integrating_randomization_factors(total, variance):
    value = quad(lambda lam: math.sqrt(2 / math.pi) * math.exp(lam * total - (variance + 1) * lam * lam / 2), 0, np.inf)[0]
    assert math.exp(log_mixture(total, variance)) == pytest.approx(value, rel=1e-10)


def test_large_negative_score_remains_finite():
    assert math.isfinite(log_mixture(-1e7, 1e7))
    assert log_mixture(0, 0) == pytest.approx(0)


def test_partial_final_second_uses_actual_duration():
    series = Series()
    series.add_target('run', 0, 1, [MotionBin(1, 3, 1), MotionBin(.5, 1, 3)])
    assert series.streams[-1].effect_lower == pytest.approx(1 / 6)
    assert series.streams[0].effect_lower == pytest.approx(.5)
    assert series.streams[1].effect_lower == pytest.approx(-.5)


def test_missing_bin_is_bounded_including_whole_target():
    series = Series()
    series.add_target('run', 0, 1, [MotionBin(1, 3, 1), MotionBin(1, None, None)])
    assert series.streams[-1].effect_lower == pytest.approx(-.25)
    assert series.streams[-1].effect_upper == .75
    assert series.streams[1].effect_lower == -1
    assert series.streams[1].effect_upper == 1
    assert series.streams[1].count == 1


def test_missing_outcome_cannot_outperform_any_completion():
    def ending(value):
        stream = Stream()
        for label, balance in [(1, .2), (0, -.1), (1, .3)]:
            stream.update(label, balance, balance)
        stream.update(0, *value, prediction_value=0.0 if value[0] != value[1] else value[0])
        return stream
    missing = ending((-1, 1))
    for balance in np.linspace(-1, 1, 41):
        complete = ending((balance, balance))
        assert missing.log_e() <= complete.log_e() + 1e-12
        lo, hi = missing.interval(.05)
        clo, chi = complete.interval(.05)
        assert lo <= clo and hi >= chi


def test_variable_duration_retains_lag_history_without_zero_padding():
    series = Series()
    series.add_target('short', 0, 1, [MotionBin(1, 2, 1)])
    series.add_target('long', 0, 0, [MotionBin(1, 1, 2), MotionBin(1, 1, 2)])
    series.add_target('shorter', 0, 1, [MotionBin(1, 2, 1)])
    assert series.streams[-1].count == 3
    assert series.streams[0].count == 3
    assert series.streams[1].count == 1


def test_same_label_runs_remain_observations_and_duplicate_targets_are_rejected():
    series = Series()
    for index in range(3):
        series.add_target('run', index, 1, [MotionBin(1, 1, 1)])
    assert series.streams[-1].count == 3
    with pytest.raises(ValueError):
        series.add_target('run', 2, 1, [MotionBin(1, 1, 1)])


def test_settings_cannot_change_within_run_and_old_runs_cannot_reappear():
    series = Series()
    series.add_target('one', 0, 1, [MotionBin(1, 1, 1)])
    with pytest.raises(ValueError):
        series.add_target('one', 1, 0, [MotionBin(.5, 1, 1)])
    series.add_target('two', 0, 0, [MotionBin(1, 1, 1)])
    with pytest.raises(ValueError):
        series.add_target('one', 1, 1, [MotionBin(1, 1, 1)])


def test_zero_data_does_not_fabricate_no_effect_precision():
    series = Series()
    assert series.log_e() == pytest.approx(0)
    assert series.streams == {}
    stream = Stream()
    assert stream.interval(.05) == (-1, 1)


def test_variance_boundary_monotone_and_later_data_tighten_constant_effect():
    assert confidence_boundary(20, .05) > confidence_boundary(2, .05)
    stream = Stream()
    for index in range(100):
        sign = 1 if index % 2 else -1
        stream.update(int(sign == 1), .1 * sign, .1 * sign)
    width = np.diff(stream.interval(.05))[0]
    for index in range(900):
        sign = 1 if index % 2 else -1
        stream.update(int(sign == 1), .1 * sign, .1 * sign)
    lower, upper = stream.interval(.05)
    assert lower <= .1 <= upper
    assert lower > 0
    assert upper - lower < width


def test_design_estimate_is_unbiased_despite_region_bias():
    # Two potential balances .7 (A assigned) and .5 (B assigned).
    # The contrast of shares is (.7 - .5)/2 = .1.
    means = []
    for label, balance in [(1, .7), (0, .5)]:
        stream = Stream()
        stream.update(label, balance, balance)
        means.append(stream.effect_lower)
    assert sum(means) / 2 == pytest.approx(.1)


def test_complete_fair_enumeration_with_history_dependent_outcomes():
    terminal = []
    crossed = 0
    for labels in itertools.product((0, 1), repeat=10):
        stream = Stream()
        maximum = 0
        for index, label in enumerate(labels):
            balance = .2 * math.sin(index) + .05 * sum(labels[:index])
            stream.update(label, balance, balance)
            maximum = max(maximum, stream.log_e())
        terminal.append(math.exp(stream.log_e()))
        crossed += maximum >= math.log(20)
    assert np.mean(terminal) <= 1 + 1e-12
    assert crossed / len(terminal) <= .05


def test_minority_motion_contributes_to_region_measurement():
    from reference import mean_feature_speed
    # Ninety stationary accepted features and ten moving 1 pixel in 40 ms.
    assert mean_feature_speed([0] * 90 + [1] * 10, .04) == pytest.approx(2.5)
    assert mean_feature_speed([1] * 10, .04) == pytest.approx(25)
    assert mean_feature_speed([0] * 10, .04) == 0
    with pytest.raises(ValueError):
        mean_feature_speed([], .04)


def test_quality_mask_does_not_retrain_reference_from_selected_outcomes():
    series = Series()
    series.add_target('run', 0, 1, [MotionBin(1, 3, 1, usable=False)])
    series.add_target('run', 1, 1, [MotionBin(1, 3, 1)])
    # First outcome has worst-case score -1. Next outcome equals its raw
    # predecessor's balance, despite the predecessor being excluded by review.
    assert series.streams[0].evidence_total == pytest.approx(-1)


def test_motion_reference_restarts_for_new_scene_without_resetting_evidence():
    series = Series()
    series.add_target('one', 0, 1, [MotionBin(1, 3, 1)])
    series.add_target('one', 1, 1, [MotionBin(1, 3, 1)])
    assert series.streams[0].evidence_total == pytest.approx(.5)
    series.add_target('two', 0, 1, [MotionBin(1, 3, 1)])
    assert series.streams[0].evidence_total == pytest.approx(1)
    assert series.streams[0].count == 3


def test_even_future_informed_masks_cannot_increase_evidence_with_retained_predictors():
    rng = np.random.default_rng(8)
    for _ in range(30):
        labels = rng.integers(0, 2, size=12)
        balances = rng.uniform(-.8, .8, size=(12, 3))
        full, masked = Series(), Series()
        for index, label in enumerate(labels):
            full.add_target('run', index, int(label), [MotionBin(1, 1 + r, 1 - r) for r in balances[index]])
            # Deliberately outcome/label/future-dependent exclusion to stress
            # the pointwise bound. The raw predictor values remain unchanged.
            masked.add_target('run', index, int(label), [MotionBin(1, 1 + r, 1 - r, usable=not ((2 * label - 1) * r < 0 or (labels[-1] and index % 3 == 0))) for r in balances[index]])
            assert masked.log_e() <= full.log_e() + 1e-12
            for key in full.streams:
                low, high = masked.streams[key].interval(.01)
                flow, fhigh = full.streams[key].interval(.01)
                assert low <= flow + 1e-12 and high >= fhigh - 1e-12


def test_missing_outcome_requires_explicit_predictor_provenance():
    with pytest.raises(ValueError):
        Stream().update(1, -1, 1)
