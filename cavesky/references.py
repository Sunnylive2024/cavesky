from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .models import Element, InteractionGroup, Shot, VisualKeyframe


class CameraContinuityMode(StrEnum):
    """Provider-neutral camera continuity requested by the author."""

    FREE = "free"
    PREFER = "prefer"
    LOCK = "lock"
    DIRECTED = "directed"


class ReferenceRelation(StrEnum):
    """Temporal relation of a reference frame to the target frame."""

    BEFORE = "before"
    AFTER = "after"
    SAME = "same"
    TIMELESS = "timeless"


class ReferencePurpose(StrEnum):
    """What a reference image is used for."""

    CONTINUITY = "continuity"
    SCENE = "scene"
    IDENTITY = "identity"
    OBJECT_IDENTITY = "objectIdentity"


class ReferenceSelectionMode(StrEnum):
    """How continuity reference frames are chosen."""

    AUTO = "auto"
    NONE = "none"
    PREVIOUS = "previous"
    NEXT = "next"
    BOTH = "both"


class KeyframeReference(BaseModel):
    """A structured, role-bearing reference frame (replaces the opaque image array)."""

    frame: int | None = None
    relation: ReferenceRelation = ReferenceRelation.TIMELESS
    purpose: ReferencePurpose = ReferencePurpose.CONTINUITY
    image: str
    targetId: str | None = None

    @model_validator(mode="after")
    def frame_required_for_temporal_relations(self) -> "KeyframeReference":
        if self.relation in {ReferenceRelation.BEFORE, ReferenceRelation.AFTER, ReferenceRelation.SAME} and self.frame is None:
            raise ValueError(f"relation '{self.relation.value}' requires a frame")
        if self.relation == ReferenceRelation.TIMELESS and self.frame is not None:
            raise ValueError("timeless references must not carry a frame")
        return self


class _ConfirmedState:
    """A confirmed (locked) keyframe state usable as a continuity reference."""

    def __init__(self, frame: int, image: str, keyframe_id: str, member_ids: set[str]) -> None:
        self.frame = frame
        self.image = image
        self.keyframe_id = keyframe_id
        self.member_ids = member_ids


def anchor_keyframe_for_group(shot: Shot, group: InteractionGroup) -> VisualKeyframe | None:
    for element in shot.elements:
        for keyframe in element.keyframes:
            if keyframe.id == group.anchorKeyframeId:
                return keyframe
    return None


def _confirmed(keyframe: VisualKeyframe) -> bool:
    return bool(keyframe.locked and keyframe.image)


def _group_local_states(shot: Shot, group: InteractionGroup) -> list[_ConfirmedState]:
    states: list[_ConfirmedState] = []
    anchor = anchor_keyframe_for_group(shot, group)
    if anchor is not None and _confirmed(anchor):
        states.append(_ConfirmedState(anchor.frame, anchor.image, anchor.id, set(group.members)))
    for keyframe in group.keyframes:
        if _confirmed(keyframe):
            states.append(_ConfirmedState(keyframe.frame, keyframe.image, keyframe.id, set(group.members)))
    return states


def _shared_member_states(shot: Shot, group: InteractionGroup) -> list[_ConfirmedState]:
    member_set = set(group.members)
    states: list[_ConfirmedState] = []
    for other in shot.interactionGroups:
        if other.id == group.id or not (member_set & set(other.members)):
            continue
        anchor = anchor_keyframe_for_group(shot, other)
        if anchor is not None and _confirmed(anchor):
            states.append(_ConfirmedState(anchor.frame, anchor.image, anchor.id, set(other.members)))
        for keyframe in other.keyframes:
            if _confirmed(keyframe):
                states.append(_ConfirmedState(keyframe.frame, keyframe.image, keyframe.id, set(other.members)))
    return states


def _element_local_states(element: Element) -> list[_ConfirmedState]:
    return [
        _ConfirmedState(keyframe.frame, keyframe.image, keyframe.id, {element.id})
        for keyframe in element.keyframes
        if _confirmed(keyframe)
    ]


def _nearest_before(local: list[_ConfirmedState], shared: list[_ConfirmedState], target_frame: int) -> _ConfirmedState | None:
    candidates = [state for state in local if state.frame < target_frame]
    if candidates:
        return max(candidates, key=lambda state: state.frame)
    shared_candidates = [state for state in shared if state.frame < target_frame]
    if shared_candidates:
        return max(shared_candidates, key=lambda state: state.frame)
    return None


def _nearest_after(local: list[_ConfirmedState], shared: list[_ConfirmedState], target_frame: int) -> _ConfirmedState | None:
    candidates = [state for state in local if state.frame > target_frame]
    if candidates:
        return min(candidates, key=lambda state: state.frame)
    shared_candidates = [state for state in shared if state.frame > target_frame]
    if shared_candidates:
        return min(shared_candidates, key=lambda state: state.frame)
    return None


def _reference_for(state: _ConfirmedState, relation: ReferenceRelation) -> KeyframeReference:
    return KeyframeReference(
        frame=state.frame,
        relation=relation,
        purpose=ReferencePurpose.CONTINUITY,
        image=state.image,
    )


def _manual_references(
    local: list[_ConfirmedState],
    shared: list[_ConfirmedState],
    target_frame: int,
    manual_keyframe_ids: list[str],
) -> list[KeyframeReference]:
    by_id = {state.keyframe_id: state for state in [*local, *shared]}
    references: list[KeyframeReference] = []
    for keyframe_id in manual_keyframe_ids:
        state = by_id.get(keyframe_id)
        if state is None:
            continue
        if state.frame < target_frame:
            relation = ReferenceRelation.BEFORE
        elif state.frame > target_frame:
            relation = ReferenceRelation.AFTER
        else:
            relation = ReferenceRelation.SAME
        references.append(_reference_for(state, relation))
    return references


def resolve_continuity_references(
    shot: Shot,
    target: InteractionGroup | Element,
    target_frame: int,
    mode: ReferenceSelectionMode | str,
    manual_keyframe_ids: list[str] | None = None,
) -> list[KeyframeReference]:
    """Resolve the continuity reference frames for a target keyframe.

    Only confirmed (locked with image) states are considered. Same-group states
    take precedence over shared-member states from other groups.
    """
    if isinstance(target, InteractionGroup):
        local = _group_local_states(shot, target)
        shared = _shared_member_states(shot, target)
    else:
        local = _element_local_states(target)
        shared = []

    if mode not in {m.value for m in ReferenceSelectionMode}:
        mode = ReferenceSelectionMode.AUTO.value

    if manual_keyframe_ids:
        return _manual_references(local, shared, target_frame, list(dict.fromkeys(manual_keyframe_ids)))

    if mode == ReferenceSelectionMode.NONE.value:
        return []

    before = _nearest_before(local, shared, target_frame)
    after = _nearest_after(local, shared, target_frame)

    if mode == ReferenceSelectionMode.PREVIOUS.value:
        return [_reference_for(before, ReferenceRelation.BEFORE)] if before else []
    if mode == ReferenceSelectionMode.NEXT.value:
        return [_reference_for(after, ReferenceRelation.AFTER)] if after else []

    # auto and both
    references: list[KeyframeReference] = []
    if before:
        references.append(_reference_for(before, ReferenceRelation.BEFORE))
    if after:
        references.append(_reference_for(after, ReferenceRelation.AFTER))
    return references


def available_continuity_directions(shot: Shot, target: InteractionGroup | Element, target_frame: int) -> set[str]:
    """Which continuity directions have a confirmed reference for the target frame."""
    if isinstance(target, InteractionGroup):
        local = _group_local_states(shot, target)
        shared = _shared_member_states(shot, target)
    else:
        local = _element_local_states(target)
        shared = []
    directions: set[str] = set()
    if _nearest_before(local, shared, target_frame):
        directions.add("before")
    if _nearest_after(local, shared, target_frame):
        directions.add("after")
    return directions


def continuity_candidates(shot: Shot, target: InteractionGroup | Element, target_frame: int) -> list[dict[str, object]]:
    """All confirmed before/after states usable for manual reference selection."""
    if isinstance(target, InteractionGroup):
        local = _group_local_states(shot, target)
        shared = _shared_member_states(shot, target)
    else:
        local = _element_local_states(target)
        shared = []
    candidates: list[dict[str, object]] = []
    for state in [*local, *shared]:
        if state.frame < target_frame:
            relation = ReferenceRelation.BEFORE.value
        elif state.frame > target_frame:
            relation = ReferenceRelation.AFTER.value
        else:
            continue
        candidates.append({"keyframeId": state.keyframe_id, "frame": state.frame, "relation": relation, "image": state.image})
    seen: set[str] = set()
    unique: list[dict[str, object]] = []
    for candidate in sorted(candidates, key=lambda item: (int(item["frame"]), str(item["keyframeId"]))):
        keyframe_id = str(candidate["keyframeId"])
        if keyframe_id not in seen:
            seen.add(keyframe_id)
            unique.append(candidate)
    return unique
