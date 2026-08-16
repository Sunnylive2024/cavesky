from __future__ import annotations

from .base import Planner
from .models import ElementContext, PlannerCapability, PlanProposal, PlanRequest, PlanStep

_KIND_LABELS = {
    "background": "背景",
    "character": "角色",
    "prop": "道具",
    "foreground": "前景",
    "effect": "特效",
}


class MockPlanner(Planner):
    """Deterministic planner that needs no key or network.

    Given the same PlanRequest it always returns the same PlanProposal: two
    remaining key states after the anchor (a midpoint and an end state).
    """

    @property
    def capability(self) -> PlannerCapability:
        return PlannerCapability(
            id="mock",
            label="Mock action planner",
            configured=True,
        )

    def plan(self, request: PlanRequest) -> PlanProposal:
        member_ids = [member.id for member in request.members]
        frames = self._remaining_frames(request.anchorFrame, request.targetEndFrame)
        requires = len(member_ids) >= 2

        char = next((member for member in request.members if member.kind == "character"), None)
        prop = next((member for member in request.members if member.kind == "prop"), None)

        if char is not None and prop is not None:
            steps = self._pair_steps(frames, member_ids, char, prop, requires)
        elif len(member_ids) == 1:
            steps = self._single_steps(frames, member_ids, request.members[0])
        else:
            steps = self._generic_steps(frames, member_ids, requires)
        return PlanProposal(steps=steps)

    @staticmethod
    def _remaining_frames(anchor: int, duration: int) -> list[int]:
        end = min(duration, anchor + 48)
        span=end-anchor
        frames: list[int] = []
        for frame in (anchor+max(1,span//3),anchor+max(2,span*2//3),end):
            if frame > anchor and (not frames or frame > frames[-1]):
                frames.append(frame)
        return frames or [min(duration, anchor + 1)]

    @staticmethod
    def _label(member: ElementContext) -> str:
        return member.name or _KIND_LABELS.get(member.kind, member.kind)

    def _pair_steps(self, frames, member_ids, char, prop, requires) -> list[PlanStep]:
        char_label = self._label(char)
        prop_label = self._label(prop)
        return [
            PlanStep(frame=frames[0], memberIds=member_ids, stateDescription=f"{char_label} 接触{prop_label}", transitionDescription="稳定抓握", requiresInteractionGroup=requires,phase="main",continuity={"activeHand":"right","contacts":[f"{char.id}:{prop.id}"]},framing=self._framing()),
            PlanStep(frame=frames[1], memberIds=member_ids, stateDescription=f"{char_label} 稳定拿起{prop_label}", transitionDescription="动作完成后保持", requiresInteractionGroup=requires,phase="completion",continuity={"activeHand":"right","ownership":{prop.id:char.id},"supports":[f"{char.id}:{prop.id}"]},framing=self._framing()),
            PlanStep(frame=frames[2], memberIds=member_ids, stateDescription=f"{char_label} 保持拿起{prop_label}的完成姿态", transitionDescription=None, requiresInteractionGroup=requires,phase="hold",holdFrames=12,continuity={"activeHand":"right","ownership":{prop.id:char.id},"supports":[f"{char.id}:{prop.id}"]},framing=self._framing()),
        ]

    def _single_steps(self, frames, member_ids, member) -> list[PlanStep]:
        label = self._label(member)
        return [
            PlanStep(frame=frames[0], memberIds=member_ids, stateDescription=f"{label} 动作进行中", transitionDescription="动作收尾", requiresInteractionGroup=False,phase="main",framing=self._framing()),
            PlanStep(frame=frames[1], memberIds=member_ids, stateDescription=f"{label} 动作完成", transitionDescription="保持完成姿态", requiresInteractionGroup=False,phase="completion",framing=self._framing()),
            PlanStep(frame=frames[2], memberIds=member_ids, stateDescription=f"{label} 保持完成姿态", transitionDescription=None, requiresInteractionGroup=False,phase="hold",holdFrames=12,framing=self._framing()),
        ]

    def _generic_steps(self, frames, member_ids, requires) -> list[PlanStep]:
        return [
            PlanStep(frame=frames[0], memberIds=member_ids, stateDescription="动作进行中", transitionDescription="动作收尾", requiresInteractionGroup=requires,phase="main",framing=self._framing()),
            PlanStep(frame=frames[1], memberIds=member_ids, stateDescription="动作完成", transitionDescription="保持完成状态", requiresInteractionGroup=requires,phase="completion",framing=self._framing()),
            PlanStep(frame=frames[2], memberIds=member_ids, stateDescription="保持完成状态", transitionDescription=None, requiresInteractionGroup=requires,phase="hold",holdFrames=12,framing=self._framing()),
        ]

    @staticmethod
    def _framing() -> dict[str, str]:
        return {"screenPosition": "center", "bodyAnchor": "chest", "framingRisk": "none"}
