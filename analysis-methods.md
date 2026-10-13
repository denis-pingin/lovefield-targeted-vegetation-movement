# Targeted Vegetation Movement: analysis methods

Statistical calculation identifier: `tree-analysis-development-1`. This identifier links retained results to the equations below. Motion measurements and profile settings have their own identifiers, specified in section 2.

This document specifies the measurements, statistical calculations, and interpretation for the [study protocol](protocol.md). The executable statistical reference is [validation/reference.py](validation/reference.py), with behavioral checks in [validation/test_reference.py](validation/test_reference.py). Measurement qualification combines controlled image tests and representative footage review with arithmetic and simulation checks.

## Plain-language model

Track image detail within a fixed grid over each region. Calculate local movement between successive frames, combine the cell measurements according to the area they represent, and summarize the regional movement per second. Compare each region under the two randomized instructions and retain both regional time courses.

For accumulation across camera views, express the two movement indices as a relative balance. If A contributes 45% of their sum under B targeting and 50% under A targeting, the relative targeting difference is 5 percentage points. This unit describes a change in movement share. The separate raw curves show whether A sped up, B slowed down, or both changed.

Maintain an accumulating comparison for the full response and for each elapsed second. Combine their evidence through fixed weights chosen before analysis. Each randomized instruction contributes to the applicable comparisons as one observation. Report effect magnitude and uncertainty alongside evidence. The method imposes no minimum effect size.

## 1. Input contract and order

Each run supplies its immutable ID, optional tag, preparation or scored status, settings, setup image and polygons with source provenance, profile, software release, actual playback records with phone-clock references, authenticated A/B assignments, complete event history, and original recording hash. Each target has a stable ID and ordinal, label Z=1 for A or Z=0 for B, mapped playback onset t, and configured response duration T. Outcomes are measured over [t,t+T).

Process generated assignments in collection order within and between runs, with each target contributing once. Transitions describe successive targets within a run. Retain assignments from interrupted runs. A generated label whose delivery failed contributes a bounded unknown outcome; a successful retry of the same label uses its actual playback onset. Unused tickets with no generated assignment contribute no observation. An assignment whose authenticity cannot be verified leaves randomization unresolved.

An accepted accumulation covers a resolved chronological prefix: every preceding run has an analysis or an explicit disposition for unavailable outcomes. Keep later runs pending while an earlier status remains unresolved. A correction recomputes the prefix as an identified analysis revision, preserving earlier results and the reason for the correction. Each recording contributes once within a revision.

During preparation, earlier observations can inform settings saved before the next run. The scored profile fixes settings across runs. Each elapsed-second comparison identifies the durations and settings that contributed to it; longer lags can include fewer targets.

## 2. Motion measurement

### 2.1 Image sampling and tracking

The study measures area-weighted image motion, identified as `area-grid-mean-v1`. The supplied profile `tree-development-area-1` uses profile format `tree-profile-development-2`. Every analysis retains its exact profile, hash, and code identity. The following values are development settings that can be adjusted during preparation. A scored series uses the qualified profile fixed before collection.

| Operation | Supplied setting or rule |
| --- | --- |
| Decoding | Original resolution, grayscale, actual presentation timestamps; retain original bytes. |
| Grid | 128 x 128-pixel cells anchored at image coordinate (0,0), using the same cell size for A and B. |
| Target sampling | At most 32 Shi-Tomasi features per full cell; qualityLevel=0.01, minDistance=7 pixels, blockSize=7. |
| Accepted target samples | At least 3 reliable tracks per full cell. Scale the maximum and minimum counts by the cell's area inside the region, rounding upward to at least one. |
| Background sampling | At most 3,000 features in the stationary reference region, with at least 10 accepted tracks. |
| Flow | Pyramidal Lucas-Kanade, winSize=(41,41), maxLevel=3, at most 30 iterations or displacement convergence 0.01. |
| Accepted track | Finite coordinates; forward and backward status valid; endpoints inside the original image and same polygon; forward/backward discrepancy <=1 pixel. |
| Target refresh | Timed refresh on the fixed one-second video timeline; replenish available cell sample capacity between refreshes. The saved profile can select continuous refresh, which retains valid tracks and replenishes capacity without the timed reset. |
| Spatial coverage | At least 99% of the polygon area must belong to measured cells for a frame-pair regional value. |
| Temporal coverage | At least 95% valid frame-pair time in every measured response bin. |
| Shake | Background median displacement-vector magnitude >0.5 pixel for 3 consecutive frame pairs invalidates affected outcomes. |
| Obstruction | Retain a clear-footage review or exact obstructed spans, assessed without assignment-linked results when practicable. |

Detect suitable image features separately within each cell. Track them forward and backward against full-resolution frames using the saved window and acceptance settings. The tracking window is the image neighborhood used to match a point between frames; it may extend across an internal cell boundary. Assign each accepted displacement to the cell containing its previous-frame position. Both moving and stationary accepted features contribute. Sampling and quality decisions are independent of target labels.

### 2.2 Area-weighted regional motion

For each measured cell, calculate the arithmetic mean of accepted displacement magnitudes divided by elapsed frame-pair time, giving speed in pixels per second. Weight that local speed by the number of pixels where the cell intersects the selected polygon.

For cell area `w_j` and valid mean speed `m_j`, regional motion is `sum(w_j*m_j)/sum(w_j)` over measured cells. Two equal-area cells with mean speeds of 0 and 2 px/s contribute a regional value of 1 px/s, regardless of their different accepted point counts. Normalizing by measured area permits comparison of differently sized regions.

Spatial coverage is measured area divided by complete polygon area. Below the saved cutoff, the regional measurement is unavailable and its observed-area diagnostic is retained separately. At or above the cutoff, report the measured-area mean and actual coverage.

A cell is unmeasured when it has too few reliable matches for that frame pair. Blur, limited texture, or failed matching can cause this. A stationary textured cell can have a valid zero or near-zero speed. Retain these distinct states in the data and annotation. A and B share valid timing intervals, and unusable response bins receive the bounded-unknown treatment below.

This outcome describes visible image activity across the selected canopy. Its interpretation depends on camera geometry, foliage coverage, apparent leaf size, depth, and spatial sampling. Sky gaps and trunks affect how well a polygon represents foliage. Inspect spatial coverage and representative annotations during qualification, including whether unmeasured portions have different motion. Keep polygons fixed throughout the recording.

Barbacci and colleagues converted tracked image features into local spatial-grid velocities in their [tree-motion method, section 2.5.2](https://yakari.polytechnique.fr/Django-pub/documents/barbacci2014rp-1pp.pdf#page=6). This study uses that spatial-aggregation principle with the magnitude averaging, coverage rules, and randomized targeting comparison specified here.

### 2.3 Measurement qualification

Assess motion extraction through stationary and known-motion images, localized moving patches, brightness changes, duplicated-content area invariance, sampling-density sensitivity, and annotated real footage. Apply the [protocol's qualification tolerances](protocol.md#motion-measurement-and-qualification). Retain settings, technical checks, and outcomes for each tested profile.

Choose profile settings using tracking accuracy and coverage before scored collection. Preparation comparisons retain identical source recordings, regions, clock mappings, footage reviews, and response intervals. Each analysis remains a revision of those observations. The chosen scored profile and statistical version are frozen for the series.

### 2.4 Timing and diagnostics

Retain accepted and rejected counts, frame-pair time, mean speed, measured cell areas and spatial coverage, background motion, refreshes, and quality flags. Extraction uses the images and saved settings independently of target labels.

For each target create bins [t+k,min(t+k+1,t+T)), k=0,...,ceil(T)-1. Retain the final partial second at its actual duration. A frame pair must lie wholly inside the parent response. At internal bin edges, apportion its measured speed by overlap duration. Divide accumulated speed-times-duration by covered seconds and report temporal coverage separately. Missing frames remain unavailable. A cue delivered before the preceding response ends makes the overlapping bin unavailable.

A bin contains paired A and B motion values a>=0 and b>=0, or a reason for unavailability. An invalid region makes the paired relative outcome unavailable. Shake and obstruction invalidate the bins they touch. A setup mismatch or unresolved timing can invalidate all bins in a recording. Retain valid bins and apply conservative bounds to unavailable bins within every generated target.

## 3. Comparable relative outcome and effect size

For a paired valid bin define

```
q = a / (a + b)                  if a + b > 0
q = 1/2                         if a = b = 0
R = 2q - 1 = (a - b)/(a + b)    in [-1,1]
```

Two valid zero measurements give a neutral balance. Negative, non-finite, failed-tracking, or unqualified values are unavailable. The specified ratio uses no fitted small-denominator cutoff. Near zero, it is sensitive to measurement noise, so retain raw magnitudes and tracking diagnostics. Scored interpretation is limited to the motion range established during measurement qualification.

Common scaling of a and b leaves R unchanged, allowing a dimensionless comparison across camera views. Differences in depth, perspective, branch stiffness, texture, and tracking accuracy still affect interpretation. Report individual recordings and their setups alongside the aggregate.

For the full response, R_full is the duration-weighted mean of the bin R values, including a partial final bin. Calculate raw full-response a and b separately as duration-weighted means of their paired measurements. Averaging bin ratios and taking the ratio of full-response raw speeds are distinct operations; the specified relative outcome uses the former.

Let S=2Z-1. For each stream, use X=S*R. With fair randomized assignment,

```
E(X | earlier history) = E(q under A | history) - E(q under B | history) = tau_i.
```

The effect estimate is sum(X)/n: the average conditional relative targeting effect over the n instructions in the comparison. Multiply by 100 for percentage points. This randomization-weighted estimator can differ from the observed difference between label-group means in an unbalanced sample. A region's natural excess movement contributes noise through S and is reflected in uncertainty. Pronounced regional imbalance can reduce estimation efficiency. The analysis retains the prospectively selected regions and all generated assignments.

Effects and weather can vary, including dependence on preceding targets. The estimate concerns the immediate effect of the current assignment along those observed histories. It includes any joint response of A and B to that assignment; the statistical model permits dependence between the regions.

Each randomized instruction has equal weight within its comparison stream. A run with more targets contributes more assignments. A mixed-duration preparation summary estimates the response across the saved durations; the scored study fixes one duration. Because the average conditional effect can change as histories accumulate, each confidence range applies to its own update. Keep successive ranges separately.

## 4. One primary accumulating evidence process

### Hypothesis and component calculation

The no-current-target-effect hypothesis states that, conditional on the recorded past and settings selected before the cue, the current A/B assignment leaves the distribution of the response's measured relative outcome unchanged. The assignment is concealed, fair, and independent of that past. Outcomes can be autocorrelated and depend on earlier targets. This distributional hypothesis is stronger than a zero mean averaged over the full response.

For each stream, predict its ordinary regional balance from the arithmetic mean of that stream's earlier raw R measurements in the same run. Call this c_i, with c_i=0 for the first target. The predictor restarts for each recording while accumulated evidence continues across recordings. Only information preceding the current cue enters c_i.

Build and retain the prediction sequence from label-blind extraction of preceding frames, before applying retrospective obstruction or recording-rejection masks. Preserve earlier raw values when a review changes a quality decision. If no finite raw paired measurement existed in an earlier window, use 0 as that prediction input and retain the reason. The predictor may be inaccurate; validity requires it to be bounded and independent of the current assignment. Qualification includes reproducing this chronological dependency.

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

where Phi is the standard normal cumulative distribution function. Initially U=V=0 and E=1. Calculate in log space; use the scaled complementary error function for negative U to avoid cancellation/underflow. No finite set of effect sizes or minimum detectable effect is built into the continuous mixture.

Why it is valid: for one fixed nonnegative lambda, under the null the two signs are fair for a label-independent R and a previously determined c. Averaging the next factor gives `cosh(lambda*(R-c)) * exp(-lambda**2*(R-c)**2/2) <= 1`. Multiplication through chronological assignments and a fixed mixture over lambda therefore produce a nonnegative supermartingale. No independent-weather, independent-frame or normal-outcome assumption is used. More data need not increase its value. The one-sided mixture is oriented toward target-following movement; a negative estimate is still reported through the effect interval.

### Combining full response and elapsed seconds

Retain one full-response stream E_full and streams E_k for elapsed seconds k=0,1,... . Every eligible target updates each applicable stream once. A target whose configured duration does not reach k contributes nothing to that stream; its non-existent tail is not a zero observation. Partial final bins contribute their actual shorter measurement and are identified in counts/duration summaries. Eligibility depends on saved duration, not on which outcome looks favorable.

Fix these weights before accumulation:

```
w_full = 1/2
w_k = (1/2) * (1-exp(-1/15)) * exp(-k/15)
E_total = w_full*E_full + sum_k(w_k*E_k)
```

The infinite weights sum to one. Unobserved streams remain E=1, so their tail weight can be included exactly without creating infinite arrays. After the largest observed index K, the remaining weight is `(1/2)*exp(-(K+1)/15)`. The 15-second decay is a fixed sensitivity allocation, not a fixed response length, response latency, effect threshold or requirement to collect 15 seconds. Later seconds get less primary weight but remain measured and reported. The full-response component supports sustained responses; the elapsed components support localized responses that can cancel in the full mean. Keep these weights fixed when preparation duration changes. Do not renormalize them to whichever seconds were observed or looked strongest.

Each component is valid on the same chronological history. Their fixed convex mixture is valid even though their measurements are highly dependent and use the same assignments. This is why evidence is not multiplied across seconds. There is no run-wise evidence reset or product of reset run scores. U and V persist across runs; only the nuisance prediction restarts at zero for the new scene. No first target is consumed just to initialize a reference.

At accepted run updates compare E_total with 20. Under the stated null, the probability of ever crossing is at most 1/20=0.05. Preserve the current value, the maximum at these updates and the first crossing. A later decline does not erase an earlier crossing. Threshold crossing alone does not establish size, certainty about direction of the mean, or a mechanism. The independently valid magnitude ranges below state what can be said about the average effect.

The fixed mixture and E=20 threshold define the single primary evidence decision. Individual runs, elapsed-second components, and switch comparisons are reported as supporting detail.

### Displaying the same evidence as a sequential p-value

For a nonempty series, the readable report also displays

```
log(p_sequential) = -max(0, highest log(E_total) at accepted-run updates)
```

This is the reciprocal of the highest cumulative E reached, capped at one. It is a reporting conversion of the existing evidence process, with no new hypothesis or success route. E = 20 gives p = 0.05, E = 100 gives p = 0.01, and E = 1,000 gives p = 0.001. The sequential p-value permits repeated checks under the same assumptions as E; it is not the probability that the no-effect explanation is true. An empty series has no displayed p-value. Keep the logarithm and use scientific notation for small values rather than displaying an underflowed or rounded zero.

Show current cumulative E and the highest cumulative E together so a later decline is visible. The p-value can stay unchanged while current E falls. It uses completed accepted-run updates, not a search for the best individual recording, elapsed second or intermediate target. Preparation remains exploratory; displaying p does not turn retrospectively selected settings or regions into a confirmatory procedure.

The series table shows each selected recording's own retained E, full-response estimate and simultaneous confidence range beside the cumulative values after that recording. Individual E describes that recording alone, starting from one. Those displayed E values are neither averaged nor multiplied to obtain the cumulative E. The table uses the existing selected analysis revisions and exact run identities, not a fresh analysis or additional statistical test.

## 5. Effect uncertainty valid at repeated looks

Use a confidence sequence: a range constructed to cover the changing average conditional effect at every update, not just at a preselected final sample size. It need not become monotonically narrower. All stated ranges concern the relative q contrast; raw per-region pixel differences do not acquire these confidence guarantees.

For a stream let W_i=(X_i+1)/2 in [0,1]. Use the fixed prediction 1/2 and retain `Q=sum((W_i-1/2)**2)=sum(R_i**2)/4`. Fixed prediction avoids assumptions about estimated trends and keeps missing-data treatment transparent. For j=1,2,...,

```
lambda_j = 0.9 * 2**(1-j)
v_j = 1/(j*(j+1))
psi(lambda) = -log(1-lambda) - lambda
b(Q, alpha_stream) = min_j [log(2/(alpha_stream*v_j)) + psi(lambda_j)*Q]/lambda_j
confidence interval = [mean(X)-2*b/n, mean(X)+2*b/n] intersect [-1,1]
```

Stop evaluating j once its increasing log-intercept exceeds the best boundary: all later intercepts are larger and variance terms are nonnegative. This computes the infinite bound exactly to floating-point precision, without a fixed maximum sample size or finite-grid precision floor.

For each lambda the empirical-Bernstein inequality gives a time-uniform tail bound; allocate `alpha_stream*v_j/2` to each sign and take their union. Allocate `alpha_stream=0.05*w_stream` across the full and elapsed streams. Consequently with probability at least 0.95, all these relative-effect ranges cover their specified average effects at every update. This is nonasymptotic, under bounded outcomes and valid randomization; it is not an ordinary standard-error interval. The code uses a conservative bound and can need substantial data for precision.

The E test has its stated null error guarantee; the confidence family has its own simultaneous coverage guarantee. Do not advertise a stronger joint probability for both statements. Confidence ranges do not create another unadjusted primary success rule.

At a stream with no observations use [-1,1] and no point estimate. With missing observations use the bounded formula below, not a falsely precise mean. Show percentages as percentage points and explain, for example, that [-2,+3] points excludes a 10-point mean shift for that outcome under the tested conditions, but permits small positive, zero or negative effects. A whole-period range cannot exclude a response only at one elapsed second; consult its simultaneous range. Do not call a confidence range a probability distribution for the effect.

## 6. Missing measurements

When one region/bin is unavailable, its latent relative R is somewhere in [-1,1]. For the full response, combine known bin values and unknown bin ranges using their durations to obtain [L,H]. The same bounds apply when timing or coverage fails. Raw motion itself remains missing.

For every generated target and stream, calculate

```
x_low  = L if assigned A else -H
x_high = H if assigned A else -L
U += x_low - S*c_i
V += max((L-c_i)**2, (H-c_i)**2)
```

For every possible completion of an unknown outcome, this U is no greater and V is no smaller than their complete-data values. Each positive-lambda factor and the mixture therefore provide conservative evidence. This bound allows missingness to depend on the outcome or label. It requires fixed weights and the retained prior-raw-data predictor sequence, unchanged by later quality exclusions.

For confidence ranges accumulate `X_low=sum(x_low)`, `X_high=sum(x_high)` and `Q_upper=sum(max(L**2,H**2))/4`. Report

```
[X_low/n - 2*b(Q_upper,alpha_stream)/n,
 X_high/n + 2*b(Q_upper,alpha_stream)/n] intersect [-1,1].
```

If any unknown width remains, report the estimate as [X_low/n,X_high/n]. Show missing counts and reasons. Pre/post-roll is outside the target outcome definition and can be unavailable while targets remain analyzable. Background, timing, and setup information required to qualify target motion determines availability of the affected target outcomes.

Every generated target remains in the denominator, including targets with missing measurements and those generated before an interruption. Collection can continue with another run. Randomization authenticity must be resolved separately before applying these outcome bounds.

## 7. Regional motion, switches and absent context

For each run and elapsed second with paired available outcomes show:

```
A difference = mean(a | A target) - mean(a | B target)
B difference = mean(b | B target) - mean(b | A target)
raw relative difference = mean(a-b | A target) - mean(a-b | B target)
```

The last equals the sum of the first two when all use the same paired measurements. Retain counts for both labels. Observed group differences are unavailable for a single-label run, which still contributes to the randomization-weighted estimate and evidence. Raw differences use px/s within the same camera view. A percentage change requires an identified nonzero comparison mean. Cross-view accumulation uses the relative outcome defined above.

Keep actual-time A/B traces with cue boundaries. Group consecutive within-run cues as A-to-B, B-to-A, A-to-A, and B-to-B to compare switches with repetitions after the same preceding label. Show up to 5 seconds of available pre-cue context and each available elapsed-second bin afterward. Identify whether context belongs to the previous target or recovery, and retain actual interval durations and gaps. A repeated target can sustain a response already present.

Transition curves describe movement changes and persistence, with counts and saved settings for each group. Different histories or preparation settings can affect group means. Apparent onset resolution is limited by synchronization allowance and one-second binning. These descriptive comparisons are separate from the primary evidence calculation.

For absent pre-roll [Start,Start+configured pre-roll] and post-roll [Away,Away+configured post-roll], apply the same extraction, masks, review, and coverage requirements. Start here denotes the recorded beginning of pre-roll after successful registration in a scored run. Report a and b means separately, targeting mean minus pre-roll mean, targeting mean minus post-roll mean, and continuous traces. Approach, departure, and return-to-camera footage fall outside these intervals. The comparison describes how movement during absence differs from movement during targeting; the fixed order leaves time-varying conditions inseparable from presence. These intervals contribute descriptive context only, outside the target evidence and confidence calculations.

## 8. Interpretation rules and output contract

The machine-readable result must retain counts, profile/configuration/release hashes, status, quality decisions, per-run and per-stream measurements, actual bin durations, missing ranges, U/V/Q/n, the raw prediction sequence, weights, estimates and confidence ranges, current/max E, first crossing, revision and source identities. Calculate labels and text from this result object; do not generate new statistics in the narrative.

The default human report says, in order:

1. preparation or scored, recordings/targets/usable bins/missing counts and which
   analyzed version is shown;
2. evidence threshold met or not, current E and earlier crossing if relevant;
3. estimated relative effect and simultaneous range, explicitly naming units;
4. which region accelerated or slowed within each recording, with both raw curves;
5. what happened on switches versus repetitions, with counts and time course;
6. descriptive pre/post-roll findings and any concrete missing information.

When E crosses the threshold while the full-response effect range includes zero, report both findings: the randomized pattern conflicts with the no-current-target-effect model, while the average effect remains imprecisely estimated. A localized response can drive evidence even when changes cancel over the full period. Interpretation concerns the measured targeting procedure under the recorded conditions.

Report opposite-direction estimates and ranges with their observed sign. Preparation findings remain exploratory. Interpreting evidence requires qualified motion measurements, authenticated assignments, and valid timing. Missing inputs are identified in the result and receive the specified uncertainty treatment.

## 9. Statistical assumptions and limitations

- The relative index provides a bounded, dimensionless outcome across camera views. Raw regional measurements retain the within-view information needed to interpret it; scene and tracking differences still affect comparability.
- Fixed full-response and elapsed-second comparisons cover sustained and time-localized responses. Their weights determine sensitivity and remain fixed as data accumulate.
- Evidence continues through assignments in collection order. During preparation, variable saved durations define which elapsed-second comparisons each target contributes to.
- The continuous mixture spans arbitrarily small positive betting scales. Its sensitivity varies with the actual response pattern; a test designed for a specific alternative may detect that pattern more efficiently.
- Prior-only centering reduces regional-offset noise in the evidence. Preserving the raw predictor sequence before quality exclusions supports conservative handling of missing outcomes. The effect estimator and confidence calculation use an uncentered outcome and fixed prediction, so regional imbalance can leave magnitude estimates imprecise even with strong evidence.
- The simultaneous confidence bound is conservative and supplies finite-sample coverage under bounded outcomes and valid randomization. The number of recordings needed for a narrow range depends on the observed variation, effects, and missing data.

## Scientific foundations

The outcome definition, mixture weights, and missing-outcome rules are specified above. The following sources provide their mathematical foundations and the tracking algorithms.

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
  feature detection and optical-flow tracking.
