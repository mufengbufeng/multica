"""Apply the repository-root mining policy to a bounded project subtree."""

from __future__ import annotations

import argparse
from pathlib import Path

from mempalace.miner import load_config, mine, scan_project


def contained_path(root: Path, candidate: Path) -> Path:
    resolved_root = root.resolve(strict=True)
    resolved_candidate = candidate.resolve(strict=True)
    try:
        resolved_candidate.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"mine target escapes the repository: {resolved_candidate}") from error
    if not resolved_candidate.is_dir():
        raise ValueError(f"mine target must be a directory: {resolved_candidate}")
    return resolved_candidate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--palace", required=True)
    parser.add_argument("--wing", required=True)
    parser.add_argument("--agent", default="multica")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).resolve(strict=True)
    target = contained_path(root, Path(args.target))
    config = load_config(str(root))
    files = [
        path
        for path in scan_project(
            str(root),
            respect_gitignore=True,
            exclude_patterns=config.get("exclude_patterns", []),
        )
        if target in path.parents
    ]
    mine(
        project_dir=str(root),
        palace_path=str(Path(args.palace).resolve()),
        wing_override=args.wing,
        agent=args.agent,
        dry_run=args.dry_run,
        respect_gitignore=True,
        files=files,
    )


if __name__ == "__main__":
    main()
