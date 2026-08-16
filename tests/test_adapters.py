import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from cavesky.adapters import (
    AdapterNotFoundError,
    AdapterRegistry,
    MockGenerationAdapter,
    QwenImageAdapter,
    TransitionTask,
    Wan27ImageToVideoAdapter,
    WanKeyframeVideoAdapter,
)


class AdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = AdapterRegistry([MockGenerationAdapter()])

    def test_registry_exposes_provider_neutral_capabilities(self) -> None:
        capability = self.registry.capabilities()[0]
        self.assertEqual(capability.id, "mock")
        self.assertTrue(capability.supportsFirstLastFrame)

    def test_unknown_adapter_is_rejected(self) -> None:
        with self.assertRaises(AdapterNotFoundError):
            self.registry.get("missing")

    def test_mock_runs_transition_without_media(self) -> None:
        task = TransitionTask(
            shotId="SH001",
            transitionId="TR001",
            targetType="interactionGroup",
            targetId="IG001",
            instruction="Pick up the cup",
            fromFrame=0,
            toFrame=24,
            fps=24,
            width=1280,
            height=720,
        )
        result = self.registry.get("mock").run_transition(task)
        self.assertEqual(result.outputs, [])
        self.assertIsNone(result.error)


class AliyunAdapterTests(unittest.TestCase):
    def test_capabilities_report_configuration_without_exposing_keys(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            qwen = QwenImageAdapter(root=root, base_url="https://example.test/api/v1", api_key="secret", model="qwen-image-test")
            wan = WanKeyframeVideoAdapter(root=root, base_url="https://example.test/api/v1", api_key=None, model="wan-test")
            wan27 = Wan27ImageToVideoAdapter(root=root, base_url="https://example.test/api/v1", api_key="secret", model="wan2.7-test")
            self.assertTrue(qwen.capability.configured)
            self.assertFalse(wan.capability.configured)
            self.assertEqual(wan27.capability.id, "wan-i2v-2.7")
            self.assertTrue(wan27.capability.supportsFirstLastFrame)
            self.assertNotIn("secret", qwen.capability.model_dump_json())

    def test_qwen_requires_configuration_before_network_call(self) -> None:
        with TemporaryDirectory() as directory:
            adapter = QwenImageAdapter(root=Path(directory), base_url="https://example.test/api/v1", api_key=None, model="qwen-image-test")
            result = adapter.run_transition(self._task())
            self.assertEqual(result.error.code, "not_configured")

    def test_wan_requires_both_frames(self) -> None:
        with TemporaryDirectory() as directory:
            adapter = WanKeyframeVideoAdapter(root=Path(directory), base_url="https://example.test/api/v1", api_key="secret", model="wan-test")
            result = adapter.run_transition(self._task())
            self.assertEqual(result.error.code, "missing_input")

    @staticmethod
    def _task() -> TransitionTask:
        return TransitionTask(
            shotId="SH001",
            transitionId="TR001",
            targetType="interactionGroup",
            targetId="IG001",
            instruction="Pick up the cup",
            fromFrame=0,
            toFrame=24,
            fps=24,
            width=1280,
            height=720,
        )


class QwenImageReferenceTests(unittest.TestCase):
    def _adapter(self, root: Path) -> QwenImageAdapter:
        return QwenImageAdapter(root=root, base_url="https://example.test/api/v1", api_key="secret", model="wan2.7-image")

    def test_capability_reports_reference_support(self) -> None:
        with TemporaryDirectory() as directory:
            capability = self._adapter(Path(directory)).capability
            self.assertTrue(capability.supportsImageReference)
            self.assertEqual(capability.maxReferenceImages, 3)
            self.assertTrue(capability.cameraLockIsSoftHint)

    def test_coerce_string_reference_is_timeless(self) -> None:
        reference = QwenImageAdapter._coerce_reference("data:image/png;base64,AAAA", 0)
        self.assertEqual(reference.relation.value, "timeless")
        self.assertEqual(reference.image, "data:image/png;base64,AAAA")

    def test_role_references_become_multimodal_content(self) -> None:
        with TemporaryDirectory() as directory:
            adapter = self._adapter(Path(directory))
            task = TransitionTask(
                shotId="SH001", transitionId="TR001", targetType="interactionGroup", targetId="IG001",
                instruction="伸手拿杯", fromFrame=0, toFrame=24, fps=24, width=1280, height=720,
                parameters={"references": [{"frame": 24, "relation": "before", "purpose": "continuity", "image": "data:image/png;base64,AAAA"}], "n": 1},
            )
            captured: dict[str, object] = {}

            def fake_request_json(method, path, payload, **kwargs):
                captured["payload"] = payload
                return {"output": {"choices": [{"message": {"content": [{"image": "https://example/x.png"}]}}]}}

            with patch.object(adapter, "_request_json", side_effect=fake_request_json), patch.object(adapter, "_download", return_value=Path(directory) / "out.png"):
                result = adapter.run_transition(task)
            self.assertIsNone(result.error)
            content = captured["payload"]["input"]["messages"][0]["content"]  # type: ignore[index]
            texts = [item["text"] for item in content if "text" in item]  # type: ignore[index]
            self.assertIn("目标状态之前的已确认关键状态", texts[0])

    def test_rejects_too_many_references(self) -> None:
        with TemporaryDirectory() as directory:
            adapter = self._adapter(Path(directory))
            references = [{"relation": "timeless", "purpose": "continuity", "image": "data:image/png;base64,AAAA"} for _ in range(4)]
            task = TransitionTask(
                shotId="SH001", transitionId="TR001", targetType="interactionGroup", targetId="IG001",
                instruction="x", fromFrame=0, toFrame=24, fps=24, width=1280, height=720,
                parameters={"references": references},
            )
            result = adapter.run_transition(task)
            self.assertEqual(result.error.code, "too_many_references")

    def test_legacy_images_do_not_crash(self) -> None:
        with TemporaryDirectory() as directory:
            adapter = QwenImageAdapter(root=Path(directory), base_url="https://example.test/api/v1", api_key=None, model="wan2.7-image")
            task = TransitionTask(
                shotId="SH001", transitionId="TR001", targetType="interactionGroup", targetId="IG001",
                instruction="x", fromFrame=0, toFrame=24, fps=24, width=1280, height=720,
                parameters={"images": ["data:image/png;base64,AAAA"]},
            )
            result = adapter.run_transition(task)
            self.assertEqual(result.error.code, "not_configured")


if __name__ == "__main__":
    unittest.main()
