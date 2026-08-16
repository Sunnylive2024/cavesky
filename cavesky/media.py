from __future__ import annotations

from pathlib import Path

# URL prefixes served by the local StaticFiles mounts, mapped to workspace
# directories relative to the repository root (see cavesky.api mounts).
_URL_PREFIX_PARTS: dict[str, tuple[str, ...]] = {
    "/generated-media/": ("work", "generations"),
    "/assets/": ("examples", "pickup-cup", "assets"),
    "/source-assets/": ("zichang",),
}

_REMOTE_SCHEMES = ("https://", "http://", "data:image/", "oss://")


def is_remote_or_data(value: str) -> bool:
    return value.startswith(_REMOTE_SCHEMES)


def resolve_media_path(root: Path, value: str) -> Path:
    """Map a mounted URL prefix or relative path to an absolute workspace path.

    Returns a resolved path that is guaranteed to be inside ``root``. Raises
    ValueError when the path escapes the workspace. Callers still need to check
    whether the file actually exists.
    """
    root = root.resolve()
    candidate: Path
    for prefix, parts in _URL_PREFIX_PARTS.items():
        if value.startswith(prefix):
            filename = value.split("/")[-1]
            candidate = root.joinpath(*parts) / filename
            break
    else:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = root / candidate
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"image path escapes the workspace: {value}")
    return resolved
