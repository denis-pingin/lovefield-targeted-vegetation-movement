"""Load the single retained scientific calculator from this package."""
import importlib.util
from pathlib import Path
import sys

_path = Path(__file__).resolve().parents[1] / 'validation' / 'reference.py'
_spec = importlib.util.spec_from_file_location('tree_targeting_reference', _path)
_reference = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _reference
_spec.loader.exec_module(_reference)
MotionBin = _reference.MotionBin
Series = _reference.Series
Stream = _reference.Stream
motion_balance = _reference.motion_balance
mean_feature_speed = _reference.mean_feature_speed
