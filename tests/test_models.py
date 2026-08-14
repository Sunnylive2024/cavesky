import json
import unittest
from pathlib import Path

from pydantic import ValidationError

from cavesky.models import Shot


ROOT = Path(__file__).resolve().parents[1]


class ShotValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        path = ROOT / "examples" / "pickup-cup" / "shots" / "SH001" / "shot.json"
        self.payload = json.loads(path.read_text(encoding="utf-8"))

    def test_example_is_valid(self) -> None:
        shot = Shot.model_validate(self.payload)
        self.assertEqual(shot.id, "SH001")
        self.assertEqual(len(shot.interactionGroups[0].keyframes), 2)
        self.assertEqual(shot.interactionGroups[0].members, ["CHAR_01", "PROP_CUP_01"])

    def test_missing_interaction_member_is_rejected(self) -> None:
        self.payload["interactionGroups"][0]["members"][1] = "MISSING_PROP"
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)

    def test_interaction_attachment_requires_member_targets(self) -> None:
        self.payload["interactionGroups"][0]["exit"] = {
            "mode": "attachToMember",
            "subjectId": "PROP_CUP_01",
            "targetId": "MISSING",
            "anchor": "rightHand",
        }
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)

    def test_transition_outside_shot_is_rejected(self) -> None:
        self.payload["transitions"][0]["toFrame"] = 120
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)


if __name__ == "__main__":
    unittest.main()
