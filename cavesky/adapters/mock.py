from __future__ import annotations

from .base import AdapterCapability, AdapterResult, GenerationAdapter, TransitionTask


class MockGenerationAdapter(GenerationAdapter):
    @property
    def capability(self) -> AdapterCapability:
        return AdapterCapability(
            id="mock",
            label="Mock transition adapter",
            kinds=["transitionVideo"],
            supportsMasks=True,
            supportsFirstLastFrame=True,
        )

    def run_transition(self, task: TransitionTask) -> AdapterResult:
        return AdapterResult(
            message=(
                f"Mock adapter completed transition {task.transitionId}; "
                "no media was generated"
            )
        )


class MockImageAdapter(GenerationAdapter):
    @property
    def capability(self) -> AdapterCapability:
        return AdapterCapability(
            id="mock-image",
            label="Mock keyframe image adapter",
            kinds=["keyframeImage"],
            supportsImageReference=True,
            maxReferenceImages=3,
            cameraLockIsSoftHint=True,
        )

    def run_transition(self, task: TransitionTask) -> AdapterResult:
        reference_count = len(task.parameters.get("references", []) or [])
        return AdapterResult(message=f"Mock image adapter accepted {reference_count} reference(s); no media was generated")

