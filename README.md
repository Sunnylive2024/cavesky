# CaveSky

CaveSky 是面向个人与小型创作团队的本地优先 AI 动画摄影棚。作者管理角色、物品、背景和时间，AI 负责绘制关键状态并生成状态之间的自然过渡。

> 作者决定元素、关键状态和动作意图；AI 负责关键状态之间的自然过渡。

当前第一阶段已经跑通：语言模型动作规划、关键帧候选、Wan 2.7 I2V 整组过渡、SAM 2.1 动态蒙版、锁定背景合成、生成历史和时间轴预览。近期重点是整理编辑器前端工作流、确定性属性插值、导出和端到端验收。

## 先理解这套工作方式

CaveSky 不让视频模型重画整个镜头，而是把创作拆成可控制的小单元：

1. 背景、人物、物品作为独立元素进入镜头。
2. 普通位移、缩放、旋转等确定性变化由编辑器完成。
3. 人物与物品发生接触时，临时组成一个交互组。
4. 作者确认交互组的几个视觉关键状态。
5. 图像模型生成关键帧候选，作者选择并保存蒙版。
6. 视频模型生成相邻关键状态之间的过渡。
7. SAM 2.1 将首帧蒙版传播成动态视频蒙版。
8. 编辑器只把蒙版内的交互动画合成回锁定背景。

第一次接手请先阅读 [朋友接手与本地启动指南](docs/FRIEND_SETUP.md)。完整原则见 [项目上下文](docs/PROJECT_CONTEXT.md)，镜头数据约束见 [镜头工程规范](docs/shot-project-spec-v0.1.md)，重要设计决定见 [docs/decisions](docs/decisions)。

## 当前能力

已经实现：

- React + TypeScript + Vite 本地编辑器；
- Python + FastAPI 本地后端；
- 资产库、镜头元素、独立时间轴和视觉关键帧；
- 人物与物品交互组及交互接管；
- Wan 2.7 Image、Qwen Image 关键帧适配；
- Wan 2.2 KF2V、Wan 2.7 I2V 过渡适配；
- Qwen Flash 动作规划、48 帧默认动作范围、逐状态规划历史；
- 生成候选历史、采用版本和刷新恢复；
- SAM 2.1 Tiny 点选、排除点、画笔修正和撤销；
- SAM 2.1 Tiny 短视频蒙版传播；
- 镜头合成、仅交互动画、动态蒙版、生成原视频四种视图；
- 已采用视频随时间轴定位和播放。

尚未完成：

- 规划历史和尾帧工作流的前端可用性整理；
- 元素位置、缩放、旋转等关键帧属性插值；
- 稳定的视频导出与分层素材导出；
- 完整的失败重试、取消和成本统计；
- 第一阶段端到端验收脚本。

当前任务状态以 [任务看板](docs/TASKS.md) 为准。

## 仓库结构

```text
apps/editor/                  React 编辑器
cavesky/                      FastAPI、模型适配器和本地分割
cavesky/adapters/             云端生成模型适配边界
cavesky/segmentation/         SAM 图片分割与视频蒙版传播
examples/pickup-cup/          拿杯子 Demo 镜头
work/generations/             本地生成结果（Git 忽略）
work/models/                  本地模型权重（Git 忽略）
docs/decisions/               架构决策记录
tests/                        后端测试
```

模型供应商字段不得写入通用镜头格式。新增模型时应实现独立 Adapter，让编辑器仍只认识“关键帧生成”“过渡生成”“规划”等通用职责。

## 环境要求

基础开发：

- Windows 10/11（目前主要验证环境）；
- Python 3.12+；
- Node.js 20+；
- pnpm；
- FFmpeg 和 FFprobe，且可从 `PATH` 调用；
- Git。

仅使用云端规划、图像和视频模型时不需要高端显卡。本地 SAM 建议使用 NVIDIA GPU；当前 SAM 2.1 Tiny 已在 RTX 3060 6 GB 上验证，60 帧、512×288 分块重叠传播可用。CPU 可以作为兼容路径，但速度会明显较慢。

## 首次安装

在仓库根目录执行：

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
pnpm install
```

如果只参与语言模型规划层，可以先不安装 SAM 和 CUDA；使用 `mock` 或云端 Adapter 完成接口与测试。

### 可选：安装本地 SAM 2.1 Tiny

SAM 不是 Python 基础依赖，需额外安装：

1. 安装与本机 CUDA 匹配的 PyTorch；本项目当前验证环境为 PyTorch 2.11 + CUDA 12.8。
2. 安装 Meta 官方 `segment-anything-2` 包。
3. 下载 `sam2.1_hiera_tiny.pt`。
4. 将权重放到：

```text
work/models/sam2/sam2.1_hiera_tiny.pt
```

不要提交模型权重、虚拟环境或生成媒体。它们均已加入 `.gitignore`。启动后访问 `GET /api/segmentation/status` 可检查 PyTorch、CUDA 和权重状态。

## 使用自己的 API Key

每位开发者都应使用自己的业务空间、额度和 API Key。不要共享创建者的 `.env`，不要把 Key 发到群聊、提交到 Git、写进前端代码或 `shot.json`。

1. 在阿里云百炼控制台创建或选择业务空间。
2. 在该业务空间创建 API Key，并确认目标模型已开通或有额度。
3. 复制 `.env.example` 为 `.env`：

```powershell
Copy-Item .env.example .env
```

4. 填写自己的配置：

```dotenv
CAVESKY_ALIYUN_BASE_URL=https://你的业务空间域名.cn-beijing.maas.aliyuncs.com/api/v1
CAVESKY_QWEN_API_KEY=你的关键帧模型Key
CAVESKY_WAN_API_KEY=你的过渡视频模型Key
CAVESKY_KEYFRAME_IMAGE_MODEL=wan2.7-image
CAVESKY_WAN_27_VIDEO_MODEL=wan2.7-i2v-2026-04-25

CAVESKY_PLANNER_BASE_URL=https://你的业务空间域名.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
CAVESKY_PLANNER_API_KEY=你的动作规划Key
CAVESKY_PLANNER_MODEL=qwen-flash
```

图像和视频使用业务空间专属 DashScope `/api/v1` 地址；动作规划使用同一业务空间的 `/compatible-mode/v1` 地址。两种地址不能互换。

如果同一业务空间的 Key 拥有 `wan2.7-image`、`wan2.7-i2v-2026-04-25` 和 `qwen-flash` 权限，一个实际 Key 可以同时填入三个 Key 变量；也可以分开创建以便统计和轮换。业务空间是模型权限、额度、Key 和调用记录的隔离范围，不需要把“默认业务空间”文字写进请求。

`.env` 会由后端加载，前端永远不应读取这些值。云端返回的临时媒体会立即缓存到 `work/generations/`，因此刷新页面后仍可查看已经付费生成的历史候选。

`work/generations/` 被 Git 忽略。朋友克隆仓库后不会得到创建者本机已经付费生成的图片、视频和动态蒙版；镜头 JSON 中的历史媒体地址可能因此暂时不可用。团队如需共享示例结果，应另行提供经过许可的媒体包，而不是提交个人完整生成目录。

### 可选模型变量

```dotenv
# Qwen Image 兼容模型
CAVESKY_QWEN_IMAGE_MODEL=qwen-image-3.0-pro

# Wan 2.7 首尾帧视频
CAVESKY_WAN_27_VIDEO_MODEL=wan2.7-i2v-2026-04-25
```

模型 ID、权限和免费额度会变化，应以开发者自己业务空间的模型列表和控制台账单为准。测试真实调用前先使用低分辨率、最短片段，并确认请求只会生成一次。

### 语言模型规划配置

动作规划层已经接入 OpenAI-compatible Chat Completions。百炼需要使用业务空间的兼容地址：

```dotenv
CAVESKY_PLANNER_BASE_URL=https://你的业务空间域名.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
CAVESKY_PLANNER_API_KEY=你的Key
CAVESKY_PLANNER_MODEL=qwen-flash
```

未配置云端 Planner 时仍可选择 `mock` 做无费用测试。密钥规则与图像、视频模型相同：仅后端可见。

## 启动项目

打开两个 PowerShell 窗口。

后端：

```powershell
.venv\Scripts\Activate.ps1
python -m uvicorn cavesky.api:app --reload
```

前端：

```powershell
pnpm dev
```

访问：

- 编辑器：`http://127.0.0.1:5173/`
- 后端健康检查：`http://127.0.0.1:8000/api/health`
- API 文档：`http://127.0.0.1:8000/docs`
- 已注册模型能力：`http://127.0.0.1:8000/api/generation-adapters`

## Demo 创作流程

1. 打开 `pickup-cup` 示例镜头。
2. 在时间轴选择紫色交互组“拿起杯子”。交互期间人物与杯子的独立轨道由交互层接管。
3. 选择交互关键状态，填写“此刻看起来怎样”，而不是写冗长的模型咒语。
4. 选择关键帧图片模型并生成候选；预览候选后明确点击采用。
5. 使用智能选择建立蒙版：点击为保留，`Shift + 点击`为排除；可继续加点，也可用画笔、橡皮和撤销修正。
6. 保存首尾关键状态的蒙版并锁定采用结果。
7. 选择过渡模型，生成相邻关键状态的过渡视频并采用一个版本。
8. 第一次采用的视频仍是带背景的“生成原视频”。点击“生成动态蒙版”，SAM 才会把它变成可合成的交互动画层。
9. 用四种视图检查：
   - 镜头合成：最终预览；
   - 仅交互动画：蒙版后的动画；
   - 动态蒙版：逐帧黑白蒙版；
   - 生成原视频：云模型返回的完整 RGB 视频。
10. 若蒙版带入桌面或背景，先修正首关键帧蒙版，再点击“重新生成动态蒙版”。无需重新付费生成视频。

“尚未分层”表示当前只有云模型返回的完整视频，还没有动态蒙版。系统会阻止它直接覆盖锁定背景。

## 语言模型动作规划层

规划层已经实现。目标不是让语言模型代替导演，而是把作者的一句话变成少量、可追溯的关键状态。例如作者输入“女孩拿起杯子喝水”，规划层可以给出：

```text
状态 1：右手接近杯把，杯子仍在桌面
状态 2：手握住杯把，杯底刚离开桌面
状态 3：杯口接近嘴边，头部轻微迎向杯子
状态 4：杯子贴近嘴唇，保持短暂饮水姿态
```

当前边界：

- 锚点描述只表达当前可见状态，动作意图表达随后发生什么。
- 后端在调用 Planner 前确定动作范围；普通动作默认 48 帧，作者可以调整。
- Planner 返回经过 Pydantic 校验的状态、帧号、阶段、保持时间和连续性数据。
- 原始请求、原始回复和解析结果写入不可变规划历史。
- 应用规划只创建动作/互动组和描述节点，不会自动调用付费图片或视频模型。
- 组尾是明确生成边界，作者生成候选并采用尾图后，才能提交 Wan。
- `mock` Planner 无需 API Key、联网或费用，供测试使用。

目录边界：

```text
cavesky/planning/              规划领域模型、Planner 接口、mock 和云端适配器
cavesky/api.py                 只增加通用规划 API
apps/editor/                   规划历史、动作组状态和作者确认
tests/                         规划校验、失败路径和 API 测试
docs/decisions/                如需改动镜头格式，先写 ADR
```

当前 API：

```text
GET  /api/planning-adapters      查询 mock 与云端 Planner 状态
POST /api/action-groups          从锚点、动作意图和目标时长创建动作/互动组
```

当前待办是把原始 JSON 历史改成作者可读的逐帧时间表，并修正“从上一状态到当前状态”的过渡语义。详细拆分见 [任务看板](docs/TASKS.md) 中的 `UI-010`。

## 开发与验证

开始修改前先阅读 `AGENTS.md`，然后依次阅读项目上下文、任务看板和相关 ADR，并在任务看板登记负责人和文件范围。

```powershell
pnpm typecheck
pnpm build
.venv\Scripts\python.exe -m unittest discover -s tests -v
```

开发模型适配器时，测试默认使用 mock。只有任务明确要求真实联调、调用范围和预计费用均已确认时，才使用自己的 Key 发起云调用。

## 常见问题

### 页面能打开，但生成按钮没有结果

确认后端在 8000 端口运行，访问 `/api/health` 和 `/api/generation-adapters`。适配器显示未配置时，检查 `.env` 变量名并重启后端。

### 图片或视频返回后看不到

确认 `/generated-media/...` 能返回 200。生成结果位于 `work/generations/`，不要清理该目录，否则历史记录仍在但本地媒体会丢失。

### `WinError 10013`

通常表示端口被占用或 Windows 拒绝监听。检查 5173/8000 是否已有旧进程；不要同时启动多个后端。

### 动态蒙版选中了背景

视频传播以首关键帧蒙版为种子。先在关键帧中用排除点或橡皮去掉背景，再重新生成动态蒙版。

### 6 GB 显存够吗

SAM 2.1 Tiny 的当前低显存分块路径已验证可用。云端 Wan/Qwen 不占本机显存；不要在同一块 6 GB 显卡上同时运行多个本地生成大模型。

## 安全与成本

- 永远不要提交 `.env`、API Key、模型权重或 `work/generations/`。
- Key 如果曾出现在聊天、截图或提交记录中，应立即去控制台轮换。
- 候选预览与采用是两个操作；预览历史不应重复调用模型。
- 动态蒙版可本地重新生成，不需要再次调用付费视频模型。
- 模型价格与免费额度不是项目常量，真实调用前在自己的控制台确认。

第一阶段的成功标准不是做出完整剪辑软件，而是证明：锁定背景不漂移、人物与物品交互可信、失败区间可以局部重做，并且资产与已付费生成结果能够复用。
