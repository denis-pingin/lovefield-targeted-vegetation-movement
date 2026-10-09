"""Fixed-image spatial sampling and measured-area motion diagnostics for Tree."""
import math

import cv2
import numpy as np


def grid_cells(mask, cell_size, points_per_cell, minimum_tracks_per_cell):
    """Partition one polygon mask on the native image origin, including clipped cells."""
    height, width = mask.shape
    cells = []
    for y in range(0, height, cell_size):
        for x in range(0, width, cell_size):
            right, bottom = min(x + cell_size, width), min(y + cell_size, height)
            area = int(np.count_nonzero(mask[y:bottom, x:right]))
            if not area:
                continue
            budget = max(1, math.ceil(points_per_cell * area / (cell_size * cell_size)))
            minimum = min(budget, max(1, math.ceil(minimum_tracks_per_cell * area / (cell_size * cell_size))))
            cells.append({'id': len(cells), 'x': x, 'y': y, 'right': right, 'bottom': bottom,
                          'area': area, 'budget': budget, 'minimum_tracks': minimum})
    return cells


def aggregate_cells(cells, tracks, elapsed, minimum_coverage):
    """Average valid cell magnitudes by polygon area, leaving unmeasured area unknown."""
    if not math.isfinite(elapsed) or elapsed <= 0:
        raise ValueError('A spatial frame pair needs positive elapsed time')
    total_area = sum(cell['area'] for cell in cells)
    if not total_area:
        raise ValueError('A spatial region must have positive masked area')
    covered_area, weighted_speed, diagnostics = 0, 0., []
    for cell in cells:
        samples = tracks.get(cell['id'], [])
        valid = len(samples) >= cell['minimum_tracks']
        mean_speed = (math.fsum(math.hypot(u - x, v - y) for x, y, u, v in samples) /
                      (len(samples) * elapsed)) if valid else None
        if valid:
            covered_area += cell['area']
            weighted_speed += cell['area'] * mean_speed
        diagnostics.append({**cell, 'accepted_count': len(samples), 'speed': mean_speed,
                            'reason': None if valid else 'insufficient_tracks'})
    coverage = covered_area / total_area
    observed = weighted_speed / covered_area if covered_area else None
    return {'speed': observed if coverage + 1e-12 >= minimum_coverage else None,
            'observed_area_speed': observed, 'coverage_fraction': coverage,
            'covered_area': covered_area, 'total_area': total_area,
            'cells': diagnostics,
            'reason': None if coverage + 1e-12 >= minimum_coverage else 'insufficient_spatial_coverage'}


def _inside(points, mask):
    height, width = mask.shape
    finite = np.isfinite(points).all(axis=1)
    inside = finite & (points[:, 0] >= 0) & (points[:, 0] < width) & (points[:, 1] >= 0) & (points[:, 1] < height)
    indices = np.flatnonzero(inside)
    inside[indices] &= mask[points[indices, 1].astype(np.intp), points[indices, 0].astype(np.intp)]
    return inside


def _rows(starts, ends):
    return [[float(x), float(y), float(u) if np.isfinite(u) else None,
             float(v) if np.isfinite(v) else None] for (x, y), (u, v) in zip(starts, ends)]


def track_grid(previous, current, mask, cells, carried, settings, measurement, elapsed):
    """Top up each cell, then track all target points against full-size frames."""
    min_distance = settings['features']['minDistance']
    cell_size = measurement['cellSizePixels']
    destination_cells = {(cell['x'] // cell_size, cell['y'] // cell_size): cell['id'] for cell in cells}
    points_by_cell = {}
    detected_counts = {}
    carried_counts = {}
    for cell in cells:
        retained = carried.get(cell['id'])
        retained = np.empty((0, 2), dtype=np.float32) if retained is None else np.asarray(retained, dtype=np.float32).reshape(-1, 2)
        retained = retained[_inside(retained, mask)]
        retained = retained[(retained[:, 0] >= cell['x']) & (retained[:, 0] < cell['right']) &
                            (retained[:, 1] >= cell['y']) & (retained[:, 1] < cell['bottom'])]
        retained = retained[:cell['budget']]
        carried_counts[cell['id']] = len(retained)
        needed = cell['budget'] - len(retained)
        new = np.empty((0, 2), dtype=np.float32)
        if needed:
            support = settings['features']['blockSize']
            left, top = max(0, cell['x'] - support), max(0, cell['y'] - support)
            right, bottom = min(mask.shape[1], cell['right'] + support), min(mask.shape[0], cell['bottom'] + support)
            detection_mask = np.zeros((bottom - top, right - left), dtype=np.uint8)
            detection_mask[cell['y'] - top:cell['bottom'] - top,
                           cell['x'] - left:cell['right'] - left] = (
                mask[cell['y']:cell['bottom'], cell['x']:cell['right']].astype(np.uint8) * 255)
            for x, y in retained:
                cv2.circle(detection_mask, (round(float(x)) - left, round(float(y)) - top),
                           math.ceil(min_distance), 0, -1)
            found = cv2.goodFeaturesToTrack(previous[top:bottom, left:right], mask=detection_mask, maxCorners=needed,
                                            qualityLevel=settings['features']['qualityLevel'],
                                            minDistance=min_distance, blockSize=settings['features']['blockSize'])
            if found is not None:
                new = found.reshape(-1, 2) + np.array([left, top], dtype=np.float32)
        points_by_cell[cell['id']] = np.concatenate((retained, new))
        detected_counts[cell['id']] = len(points_by_cell[cell['id']])
    active = [(cell['id'], point) for cell in cells for point in points_by_cell[cell['id']]]
    tracks = {cell['id']: [] for cell in cells}
    following_by_cell = {cell['id']: [] for cell in cells}
    rejected = []
    if active:
        starts = np.asarray([point for _, point in active], dtype=np.float32)
        options = settings['tracking']
        lk_options = {'winSize': tuple(options['winSize']), 'maxLevel': options['maxLevel'],
                      'criteria': (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                                   options['maxIterations'], options['epsilon'])}
        forward, forward_status, _ = cv2.calcOpticalFlowPyrLK(previous, current, starts.reshape(-1, 1, 2), None, **lk_options)
        if forward is None or forward_status is None or len(forward) != len(starts):
            forward = np.full_like(starts, np.nan)
            forward_status = np.zeros((len(starts), 1), dtype=np.uint8)
        else:
            forward = forward.reshape(-1, 2)
        valid = forward_status.reshape(-1).astype(bool) & _inside(starts, mask) & _inside(forward, mask)
        backward = np.full_like(starts, np.nan)
        backward_status = np.zeros(len(starts), dtype=bool)
        if np.any(valid):
            returned, status, _ = cv2.calcOpticalFlowPyrLK(current, previous,
                forward[valid].reshape(-1, 1, 2), None, **lk_options)
            if returned is not None and status is not None and len(returned) == int(np.count_nonzero(valid)):
                backward[valid] = returned.reshape(-1, 2)
                backward_status[valid] = status.reshape(-1).astype(bool)
        error = np.linalg.norm(backward - starts, axis=1)
        valid &= backward_status & np.isfinite(error) & (error <= settings['forward_backward_error_pixels'])
        for index, (cell_id, start) in enumerate(active):
            end = forward[index]
            if valid[index]:
                tracks[cell_id].append(_rows([start], [end])[0])
                destination = destination_cells.get((int(end[0]) // cell_size, int(end[1]) // cell_size))
                if destination is not None:
                    following_by_cell[destination].append(end.tolist())
            else:
                rejected.extend(_rows([start], [end]))
    aggregate = aggregate_cells(cells, tracks, elapsed, measurement['minimumSpatialCoverageFraction'])
    count = sum(len(samples) for samples in tracks.values())
    return {'speed': aggregate['speed'], 'vector': None, 'count': count,
            'following': {cell_id: np.asarray(points, dtype=np.float32).reshape(-1, 2)
                          for cell_id, points in following_by_cell.items()},
            'tracks': [track for samples in tracks.values() for track in samples],
            'rejected_tracks': rejected, 'detected_count': sum(detected_counts.values()),
            'carried_count': sum(carried_counts.values()),
            'rejected_count': len(rejected), 'reason': aggregate['reason'],
            'spatial': {**aggregate, 'cells': [{**cell, 'detected_count': detected_counts[cell['id']],
                                               'carried_count': carried_counts[cell['id']]}
                                              for cell in aggregate['cells']]}}
