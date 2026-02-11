#!/usr/bin/env python3
"""
Backfill existing scope JSONs with scope_uid and lancedb_table_id.

For each scope JSON that lacks lancedb_table_id:
  - Generates a scope_uid (UUID4)
  - Sets lancedb_table_id = "{dataset_id}__{scope_uid}"
  - Writes the updated JSON back

Usage:
  uv run python3 scripts/backfill_lancedb_table_id.py <dataset_path>

  dataset_path: full path to the dataset directory, e.g.
    ~/latent-scope-data/sheik-tweets

Options:
  --dry-run   Print what would change without writing (default)
  --execute   Actually write the changes
"""

import argparse
import glob
import json
import os
import uuid


def backfill_dataset(dataset_path, dry_run=True):
    dataset_path = os.path.expanduser(dataset_path)
    dataset_id = os.path.basename(dataset_path)
    scopes_dir = os.path.join(dataset_path, "scopes")

    if not os.path.isdir(scopes_dir):
        print(f"No scopes directory at {scopes_dir}")
        return

    # Match only scopes-NNN.json, not scopes-NNN-transactions.json etc.
    import re
    all_json = sorted(glob.glob(os.path.join(scopes_dir, "scopes-*.json")))
    scope_files = [f for f in all_json if re.search(r"scopes-\d+\.json$", f)]
    if not scope_files:
        print(f"No scope JSON files found in {scopes_dir}")
        return

    updated = 0
    skipped = 0

    for scope_file in scope_files:
        with open(scope_file) as f:
            scope = json.load(f)

        scope_id = scope.get("id", os.path.basename(scope_file).replace(".json", ""))

        if scope.get("lancedb_table_id"):
            print(f"  SKIP {scope_id} — already has lancedb_table_id: {scope['lancedb_table_id']}")
            skipped += 1
            continue

        scope_uid = str(uuid.uuid4())
        lancedb_table_id = f"{dataset_id}__{scope_uid}"

        if dry_run:
            print(f"  WOULD SET {scope_id}:")
            print(f"    scope_uid:        {scope_uid}")
            print(f"    lancedb_table_id: {lancedb_table_id}")
        else:
            scope["scope_uid"] = scope_uid
            scope["lancedb_table_id"] = lancedb_table_id
            with open(scope_file, "w") as f:
                json.dump(scope, f, indent=2)
            print(f"  UPDATED {scope_id}:")
            print(f"    scope_uid:        {scope_uid}")
            print(f"    lancedb_table_id: {lancedb_table_id}")

        updated += 1

    mode = "DRY RUN" if dry_run else "EXECUTED"
    print(f"\n{mode}: {updated} scope(s) {'would be ' if dry_run else ''}updated, {skipped} skipped")

    if dry_run and updated > 0:
        print("\nRe-run with --execute to apply changes.")
        print("After backfill, re-export to LanceDB Cloud:")
        print(f'  uv run --env-file .env python3 -c "')
        print(f"from latentscope.scripts.scope import export_lance")
        print(f"export_lance('<data-dir>', '{dataset_id}', '<scope-id>', cloud=True)")
        print(f'"')


def main():
    parser = argparse.ArgumentParser(description="Backfill scope JSONs with lancedb_table_id")
    parser.add_argument("dataset_path", help="Path to the dataset directory")
    parser.add_argument("--execute", action="store_true", help="Actually write changes (default: dry-run)")

    args = parser.parse_args()
    dry_run = not args.execute
    print(f"Backfilling lancedb_table_id for {args.dataset_path}")
    print(f"Mode: {'DRY RUN' if dry_run else 'EXECUTE'}\n")
    backfill_dataset(args.dataset_path, dry_run=dry_run)


if __name__ == "__main__":
    main()
