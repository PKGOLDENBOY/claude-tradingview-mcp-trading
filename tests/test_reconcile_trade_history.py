import csv
import tempfile
import unittest
from pathlib import Path
from tools.reconcile_trade_history import audit

class AuditTests(unittest.TestCase):
    def test_missing_does_not_create_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "missing.csv"
            report = audit([p])
            self.assertFalse(p.exists())
            self.assertEqual(report["totals"]["rows"], 0)
    def test_counts_without_claiming_pnl(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "trades.csv"
            with p.open("w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=["mode", "side"])
                w.writeheader()
                w.writerow({"mode": "PAPER", "side": "buy"})
                w.writerow({"mode": "LIVE", "side": "sell"})
            report = audit([p])
            self.assertEqual(report["files"][0]["modes"], {"PAPER": 1, "LIVE": 1})
            self.assertNotIn("pnl", report["totals"])

if __name__ == "__main__":
    unittest.main()
