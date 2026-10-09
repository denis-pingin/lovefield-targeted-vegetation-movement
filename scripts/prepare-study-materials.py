"""Prepare the current study's static reading and source assets using stdlib only."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from tree_study_materials import prepare_study_materials


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'web/current-study')
    parser.add_argument('--checkpoint')
    parser.add_argument('--repository-url')
    options = parser.parse_args()
    materials = prepare_study_materials(options.output, checkpoint=options.checkpoint,
                                       repository_url=options.repository_url)
    print(f"Prepared current study materials: {materials['source']['contentSha256']}")


if __name__ == '__main__':
    main()
