import json
from pathlib import Path

from .models import Shot


class ShotRepository:
    def __init__(self, root: Path) -> None:
        self.root = root

    def get(self, shot_id: str) -> Shot:
        path = self.root / shot_id / "shot.json"
        if not path.is_file():
            raise FileNotFoundError(shot_id)
        return Shot.model_validate_json(path.read_text(encoding="utf-8"))

    def save(self, shot: Shot) -> Path:
        folder = self.root / shot.id
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "shot.json"
        path.write_text(json.dumps(shot.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
        return path

