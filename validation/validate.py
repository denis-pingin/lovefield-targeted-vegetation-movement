"""Reproduce the protocol's finite checks and simulations; write JSON to stdout.

No application, credentials, originals or network are modified. Optional
--retained-analysis reads one existing exported analysis for a preparation-only
worked example. Simulations are mathematical examples, not field power claims.
"""
import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path

import numpy as np
from reference import ALPHA, MotionBin, Series, Stream


class PriorCandidate:
    """The two previously proposed tanh calculations, for sensitivity comparison."""
    def __init__(self):
        self.means = []
        self.squares = []
        self.counts = []
        self.products = []

    def add(self, values, label):
        while len(self.counts) < len(values):
            self.means.append(0.0)
            self.squares.append(0.0)
            self.counts.append(0)
            self.products.append(1.0)
        for k, value in enumerate(values):
            n = self.counts[k]
            if n:
                scale = max(1.0, math.sqrt(max(0, self.squares[k] / n)))
                factor = 1 + (2 * label - 1) * math.tanh((value - self.means[k]) / scale)
                self.products[k] *= factor
            self.counts[k] += 1
            difference = value - self.means[k]
            self.means[k] += difference / self.counts[k]
            self.squares[k] += difference * (value - self.means[k])

    def value(self):
        return sum(self.products) / len(self.products)


def rate_interval(hits, count):
    z = 1.959963984540054
    p = hits / count
    denominator = 1 + z * z / count
    center = (p + z * z / (2 * count)) / denominator
    width = z * math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator
    return [center - width, center + width]


def enumeration():
    final_values, hits, missed = [], 0, 0
    for labels in itertools.product((0, 1), repeat=12):
        series = Series()
        maximum = 0
        missed_path = False
        for r in range(3):
            duration = 1 + sum(labels[:4 * r]) % 3
            for i in range(4):
                j = 4 * r + i
                # Depends on past labels but never the current label.
                base = .15 * math.sin(j) + .08 * sum(labels[max(0, j - 3):j])
                bins = [MotionBin(1, 1 + base + .03 * k, 1 - base - .03 * k) for k in range(duration)]
                series.add_target(str(r), i, labels[j], bins)
                maximum = max(maximum, series.log_e())
                for k, stream in series.streams.items():
                    lo, hi = stream.interval(ALPHA * series.weight(k))
                    missed_path |= not lo <= 0 <= hi
        final_values.append(math.exp(series.log_e()))
        hits += maximum >= math.log(20)
        missed += missed_path
    return {'paths': len(final_values), 'mean_terminal_e': float(np.mean(final_values)), 'ever_crossed_20': hits, 'ever_missed_true_zero_in_any_interval': missed}


def scenario(name, paths, seed, runs=16):
    rng = np.random.default_rng(seed)
    detected = old_carried = old_run_product = coverage_misses = 0
    final_log_e, widths, estimates, target_counts = [], [], [], []
    for _ in range(paths):
        series, carried = Series(), PriorCandidate()
        product_e = 1.0
        maximum = maximum_carried = maximum_product = 0.0
        noise, previous_sign, previous_sum, total_targets = 0.0, 0, 0, 0
        truth, truth_counts = {}, {}
        missed = False
        for run in range(runs):
            variable = name == 'null_adaptive_settings'
            duration = [2, 8, 15][previous_sum % 3] if variable else 15
            count = (8 if previous_sum % 2 else 16) if variable else 16
            run_candidate = PriorCandidate()
            for target in range(count):
                label = int(rng.integers(0, 2))
                sign = 2 * label - 1
                noise = .85 * noise + rng.normal(0, .055)
                base = noise
                if name in ('null_region_bias', 'biased_5pp'):
                    base += .55
                if name in ('null_drift_carryover', 'null_adaptive_settings'):
                    base += .2 * math.sin(total_targets / 19) + .15 * previous_sign
                bins, raw_differences, true_effects = [], [], []
                for k in range(duration):
                    amplitude = {'sustained_1pp': .01, 'sustained_5pp': .05, 'sustained_12pp': .12, 'biased_5pp': .05, 'opposite_8pp': -.08}.get(name, 0)
                    if name == 'early_12pp':
                        amplitude = .12 if k < 2 else 0
                    elif name == 'late_12pp':
                        amplitude = .12 if 8 <= k < 10 else 0
                    elif name == 'reversal_10pp':
                        amplitude = .1 if k < 5 else (-.1 if k < 10 else 0)
                    regional_background = base + .035 * math.sin(k + total_targets / 11)
                    plus = max(-.95, min(.95, regional_background + amplitude))
                    minus = max(-.95, min(.95, regional_background - amplitude))
                    balance = plus if label else minus
                    missing = name == 'null_selective_missing' and sign * balance < -.025
                    bins.append(MotionBin(1, 1 + balance, 1 - balance, usable=not missing))
                    raw_differences.append(2 * balance)
                    true_effects.append((plus - minus) / 2)
                series.add_target(str(run), target, label, bins)
                carried.add(raw_differences, label)
                run_candidate.add(raw_differences, label)
                for key, effect in [(-1, sum(true_effects) / duration)] + list(enumerate(true_effects)):
                    truth[key] = truth.get(key, 0) + effect
                    truth_counts[key] = truth_counts.get(key, 0) + 1
                previous_sign = sign
                previous_sum += label
                total_targets += 1
            product_e *= run_candidate.value()
            maximum = max(maximum, series.log_e())
            maximum_carried = max(maximum_carried, carried.value())
            maximum_product = max(maximum_product, product_e)
            for key, stream in series.streams.items():
                lo, hi = stream.interval(ALPHA * series.weight(key))
                missed |= not lo <= truth[key] / truth_counts[key] <= hi
        detected += maximum >= math.log(20)
        old_carried += maximum_carried >= 20
        old_run_product += maximum_product >= 20
        coverage_misses += missed
        final_log_e.append(series.log_e())
        lower, upper = series.streams[-1].interval(.025)
        widths.append(upper - lower)
        estimates.append(series.streams[-1].effect_lower / total_targets)
        target_counts.append(total_targets)
    comparisons_eligible = name not in ('null_adaptive_settings', 'null_selective_missing')
    return {
        'paths': paths, 'runs_per_path': runs, 'targets_min_max': [min(target_counts), max(target_counts)],
        'selected_ever_crossed_20': detected, 'selected_crossing_rate': detected / paths,
        'crossing_rate_mc_95pct_interval': rate_interval(detected, paths),
        'any_simultaneous_interval_missed_truth': coverage_misses,
        'median_terminal_e': float(math.exp(np.median(final_log_e))),
        'median_whole_effect': float(np.median(estimates)) if name != 'null_selective_missing' else None,
        'median_whole_interval_width': float(np.median(widths)),
        'prior_carried_crossing_rate': old_carried / paths if comparisons_eligible else None,
        'prior_run_product_crossing_rate': old_run_product / paths if comparisons_eligible else None,
        'comparison_note': 'Same simulated camera motions, prior raw D with scale floor 1 versus bounded balance. This compares complete analysis choices, not one isolated formula change.' if comparisons_eligible else 'Prior fixed-setting/complete-outcome comparison not applicable.'
    }


def worked_examples():
    examples = {}
    for name, amplitude in [('no_systematic_change', 0), ('positive', .12), ('opposite', -.12), ('brief', 0)]:
        rng = np.random.default_rng(913)
        series = Series()
        regional = []
        transition_rows = {}
        for run in range(16):
            previous_label, previous_bins = None, None
            for target in range(16):
                label = int(rng.integers(0, 2))
                noise = rng.normal(0, .04)
                bins = []
                for k in range(15):
                    effect = (.2 if k < 2 else 0) if name == 'brief' else amplitude
                    balance = noise + (2 * label - 1) * effect
                    bins.append(MotionBin(1, 1 + balance, 1 - balance))
                series.add_target(str(run), target, label, bins)
                regional.append((label, sum(b.a for b in bins) / 15, sum(b.b for b in bins) / 15))
                if previous_label is not None:
                    transition = ('A' if previous_label else 'B') + '-to-' + ('A' if label else 'B')
                    transition_rows.setdefault(transition, []).append((bins[0].a - sum(b.a for b in previous_bins[-5:]) / 5, bins[0].b - sum(b.b for b in previous_bins[-5:]) / 5))
                previous_label, previous_bins = label, bins
        examples[name] = series.result()
        mean = lambda values: sum(values) / len(values)
        examples[name]['regional_diagnostics'] = {
            'A_targeting_difference_px_s': mean([a for z, a, b in regional if z]) - mean([a for z, a, b in regional if not z]),
            'B_targeting_difference_px_s': mean([b for z, a, b in regional if not z]) - mean([b for z, a, b in regional if z]),
            'A_assignments': sum(z for z, a, b in regional),
            'B_assignments': sum(1-z for z, a, b in regional),
            'transitions': {key: {'count': len(values), 'first_second_A_minus_previous_five_seconds': mean([a for a, b in values]), 'first_second_B_minus_previous_five_seconds': mean([b for a, b in values])} for key, values in transition_rows.items()},
        }
    return examples


def retained_example(path):
    raw = Path(path).read_bytes()
    result = json.loads(raw)['result']
    series = Series()
    for i, (label, interval) in enumerate(zip(result['assignments']['tree'], result['measurements']['tree']['intervals'], strict=True)):
        bins = [MotionBin(row['durationSeconds'], row['A_motion'], row['B_motion'], usable=row['quantifiable']) for row in interval['timeBins']]
        series.add_target('retained-preparation', i, label, bins)
    return {'source_sha256': hashlib.sha256(raw).hexdigest(), 'interpretation': 'Calculation illustration on retained median-track measurements, not re-extraction with the new mean-track profile. Retrospective preparation only; not scored evidence or new data.', 'result': series.result()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--paths', type=int, default=500)
    parser.add_argument('--retained-analysis')
    options = parser.parse_args()
    names = ['null_equal', 'null_region_bias', 'null_drift_carryover', 'null_adaptive_settings', 'null_selective_missing', 'sustained_1pp', 'sustained_5pp', 'sustained_12pp', 'biased_5pp', 'early_12pp', 'late_12pp', 'reversal_10pp', 'opposite_8pp']
    results = {'seed': 20260928, 'enumeration': enumeration(), 'scenarios': {}, 'examples': worked_examples()}
    for index, name in enumerate(names):
        results['scenarios'][name] = scenario(name, options.paths, 20260928 + index)
    if options.retained_analysis:
        results['retained_preparation'] = retained_example(options.retained_analysis)
    print(json.dumps(results, indent=2, allow_nan=False))
