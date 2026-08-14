from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class FrameRange(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def end_follows_start(self) -> "FrameRange":
        if self.end <= self.start:
            raise ValueError("range.end must be greater than range.start")
        return self


class Canvas(BaseModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    backgroundColor: str = "#000000"


class Layer(BaseModel):
    id: str
    role: Literal["background", "shadow", "content", "foreground", "effect"]
    order: int
    locked: bool = False


class VisualKeyframe(BaseModel):
    id: str
    frame: int = Field(ge=0)
    image: str
    mask: str | None = None
    instruction: str | None = None
    state: dict[str, Any] = Field(default_factory=dict)
    locked: bool = False


class Transform(BaseModel):
    x: float = 0.5
    y: float = 0.5
    scale: float = Field(default=1, gt=0)
    rotation: float = 0


class Element(BaseModel):
    id: str
    kind: Literal["background", "character", "prop", "foreground", "effect"]
    assetId: str
    layerId: str
    activeRange: FrameRange
    name: str | None = None
    transform: Transform = Field(default_factory=Transform)
    visible: bool = True
    locked: bool = False
    keyframes: list[VisualKeyframe] = Field(default_factory=list)


class InteractionExit(BaseModel):
    mode: Literal["restoreIndependent", "keepMerged", "attachToMember", "hideMember"] = "restoreIndependent"
    subjectId: str | None = None
    targetId: str | None = None
    anchor: str | None = None


class InteractionGroup(BaseModel):
    id: str
    members: list[str] = Field(min_length=2)
    range: FrameRange
    instruction: str
    contextPolicy: Literal["referenceOnly"] = "referenceOnly"
    outputMode: Literal["mergedRgba", "rgbWithMask"] = "mergedRgba"
    exit: InteractionExit = Field(default_factory=InteractionExit)
    keyframes: list[VisualKeyframe] = Field(default_factory=list)


class Transition(BaseModel):
    id: str
    targetType: Literal["element", "interactionGroup"]
    targetId: str
    fromFrame: int = Field(ge=0)
    toFrame: int = Field(gt=0)
    instruction: str
    strategy: Literal["auto", "interpolate", "aiVideo"] = "auto"
    selectedGenerationId: str | None = None


class Shot(BaseModel):
    schemaVersion: Literal["0.1"]
    id: str
    fps: int = Field(gt=0, le=120)
    durationFrames: int = Field(gt=0)
    canvas: Canvas
    layers: list[Layer]
    elements: list[Element]
    interactionGroups: list[InteractionGroup] = Field(default_factory=list)
    transitions: list[Transition] = Field(default_factory=list)
    generations: list[dict[str, Any]] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_references(self) -> "Shot":
        layer_ids = {layer.id for layer in self.layers}
        element_ids = {element.id for element in self.elements}
        group_ids = {group.id for group in self.interactionGroups}
        if len(layer_ids) != len(self.layers) or len(element_ids) != len(self.elements):
            raise ValueError("layer and element IDs must be unique")
        for element in self.elements:
            if element.layerId not in layer_ids:
                raise ValueError(f"element {element.id} references missing layer {element.layerId}")
            if element.activeRange.end > self.durationFrames:
                raise ValueError(f"element {element.id} exceeds shot duration")
            for keyframe in element.keyframes:
                if keyframe.frame > self.durationFrames:
                    raise ValueError(f"keyframe {keyframe.id} exceeds shot duration")
        for group in self.interactionGroups:
            if group.exit.subjectId is not None and group.exit.subjectId not in group.members:
                raise ValueError(f"interaction group {group.id} exit subject is not a member")
            if group.exit.targetId is not None and group.exit.targetId not in group.members:
                raise ValueError(f"interaction group {group.id} exit target is not a member")
            if group.exit.mode == "attachToMember" and (not group.exit.subjectId or not group.exit.targetId or group.exit.subjectId == group.exit.targetId):
                raise ValueError(f"interaction group {group.id} attachment requires distinct subject and target members")
            if group.exit.mode == "hideMember" and not group.exit.subjectId:
                raise ValueError(f"interaction group {group.id} hideMember requires a subject member")
            missing = set(group.members) - element_ids
            if missing:
                raise ValueError(f"interaction group {group.id} has missing members: {sorted(missing)}")
            if group.range.end > self.durationFrames:
                raise ValueError(f"interaction group {group.id} exceeds shot duration")
            for keyframe in group.keyframes:
                if keyframe.frame < group.range.start or keyframe.frame > group.range.end:
                    raise ValueError(f"interaction keyframe {keyframe.id} is outside group range")
        for transition in self.transitions:
            targets = group_ids if transition.targetType == "interactionGroup" else element_ids
            if transition.targetId not in targets:
                raise ValueError(f"transition {transition.id} references missing target")
            if transition.toFrame <= transition.fromFrame or transition.toFrame > self.durationFrames:
                raise ValueError(f"transition {transition.id} has invalid frame range")
        return self


class GenerationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class GenerationRequest(BaseModel):
    shotId: str
    transitionId: str
    adapter: str = "mock"
    parameters: dict[str, Any] = Field(default_factory=dict)


class GenerationOutput(BaseModel):
    kind: Literal["image", "video", "mask", "metadata"]
    uri: str
    mimeType: str | None = None


class GenerationError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class GenerationJob(BaseModel):
    id: str
    shotId: str
    transitionId: str | None = None
    adapter: str
    targetType: Literal["keyframe", "interactionKeyframe", "transition"] = "transition"
    targetId: str | None = None
    keyframeId: str | None = None
    status: GenerationStatus
    progress: int = Field(ge=0, le=100)
    message: str
    outputs: list[GenerationOutput] = Field(default_factory=list)
    error: GenerationError | None = None
