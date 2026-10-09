"""Readable values, narrative and chart data from retained reference calculations."""
import copy
import logging
import math
from datetime import datetime, timezone

from tree_series import evidence_label

UNITS = 'relative-share percentage points'
LOGGER = logging.getLogger(__name__)


def _sequential_p_label(log_p):
    if log_p >= math.log(.001):
        return f'{math.exp(log_p):.3g}'
    exponent = math.floor(log_p / math.log(10))
    coefficient = float(f'{math.exp(log_p - exponent * math.log(10)):.3g}')
    if coefficient == 10:
        coefficient, exponent = 1., exponent + 1
    return f'{coefficient:g} × 10^{exponent}'


def _stream(value, index):
    if 'confidenceRange' in value:
        return {'index': index, **copy.deepcopy(value)}
    return {**copy.deepcopy(value), 'index': index,
            'estimate': None if value.get('effect_estimate') is None else 100 * value['effect_estimate'],
            'estimateBounds': [100 * number for number in value.get('effect_estimate_bounds', [-1, 1])],
            'confidenceRange': [100 * number for number in value.get('simultaneous_confidence_interval', [-1, 1])]}


def _chart(title, kind, rows, columns, *, x_label, y_label, markers=()):
    return {'title': title, 'kind': kind, 'description': title, 'xLabel': x_label, 'yLabel': y_label,
            'xDomain': [min((row['x'] for row in rows), default=0), max((row['x'] for row in rows), default=1)],
            'markers': list(markers), 'series': [{'key': key, 'label': label, 'values': [
                {'x': row['x'], 'y': row.get(column), **{name: row[name] for name in ('start', 'end') if name in row}}
                for row in rows]} for key, label, column in columns]}


def _timeline_context_rows(display, response_spans, origin):
    fragments = []
    for row in display:
        outside = [(row['startSeconds'], row['endSeconds'])]
        for response_start, response_end in response_spans:
            remaining = []
            for start, end in outside:
                if response_end <= start or response_start >= end:
                    remaining.append((start, end))
                else:
                    if start < response_start:
                        remaining.append((start, response_start))
                    if response_end < end:
                        remaining.append((response_end, end))
            outside = remaining
        for start, end in outside:
            while start < end - 1e-9:
                second = math.floor(start - origin)
                boundary = origin + second + 1
                if boundary <= start + 1e-9:
                    boundary += 1
                fragment_end = min(end, boundary)
                values = (None, None) if row['reasons'] else (row['a'], row['b'])
                values = tuple(value if isinstance(value, (int, float)) and math.isfinite(value) else None
                               for value in values)
                fragments.append((start, fragment_end, second, values))
                start = fragment_end
    fragments.sort(key=lambda item: (item[0], item[1]))
    groups = []
    for start, end, second, values in fragments:
        # Display-only duration weighting retains measured spans without bridging missing intervals.
        if not groups or groups[-1]['second'] != second or groups[-1]['validity'] != tuple(value is not None for value in values) or start > groups[-1]['end'] + 1e-9:
            groups.append({'start': start, 'end': end, 'second': second,
                           'validity': tuple(value is not None for value in values),
                           'weighted': [[], []], 'durations': [[], []]})
        group = groups[-1]
        group['end'] = end
        for index, value in enumerate(values):
            if value is not None:
                group['weighted'][index].append(value * (end - start))
                group['durations'][index].append(end - start)
    return [{'start': group['start'] - origin, 'end': group['end'] - origin,
             'x': (group['start'] + group['end']) / 2 - origin,
             **{key: math.fsum(group['weighted'][index]) / math.fsum(group['durations'][index])
                if group['durations'][index] else None for index, key in enumerate(('a', 'b'))}}
            for group in groups]


def _missing_measurement_narrative(result):
    narrative = []
    for run in result.get('runs', [result]):
        disposition = run.get('measurementDisposition')
        if disposition is None:
            continue
        recorded = datetime.fromtimestamp(disposition['recordedAtMs'] / 1000, timezone.utc).isoformat()
        narrative.append(f"Run {run['runId']} was finalized with missing measurements on {recorded}: {disposition['reason']}")
        if disposition['retainedAnalysis']:
            narrative.append('The original video extraction cannot be repeated without the missing camera file. Surviving measurements and the original raw prediction sequence are retained; their bounded calculation can be reproduced.')
        else:
            narrative.append('The original video extraction cannot be repeated without the missing camera file. Unavailable measurements remain bounded unknown; every generated assignment stays in the calculation.')
    return narrative


def build_tree_report(result):
    calculation = result.get('calculation', {})
    streams = calculation.get('streams', {})
    full = _stream(result.get('full', streams.get('-1', {})), -1)
    elapsed = copy.deepcopy(result.get('elapsed')) if result.get('elapsed') is not None else [
        _stream(value, int(index)) for index, value in sorted(streams.items(), key=lambda pair: int(pair[0])) if int(index) >= 0]
    log_value = result.get('logEvidence', calculation.get('log_e', 0.))
    targets = result.get('targets', [])
    bins = [item for target in targets for item in target['bins']]
    counts = {'runs': result.get('runCount', 1 if streams else 0),
              'targets': result.get('targetCount', full.get('targets', len(targets))),
              'deliveredTargets': result.get('deliveredTargetCount', sum(target['playbackAtMs'] is not None for target in targets)),
              'usableBins': result.get('usableBinCount', sum(item['usable'] for item in bins)),
              'missingBins': result.get('missingBinCount', sum(not item['usable'] for item in bins)),
              'boundedMissingTargets': full.get('bounded_missing_targets', 0)}
    if counts['targets'] == 0:
        pending = copy.deepcopy(result.get('pendingRuns', []))
        narrative = ['No analyzed targets yet. Import and analyze a Tree recording to start the series.']
        narrative.extend(_missing_measurement_narrative(result))
        if pending:
            narrative.append(f"The chronological series is waiting for {len(pending)} pending runs.")
        if result.get('membershipStatus') in ('manifest_missing', 'manifest_outdated'):
            narrative.append('Import the latest hosted series bundle to retain its complete collected recording inventory.')
        return {'status': 'Pending Tree result', 'title': 'Accumulating Tree result', 'effectUnits': UNITS,
                'full': None, 'elapsed': [], 'counts': counts, 'evidence': None,
                'pendingRuns': pending, 'randomizationStatus': None, 'narrative': narrative,
                'caveat': '', 'charts': [], 'tables': {name: [] for name in ('effects', 'regional', 'absent', 'transitions', 'history')}}
    preparation = result.get('purpose', 'preparation') == 'preparation'
    pending = copy.deepcopy(result.get('pendingRuns', []))
    randomization = result.get('randomizationStatus', 'unverified')
    status = 'Preparation result' if preparation else 'Unqualified result' if pending or randomization != 'verified' else 'Scored result'
    estimate, interval = full['estimate'], full['confidenceRange']
    narrative = []
    if estimate is None:
        narrative.append(f"The estimated full-response effect size is bounded unknown between {full['estimateBounds'][0]:.3g} and {full['estimateBounds'][1]:.3g} {UNITS}.")
    else:
        direction = 'toward the cued region' if estimate > 0 else 'away from the cued region' if estimate < 0 else 'without a directional shift'
        narrative.append(f"The estimated full-response effect size is {estimate:.3g} {UNITS}, {direction}.")
    narrative.append(f"The simultaneous confidence range is {interval[0]:.3g} to {interval[1]:.3g} {UNITS}.")
    crossed = result.get('thresholdReached', log_value >= math.log(20))
    narrative.append(f"Current evidence E is {evidence_label(log_value)}. The E=20 threshold {'has been reached in an accepted prefix' if crossed else 'has not been reached'}.")
    series = 'runCount' in result
    peak_log_value = max(0., log_value, result.get('maxLogEvidence', log_value)) if series else None
    sequential_log_p = -peak_log_value if series else None
    if series:
        narrative.append(f"Highest cumulative E so far is {evidence_label(peak_log_value)}; the sequential p-value is {_sequential_p_label(sequential_log_p)} from that peak.")
    if counts['missingBins'] or counts['boundedMissingTargets']:
        narrative.append(f"{counts['missingBins']} missing elapsed bins remain bounded unknown; every generated assignment stays in the calculation.")
    if pending:
        narrative.append(f"The chronological series is waiting for {len(pending)} pending runs; later recordings have not been selected around them.")
    if randomization != 'verified':
        narrative.append('The saved randomization is unverified; this output cannot establish a qualified scored conclusion.')
    narrative.extend(_missing_measurement_narrative(result))
    caveat = ('Preparation results are exploratory. Settings and retrospective region choices can affect the result. '
              'Relative-share percentage points describe A/B motion balance, not raw-speed percent or an explanation of a mechanism.'
              if preparation else 'Interpretation requires verified randomization, frozen settings and qualified measurements. Relative shares do not establish absolute increases.')
    charts = [_chart('Targeting effect by elapsed second', 'effect',
                     [{'x': item['index'] + .5, 'estimate': item['estimate'], 'lower': item['confidenceRange'][0], 'upper': item['confidenceRange'][1]} for item in elapsed],
                     [('A', 'Estimate', 'estimate'), ('B', 'Lower confidence limit', 'lower'), ('C', 'Upper confidence limit', 'upper')],
                     x_label='Time from cue (seconds)', y_label=UNITS)]
    tables = {'effects': [{'second': 'Full response' if item['index'] < 0 else item['index'] + 1,
                          'estimate': item['estimate'], 'estimate bounds': item['estimateBounds'],
                          'simultaneous confidence range': item['confidenceRange'],
                          'targets': item.get('targets', 0), 'bounded missing': item.get('bounded_missing_targets', 0),
                          'durations': item.get('durations', []), 'unit': UNITS} for item in [full, *elapsed]],
              'regional': [], 'absent': [], 'transitions': [], 'history': copy.deepcopy(result.get('history', []))}
    history = result.get('history', [])
    if history:
        selected = {run['runId']: run for run in result.get('runs', [])}
        for row in tables['history']:
            run = selected.get(row['runId'])
            if run is None:
                LOGGER.warning('Tree report has no selected individual result for run %s; individual values are unavailable.', row['runId'])
                row['individual'] = {'tag': None, 'targetCount': None, 'logEvidence': None, 'full': None}
                continue
            run_calculation = run.get('calculation', {})
            run_full = run_calculation.get('streams', {}).get('-1')
            if run_full is None:
                LOGGER.warning('Tree report has no full-response calculation for run %s; individual effect size is unavailable.', row['runId'])
            row['individual'] = {'tag': run.get('tag'), 'targetCount': len(run['targets']),
                                 'logEvidence': run_calculation.get('log_e'),
                                 'full': _stream(run_full, -1) if run_full is not None else None}
        charts.extend([
            _chart('Evidence over accepted recordings', 'evidence', [{'x': row['runCount'], 'e': row['logEvidence'], 'threshold': math.log(20)} for row in history],
                   [('A', 'log E', 'e'), ('B', 'log 20', 'threshold')], x_label='Accepted recordings', y_label='Natural logarithm of evidence E'),
            _chart('Full-response estimate over accepted recordings', 'history',
                   [{'x': row['runCount'], 'estimate': row['full']['estimate'], 'lower': row['full']['confidenceRange'][0], 'upper': row['full']['confidenceRange'][1]} for row in history],
                   [('A', 'Estimate', 'estimate'), ('B', 'Lower confidence limit', 'lower'), ('C', 'Upper confidence limit', 'upper')],
                   x_label='Accepted recordings', y_label=UNITS)])
    regional = result.get('regional', {})
    for item in ([{'index': -1, **regional['full']}] if 'full' in regional else []) + regional.get('elapsed', []):
        tables['regional'].append({'second': 'Full response' if item['index'] < 0 else item['index'] + 1,
                                  'A targeting difference': item['A_difference'], 'B targeting difference': item['B_difference'],
                                  'relative difference': item['relativeDifference'], 'A assignments': item['counts']['A'],
                                  'B assignments': item['counts']['B'], 'means': item['means'], 'unit': 'pixels/second'})
    if regional and any(value is None for value in (regional['full']['A_difference'], regional['full']['B_difference'])):
        narrative.append('The raw A/B targeting contrast is unavailable when either label has no qualified measurements.')
    if tables['regional']:
        rows = tables['regional'][1:]
        charts.append(_chart('Raw regional targeting differences', 'regional',
             [{'x': row['second'] - .5, 'a': row['A targeting difference'], 'b': row['B targeting difference']} for row in rows],
             [('A', 'A targeting difference', 'a'), ('B', 'B targeting difference', 'b')], x_label='Time from cue (seconds)', y_label='Pixels/second'))
    timeline = result.get('timeline', [])
    if timeline:
        origin = timeline[0]['startSeconds']
        context = result.get('profile', {}).get('treeAnalysis', {}).get('contextBeforeSeconds', 0)
        spans = [(target['playbackAtMs'] / 1000 - context,
                  target['playbackAtMs'] / 1000 + target['responseSeconds'])
                 for target in targets if target['playbackAtMs'] is not None]
        spans.extend((item['startSeconds'], item['startSeconds'] + item['duration'])
                     for name, item in result.get('absent', {}).items()
                     if name in ('preRoll', 'postRoll') and
                     'startSeconds' in item and item.get('duration', 0) > 0)
        display = [row for row in timeline if spans and
                   row['startSeconds'] >= min(start for start, _ in spans) - 1e-6 and
                   row['endSeconds'] <= max(end for _, end in spans) + 1e-6]
        if display:
            target_intervals = [{'index': target['targetIndex'] + 1, 'label': target['assignedRegion'],
                                 'start': target['playbackAtMs'] / 1000 - origin,
                                 'end': target['playbackAtMs'] / 1000 + target['responseSeconds'] - origin}
                                for target in targets if target['playbackAtMs'] is not None]
            response_spans = [(item['start'] + origin, item['end'] + origin) for item in target_intervals]
            context_rows = _timeline_context_rows(display, response_spans, origin)
            response_rows = [{'x': item['startSeconds'] + item['duration'] / 2 - origin,
                              'start': item['startSeconds'] - origin,
                              'end': item['startSeconds'] + item['duration'] - origin,
                              'a': item['a'] if item['usable'] else None,
                              'b': item['b'] if item['usable'] else None}
                             for target in targets if target['playbackAtMs'] is not None
                             for item in target['bins'] if item['startSeconds'] is not None]
            rows = sorted([*context_rows, *response_rows], key=lambda row: (row['start'], row['end']))
            chart = _chart('A and B motion around targeting', 'timeline', rows,
                           [('A', 'A', 'a'), ('B', 'B', 'b')],
                           x_label='Recording time (minutes:seconds)', y_label='Pixels/second',
                           markers=[{'x': item['start'], 'label': 'Target ' + item['label']}
                                    for item in target_intervals])
            chart['targetIntervals'] = target_intervals
            chart['xDomain'] = [min([row['start'] for row in rows] + [item['start'] for item in target_intervals]),
                                max([row['end'] for row in rows] + [item['end'] for item in target_intervals])]
            charts.append(chart)
    for name, item in result.get('absent', {}).items():
        tables['absent'].append({'period': name, 'A': item.get('a'), 'B': item.get('b'), 'reasons': item.get('reasons', []),
                                'targeting minus absent': item.get('targetingMinusAbsent'), 'unit': 'pixels/second'})
    for name, item in result.get('transitions', {}).items():
        tables['transitions'].append({'transition': name, 'count': item['count'], **item['firstSecondChange'], 'unit': 'pixels/second'})
        rows = [{'x': row['elapsedSeconds'] + .5, 'a': row['a'], 'b': row['b']} for row in item['curves']]
        # Previous-context rows stay descriptive and separate from the inference.
        contexts = {}
        for transition in item['transitions']:
            for row in transition['before']:
                contexts.setdefault(row['elapsedSeconds'], []).append(row)
        for elapsed_second, context in sorted(contexts.items()):
            rows.insert(0, {'x': elapsed_second + context[0]['duration'] / 2,
                           **{key: math.fsum(row[key] for row in context if row[key] is not None) / sum(row[key] is not None for row in context)
                              if any(row[key] is not None for row in context) else None for key in ('a', 'b')}})
        rows.sort(key=lambda row: row['x'])
        charts.append(_chart(name + ' switch/repeat motion', 'transition', rows, [('A', 'A', 'a'), ('B', 'B', 'b')],
             x_label='Time from cue (seconds)', y_label='Pixels/second', markers=[{'x': 0, 'label': 'Current target cue'}]))
    return {'status': status, 'title': 'Accumulating Tree result' if 'runCount' in result else 'Tree run result',
            'effectUnits': UNITS, 'full': full, 'elapsed': elapsed, 'counts': counts,
            'evidence': {'logValue': log_value, 'label': evidence_label(log_value), 'threshold': 20,
                         'maxLogValue': peak_log_value if series else result.get('maxLogEvidence', log_value),
                         'firstCrossing': result.get('firstCrossing'), 'thresholdReached': crossed,
                         **({'sequentialLogPValue': sequential_log_p,
                             'sequentialPValueLabel': _sequential_p_label(sequential_log_p)} if series else {})},
            'pendingRuns': pending, 'randomizationStatus': randomization, 'narrative': narrative, 'caveat': caveat,
            'charts': charts, 'tables': tables}
