"""Write a handwritten rows file (<name>.rows.json) to an XLSForm workbook.

This is a serializer only: it copies cells verbatim and adds no logic.
Keys starting with '_' are review annotations and are skipped.

Usage: python write_reference_xlsx.py <rows.json> <output.xlsx>
"""

import datetime
import json
import sys

from openpyxl import Workbook

FIXED_TIMESTAMP = datetime.datetime(2026, 1, 1)


def write_sheet(ws, columns, rows):
    ws.append(columns)
    for row in rows:
        unknown = [k for k in row if not k.startswith("_") and k not in columns]
        if unknown:
            sys.exit(f"Error: row {row.get('name', row)} has columns not declared for sheet '{ws.title}': {unknown}")
        ws.append([row.get(col) for col in columns])


def main(rows_path, output_path):
    with open(rows_path, encoding="utf-8") as f:
        spec = json.load(f)

    wb = Workbook()
    wb.properties.created = FIXED_TIMESTAMP
    wb.properties.modified = FIXED_TIMESTAMP
    wb.remove(wb.active)
    for sheet in ("survey", "choices", "settings"):
        write_sheet(wb.create_sheet(sheet), spec["columns"][sheet], spec[sheet])
    wb.save(output_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
