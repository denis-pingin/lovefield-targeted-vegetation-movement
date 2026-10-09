#!/usr/bin/env python3
"""Prepare an exact standalone source copy in a new empty directory."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from tree_source_release import prepare_source_release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    arguments = parser.parse_args()
    try:
        inventory = prepare_source_release(arguments.destination)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')
    print(json.dumps({'destination': str(arguments.destination.resolve()), 'contentSha256': inventory['contentSha256'],
                      'fileCount': len(inventory['files'])}))


if __name__ == '__main__': main()
