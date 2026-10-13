"""Exact versioned Tree preparation profiles; scientific constants are method-owned."""
import copy
import hashlib
import json
import math
import re
from pathlib import Path

AREA_PROFILE_PATH = Path(__file__).resolve().parents[1] / 'analysis-profile-area.json'
BUILTIN_PROFILE_PATHS = {'tree-development-area-1': AREA_PROFILE_PATH}
PROFILE_LABELS = {'tree-development-area-1': 'Area-weighted motion - 128-pixel grid'}
AREA_VERSION = 'tree-profile-development-2'
AREA_GRID_MEAN = 'area-grid-mean-v1'
METHOD = 'tree-analysis-development-1'

def area_profile():
    return load_profile(AREA_PROFILE_PATH)['profile']

def canonical_profile():
    return area_profile()

def measurement_method(profile):
    if (not isinstance(profile, dict) or profile.get('version') != AREA_VERSION or
        not isinstance(profile.get('video'), dict) or
        not isinstance(profile['video'].get('measurement'), dict) or
        profile['video']['measurement'].get('method') != AREA_GRID_MEAN):
        raise ValueError('Unsupported motion profile. Use area-weighted motion.')
    return AREA_GRID_MEAN

def time_resolved_tree(profile):
    return profile.get('treeAnalysis', {}).get('method') == METHOD

def validate_run_profile(profile, bundle):
    validated = validate_profile(profile)
    if bundle['config']['purpose'] == 'scored':
        sealed = bundle.get('sealedProfileJson')
        try:
            frozen = json.loads(sealed) if isinstance(sealed, str) else None
        except (ValueError, TypeError):
            frozen = None
        if (not isinstance(sealed, str) or frozen != bundle.get('profile') or frozen != validated or
            bundle['config'].get('analysisProfileId') != validated['profileId'] or
            hashlib.sha256(sealed.encode('utf-8')).hexdigest() != bundle.get('profileHash')):
            raise ValueError('The scored analysis profile differs from its frozen bytes, identity or hash.')
    return validated

def validate_profile(profile):
    if not isinstance(profile, dict) or set(profile) - {'label'} != {'profileId', 'version', 'video', 'timing', 'treeAnalysis'}:
        raise ValueError('A Tree profile needs profileId, version, video, timing and treeAnalysis')
    if 'label' in profile and (not isinstance(profile['label'], str) or not profile['label'].strip()):
        raise ValueError('Enter a profile name')
    measurement_method(profile)
    if not isinstance(profile['profileId'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', profile['profileId']):
        raise ValueError('Unsupported Tree profile version or identifier')
    template = json.loads(AREA_PROFILE_PATH.read_text())
    def structure(value, expected, location):
        if isinstance(expected, dict):
            if not isinstance(value, dict) or set(value) != set(expected):
                raise ValueError(f'{location} has missing or unknown settings')
            for name in expected: structure(value[name], expected[name], f'{location}.{name}')
        elif isinstance(expected, list):
            if not isinstance(value, list) or len(value) != len(expected): raise ValueError(f'{location} has an invalid shape')
            for index, item in enumerate(value): structure(item, expected[index], location)
        elif type(expected) in (int, float):
            if type(value) not in (int, float) or not math.isfinite(value): raise ValueError(f'{location} must be finite and numeric')
        elif not isinstance(value, type(expected)):
            raise ValueError(f'{location} has an invalid type')
    structure({key: value for key, value in profile.items() if key != 'label'}, template, 'profile')
    if profile['treeAnalysis'] != template['treeAnalysis']:
        raise ValueError('Statistical settings belong to the named analysis method')
    measurement = profile['video']['measurement']
    for name in ('cellSizePixels', 'pointsPerCell', 'minimumTracksPerCell'):
        value = measurement[name]
        if type(value) is not int or value < 1:
            raise ValueError(f'{name} must be a positive integer')
    if measurement['minimumTracksPerCell'] > measurement['pointsPerCell']:
        raise ValueError('Minimum cell tracks cannot exceed points per cell')
    coverage = measurement['minimumSpatialCoverageFraction']
    if type(coverage) not in (int, float) or not math.isfinite(coverage) or not 0 < coverage <= 1:
        raise ValueError('Spatial coverage fraction must be between zero and one')
    if measurement['refreshPolicy'] not in ('timed', 'continuous'):
        raise ValueError('Unknown grid refresh policy')
    window = profile['video']['tracking']['windowSizePixels']
    if any(type(width) is not int or width <= 0 or width % 2 != 1 for width in window):
        raise ValueError('Tracking windows must have positive odd integer widths')
    from study_video import _motion_settings
    _motion_settings(tracking_settings(profile))
    timing = profile['timing']
    if timing['maximumPairwiseAlignmentSeconds'] <= 0 or timing['maxCueWaitSeconds'] <= 0 or type(timing['clockExchangeCount']) is not int or timing['clockExchangeCount'] < 1:
        raise ValueError('Timing limits and exchange count must be positive')
    return copy.deepcopy(profile)

def load_profile(path):
    raw = Path(path).read_bytes()
    text = raw.decode('utf-8')
    return {'profile': validate_profile(json.loads(text)), 'sealedProfileJson': text,
            'sha256': hashlib.sha256(raw).hexdigest()}

class ProfileRepository:
    def __init__(self, directory):
        self.directory = Path(directory)

    def save_new(self, profile, *, purpose='preparation'):
        if purpose != 'preparation':
            raise ValueError('A scored profile is frozen and cannot be saved or mutated')
        validated = validate_profile(profile)
        path = self.directory / f"{validated['profileId']}.json"
        if path.exists() or validated['profileId'] in BUILTIN_PROFILE_PATHS:
            raise ValueError('This profile already exists; save with a new profile ID')
        self.directory.mkdir(parents=True, exist_ok=True)
        with path.open('x') as output:
            json.dump(validated, output, sort_keys=True, indent=2, allow_nan=False)
            output.write('\n')
        return load_profile(path)

    def load(self, profile_id):
        if not isinstance(profile_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', profile_id):
            raise ValueError('Choose a valid profile ID')
        return load_profile(BUILTIN_PROFILE_PATHS.get(profile_id, self.directory / f'{profile_id}.json'))

def tracking_settings(profile):
    video = profile["video"]
    return {"features": {
        "maxCorners": video["featureDetection"]["maxCorners"],
        "qualityLevel": video["featureDetection"]["qualityLevel"],
        "minDistance": video["featureDetection"]["minDistancePixels"],
        "blockSize": video["featureDetection"]["blockSize"],
    }, "tracking": {
        "winSize": video["tracking"]["windowSizePixels"],
        "maxLevel": video["tracking"]["maxLevel"],
        "maxIterations": video["tracking"]["maxIterations"],
        "epsilon": video["tracking"]["epsilon"],
    }, "forward_backward_error_pixels": video["tracking"]["maximumForwardBackwardErrorPixels"],
        "minimum_target_tracks": video["minimumTracks"]["target"],
        "minimum_background_tracks": video["minimumTracks"]["background"],
        "reseed_seconds": video["reseedSeconds"],
        "minimum_coverage_fraction": video["minimumCoverageFraction"],
        "shake_displacement_pixels": video["shake"]["minimumBackgroundDisplacementPixels"],
        "shake_consecutive_pairs": video["shake"]["consecutiveFramePairs"]}
