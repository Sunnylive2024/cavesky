import json
import unittest
from pathlib import Path

from pydantic import ValidationError

from cavesky.models import Shot


ROOT = Path(__file__).resolve().parents[1]


class ShotValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        path = ROOT / "examples" / "pickup-cup" / "shots" / "SH002" / "shot.json"
        self.payload = json.loads(path.read_text(encoding="utf-8"))

    def test_example_is_valid(self) -> None:
        shot = Shot.model_validate(self.payload)
        self.assertEqual(shot.id, "SH002")
        self.assertEqual(len(shot.interactionGroups[0].keyframes), 2)
        self.assertEqual(shot.interactionGroups[0].kind, "action")

    def test_missing_interaction_member_is_rejected(self) -> None:
        self.payload["interactionGroups"][0]["members"][0] = "MISSING_PROP"
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)

    def test_interaction_attachment_requires_member_targets(self) -> None:
        self.payload["interactionGroups"][0]["exit"] = {
            "mode": "attachToMember",
            "subjectId": "CHARACTER_B5788215",
            "targetId": "MISSING",
            "anchor": "rightHand",
        }
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)

    def test_transition_outside_shot_is_rejected(self) -> None:
        self.payload["transitions"][0]["toFrame"] = 120
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)

    def test_single_member_group_is_valid(self) -> None:
        self.payload["interactionGroups"][0]["exit"] = {"mode": "restoreIndependent"}
        shot = Shot.model_validate(self.payload)
        self.assertEqual(shot.interactionGroups[0].members, ["CHARACTER_B5788215"])

    def test_missing_anchor_is_rejected(self) -> None:
        self.payload["interactionGroups"][0].pop("anchorKeyframeId")
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)

    def test_action_group_cannot_attach(self) -> None:
        self.payload["interactionGroups"][0]["exit"] = {"mode":"attachToMember","subjectId":"CHARACTER_B5788215","targetId":"CHARACTER_B5788215"}
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)

    def test_directed_camera_requires_instruction(self) -> None:
        self.payload["interactionGroups"][0]["cameraMode"] = "directed"
        self.payload["interactionGroups"][0]["cameraInstruction"] = None
        with self.assertRaises(ValidationError):
            Shot.model_validate(self.payload)


if __name__ == "__main__":
    unittest.main()
