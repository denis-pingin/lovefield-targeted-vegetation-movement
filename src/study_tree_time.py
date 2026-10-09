"""Descriptive regional, switch/repeat and absence summaries. No inference formula."""
import math

from study_video import aggregate_tree_pairs


def _mean(values):
    return math.fsum(values) / len(values) if values else None


def _raw_summary(rows):
    by_label = {label: [row for row in rows if row['label'] == label and row['a'] is not None and row['b'] is not None] for label in ('A', 'B')}
    means = {label: {key: _mean([row[key] for row in by_label[label]]) for key in ('a', 'b')} for label in by_label}
    both = all(by_label.values())
    a_difference = means['A']['a'] - means['B']['a'] if both else None
    b_difference = means['B']['b'] - means['A']['b'] if both else None
    return {'counts': {label: len(rows) for label, rows in by_label.items()}, 'means': means,
            'A_difference': a_difference, 'B_difference': b_difference,
            'relativeDifference': a_difference + b_difference if both else None,
            'units': 'pixels/second', 'descriptive': True}


def regional_summary(targets):
    whole = []
    elapsed = []
    for index in range(max((len(target['bins']) for target in targets), default=0)):
        elapsed.append({'index': index, **_raw_summary([{'label': target['assignedRegion'], 'a': target['bins'][index]['a'], 'b': target['bins'][index]['b']}
            for target in targets if index < len(target['bins'])])})
    for target in targets:
        bins = target['bins']
        if all(item['usable'] for item in bins):
            total = sum(item['duration'] for item in bins)
            whole.append({'label': target['assignedRegion'], **{key: sum(item[key] * item['duration'] for item in bins) / total for key in ('a', 'b')}})
    return {'full': _raw_summary(whole), 'elapsed': elapsed}


def transition_summary(targets, pairs, recording_id, minimum_coverage):
    groups = {key: [] for key in ('A-to-A', 'A-to-B', 'B-to-A', 'B-to-B')}
    for previous, current in zip(targets, targets[1:]):
        if previous['playbackAtMs'] is None or current['playbackAtMs'] is None:
            continue
        onset = current['playbackAtMs'] / 1000
        start = max(previous['playbackAtMs'] / 1000, onset - 5)
        before = []
        cursor = start
        while cursor < onset - 1e-10:
            end = min(onset, cursor + 1)
            measurement = aggregate_tree_pairs(pairs, {'recording_id': recording_id, 'start': cursor, 'end': end}, minimum_coverage)
            before.append({'elapsedSeconds': cursor - onset, 'duration': end - cursor,
                           'a': measurement['A_motion'], 'b': measurement['B_motion'],
                           'context': 'previous target or recovery', 'coverage': measurement['coverage_fraction']})
            cursor = end
        groups[f"{previous['assignedRegion']}-to-{current['assignedRegion']}"].append({'targetIndex': current['targetIndex'], 'before': before, 'after': current['bins']})
    summaries = {}
    for name, transitions in groups.items():
        curves = []
        for index in range(max((len(item['after']) for item in transitions), default=0)):
            values = [item['after'][index] for item in transitions if index < len(item['after']) and item['after'][index]['usable']]
            curves.append({'elapsedSeconds': index, 'count': len(values), 'a': _mean([item['a'] for item in values]), 'b': _mean([item['b'] for item in values])})
        baselines = []
        for item in transitions:
            valid = [row for row in item['before'] if row['a'] is not None and row['b'] is not None]
            duration = sum(row['duration'] for row in valid)
            baselines.append({key: sum(row[key] * row['duration'] for row in valid) / duration if duration else None for key in ('a', 'b')})
        first_changes = {key: _mean([item['after'][0][key] - baseline[key] for item, baseline in zip(transitions, baselines)
                                   if item['after'][0]['usable'] and baseline[key] is not None]) for key in ('a', 'b')}
        summaries[name] = {'count': len(transitions), 'curves': curves, 'transitions': transitions,
                           'firstSecondChange': first_changes, 'descriptive': True}
    return summaries
