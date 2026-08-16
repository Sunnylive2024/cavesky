from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import BaseModel, Field

from ..models import GenerationError, GenerationOutput


class AdapterCapability(BaseModel):
    id: str
    label: str
    kinds: list[str]
    supportsMasks: bool = False
    supportsFirstLastFrame: bool = False
    supportsImageReference: bool = False
    maxReferenceImages: int = Field(default=3, ge=1)
    cameraLockIsSoftHint: bool = True
    configured: bool = True


class TransitionTask(BaseModel):
    shotId: str
    transitionId: str
    targetType: str
    targetId: str
    instruction: str
    fromFrame: int = Field(ge=0)
    toFrame: int = Field(gt=0)
    fps: int = Field(gt=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    parameters: dict[str, object] = Field(default_factory=dict)


class AdapterResult(BaseModel):
    outputs: list[GenerationOutput] = Field(default_factory=list)
    message: str
    error: GenerationError | None = None


class GenerationAdapter(ABC):
    @property
    @abstractmethod
    def capability(self) -> AdapterCapability:
        """Describe stable, provider-neutral behavior exposed to the editor."""

    @abstractmethod
    def run_transition(self, task: TransitionTask) -> AdapterResult:
        """Run a transition task and return normalized outputs or an error."""
