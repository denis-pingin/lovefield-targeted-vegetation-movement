"""Executable scientific specification. No field-app, video or network operations.

Read ../analysis-methods.md before interpreting outputs. Inputs must already be
chronological, authenticated randomized targets with fixed within-run settings.
"""
from dataclasses import dataclass, field
import math

from scipy.special import erfcx, log_ndtr, logsumexp


RHO = 1.0
LAG_DECAY_SECONDS = 15.0
ALPHA = .05


def motion_balance(a, b):
    if not (math.isfinite(a) and math.isfinite(b)) or min(a, b) < 0:
        raise ValueError('Motion must be finite and nonnegative; missing is not zero')
    if a == b == 0:
        return 0.0
    # Rescale first to avoid overflow of a+b without changing the ratio.
    scale = max(a, b)
    return (a / scale - b / scale) / (a / scale + b / scale)


def log_mixture(total, variance, rho=RHO):
    """Half-normal mixture of exp(lambda*total-lambda**2*variance/2)."""
    if variance < 0 or rho <= 0:
        raise ValueError('Nonnegative variance and positive rho required')
    z = total / math.sqrt(rho + variance)
    normalizer = .5 * math.log(rho / (rho + variance))
    if z <= 0:
        return normalizer + float(math.log(erfcx(-z / math.sqrt(2))))
    return math.log(2) + normalizer + z * z / 2 + float(log_ndtr(z))


def confidence_boundary(variance, alpha):
    """Two-sided time-uniform bound for [0,1] outcomes, all dyadic bets."""
    if variance < 0 or not 0 < alpha < 1:
        raise ValueError('Invalid variance or error allowance')
    best = math.inf
    index = 1
    while True:
        lam = math.ldexp(.9, 1 - index)
        weight = 1 / (index * (index + 1))
        intercept = math.log(2 / (alpha * weight)) / lam
        # Later intercepts only increase; variance terms are nonnegative.
        if intercept >= best:
            return best
        penalty = -math.log1p(-lam) - lam
        best = min(best, intercept + penalty * variance / lam)
        index += 1


@dataclass(frozen=True)
class MotionBin:
    duration: float
    a: float | None
    b: float | None
    usable: bool = True
    raw_motion: tuple[float | None, float | None] | None = None

    def prediction_value(self):
        # Raw prefix measurement; later quality review cannot change this value.
        a, b = self.raw_motion if self.raw_motion is not None else (self.a, self.b)
        return 0.0 if a is None or b is None else motion_balance(a, b)

    def bounds(self):
        if not math.isfinite(self.duration) or not 0 < self.duration <= 1:
            raise ValueError('A bin must have actual duration in (0,1] seconds')
        if self.raw_motion is not None and (not isinstance(self.raw_motion, tuple) or len(self.raw_motion) != 2):
            raise ValueError('Raw predictor motion must be an explicit A/B pair')
        for value in (self.a, self.b, *(self.raw_motion or ())):
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError('Invalid movement must be explicitly marked missing')
        if not self.usable or self.a is None or self.b is None:
            return -1.0, 1.0
        balance = motion_balance(self.a, self.b)
        return balance, balance


@dataclass
class Stream:
    count: int = 0
    missing: int = 0
    evidence_total: float = 0.0
    evidence_variance: float = 0.0
    effect_lower: float = 0.0
    effect_upper: float = 0.0
    confidence_variance: float = 0.0

    run_prediction_total: float = 0.0
    run_prediction_count: int = 0

    def new_run(self):
        self.run_prediction_total = 0.0
        self.run_prediction_count = 0

    def update(self, label, lower, upper, prediction_value=None):
        if label not in (0, 1) or not -1 <= lower <= upper <= 1:
            raise ValueError('A/B label and valid bounded outcome required')
        center = self.run_prediction_total / self.run_prediction_count if self.run_prediction_count else 0.0
        if prediction_value is None:
            if lower != upper:
                raise ValueError("Missing outcome requires retained raw predictor or explicit zero for unavailable raw data")
            prediction_value = lower
        if not math.isfinite(prediction_value) or not -1 <= prediction_value <= 1:
            raise ValueError("A bounded raw prefix predictor is required")
        signed_lower, signed_upper = (lower, upper) if label else (-upper, -lower)
        self.evidence_total += signed_lower - (2 * label - 1) * center
        self.evidence_variance += max((lower - center) ** 2, (upper - center) ** 2)
        prediction = .5
        wlower, wupper = (signed_lower + 1) / 2, (signed_upper + 1) / 2
        self.confidence_variance += max((wlower - prediction) ** 2, (wupper - prediction) ** 2)
        self.effect_lower += signed_lower
        self.effect_upper += signed_upper
        self.run_prediction_total += prediction_value
        self.run_prediction_count += 1
        self.count += 1
        self.missing += lower != upper

    def log_e(self):
        return log_mixture(self.evidence_total, self.evidence_variance)

    def interval(self, alpha):
        if not self.count:
            return -1.0, 1.0
        width = 2 * confidence_boundary(self.confidence_variance, alpha) / self.count
        return max(-1.0, self.effect_lower / self.count - width), min(1.0, self.effect_upper / self.count + width)

    def result(self, alpha):
        return {
            'targets': self.count,
            'bounded_missing_targets': self.missing,
            'effect_estimate': None if self.missing or not self.count else self.effect_lower / self.count,
            'effect_estimate_bounds': [self.effect_lower / self.count, self.effect_upper / self.count] if self.count else [-1, 1],
            'simultaneous_confidence_interval': list(self.interval(alpha)),
            'log_e': self.log_e(),
            'evidence_total': self.evidence_total,
            'evidence_variance': self.evidence_variance,
            'confidence_variance': self.confidence_variance,
        }


@dataclass
class Series:
    streams: dict = field(default_factory=dict)
    current_run: str | None = None
    seen_runs: set = field(default_factory=set)
    next_target: int = 0
    current_durations: tuple = ()

    def add_target(self, run_id, target_index, label, bins):
        if not bins or label not in (0, 1):
            raise ValueError('At least one bin and authenticated A/B label required')
        bounds = [item.bounds() for item in bins]
        durations = tuple(item.duration for item in bins)
        if any(duration != 1 for duration in durations[:-1]):
            raise ValueError('Only the last bin may be partial')
        if run_id == self.current_run:
            if target_index != self.next_target or durations != self.current_durations:
                raise ValueError('Duplicate/out-of-order target or changed within-run settings')
        else:
            if not run_id or run_id in self.seen_runs or target_index != 0:
                raise ValueError('Run already contributed or first target is missing')
            self.seen_runs.add(run_id)
            self.current_run = run_id
            self.current_durations = durations
            self.next_target = 0
            for stream in self.streams.values():
                stream.new_run()
        total = sum(durations)
        whole_lower = sum(duration * lower for duration, (lower, _) in zip(durations, bounds)) / total
        whole_upper = sum(duration * upper for duration, (_, upper) in zip(durations, bounds)) / total
        whole_prediction = sum(item.duration * item.prediction_value() for item in bins) / total
        self.streams.setdefault(-1, Stream()).update(label, whole_lower, whole_upper, whole_prediction)
        for index, (lower, upper) in enumerate(bounds):
            self.streams.setdefault(index, Stream()).update(label, lower, upper, bins[index].prediction_value())
        self.next_target += 1

    @staticmethod
    def weight(index):
        if index == -1:
            return .5
        return .5 * (-math.expm1(-1 / LAG_DECAY_SECONDS)) * math.exp(-index / LAG_DECAY_SECONDS)

    def log_e(self):
        if not self.streams:
            return 0.0
        largest = max(self.streams)
        terms = [math.log(self.weight(index)) + stream.log_e() for index, stream in self.streams.items()]
        # The never-eligible infinite tail has E=1, not zero-valued observations.
        terms.append(math.log(.5) - (largest + 1) / LAG_DECAY_SECONDS)
        return float(logsumexp(terms))

    def result(self):
        return {
            'runs': len(self.seen_runs),
            'log_e': self.log_e(),
            'threshold_log_e': math.log(20),
            'streams': {str(index): stream.result(ALPHA * self.weight(index)) for index, stream in self.streams.items()},
        }


def mean_feature_speed(displacement_magnitudes, elapsed_seconds):
    """Region index after the declared tracker/quality acceptance, px/second."""
    if not displacement_magnitudes or not math.isfinite(elapsed_seconds) or elapsed_seconds <= 0:
        raise ValueError('Accepted tracks and positive elapsed time required')
    if any(not math.isfinite(value) or value < 0 for value in displacement_magnitudes):
        raise ValueError('Accepted displacement magnitudes must be finite and nonnegative')
    return math.fsum(displacement_magnitudes) / len(displacement_magnitudes) / elapsed_seconds
