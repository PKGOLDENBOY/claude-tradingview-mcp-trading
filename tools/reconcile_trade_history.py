#!/usr/bin/env python3
"""Read-only inventory and reconciliation of trading CSV files. Never alters sources."""
import argparse
import csv
import json
from collections import Counter
from pathlib import Path

def audit(paths):
    result = {"files": [], "totals": {"rows": 0}, "warnings": []}
    for name in paths:
        path = Path(name)
        if not path.is_file():
            result["warnings"].append(f"Missing file: {name}")
            continue
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            fields = reader.fieldnames or []
            counts = Counter()
            rows = 0
            for row in reader:
                rows += 1
                mode = (row.get("mode") or row.get("Mode") or "UNKNOWN").strip().upper()
                counts[mode] += 1
            result["files"].append({"path": str(path), "columns": fields,
                                    "rows": rows, "modes": dict(counts)})
            result["totals"]["rows"] += rows
    result["warnings"].append("Rows are NOT verified closed trades; no P&L, win rate, profit factor or drawdown inferred.")
    result["warnings"].append("Separate files may overlap; totals are inventory counts, not unique trades.")
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    print(json.dumps(audit(args.files), indent=2))

if __name__ == "__main__":
    main()
