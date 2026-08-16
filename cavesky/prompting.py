from __future__ import annotations

from .references import CameraContinuityMode, KeyframeReference, ReferencePurpose, ReferenceRelation


def _mode(value: CameraContinuityMode | str) -> str:
    if isinstance(value, CameraContinuityMode):
        return value.value
    return value if value in {m.value for m in CameraContinuityMode} else CameraContinuityMode.PREFER.value


def compile_camera_continuity_prompt(mode: CameraContinuityMode | str, camera_instruction: str | None = None) -> str:
    """Positive-prompt fragment describing the requested camera continuity."""
    m = _mode(mode)
    if m == CameraContinuityMode.FREE.value:
        return ""
    if m == CameraContinuityMode.PREFER.value:
        return "尽量保持参考帧的景别、焦距感、视平线、透视和构图。只有为了避免主体出画时才允许小幅调整。"
    if m == CameraContinuityMode.LOCK.value:
        return "保持参考帧相同的摄影机位置、视角、焦距感、视平线、透视和画面裁切。不得推近、拉远、平移、摇镜或重新构图。"
    # directed
    if not (camera_instruction or "").strip():
        raise ValueError("directed camera mode requires a camera instruction")
    return f"只执行以下机位变化，其余机位属性尽量保持连续：{camera_instruction.strip()}"


def compile_camera_negative_prompt(mode: CameraContinuityMode | str) -> str:
    """Negative-prompt fragment that only forbids camera change for lock."""
    if _mode(mode) == CameraContinuityMode.LOCK.value:
        return "，镜头变化，推近，拉远，平移，摇镜，重新构图"
    return ""


def compile_negative_prompt(mode: CameraContinuityMode | str) -> str:
    base = "画风变化，身份变化，服装变化，背景变化，多余人物，多余物体，多余手指，手部畸形，物体复制"
    return base + compile_camera_negative_prompt(mode)


def _continuity_references(references: list[KeyframeReference]) -> list[KeyframeReference]:
    return [
        reference
        for reference in references
        if reference.purpose == ReferencePurpose.CONTINUITY
        and reference.relation in {ReferenceRelation.BEFORE, ReferenceRelation.AFTER}
    ]


def compile_reference_direction_prompt(references: list[KeyframeReference]) -> str:
    """Describe how the continuity references relate to the target frame."""
    continuity = _continuity_references(references)
    before = any(reference.relation == ReferenceRelation.BEFORE for reference in continuity)
    after = any(reference.relation == ReferenceRelation.AFTER for reference in continuity)
    if before and after:
        return "第一张连续性参考位于目标帧之前，第二张位于目标帧之后。生成的当前状态必须在动作完成程度、姿态和空间位置上自然位于二者之间。"
    if before:
        return "参考图是目标状态之前的已确认关键状态。保持人物、服装、背景和画风连续，只推进到当前目标状态。"
    if after:
        return "参考图是目标状态之后的已确认关键状态。反推当前较早状态；动作完成程度必须早于参考图，不得直接复制后续动作结果。"
    return ""


def compile_reference_role_text(reference: KeyframeReference) -> str:
    """Short adjacent-text label describing a reference image's semantic role."""
    if reference.purpose == ReferencePurpose.SCENE:
        return "参考图：当前完整场景。"
    if reference.purpose == ReferencePurpose.IDENTITY:
        return "参考图：人物身份参考。"
    if reference.purpose == ReferencePurpose.OBJECT_IDENTITY:
        return "参考图：物品身份参考。"
    if reference.relation == ReferenceRelation.BEFORE:
        return "参考图：目标状态之前的已确认关键状态。"
    if reference.relation == ReferenceRelation.AFTER:
        return "参考图：目标状态之后的已确认关键状态，用于反推当前较早状态。"
    return "参考图：连续性参考。"


def compile_keyframe_instruction(
    instruction: str,
    references: list[KeyframeReference],
    mode: CameraContinuityMode | str,
    camera_instruction: str | None = None,
    *,
    interaction: bool = True,
) -> str:
    """Compile the final keyframe prompt from author choices and resolved references."""
    base = (
        "这是同一镜头中人物与物品的联合关键状态。严格保持身份、服装、物品外观、二维画风、色板和未提及内容不变；只改变交互成员完成目标所必需的姿态和接触关系："
        if interaction
        else "这是同一镜头中单个元素的关键状态编辑。严格保持身份、服装、二维画风、色板、背景及其他元素不变；只改变目标元素完成以下状态所必需的内容："
    )
    parts = [base + instruction.strip()]
    direction = compile_reference_direction_prompt(references)
    if direction:
        parts.append(direction)
    camera = compile_camera_continuity_prompt(mode, camera_instruction)
    if camera:
        parts.append(camera)
    return "".join(parts)
