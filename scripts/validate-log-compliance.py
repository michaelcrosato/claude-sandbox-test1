#!/usr/bin/env python3
import os
import sys
import re

LOG_PATH = os.path.join("docs", "LOG.md")
MAX_LINE_LENGTH = 2000
ALLOWED_STATUSES = {"GREEN", "AMBER", "RED", "BLOCKED", "INCIDENT", "ROLLBACK"}

def run_spot_check():
    print("[SPOT CHECK] Commencing manual repository log audit...")
    
    if not os.path.exists(LOG_PATH):
        print(f"ERROR: Canonical log file missing at '{LOG_PATH}'.", file=sys.stderr)
        return False

    with open(LOG_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()

    full_text = "".join(lines)
    
    # Stable visible plain-text token prevents browser stripping mechanisms
    target_anchor = "== LOG-ANCHOR =="
    if target_anchor not in full_text:
        print(f"ERROR: Structural anchor token '{target_anchor}' is missing from Page 1.", file=sys.stderr)
        return False

    seen_ids = set()
    heading_regex = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+·\s+([a-z]+-\d{4,})\s+·\s+([A-Z]+)\s+·\s+([a-z0-9-]+)")
    
    has_passed_anchor = False
    
    # Check lines across the entire log book
    for idx, line in enumerate(lines, start=1):
        clean_line = line.rstrip("\n")
        
        # 1. Enforce hard text length boundaries
        if len(clean_line) > MAX_LINE_LENGTH:
            print(f"LINE CEILING VIOLATION: Line {idx} has {len(clean_line)} chars (Max allowed: {MAX_LINE_LENGTH}).", file=sys.stderr)
            return False
            
        if target_anchor in clean_line:
            has_passed_anchor = True
            continue
            
        # 2. Validate operational entry blocks appended below the anchor line
        if has_passed_anchor and clean_line.startswith("## "):
            match = heading_regex.match(clean_line)
            if not match:
                print(f"MALFORMED ENTRY HEADING (Line {idx}):\nFound -> {clean_line}", file=sys.stderr)
                return False
                
            timestamp, iter_id, status, slug = match.groups()
            
            if status not in ALLOWED_STATUSES:
                print(f"INVALID STATUS (Line {idx}): '{status}'. Must be one of {ALLOWED_STATUSES}", file=sys.stderr)
                return False
                
            if iter_id in seen_ids:
                print(f"DUPLICATE PRIMARY KEY: {iter_id} seen again on line {idx}.", file=sys.stderr)
                return False
                
            seen_ids.add(iter_id)

    print("[PASS] Log compliance spot check successful. Ledger matches standard.")
    return True

if __name__ == "__main__":
    sys.exit(0 if run_spot_check() else 1)