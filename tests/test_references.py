import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import ValidationError

from cavesky.media import is_remote_or_data, resolve_media_path
from cavesky.models import Canvas, Element, FrameRange, InteractionExit, InteractionGroup, Layer, Shot, VisualKeyframe
from cavesky.prompting import (
    compile_camera_continuity_prompt,
    compile_keyframe_instruction,
    compile_negative_prompt,
    compile_reference_direction_prompt,
)
from cavesky.references import (
    CameraContinuityMode,
    KeyframeReference,
    ReferencePurpose,
    ReferenceRelation,
    ReferenceSelectionMode,
    available_continuity_directions,
    continuity_candidates,
    resolve_continuity_references,
)


ROOT = Path(__file__).resolve().parents[1]


def _shot(shot_id: str) -> Shot:
    path = ROOT / "examples" / "pickup-cup" / "shots" / shot_id / "shot.json"
    return Shot.model_validate(json.loads(path.read_text(encoding="utf-8")))


def _keyframe(image: str, frame: int, *, locked: bool = True, boundary: bool = False) -> VisualKeyframe:
    return VisualKeyframe(
        id=f"KF_{frame}",
        frame=frame,
        image=image,
        locked=locked,
        renderPolicy="required" if boundary else "optional",
        generationBoundary=boundary,
        sourceKind="generatedImage" if image else "authored",
    )


def _two_group_shot() -> Shot:
    """Two single-member action groups that share no members."""
    char_a = Element(
        id="CHAR_A", kind="character", assetId="A", layerId="CONTENT",
        activeRange=FrameRange(start=0, end=96),
        keyframes=[_keyframe("/a24.png", 24)],
    )
    char_b = Element(
        id="CHAR_B", kind="character", assetId="B", layerId="CONTENT",
        activeRange=FrameRange(start=0, end=96),
        keyframes=[_keyframe("/b30.png", 30)],
    )
    group_a = InteractionGroup(
        id="GA", kind="action", members=["CHAR_A"], anchorKeyframeId="KF_24",
        range=FrameRange(start=24, end=48), instruction="a",
        exit=InteractionExit(mode="restoreIndependent"),
        keyframes=[_keyframe("/a48.png", 48, boundary=True)],
    )
    group_b = InteractionGroup(
        id="GB", kind="action", members=["CHAR_B"], anchorKeyframeId="KF_30",
        range=FrameRange(start=30, end=54), instruction="b",
        exit=InteractionExit(mode="restoreIndependent"),
        keyframes=[_keyframe("/b54.png", 54, boundary=True)],
    )
    return Shot(
        schemaVersion="0.1", id="SYN", fps=24, durationFrames=96,
        canvas=Canvas(width=1280, height=720),
        layers=[Layer(id="BG", role="background", order=0), Layer(id="CONTENT", role="content", order=20)],
        elements=[char_a, char_b],
        interactionGroups=[group_a, group_b],
    )


class ReferenceResolutionTests(unittest.TestCase):
    def test_anchor_serves_as_previous_state(self) -> None:
        shot = _shot("SH002")
        group = shot.interactionGroups[0]
        references = resolve_continuity_references(shot, group, 36, ReferenceSelectionMode.PREVIOUS.value)
        self.assertEqual([(r.frame, r.relation.value) for r in references], [(24, "before")])
        self.assertTrue(all(r.purpose == ReferencePurpose.CONTINUITY for r in references))

    def test_reverse_derivation_uses_confirmed_after_state(self) -> None:
        shot = _shot("SH005")
        group = shot.interactionGroups[0]
        # Target frame 33 is unconfirmed; the confirmed tail at 72 is the after reference.
        references = resolve_continuity_references(shot, group, 33, ReferenceSelectionMode.NEXT.value)
        self.assertEqual([(r.frame, r.relation.value) for r in references], [(72, "after")])

    def test_both_selects_nearest_before_and_after(self) -> None:
        shot = _shot("SH002")
        group = shot.interactionGroups[0]
        references = resolve_continuity_references(shot, group, 36, ReferenceSelectionMode.BOTH.value)
        self.assertEqual([(r.frame, r.relation.value) for r in references], [(24, "before"), (48, "after")])

    def test_ignores_unconfirmed_or_imageless_states(self) -> None:
        shot = _shot("SH005")
        group = shot.interactionGroups[0]
        # Frames 33/42/59 have empty images and must not surface as references.
        references = resolve_continuity_references(shot, group, 33, ReferenceSelectionMode.AUTO.value)
        self.assertEqual({r.frame for r in references}, {24, 72})

    def test_none_returns_no_continuity_references(self) -> None:
        shot = _shot("SH002")
        group = shot.interactionGroups[0]
        self.assertEqual(resolve_continuity_references(shot, group, 36, ReferenceSelectionMode.NONE.value), [])

    def test_does_not_cross_unrelated_members(self) -> None:
        shot = _two_group_shot()
        group_a = shot.interactionGroups[0]
        # Group A has no confirmed state between 24 and 48 except its own 24/48.
        references = resolve_continuity_references(shot, group_a, 36, ReferenceSelectionMode.BOTH.value)
        self.assertEqual([(r.frame, r.relation.value) for r in references], [(24, "before"), (48, "after")])

    def test_manual_selection_overrides_auto(self) -> None:
        shot = _shot("SH005")
        group = shot.interactionGroups[0]
        tail_id = group.keyframes[-1].id
        references = resolve_continuity_references(shot, group, 33, ReferenceSelectionMode.AUTO.value, [tail_id])
        self.assertEqual([(r.frame, r.relation.value) for r in references], [(72, "after")])

    def test_available_directions(self) -> None:
        shot = _shot("SH002")
        group = shot.interactionGroups[0]
        self.assertEqual(available_continuity_directions(shot, group, 36), {"before", "after"})

    def test_continuity_candidates_include_keyframe_ids(self) -> None:
        shot = _shot("SH005")
        group = shot.interactionGroups[0]
        candidates = continuity_candidates(shot, group, 33)
        self.assertEqual([c["frame"] for c in candidates], [24, 72])
        self.assertEqual({c["relation"] for c in candidates}, {"before", "after"})
        self.assertTrue(all("keyframeId" in c and "image" in c for c in candidates))


class MediaPathTests(unittest.TestCase):
    def test_remote_and_data_are_left_as_is(self) -> None:
        self.assertTrue(is_remote_or_data("data:image/png;base64,AAAA"))
        self.assertTrue(is_remote_or_data("https://example/x.png"))

    def test_generated_media_url_maps_inside_workspace(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(resolve_media_path(root, "/generated-media/abc.png"), (root / "work" / "generations" / "abc.png").resolve())
            self.assertEqual(resolve_media_path(root, "/assets/lina.svg"), (root / "examples" / "pickup-cup" / "assets" / "lina.svg").resolve())

    def test_path_escaping_workspace_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                resolve_media_path(root, "../secret.png")


class KeyframeReferenceValidationTests(unittest.TestCase):
    def test_before_requires_frame(self) -> None:
        with self.assertRaises(ValidationError):
            KeyframeReference(relation=ReferenceRelation.BEFORE, image="/x.png")

    def test_timeless_must_not_carry_frame(self) -> None:
        with self.assertRaises(ValidationError):
            KeyframeReference(relation=ReferenceRelation.TIMELESS, frame=24, image="/x.png")


class CameraPromptTests(unittest.TestCase):
    def test_free_adds_no_camera_restriction_and_no_camera_negative(self) -> None:
        self.assertEqual(compile_camera_continuity_prompt(CameraContinuityMode.FREE), "")
        self.assertNotIn("镜头变化", compile_negative_prompt(CameraContinuityMode.FREE))

    def test_prefer_adds_soft_constraint_without_camera_negative(self) -> None:
        prompt = compile_camera_continuity_prompt(CameraContinuityMode.PREFER)
        self.assertIn("尽量保持", prompt)
        self.assertNotIn("镜头变化", compile_negative_prompt(CameraContinuityMode.PREFER))

    def test_lock_adds_strict_constraint_and_camera_negative(self) -> None:
        prompt = compile_camera_continuity_prompt(CameraContinuityMode.LOCK)
        self.assertIn("不得推近", prompt)
        self.assertIn("镜头变化", compile_negative_prompt(CameraContinuityMode.LOCK))
        self.assertIn("重新构图", compile_negative_prompt(CameraContinuityMode.LOCK))

    def test_directed_requires_instruction(self) -> None:
        with self.assertRaises(ValueError):
            compile_camera_continuity_prompt(CameraContinuityMode.DIRECTED)
        self.assertIn("缓慢推近", compile_camera_continuity_prompt(CameraContinuityMode.DIRECTED, "缓慢推近"))

    def test_reference_direction_prompt_before_after_both(self) -> None:
        before = [KeyframeReference(frame=24, relation=ReferenceRelation.BEFORE, purpose=ReferencePurpose.CONTINUITY, image="/a.png")]
        after = [KeyframeReference(frame=72, relation=ReferenceRelation.AFTER, purpose=ReferencePurpose.CONTINUITY, image="/b.png")]
        self.assertIn("只推进到当前目标状态", compile_reference_direction_prompt(before))
        self.assertIn("反推当前较早状态", compile_reference_direction_prompt(after))
        self.assertIn("自然位于二者之间", compile_reference_direction_prompt(before + after))

    def test_keyframe_instruction_embeds_camera_and_direction(self) -> None:
        references = [KeyframeReference(frame=72, relation=ReferenceRelation.AFTER, purpose=ReferencePurpose.CONTINUITY, image="/b.png")]
        prompt = compile_keyframe_instruction("伸手拿杯", references, CameraContinuityMode.LOCK, interaction=True)
        self.assertIn("伸手拿杯", prompt)
        self.assertIn("反推当前较早状态", prompt)
        self.assertIn("不得推近", prompt)

    def test_forward_reference_prompt_advances_only(self) -> None:
        references = [KeyframeReference(frame=24, relation=ReferenceRelation.BEFORE, purpose=ReferencePurpose.CONTINUITY, image="/a.png")]
        prompt = compile_keyframe_instruction("伸手拿杯", references, CameraContinuityMode.PREFER, interaction=True)
        self.assertIn("只推进到当前目标状态", prompt)
        self.assertNotIn("反推", prompt)

    def test_backward_reference_prompt_reverse_derives(self) -> None:
        references = [KeyframeReference(frame=72, relation=ReferenceRelation.AFTER, purpose=ReferencePurpose.CONTINUITY, image="/b.png")]
        prompt = compile_keyframe_instruction("更早的状态", references, CameraContinuityMode.PREFER, interaction=True)
        self.assertIn("反推当前较早状态", prompt)
        self.assertIn("不得直接复制后续动作结果", prompt)

    def test_both_reference_prompt_interpolates_between(self) -> None:
        references = [
            KeyframeReference(frame=24, relation=ReferenceRelation.BEFORE, purpose=ReferencePurpose.CONTINUITY, image="/a.png"),
            KeyframeReference(frame=72, relation=ReferenceRelation.AFTER, purpose=ReferencePurpose.CONTINUITY, image="/b.png"),
        ]
        prompt = compile_keyframe_instruction("中间状态", references, CameraContinuityMode.PREFER, interaction=True)
        self.assertIn("自然位于二者之间", prompt)


if __name__ == "__main__":
    unittest.main()
