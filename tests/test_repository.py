import tempfile
import unittest
from pathlib import Path

from cavesky.models import Canvas, Shot
from cavesky.repository import ShotRepository


class ShotRepositoryTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        shot = Shot(
            schemaVersion="0.1", id="TEST", fps=24, durationFrames=24,
            canvas=Canvas(width=640, height=360), layers=[], elements=[]
        )
        with tempfile.TemporaryDirectory() as folder:
            repository = ShotRepository(Path(folder))
            repository.save(shot)
            loaded = repository.get("TEST")
        self.assertEqual(loaded, shot)


if __name__ == "__main__":
    unittest.main()

