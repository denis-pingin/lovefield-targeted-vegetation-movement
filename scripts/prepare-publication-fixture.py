#!/usr/bin/env python3
"""Prepare an isolated Test-only publication with generated original footage."""
import argparse
import json
from pathlib import Path
import sys

package = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(package / 'src'), str(package / 'tests')]
from publication_rehearsal import prepare_rehearsal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True, type=Path)
    arguments = parser.parse_args()
    try: result = prepare_rehearsal(arguments.destination)
    except (ValueError, OSError) as error: parser.exit(1, str(error) + '\n')
    print(json.dumps(result))


if __name__ == '__main__': main()
