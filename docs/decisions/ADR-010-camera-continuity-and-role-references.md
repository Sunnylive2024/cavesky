# ADR-010：可选机位连续性与带语义角色的参考帧

- 状态：已接受
- 日期：2026-08-17

## 背景

当前关键帧图片生成把参考图当作无语义数组 `referenceImages`，后端和图像 Adapter 不知道每张图是“前一确认状态”“当前场景”还是“人物身份参考”，多图模型无法正确理解图片关系。同时多个提示词无条件加入“固定机位”和“镜头变化”负向提示，把机位连续变成了所有生成任务的永久硬约束。动作规划 Planner 也只有纯文本输入，无法读取锚点关键帧图片判断站姿、占画比例、屏幕方向与空间锚点。

## 决策

1. **机位连续性模式**采用供应商中立枚举 `free | prefer | lock | directed`。语义：
   - `free`：允许重新构图和调整机位。
   - `prefer`：尽量保持参考帧景别、焦距感、视平线、透视和构图；为避免主体出画可小幅调整。
   - `lock`：保持参考帧机位、焦距感、视平线、透视和裁切；不得推近、拉远、平移、摇镜或重新构图。
   - `directed`：仅执行作者以自然语言描述的机位变化，其余机位属性尽量保持连续；必须提供 `cameraInstruction`。
   新建任务默认 `prefer`，不把已有镜头静默改成 `lock`。字段名不使用 `wanCameraMode`、`qwenCameraLock` 等供应商命名。

2. **带角色的参考帧**用结构化对象替换无语义数组：

   ```json
   { "frame": 72, "relation": "before", "purpose": "continuity", "image": "/generated-media/x.png", "targetId": "CHARACTER_ID" }
   ```

   - `relation`：`before | after | same | timeless`（参考帧相对目标帧的时间关系）。
   - `purpose`：`continuity | scene | identity | objectIdentity`。
   - `frame` 对 `before/after/same` 必填；`timeless` 身份资产可省略 `frame`。
   不出现供应商名称。

3. **参考帧选择模式**内部枚举 `auto | none | previous | next | both`。自动模式规则：
   1. 优先作者手动选择的参考状态。
   2. 目标帧两侧都有同一目标已确认状态时，取最近的前后两帧。
   3. 只有一侧有已确认状态时取最近一张。
   4. 动作组首个派生状态可用锚点关键帧作前一状态。
   5. 同组无可用状态时，才查找共享成员的前/后连续状态。
   6. 场景与身份参考使用剩余图片槽位。
   7. 图片数量不超过 Adapter 的 `maxReferenceImages`。

4. **机位连续性模式作为作者选择持久化在 `InteractionGroup.cameraMode`**（默认 `prefer`），供视频提示词按模式编译；参考帧选择模式与具体参考帧属于请求级领域字段，不写入镜头 `Shot` 核心对象，必要时以生成记录参数保存。Planner 输出的 `framing`（`screenPosition/bodyAnchor/framingRisk`）是模型建议，随规划进入 `keyframe.state.framing` 与不可变 `planningHistory`，但不得让模型输出没有依据的精确摄影机毫米参数。

5. **Planner 多模态**：`PlanRequest` 增加可选 `anchorImages`（图片引用 + 画面尺寸）、`cameraMode`、`cameraInstruction`。图片以引用形式进入请求与历史摘要，Adapter 在构造供应商请求时才转成 Base64；`planningHistory` 只保存引用摘要，不保存巨大 Base64。

6. **提示词由后端统一编译**：前端只传作者选择和领域数据。不同 `relation` 生成不同说明（前一帧推进、后一帧反推、前后帧取中间态）；机位与负向提示按模式编译，`free` 与合理 `directed` 不再禁止镜头变化。

7. **Adapter capability** 增加供应商中立的 `supportsImageReference`、`maxReferenceImages` 和 `cameraLockIsSoftHint`。纯提示词无法形成几何硬锁定；`lock` 若仅靠提示词实现，界面应称为“严格要求”，不宣称像素级锁定。

## 结果

参考图关系、机位连续性和画面连续性建议都以供应商中立字段表达；机位由作者可选，不再全局固定；Planner 可读锚点图并保持结构化输出；通用镜头格式不依赖 Qwen、Wan 或阿里云字段。
