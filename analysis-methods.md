# Targeted Vegetation Movement: analysis methods

Statistical method: `tree-analysis-development-1`.

This document specifies the measurements, statistical calculations, and
interpretation for the [study protocol](protocol.md). The executable statistical
reference is [validation/reference.py](validation/reference.py); its behavioral
checks are in [validation/test_reference.py](validation/test_reference.py). Video
extraction, collection, and report generation are separate software components.
Measurement qualification on representative footage is required in addition to
arithmetic and simulation checks.

## Plain-language model

Track both regions continuously. Save how much accepted image detail moves per
second, rather than looking at just two still frames. Compare the same regions
under the two randomized instructions. Keep the changes in each region visible.

For accumulation across different camera views, also express the two movement
indices as a relative balance. If A contributes 45% of their sum under B targeting
and 50% under A targeting, the relative targeting difference is 5 percentage
points. This is not a claim that A's physical speed increased 5%. A might speed
up, B might slow down, or both might change. Their separate raw curves answer
which occurred.

Use one accumulating comparison for the full response and one for each elapsed
second. Combine their evidence through fixed weights, not by pretending seconds
are independently randomized. This permits short responses to matter without
selecting the most favorable second after seeing the data. Report magnitude and
uncertainty separately. There is no minimum-size threshold.

## 1. Input contract and order

Each run supplies its immutable ID, optional tag, preparation/scored status,
settings, setup image/polygons/provenance, profile, release, actual playback
records with phone-clock references, authenticated A/B assignments, complete
run-event history and original recording hash. Each target has a stable ID and
ordinal, label Z=1 for A or 0 for B, mapped playback onset t and configured
response duration T. Outcomes come from [t,t+T), not provider request time.

Use collection order within and between runs. Do not construct transitions
between runs. One run may have many targets but one target cannot contribute
twice. Every generated assignment is included, even in an interrupted run.
Unused tickets for which no assignment was generated are not trials. A generated
label whose delivery failed still contributes one bounded-unknown outcome, unless
retry successfully delivers that same label once; then use its actual onset. An assignment with unavailable data
gets a bounded unknown outcome. An unauthenticated assignment is an unresolved
randomization failure, not an analyzable random target.

An accepted cumulative result consists of a resolved chronological prefix.
Keep later imported runs pending while earlier recordings await a disposition.
A correction recomputes that prefix as one named analysis revision. Reanalysis
never multiplies another copy of the same run into evidence. Preserve earlier
published results and the correction reason.

During preparation, settings may be selected from earlier observations, then
fixed before the next run's assignments. The scored profile freezes them across
runs. Inference from one-second streams always states which durations/settings
contributed; it does not imply that the same population contributed at every lag.

## 2. Versioned preparation motion measurements

### 2.1 Preserved point-average measurement

The values below define the starting candidate profile, not a production lock.
Preparation may save a revised profile and reanalyze recordings. Every result
retains the exact profile contents and hash. The scored series freezes the
qualified profile only when it is explicitly locked.

| Operation | Rule |
| --- | --- |
| Decoding | Original resolution, grayscale, actual presentation timestamps; retain original bytes. |
| Features per polygon | Shi-Tomasi maxCorners=3000, qualityLevel=0.01, minDistance=7 pixels, blockSize=7. |
| Flow | Pyramidal Lucas-Kanade, winSize=(41,41), maxLevel=3, at most 30 iterations or displacement convergence 0.01. |
| Accepted track | Finite coordinates; forward and backward status valid; endpoints inside original image and same polygon; forward/backward discrepancy <=1 pixel. |
| Minimum accepted tracks | A and B each 20; stationary background 10. |
| Refresh | Reseed on the fixed one-second video timeline and when tracks are insufficient; independent of target labels. |
| Frame-pair regional motion | Arithmetic mean of accepted displacement magnitudes divided by frame-pair elapsed seconds. |
| Shake | Background median displacement-vector magnitude >0.5 pixel for 3 consecutive frame pairs. Reject affected outcomes; no motion compensation. |
| Obstruction | Saved Clear review or exact obstructed spans; inspect without assignment-linked results when practicable. No automatic obstruction detector. |
| Coverage | At least 95% valid frame-pair time in every measured bin; failures remain explicit. |

For example, ninety stationary tracks and ten tracks each moving 1 pixel in
40 ms produce 2.5 px/s under the mean; the median is zero. The mean retains a
contribution from motion limited to a minority of accepted tracks. Each accepted
track has equal weight: this is not
an area-weighted census of leaves. Features favor visible texture; outlier
acceptance, coverage and real annotated clips must be qualified. Three thousand
is a maximum, not a promised count. A 41-pixel tracking window is a matching
neighborhood, not a rigid physical object.

### 2.2 Area-based preparation candidate

The area-based method weights local measurements by the canopy area they represent. It can be compared with the point-average method on identical inputs during preparation. Measurement accuracy requires optical checks and annotated footage review; a higher statistical evidence value does not establish better tracking.

The point-average measurement is identified as `feature-mean-v1`; the area-based measurement is `area-grid-mean-v1`. The supplied area profile is `tree-profile-development-2`. Both use the statistical equations below. Every analysis retains the motion method, exact profile, and code identity. Development profiles require qualification and prospective selection before scored use.

The aim is average visible image activity across the selected canopy area: comparable proportions moving at comparable image speeds should give comparable values despite different polygon areas. This is an approximation to visible foliage activity when foliage coverage and apparent leaf size are broadly comparable. It is not a leaf count, a three-dimensional leaf velocity, or wind speed. Existing masks remain fixed; neither weights nor selected locations depend on targeting labels. Large sky gaps, trunks, depth differences and poor spatial representation remain relevant setup limitations. No automatic leaf segmentation is introduced.

Use a fixed native-image grid anchored at image coordinate (0,0), with the same cell size for A and B. Weight each cell by the number of pixels where it intersects the selected polygon. Initial preparation choices are cell width 128 pixels, maximum 32 samples per complete cell, minimum 3 accepted samples per complete cell, and required measured area 99%. Scale both sample counts by the clipped cell area divided by full-cell area, round upward, and retain at least one. These are tunable saved defaults, not an optimum or production lock. The legacy per-region feature cap does not additionally truncate A/B grid sampling. Background tracking remains unchanged.

Detect suitable image features separately within each cell under the saved strength and spacing settings. Perform forward/backward matching against full-resolution frames, with the same tracking-window and acceptance settings as the selected profile. A tracking window may cross an internal grid boundary; that boundary must not truncate its image neighborhood. Assign each accepted displacement to the cell containing its previous-frame position. Mean the magnitudes, never signed vectors, within a cell. Both moving and successfully tracked stationary detail contribute. More accepted points in one cell improve its sampling but do not increase its spatial weight.

For cell area `w_j` and valid mean speed `m_j`, measured-area mean is `sum(w_j*m_j)/sum(w_j)` over valid cells. Spatial coverage is that measured area divided by the complete polygon area. If coverage is below the saved cutoff, return an unavailable regional measurement and retain the observed-area diagnostic separately. Above the cutoff, report the measured-area mean and actual coverage, including any unmeasured fraction. Do not fill unknown cells with zero, impute their movement, or silently imply that the whole region was measured. Coverage above 99% does not prove that missing movement is representative; comparisons include coverage changes and real annotations before this approximation is qualified.

An unmeasured cell is a location where reliable sample matches are insufficient at that frame pair, not every pixel between dots. A stationary textured cell can have valid zero or near-zero displacement. Insufficient matches may follow blur, lack of usable detail or failed tracking. Keep these cases distinguishable in data and annotation. A and B still share valid timing intervals and the existing bounded-unknown treatment for unusable response bins.

The initial area candidate uses the same timed refresh as the legacy candidate to isolate spatial selection and weighting. A separately saved continuous-refresh choice retains valid tracks and tops up cell deficits, without an automatic full reset every second. This addresses the requested track-continuity inspection while keeping that change explicit; never silently compare different refresh policies as if only area weighting changed. Tracking and annotation use the same extractor and retain the actual policy.

The published ST+KLT tree-motion work also converted tracked features into local spatial-grid velocities (Barbacci et al., [section 2.5.2](https://yakari.polytechnique.fr/Django-pub/documents/barbacci2014rp-1pp.pdf#page=6)). Our magnitude averaging, coverage rules and targeting comparison are study-specific adaptations, not that paper's validated complete method.

### 2.3 Preparation method comparisons

Retain both analyses on the same original recording. A saved comparison pins the exact profile and analysis revision for every included run on each side. It records one common chronological inventory and compares only the resolved paired prefix: when either side is missing, failed or based on different source inputs, both accumulations wait at that recording. Keep all inventory rows and their concrete statuses visible. A completed analysis with unavailable measurement bins still contributes those bounded unknowns under the unchanged calculation; it is not omitted as a failed analysis.

Require matching run bundle, original hashes, clock/footage-review inputs, masks, instructions and response boundaries. Profiles and source-code hashes may differ intentionally and remain retained. Use one exact profile and one statistical version within each side of a comparison. A reanalysis, another ordinary-series selection or a newly imported run does not mutate the saved comparison; explicitly save another snapshot to include changed revisions or further recordings. Do not combine evidence from the two methods or count the same recording twice. This comparison is preparation-only.

Present both individual and accumulating effects, confidence ranges, E and usable/missing measurements. Quantify tracking coverage and inspect movement fidelity separately. Known-motion fixtures, duplicated-content area invariance, density sensitivity and annotated real footage determine whether measurement improved. Selecting the larger E after tuning is exploratory, not prospective evidence. Preserve all earlier findings, including weaker or missing results under the candidate.

### 2.4 Shared timing and diagnostics

Retain accepted/rejected counts, frame-pair time, mean speed, background motion,
refreshes and quality flags. Retain a median diagnostic as optional technical
output if already available; it must not replace the selected mean after results
are viewed. The tracker itself remains label-blind.

For each target create bins [t+k,min(t+k+1,t+T)), k=0,...,ceil(T)-1. Retain a
partial final second with its actual duration. A frame pair must be wholly
inside the parent target response. At internal bin edges apportion its measured
speed by overlap duration. Divide accumulated speed-times-duration by covered
seconds; report the coverage fraction separately. Do not sample one frame per
second, interpolate missing frames, or let a future cue's motion enter an earlier
response. A cue delivered before the preceding configured response ends makes
the overlapping bin unavailable.

A bin has paired A and B motion values a>=0, b>=0 or a missing reason. An invalid
region makes its paired relative outcome unavailable. A shake span or obstruction
invalidates the bins it touches. A setup mismatch or unresolvable timing may
invalidate every bin in a recording. Other valid bins remain in the analysis,
with conservative bounds for failed bins. A target is not deleted merely because
some of its measurements are missing.

## 3. Comparable relative outcome and effect size

For a paired valid bin define

```
q = a / (a + b)                  if a + b > 0
q = 1/2                         if a = b = 0
R = 2q - 1 = (a - b)/(a + b)    in [-1,1]
```

Two valid zero measurements give a neutral balance, not missing data. Negative,
non-finite, failed-tracking or unqualified values are missing, not zeros.
No small-denominator cutoff is fitted to target results. When both magnitudes
are tiny, the ratio is sensitive to measurement noise: retain both magnitudes,
qualified motion diagnostics and the raw curves so this is visible. Measurement
qualification, not a favorable evidence score, determines whether those inputs
are credible. Scored interpretation is limited to the qualified motion range.

Common multiplication of a and b leaves R unchanged. That permits comparison of
a relative outcome when image-motion units differ by a common scale. It does not
correct different depth, perspective, branch stiffness, texture or tracking
accuracy between regions or recordings. Show per-run results and setup alongside
the aggregate; do not interpret the aggregate as physical speed or universal
response at all trees.

For the full response define R_full as the duration-weighted average of its
bin R values, including a partial final bin. This is a mean relative balance,
not the ratio of the two whole-response raw speeds. Raw whole-response a and b
are separately duration-weighted means of their paired measurements.

Let S=2Z-1. For each stream, use X=S*R. With fair randomized assignment,

```
E(X | earlier history) = E(q under A | history) - E(q under B | history) = tau_i.
```

The main effect estimate is sum(X)/n. It estimates the average conditional
relative targeting effect across the n instructions contributing to that stream.
Multiply by 100 for percentage points. It is a randomization-weighted estimate;
it is not necessarily identical in a small unbalanced sample to subtracting the
two observed group means. A region's natural excess motion is not assumed zero:
it contributes random noise through S, and uncertainty accounts for it. This
simple estimator can be less efficient when one region is naturally much more
mobile. Do not choose or drop regions/runs
retrospectively to improve it.

Effects and weather may vary, including dependence on previous targets. The
estimate concerns the mean immediate effect of the current assignment along
those observed histories, not a hypothetical history in which every instruction
had been A or B. A/B regional interference is part of this paired outcome; the
two regions are not assumed independent.

For preparation, each randomized instruction has equal weight within its stream.
A run with more targets supplies more assignments; a longer response does not
supply extra independent trials. Full-response effects refer to each run's saved
window, so a mixture of durations estimates a mixture of those procedures.
Freeze one duration for the scored study. Never intersect successive intervals
as though a changing-history estimand were a fixed constant.

## 4. One primary accumulating evidence process

### Hypothesis and component calculation

The no-current-target-effect hypothesis says that, conditional on the recorded
past and settings selected before the cue, the current A/B assignment does not
change the distribution of that response's measured relative outcome. The
assignment is concealed, fair and independent of that past. Outcomes can be
autocorrelated and depend on earlier targets. This is a distributional null,
not merely the assertion that a single whole-period mean happens to be zero.

For each stream, predict its ordinary regional balance from the arithmetic mean
of that stream's earlier raw R measurements in the same run. Call this c_i;
use c_i=0 for its first target. Reset this prediction for a new camera/tree run,
not the evidence. This uses existing observations, not another calibration
period. Only information before the current cue may enter c_i.

Build and retain this prediction sequence from the label-blind, prefix-only
extraction **before** applying retrospective obstruction/recording rejection
masks. A later review cannot remove earlier raw values from it. If no finite raw
paired measurement existed in that earlier window, use 0 for that prediction
input and retain that fact. A poor earlier raw value may make a poor predictor,
but a bounded prediction independent of the current assignment cannot create
valid evidence by itself. Never use a whole-run mean, later frames, the current
label, or a fitted best-performing reference. A pipeline unable to reproduce
this chronological dependency is unqualified for this calculation.

For each stream after n contributing assignments retain

```
U = sum(S_i * (R_i - c_i))
V = sum((R_i - c_i)**2)
rho = 1
E(U,V) = integral over lambda>=0 of exp(lambda*U - lambda**2*V/2)
         against a half-normal density with precision rho
```

The nonnegative component has closed form

```
E(U,V) = 2 * sqrt(rho/(rho+V)) * exp(U**2/(2*(rho+V)))
         * Phi(U/sqrt(rho+V))
```

where Phi is the standard normal cumulative distribution function. Initially
U=V=0 and E=1. Calculate in log space; use the scaled complementary error
function for negative U to avoid cancellation/underflow. No finite set of effect
sizes or minimum detectable effect is built into the continuous mixture.

Why it is valid: for one fixed nonnegative lambda, under the null the two signs
are fair for a label-independent R and a previously determined c. Averaging the next factor gives
`cosh(lambda*(R-c)) * exp(-lambda**2*(R-c)**2/2) <= 1`.
Multiplication through chronological assignments and a fixed mixture over lambda
therefore produce a nonnegative supermartingale. No independent-weather,
independent-frame or normal-outcome assumption is used. More data need not
increase its value. The one-sided mixture is oriented toward target-following
movement; a negative estimate is still reported through the effect interval.

### Combining full response and elapsed seconds

Retain one full-response stream E_full and streams E_k for elapsed seconds
k=0,1,... . Every eligible target updates each applicable stream once. A target
whose configured duration does not reach k contributes nothing to that stream;
its non-existent tail is not a zero observation. Partial final bins contribute
their actual shorter measurement and are identified in counts/duration summaries.
Eligibility depends on saved duration, not on which outcome looks favorable.

Fix these weights before accumulation:

```
w_full = 1/2
w_k = (1/2) * (1-exp(-1/15)) * exp(-k/15)
E_total = w_full*E_full + sum_k(w_k*E_k)
```

The infinite weights sum to one. Unobserved streams remain E=1, so their tail
weight can be included exactly without creating infinite arrays. After the
largest observed index K, the remaining weight is `(1/2)*exp(-(K+1)/15)`.
The 15-second decay is a fixed sensitivity allocation, not a fixed response
length, response latency, effect threshold or requirement to collect 15 seconds.
Later seconds get less primary weight but remain measured and reported.
The full-response component supports sustained responses; the elapsed components
support localized responses that can cancel in the full mean. Keep these weights
fixed when preparation duration changes. Do not renormalize them to whichever
seconds were observed or looked strongest.

Each component is valid on the same chronological history. Their fixed convex
mixture is valid even though their measurements are highly dependent and use
the same assignments. This is why evidence is not multiplied across seconds.
There is no run-wise evidence reset or product of reset run scores. U and V persist
across runs; only the nuisance prediction restarts at zero for the new scene. No
first target is consumed just to initialize a reference.

At accepted run updates compare E_total with 20. Under the stated null, the
probability of ever crossing is at most 1/20=0.05. Preserve the current value,
the maximum at these updates and the first crossing. A later decline does not
erase an earlier crossing. Threshold crossing alone does not establish size,
certainty about direction of the mean, or a mechanism. The independently valid
magnitude ranges below state what can be said about the average effect.

There is only this primary positive-evidence route. Do not replace it with the
best component E, the best run, the best lag, an unadjusted switch comparison or
a new test each time the public page refreshes.

### Displaying the same evidence as a sequential p-value

For a nonempty series, the readable report also displays

```
log(p_sequential) = -max(0, highest log(E_total) at accepted-run updates)
```

This is the reciprocal of the highest cumulative E reached, capped at one. It is a reporting conversion of the existing evidence process, with no new hypothesis or success route. E = 20 gives p = 0.05, E = 100 gives p = 0.01, and E = 1,000 gives p = 0.001. The sequential p-value permits repeated checks under the same assumptions as E; it is not the probability that the no-effect explanation is true. An empty series has no displayed p-value. Keep the logarithm and use scientific notation for small values rather than displaying an underflowed or rounded zero.

Show current cumulative E and the highest cumulative E together so a later decline is visible. The p-value can stay unchanged while current E falls. It uses completed accepted-run updates, not a search for the best individual recording, elapsed second or intermediate target. Preparation remains exploratory; displaying p does not turn retrospectively selected settings or regions into a confirmatory procedure.

The series table shows each selected recording's own retained E, full-response estimate and simultaneous confidence range beside the cumulative values after that recording. Individual E describes that recording alone, starting from one. Those displayed E values are neither averaged nor multiplied to obtain the cumulative E. The table uses the existing selected analysis revisions and exact run identities, not a fresh analysis or additional statistical test.

## 5. Effect uncertainty valid at repeated looks

Use a confidence sequence: a range constructed to cover the changing average
conditional effect at every update, not just at a preselected final sample size.
It need not become monotonically narrower. All stated ranges concern the
relative q contrast; raw per-region pixel differences do not acquire these
confidence guarantees.

For a stream let W_i=(X_i+1)/2 in [0,1]. Use the fixed prediction 1/2 and retain
`Q=sum((W_i-1/2)**2)=sum(R_i**2)/4`. Fixed prediction avoids assumptions about
estimated trends and keeps missing-data treatment transparent. For j=1,2,...,

```
lambda_j = 0.9 * 2**(1-j)
v_j = 1/(j*(j+1))
psi(lambda) = -log(1-lambda) - lambda
b(Q, alpha_stream) = min_j [log(2/(alpha_stream*v_j)) + psi(lambda_j)*Q]/lambda_j
confidence interval = [mean(X)-2*b/n, mean(X)+2*b/n] intersect [-1,1]
```

Stop evaluating j once its increasing log-intercept exceeds the best boundary:
all later intercepts are larger and variance terms are nonnegative. This computes
the infinite bound exactly to floating-point precision, without a fixed maximum
sample size or finite-grid precision floor.

For each lambda the empirical-Bernstein inequality gives a time-uniform tail
bound; allocate `alpha_stream*v_j/2` to each sign and take their union. Allocate
`alpha_stream=0.05*w_stream` across the full and elapsed streams. Consequently
with probability at least 0.95, all these relative-effect ranges cover their
specified average effects at every update. This is nonasymptotic, under bounded
outcomes and valid randomization; it is not an ordinary standard-error interval.
The code uses a conservative bound and can need substantial data for precision.

The E test has its stated null error guarantee; the confidence family has its
own simultaneous coverage guarantee. Do not advertise a stronger joint
probability for both statements. Confidence ranges do not create another
unadjusted primary success rule.

At a stream with no observations use [-1,1] and no point estimate. With missing
observations use the bounded formula below, not a falsely precise mean. Show
percentages as percentage points and explain, for example, that [-2,+3] points
excludes a 10-point mean shift for that outcome under the tested conditions,
but permits small positive, zero or negative effects. A whole-period range
cannot exclude a response only at one elapsed second; consult its simultaneous
range. Do not call a confidence range a probability distribution for the effect.

## 6. Missing measurements without favorable deletion

When one region/bin is unavailable, its latent relative R is somewhere in
[-1,1]. For the full response, combine known bin values and unknown bin ranges
using their durations to obtain [L,H]. The same bounds apply when timing or
coverage fails. Raw motion itself remains missing.

For every generated target and stream, calculate

```
x_low  = L if assigned A else -H
x_high = H if assigned A else -L
U += x_low - S*c_i
V += max((L-c_i)**2, (H-c_i)**2)
```

For any allowed completion this U is no larger and V no smaller than the
complete-data values, so every positive-lambda factor and its mixture is a
lower bound. A missing outcome cannot earn positive evidence by being removed.
This pointwise dominance remains safe even when missingness is related to the
outcome or label; the fixed weights and unchanged, prior-raw-data prediction sequence are essential
here. Do not retrain that sequence on the selected complete cases.
A low conservative E is not evidence that movement did not happen.

For confidence ranges accumulate `X_low=sum(x_low)`, `X_high=sum(x_high)` and
`Q_upper=sum(max(L**2,H**2))/4`. Report

```
[X_low/n - 2*b(Q_upper,alpha_stream)/n,
 X_high/n + 2*b(Q_upper,alpha_stream)/n] intersect [-1,1].
```

If any unknown width remains, report the estimate's [X_low/n,X_high/n] range
instead of an invented single point. Show missing counts and reasons.
Pre/post-roll may be unavailable without making valid target observations
missing: it is outside their scoring definition. A missing background/timing/
setup needed to validate target motion does affect those target outcomes.

All missing targets stay in the denominator. Do not replace them with new
"valid" trials while pretending the earlier ones never occurred. An aborted
run contributes every assignment generated before interruption and may be
followed by another run. These rules handle loss of outcomes, not unverifiable
randomization, fabricated measurements or a compromised clock mapping.

## 7. Regional motion, switches and absent context

For each run and elapsed second with paired available outcomes show:

```
A difference = mean(a | A target) - mean(a | B target)
B difference = mean(b | B target) - mean(b | A target)
raw relative difference = mean(a-b | A target) - mean(a-b | B target)
```

The last equals the sum of the first two when they use the same pairs. Keep
counts for both labels. A single-label run has unavailable observed group
contrasts, not a fabricated zero. It still contributes randomized observations
to the design-based estimate and evidence. Raw differences are px/s, descriptive
within the same camera view. Percent changes may be shown with their named
nonzero comparison mean; otherwise mark the percentage unavailable. Do not pool
those raw units over incompatible cameras as a physical effect-size estimate.

Keep actual-time A/B traces with cue boundaries. For transition curves group
within-run consecutive cues as A-to-B, B-to-A, A-to-A and B-to-B. Compare switching
versus repeating after the same preceding label. Show up to 5 seconds of existing
pre-cue context and each available elapsed-second bin afterward. Identify whether
pre-cue context belongs to the previous target or recovery. Do not fill a short
previous interval, stretch a new response, create a transition across runs, or
classify repeated targets as unsuccessful because they did not rise again.

These graphs describe the movement changes and persistence rather than issue
four extra significance tests. Group means can be confounded by different
histories/settings in preparation; keep those groups inspectable. Apparent
first-second onset is limited by the synchronization allowance and one-second
binning, not a claim of exact physical latency.

For absent pre-roll [Start,Start+configured pre-roll] and post-roll
[Away,Away+configured post-roll],
apply the same extraction, masks, review and coverage requirements. Report a
and b means separately, targeting mean minus pre-roll mean and targeting mean
minus post-roll mean, and their continuous traces. Actual approach/departure/
return-to-camera footage is outside those comparisons. None enters the target
E calculation, relative-effect calibration, confidence family, or a causal
presence/absence claim. It answers whether lower movement while absent was
observed in this recording, including when it was not.

## 8. Interpretation rules and output contract

The machine-readable result must retain counts, profile/configuration/release
hashes, status, quality decisions, per-run and per-stream measurements, actual
bin durations, missing ranges, U/V/Q/n, the raw prediction sequence, weights, estimates and confidence ranges,
current/max E, first crossing, revision and source identities. Calculate labels
and text from this result object; do not generate new statistics in the narrative.

The default human report says, in order:

1. preparation or scored, recordings/targets/usable bins/missing counts and which
   analyzed version is shown;
2. evidence threshold met or not, current E and earlier crossing if relevant;
3. estimated relative effect and simultaneous range, explicitly naming units;
4. which region accelerated or slowed within each recording, with both raw curves;
5. what happened on switches versus repetitions, with counts and time course;
6. descriptive pre/post-roll findings and any concrete missing information.

If E crosses but the mean-effect interval includes zero, state both: the
randomized pattern conflicts with the no-current-target-effect model, while the
size/direction of that specified mean remains imprecise. A time-localized pattern
can drive evidence while a whole-period interval includes zero. Do not substitute
"proven control", "all random", "no effect", or an energy explanation.

An opposite-direction range is reported as opposite direction, not as zero.
Tuning-selected preparation values never get a confirmatory label. Technical
motion qualification, authentic randomness and timing are prerequisites for
interpreting even a large E. Missing inputs produce a concrete missing status or
bounded result, not a hidden fallback.

## 9. Why these choices, and what they cost

- Raw pixels alone cannot provide a comparable cross-camera magnitude. The
  relative index supplies a bounded dimensionless outcome while keeping raw
  regional answers. It does not erase scene differences or convert pixels to wind.
- A whole-period mean alone hides short or reversing changes. Fixed elapsed
  streams preserve them; fixed weights prevent selecting a favorable lag.
- Resetting run evidence loses information and makes sensitivity depend on run
  segmentation. Carrying streams directly keeps all assignments and accepts
  different saved durations without a separate combination-coverage requirement.
- The continuous mixture covers arbitrarily small positive betting scales.
  It does not require selecting one expected effect size, but it is not uniformly
  more sensitive than a procedure tuned to a particular alternative.
- Prior-only centering removes avoidable regional-offset noise in the evidence
  without a new reference session. Keeping that prediction sequence independent
  of later quality exclusions preserves conservative missing-data handling.
  The confidence calculation deliberately retains the simpler uncentered
  design-based estimate and fixed prediction; natural regional imbalance can
  therefore still make its magnitude range wide even when the E test is strong.
  Evidence and magnitude precision are different results, not interchangeable.
- The simple simultaneous confidence bound is conservative. It offers exact
  finite-sample coverage rather than an unjustified normal approximation. The
  method makes no promise about how many field runs will produce a narrow range.

## Scientific foundations

The application-specific outcome, mixture allocation and missing-range rule are
specified here; no cited paper is claimed to have studied this phenomenon.

- Vovk and Wang, [E-values: calibration, combination and applications](https://arxiv.org/html/1912.06116v4),
  Annals of Statistics, DOI [10.1214/20-AOS2020](https://doi.org/10.1214/20-AOS2020):
  conditional accumulation and convex-mixture foundations.
- Ramdas and colleagues, [Safe anytime-valid inference](https://arxiv.org/html/2210.01948v2):
  interpreting a sequential evidence process and repeated inspection.
- Howard and colleagues, [Time-uniform, nonparametric, nonasymptotic confidence sequences](https://arxiv.org/html/1810.08240v9),
  DOI [10.1214/20-AOS1991](https://doi.org/10.1214/20-AOS1991), Theorem 4 and its proof:
  the bounded-outcome empirical-Bernstein inequality used above. The dyadic union
  boundary and study-specific transformations are explicitly derived here.
- [OpenCV optical-flow documentation](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html):
  tracking ingredients, not validation of this chosen regional summary.
