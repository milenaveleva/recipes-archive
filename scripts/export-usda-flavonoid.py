#!/usr/bin/env python3
"""Export the USDA Flavonoid Database R3.3 Access tables to CSV for scripts/build-polyphenols.mjs.

The release ships only as an Access file (Flav_R03-3.accdb inside Flav_R03-3.zip). This reads it
with the pure-Python `access-parser` package and writes FLAV_DAT, FOOD_DES, NUTR_DEF and FD_GROUP
as CSV next to it, in the git-ignored scripts/data-raw/usda-flavonoid/.

Usage:
  python3 -m venv /tmp/flav-venv && /tmp/flav-venv/bin/pip install access-parser
  curl -sSL -o scripts/data-raw/usda-flavonoid/Flav_R03-3.zip \\
    https://www.ars.usda.gov/ARSUserFiles/80400535/Data/Flav/Flav_R03-3.zip
  unzip -o scripts/data-raw/usda-flavonoid/Flav_R03-3.zip -d scripts/data-raw/usda-flavonoid
  /tmp/flav-venv/bin/python scripts/export-usda-flavonoid.py
"""
import csv
import os
import sys

from access_parser import AccessParser

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data-raw', 'usda-flavonoid')
DB = os.path.join(DIR, 'Flav_R03-3.accdb')

if not os.path.exists(DB):
    sys.exit(f'missing {DB} — download and unzip Flav_R03-3.zip first (see the docstring)')
db = AccessParser(DB)
for table in ('FLAV_DAT', 'FOOD_DES', 'NUTR_DEF', 'FD_GROUP'):
    print(f'→ exporting {table}…', file=sys.stderr, flush=True)
    data = db.parse_table(table)
    cols = list(data.keys())
    rows = len(data[cols[0]])
    with open(os.path.join(DIR, f'{table}.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for i in range(rows):
            w.writerow([data[c][i] for c in cols])
    print(f'  {rows} rows', file=sys.stderr, flush=True)
print('✓ done', file=sys.stderr)
