#!/usr/bin/env python3
"""Reproduce downloaded Tree results with the exact retained scientific engine."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from tree_publication_reproduction import reproduce_publication, download_publication, run_worker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publication', type=Path, help='Exact downloaded manifest.json.')
    parser.add_argument('--files', type=Path, help='Downloaded files named by SHA-256 or their unique retained filename.')
    parser.add_argument('--url', help='Public Tree publication URL; never an authentication URL.')
    parser.add_argument('--download', type=Path, help='New empty directory for all files listed by a public manifest.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--verify-only', action='store_true', help='Verify every byte without decoding motion.')
    parser.add_argument('--worker', choices=['analysis', 'report', 'series'], help=argparse.SUPPRESS)
    parser.add_argument('--worker-input', type=Path, help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    try:
        if arguments.worker:
            run_worker(arguments.worker, json.loads(arguments.worker_input.read_text()), arguments.output)
            return
        if arguments.url:
            if not arguments.download or arguments.publication or arguments.files: parser.error('--url requires --download; use --publication and --files for already downloaded protected Test data.')
            publication = download_publication(arguments.url, arguments.download)
            files = arguments.download
        else:
            if not arguments.publication or not arguments.files or arguments.download: parser.error('Use --publication and --files, or --url and --download.')
            publication, files = arguments.publication, arguments.files
        result = reproduce_publication(publication, files, arguments.output, verify_only=arguments.verify_only)
    except (ValueError, OSError, KeyError, ImportError) as error:
        parser.exit(1, str(error) + '\n')
    print(json.dumps(result))
    if result['comparison']['matched'] is False: parser.exit(1, 'Recomputed numerical outputs differ. See reproduction.json; no tolerance was applied.\n')


if __name__ == '__main__': main()
