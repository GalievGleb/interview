"""Repair one legacy bot issuance from its audit record; never print its key.

Usage: python3 reconcile_account_license.py email [--apply]
The dry run reports only the matching issuance. Expiry remains based on the
original audit time, not the repair time. Uses the existing issuer config.
"""
import json
import sys
from datetime import datetime
from unittest.mock import patch
import leadbot

email = sys.argv[1].strip().lower()
records = [json.loads(line) for line in leadbot.LEADS_PATH.read_text().splitlines() if line.strip()]
matches = [r for r in records if r.get('kind') == 'key_issued' and r.get('email','').strip().lower() == email]
if not matches:
    raise SystemExit('No matching audited issuance')
record = max(matches, key=lambda r: r['ts'])
print(json.dumps({k:record[k] for k in ('email','plan','days','ts')}))
if '--apply' in sys.argv:
    issued = int(datetime.fromisoformat(record['ts']).timestamp())
    cfg = leadbot.load_json(leadbot.CONFIG_PATH,{})
    with patch.object(leadbot.time,'time',return_value=issued):
        key = leadbot.mint_license(cfg,record['plan'],record['days'],record['email'])
    leadbot.register_account_license(cfg,key)
    print('Registered original issuance with account service')
