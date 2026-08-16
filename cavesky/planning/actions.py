from __future__ import annotations

from uuid import uuid4
import json

from ..models import FrameRange, InteractionExit, InteractionGroup, Shot, Transition, VisualKeyframe
from .models import PlanProposal


def create_action_group(
    shot: Shot,
    anchor_element_id: str,
    anchor_keyframe_id: str,
    member_ids: list[str],
    proposal: PlanProposal,
    action_intent: str,
    target_end_frame: int,
) -> tuple[Shot, str]:
    """Materialize a planner proposal into an interaction group anchored to a keyframe.

    Pure function: performs no I/O. The anchor keyframe stays on the element
    timeline; the group stores only the remaining key states after it.
    """
    anchor_element = next((element for element in shot.elements if element.id == anchor_element_id), None)
    if anchor_element is None:
        raise ValueError(f"anchor element not found: {anchor_element_id}")
    anchor_keyframe = next((keyframe for keyframe in anchor_element.keyframes if keyframe.id == anchor_keyframe_id), None)
    if anchor_keyframe is None:
        raise ValueError(f"anchor keyframe not found: {anchor_keyframe_id}")
    if anchor_keyframe.frame >= shot.durationFrames:
        raise ValueError("anchor keyframe has no room for remaining keyframes")
    if any(group.anchorKeyframeId == anchor_keyframe.id for group in shot.interactionGroups):
        raise ValueError("anchor keyframe already owns an action group")

    element_ids = {element.id for element in shot.elements}
    member_ids = list(dict.fromkeys(member_ids))
    missing = [member_id for member_id in member_ids if member_id not in element_ids]
    if missing:
        raise ValueError(f"members not found in shot: {missing}")
    if anchor_element.id not in member_ids:
        member_ids = [anchor_element.id, *member_ids]
    members = [element for element in shot.elements if element.id in member_ids]
    common_start = max(element.activeRange.start for element in members)
    common_end = min(element.activeRange.end for element in members)
    if not (common_start <= anchor_keyframe.frame < common_end):
        raise ValueError("members have no active-range intersection after the anchor")

    remaining = [step for step in proposal.steps if step.frame > anchor_keyframe.frame]
    if not remaining:
        raise ValueError("语言模型没有在首帧之后生成关键帧，请重试")

    frames = [step.frame for step in remaining]
    if len(frames) != len(set(frames)):
        raise ValueError("planned keyframe frames must be unique")
    if any(frame > common_end for frame in frames):
        raise ValueError("planned keyframe exceeds member active-range intersection")
    if any(frame > target_end_frame for frame in frames) or frames[-1] != target_end_frame:
        raise ValueError("planner must finish exactly at the backend-determined target end frame")
    keyframes = [
        VisualKeyframe(
            id=f"IKF_{uuid4().hex[:8].upper()}",
            frame=min(shot.durationFrames, step.frame),
            image="",
            mask=anchor_keyframe.mask,
            instruction=step.stateDescription,
            state={
                **({"transitionToNext": step.transitionDescription} if step.transitionDescription else {}),
                "phase":step.phase,
                "holdFrames":step.holdFrames,
                "continuity":step.continuity.model_dump(),
            },
            locked=False,
            renderPolicy="required" if step is remaining[-1] else "optional",
            generationBoundary=step is remaining[-1],
            sourceKind="authored",
        )
        for step in sorted(remaining, key=lambda step: step.frame)
    ]
    end_frame = max(keyframe.frame for keyframe in keyframes)

    group_id = f"IG_{uuid4().hex[:8].upper()}"
    shot.interactionGroups.append(
        InteractionGroup(
            id=group_id,
            kind="action" if len(member_ids) == 1 else "interaction",
            anchorKeyframeId=anchor_keyframe.id,
            members=member_ids,
            range=FrameRange(start=anchor_keyframe.frame, end=end_frame),
            instruction=action_intent,
            contextPolicy="referenceOnly",
            outputMode="mergedRgba",
            exit=InteractionExit(mode="restoreIndependent"),
            keyframes=keyframes,
        )
    )

    sync_action_group_transitions(shot, group_id)
    return shot, group_id


def compile_action_group_prompt(anchor: VisualKeyframe, keyframes: list[VisualKeyframe], action_intent: str) -> str:
    ordered = [anchor, *sorted(keyframes, key=lambda item: item.frame)]
    total = max(1, ordered[-1].frame - anchor.frame)
    states: list[str] = []
    for index, keyframe in enumerate(ordered):
        relative = (keyframe.frame - anchor.frame) / total
        state = keyframe.state or {}
        phase = state.get("phase", "start" if index == 0 else "unspecified")
        hold = int(state.get("holdFrames", 0) or 0)
        transition = state.get("transitionToNext") or ("进入动作" if index == 0 else "")
        continuity = state.get("continuity", {})
        states.append(f"{relative:.0%}（{phase}）：{keyframe.instruction or '未描述状态'}；到下一状态：{transition or '无'}；保持 {hold} 帧；连续性：{json.dumps(continuity, ensure_ascii=False, sort_keys=True)}")
    return f"动作意图：{action_intent}。按相对时间推进：" + "；".join(states) + "。固定人物身份、左右手、朝向、物体归属、接触/支撑关系、背景与机位。"


def sync_action_group_transitions(shot: Shot, group_id: str) -> list[Transition]:
    """Rebuild group transitions from explicit boundaries, preserving exact matches."""
    group = next((item for item in shot.interactionGroups if item.id == group_id), None)
    if group is None:
        raise ValueError(f"action group not found: {group_id}")
    anchor = next((keyframe for element in shot.elements for keyframe in element.keyframes if keyframe.id == group.anchorKeyframeId), None)
    if anchor is None:
        raise ValueError("action group anchor not found")
    boundaries = [anchor, *[keyframe for keyframe in group.keyframes if keyframe.generationBoundary]]
    boundaries.sort(key=lambda keyframe: keyframe.frame)
    if len(boundaries) < 2:
        raise ValueError("action group needs an end boundary")
    previous = {
        (transition.fromFrame, transition.toFrame): transition
        for transition in shot.transitions
        if transition.targetType == "interactionGroup" and transition.targetId == group.id
    }
    rebuilt: list[Transition] = []
    for start, end in zip(boundaries, boundaries[1:]):
        guiding = [keyframe for keyframe in group.keyframes if start.frame < keyframe.frame <= end.frame]
        old = previous.get((start.frame, end.frame))
        rebuilt.append(
            Transition(
                id=old.id if old else f"TR_{uuid4().hex[:8].upper()}",
                targetType="interactionGroup",
                targetId=group.id,
                fromFrame=start.frame,
                toFrame=end.frame,
                instruction=compile_action_group_prompt(start, guiding, group.instruction),
                strategy="aiVideo",
                selectedGenerationId=old.selectedGenerationId if old else None,
            )
        )
    shot.transitions = [transition for transition in shot.transitions if not (transition.targetType == "interactionGroup" and transition.targetId == group.id)] + rebuilt
    return rebuilt
