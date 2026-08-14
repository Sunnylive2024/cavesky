import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

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


if __name__ == "__main__":
    unittest.main()
