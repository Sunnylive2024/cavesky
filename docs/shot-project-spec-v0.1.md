# CaveSky 镜头工程规范 v0.1

状态：草案  
目标：定义 CaveSky MVP 可保存、校验和执行的最小镜头工程格式。

## 1. 设计目标

本规范描述的是创作工程，不描述某个 AI 模型的请求格式。

它需要满足：

- 一个镜头由多个可独立管理的视觉元素构成；
- 每个元素拥有自己的时间轴和视觉关键帧；
- 两个关键帧之间可以创建独立的过渡任务；
- 直接交互的元素可以在指定区间组成交互组；
- 未加入交互组的图层保持锁定，只作为上下文参考；
- 所有生成结果可以版本化、比较、锁定和替换；
- 工程不绑定即梦、可灵、Runway 或任何其他供应商。

## 2. 非目标

v0.1 不试图定义：

- 专业动画软件的骨骼、曲线和约束系统；
- 完整剪辑、调色和音频后期格式；
- 复杂三维场景格式；
- 多人身体接触或群体动作；
- 模型内部如何生成中间帧；
- 完整剧集与剧本语言。

## 3. 时间与坐标

- 工程以整数帧作为确定时间单位；
- 镜头必须声明 `fps` 和 `durationFrames`；
- UI 可以显示秒和时间码，但写入工程时转换为帧；
- 画面坐标采用归一化二维坐标，左上角为 `(0, 0)`，右下角为 `(1, 1)`；
- 元素深度和遮挡主要由图层顺序决定，v0.1 不强制三维坐标。

## 4. 核心概念

### 4.1 Shot（镜头）

所有元素共享的时间与画布容器。

必需字段：

- `id`：镜头内唯一标识；
- `schemaVersion`：规范版本；
- `fps`：帧率；
- `durationFrames`：镜头总帧数；
- `canvas`：宽、高与背景颜色；
- `layers`：有序图层列表；
- `elements`：元素实例；
- `transitions`：过渡任务；
- `interactionGroups`：交互组；
- `generations`：生成版本记录。

### 4.2 Layer（图层）

图层规定元素的合成顺序和用途，不规定生成模型。

v0.1 支持以下角色：

- `background`：锁定背景；
- `shadow`：接触阴影；
- `content`：人物、物品或交互组；
- `foreground`：桌沿等前景遮挡；
- `effect`：可选效果层。

### 4.3 Element（元素）

元素是某项资产在当前镜头中的实例，例如角色、杯子或前景桌沿。

元素包含：

- 资产引用；
- 所在图层；
- 生效时间范围；
- 变换和可见性；
- 视觉关键帧；
- 可选的语义状态。

元素状态用于表达作者关心的结果，例如 `cup.location = table` 或 `cup.heldBy = character_01`，不要求作者描述手腕角度和接触帧。

### 4.4 VisualKeyframe（视觉关键帧）

视觉关键帧是元素在某一帧已经确认的视觉状态，不只是提示词。

它可以包含：

- 图像或透明图像；
- Alpha 蒙版；
- 作者指令；
- 位置、缩放和旋转；
- 表情、视线、姿势等语义标签；
- 状态快照；
- 是否锁定；
- 可选的模型建议定性画面连续性 `framing`（`screenPosition`/`bodyAnchor`/`framingRisk`），只表达有依据的定性判断，不写入精确摄影机毫米参数。
- 图片策略 `renderPolicy`（必须生成、可选图片或从视频抽帧）；
- 是否作为视频生成边界 `generationBoundary`；
- 来源 `sourceKind`（作者、生成图片或已采用视频抽帧）。

锁定关键帧不能被后续生成任务静默覆盖。

### 4.5 Transition（过渡）

过渡连接同一元素或交互组的两个视觉关键帧。

作者只需声明：

- 起止关键帧；
- 动作意图；
- 可选表演提示；
- 希望的输出类型。

系统可以采用普通插值、图像动画、视频生成或其他方式实现，执行细节不进入作者层规范。

### 4.6 InteractionGroup（交互组）

动作/交互组是从元素锚点关键帧派生的有限时间状态集合。普通动作继续使用发起元素语义；人物拿杯子等互动产生联合图层。

规则：

- `kind` 必须显式为 `action` 或 `interaction`；动作组恰好一个成员，互动组至少两个成员；
- `anchorKeyframeId` 必须指向成员元素上的首帧关键帧；锚点帧等于组起点，一个锚点只能拥有一个组；首帧留在元素时间轴，组的 `keyframes` 只存首帧之后的剩余关键帧；删除首帧即删除组；
- 锚点描述当前可见状态，组 `instruction` 描述后续动作意图；
- 组内状态帧唯一、严格递增，并位于所有成员有效区间的交集；
- 必须声明活动帧区间；
- 可以拥有独立的视觉关键帧，用于描述组内成员的联合接触状态；
- 接受的交互关键帧不得覆盖成员元素原有关键帧；
- 组外图层默认 `referenceOnly`，可供模型理解空间和光照，但不得被重绘；
- 交互区间允许输出一个合并 RGBA 动画，不要求逐帧拆回成员；
- 逻辑状态仍应记录各成员在交互结束后的归属和位置；
- 交互组通过 `exit` 声明结束后恢复独立、保持联合、附着到成员或隐藏成员；附着时可保存语义锚点（如 `rightHand`）；
- 同一元素在同一时刻不能加入两个可写交互组。

### 4.7 Generation（生成版本）

一次模型调用或人工导入形成一个不可变生成版本。新尝试必须创建新记录，不能覆盖旧输出。

生成记录至少包含：

- 任务和目标引用；
- 模型适配器和模型版本；
- 输入资源与参数；
- 输出资源；
- 状态；
- 耗时与可选成本；
- 作者是否接受以及拒绝原因。

动作规划另存不可变 `planningHistory`。记录后端确定的动作范围、Planner 原始请求、语言模型原始回复和解析结果；删除或重新规划只改变当前有效组，不清除规划历史或付费媒体历史。

动作组默认时长由后端决定，24 fps 下普通动作建议 48 帧。作者可在规划前调整，Planner 只能在后端给定的目标结束帧内安排状态。视频提示词使用 0%–100% 相对时间描述阶段，不把绝对帧号当作模型节奏指令。

### 4.8 机位连续性与参考帧（请求级）

机位连续性与带语义角色的参考帧是生成请求级的领域字段，不写入镜头核心对象（见 ADR-010）。机位连续性使用供应商中立枚举 `free | prefer | lock | directed`；参考帧使用结构化对象表达 `relation`（`before | after | same | timeless`）、`purpose`（`continuity | scene | identity | objectIdentity`）、`frame` 与 `image`。它们与作者选择一起由后端统一编译进最终提示词，供应商字段不进入镜头文件。

## 5. 最小工程示例

下面的示例表达：角色 `CHAR_01` 在第 24 至 72 帧拿起杯子 `PROP_CUP_01`。背景和前景只提供参考，人物与杯子在该区间联合生成。

```json
{
  "schemaVersion": "0.1",
  "id": "SH001",
  "fps": 24,
  "durationFrames": 96,
  "canvas": {
    "width": 1280,
    "height": 720,
    "backgroundColor": "#000000"
  },
  "layers": [
    { "id": "BG", "role": "background", "order": 0, "locked": true },
    { "id": "SHADOW", "role": "shadow", "order": 10, "locked": false },
    { "id": "CONTENT", "role": "content", "order": 20, "locked": false },
    { "id": "FG", "role": "foreground", "order": 30, "locked": true }
  ],
  "elements": [
    {
      "id": "BACKGROUND_01",
      "kind": "background",
      "assetId": "ASSET_BG_LIVING_ROOM",
      "layerId": "BG",
      "activeRange": { "start": 0, "end": 96 },
      "keyframes": [
        {
          "id": "KF_BG_000",
          "frame": 0,
          "image": "assets/background/living-room.png",
          "locked": true
        }
      ]
    },
    {
      "id": "CHAR_01",
      "kind": "character",
      "assetId": "ASSET_CHAR_LINA",
      "layerId": "CONTENT",
      "activeRange": { "start": 0, "end": 96 },
      "keyframes": [
        {
          "id": "KF_CHAR_024",
          "frame": 24,
          "image": "shots/SH001/keyframes/char-024.png",
          "mask": "shots/SH001/masks/char-024.png",
          "instruction": "Lina 坐着，右手空闲，视线看向杯子",
          "state": { "pose": "sitting", "rightHand": "free", "gaze": "PROP_CUP_01" },
          "locked": true
        },
        {
          "id": "KF_CHAR_072",
          "frame": 72,
          "image": "shots/SH001/keyframes/char-with-cup-072.png",
          "mask": "shots/SH001/masks/char-with-cup-072.png",
          "instruction": "Lina 右手拿杯子，杯子停在胸前",
          "state": { "pose": "sitting", "rightHand": "holding:PROP_CUP_01", "gaze": "PROP_CUP_01" },
          "locked": true
        }
      ]
    },
    {
      "id": "PROP_CUP_01",
      "kind": "prop",
      "assetId": "ASSET_PROP_BLUE_CUP",
      "layerId": "CONTENT",
      "activeRange": { "start": 0, "end": 96 },
      "keyframes": [
        {
          "id": "KF_CUP_024",
          "frame": 24,
          "image": "shots/SH001/keyframes/cup-024.png",
          "state": { "location": "table", "heldBy": null },
          "locked": true
        },
        {
          "id": "KF_CUP_072",
          "frame": 72,
          "image": "shots/SH001/keyframes/cup-in-hand-072.png",
          "state": { "location": "CHAR_01.rightHand", "heldBy": "CHAR_01" },
          "locked": true
        }
      ]
    }
  ],
  "interactionGroups": [
    {
      "id": "IG_PICKUP_CUP_01",
      "members": ["CHAR_01", "PROP_CUP_01"],
      "range": { "start": 24, "end": 72 },
      "instruction": "Lina 犹豫地伸出右手，自然拿起杯子并停在胸前",
      "contextPolicy": "referenceOnly",
      "outputMode": "mergedRgba",
      "exit": { "mode": "attachToMember", "subjectId": "PROP_CUP_01", "targetId": "CHAR_01", "anchor": "rightHand" },
      "keyframes": [
        {
          "id": "IKF_PICKUP_024",
          "frame": 24,
          "image": "shots/SH001/keyframes/interaction-start.png",
          "instruction": "右手空闲，杯子在桌面",
          "state": { "contact": "none" },
          "locked": true
        },
        {
          "id": "IKF_PICKUP_072",
          "frame": 72,
          "image": "shots/SH001/keyframes/interaction-end.png",
          "instruction": "右手握住杯柄，杯子在胸前",
          "state": { "contact": "grasp" },
          "locked": true
        }
      ]
    }
  ],
  "transitions": [
    {
      "id": "TR_PICKUP_CUP_01",
      "targetType": "interactionGroup",
      "targetId": "IG_PICKUP_CUP_01",
      "fromFrame": 24,
      "toFrame": 72,
      "instruction": "犹豫但自然地拿起杯子",
      "strategy": "auto",
      "selectedGenerationId": null
    }
  ],
  "generations": []
}
```

## 6. 统一生成任务

领域工程经过任务构建器后，转换成与供应商无关的请求：

```json
{
  "taskId": "GEN_SH001_TR001_V1",
  "type": "keyframeTransition",
  "target": {
    "type": "interactionGroup",
    "id": "IG_PICKUP_CUP_01"
  },
  "range": { "start": 24, "end": 72, "fps": 24 },
  "inputs": {
    "startImage": "renders/ig-start.png",
    "endImage": "renders/ig-end.png",
    "contextImage": "renders/full-shot-reference.png",
    "editableMask": "renders/ig-editable-mask.png"
  },
  "instruction": "Lina 犹豫但自然地伸出右手拿起杯子",
  "constraints": {
    "preserveIdentity": true,
    "preserveStyle": true,
    "preserveCamera": true,
    "outsideMaskLocked": true
  },
  "output": {
    "preferred": "rgbaVideo",
    "allowRgbWithMask": true
  }
}
```

模型适配器负责将该请求翻译成供应商参数。供应商专属参数只保存于生成记录，不写回镜头核心对象。

## 7. 合成规则

MVP 默认合成顺序：

```text
前景遮挡层
交互组动画层
接触阴影层
固定背景层
```

如果模型不能直接输出 Alpha：

1. 接收普通 RGB 视频；
2. 对交互组进行视频分割；
3. 生成逐帧蒙版并进行时序稳定；
4. 清理边缘；
5. 合成回锁定背景。

组外图层不得通过重新生成的方式改变。

## 8. 最小校验规则

系统在提交生成任务前必须检查：

- 所有 ID 引用存在；
- 帧范围处于镜头时长内；
- 起始帧早于结束帧；
- 过渡的首尾关键帧存在且已锁定；
- 交互组至少包含一个元素；
- 同一元素没有重叠的可写交互组；
- 背景与参考上下文可读取；
- 锁定图层没有被列入可编辑目标；
- 输出不会覆盖已有生成版本。

校验只阻止结构性错误。模型是否能高质量完成动作属于生成评估，而不是通过复杂参数提前约束作者。

## 9. 文件组织

```text
project/
  project.json
  assets/
    background/
    characters/
    props/
  shots/
    SH001/
      shot.json
      keyframes/
      masks/
      generations/
        GEN_001/
          request.json
          result.json
          output.mp4
          alpha.mp4
      renders/
  exports/
```

工程路径必须使用相对路径，以便复制、压缩和迁移。密钥、访问令牌和供应商账户信息不得写入工程。

## 10. 生成状态

生成任务使用以下状态：

```text
draft → queued → running → succeeded
                         ↘ failed
succeeded → accepted | rejected
accepted → locked
```

- `accepted` 表示作者选择该结果；
- `locked` 表示该结果进入正式镜头，后续操作不得静默替换；
- 重新生成始终产生新版本。

## 11. v0.1 的实施顺序

1. 用手工方式准备背景、交互组首尾关键帧和蒙版；
2. 使用一个生成工具完成过渡，并将结果导回工程；
3. 实现工程读取、时间轴显示和分层预览；
4. 实现生成版本管理；
5. 接入第一个自动模型适配器；
6. 自动完成抠图、合成和导出；
7. 用第二个相似镜头验证资产复用收益。

## 12. 待验证问题

- 首尾帧约束对人物身份和杯子形态的稳定程度；
- 联合生成后能否获得可用的时序稳定蒙版；
- 交互组是否需要包含桌面局部，还是只作为参考上下文；
- 接触阴影应由生成模型、专用模型还是合成规则产生；
- 哪些视觉风格最适合第一版；
- 获得一个可用交互动画的平均生成次数、时间与费用。

这些问题通过实验回答，不在 v0.1 中过早固化。
