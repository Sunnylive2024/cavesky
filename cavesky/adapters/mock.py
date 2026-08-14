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
