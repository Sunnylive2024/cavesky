from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ..models import FrameRange


class PlannerCapability(BaseModel):
    id: str
    label: str
    configured: bool = True


class ElementContext(BaseModel):
    """Provider-neutral snapshot of a target member element."""

    id: str
    kind: str
    name: str | None = None
    activeRange: FrameRange


class PlanRequest(BaseModel):
    """Split an anchor keyframe's description into consecutive key states."""

    shotId: str
    fps: int = Field(gt=0)
    durationFrames: int = Field(gt=0)
    desiredDurationFrames: int = Field(gt=0)
    targetEndFrame: int = Field(gt=0)
    modelDurationSeconds: list[int] = Field(min_length=1)
    members: list[ElementContext] = Field(min_length=1)
    anchorFrame: int = Field(ge=0)
    anchorDescription: str
    actionIntent: str
    embellishment: float = Field(default=0.3, ge=0, le=1)

    @model_validator(mode="after")
    def validates_backend_scope(self) -> "PlanRequest":
        if self.targetEndFrame <= self.anchorFrame:
            raise ValueError("targetEndFrame must follow anchorFrame")
        if self.targetEndFrame > self.durationFrames:
            raise ValueError("targetEndFrame exceeds shot duration")
        return self


class PlanStep(BaseModel):
    """One proposed key state after the anchor, plus transition to the next."""

    frame: int = Field(ge=0)
    memberIds: list[str] = Field(min_length=1)
    stateDescription: str
    transitionDescription: str | None = None
    requiresInteractionGroup: bool = False
    phase: Literal["preparation", "main", "completion", "hold"]
    holdFrames: int = Field(default=0, ge=0, le=120)
    continuity: "ContinuityState" = Field(default_factory=lambda: ContinuityState())


class ContinuityState(BaseModel):
    facing: Literal["left", "right", "front", "back", "unchanged"] = "unchanged"
    activeHand: Literal["left", "right", "both", "none", "unchanged"] = "unchanged"
    ownership: dict[str, str] = Field(default_factory=dict)
    contacts: list[str] = Field(default_factory=list)
    supports: list[str] = Field(default_factory=list)
    wearables: list[str] = Field(default_factory=list)


class PlanProposal(BaseModel):
    """Structured, provider-neutral remaining key states returned by a Planner."""

    steps: list[PlanStep] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def covers_action_arc(self) -> "PlanProposal":
        phases={step.phase for step in self.steps}
        if not {"main","completion","hold"}.issubset(phases):
            raise ValueError("plan must cover main action, completion and hold")
        frames=[step.frame for step in self.steps]
        if frames != sorted(frames) or len(frames) != len(set(frames)):
            raise ValueError("plan steps must be unique and strictly ordered")
        return self
