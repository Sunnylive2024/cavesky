# CaveSky 朋友接手与本地启动指南

这份指南面向第一次拉取 CaveSky 的协作者。目标是先用自己的阿里云百炼业务空间跑通云端规划、关键帧和过渡视频，再按需要安装本地 SAM 蒙版。

## 先知道仓库里没有什么

GitHub 仓库不包含：

- API Key 和个人 `.env`；
- Python 虚拟环境、Node 依赖；
- PyTorch、CUDA 和 SAM 2.1 权重；
- `work/generations/` 中已经付费生成的图片、视频和动态蒙版。

镜头 JSON 可能保留创建者本机的媒体相对地址，但克隆者不会自动得到对应文件。不要把“历史记录存在”误认为媒体已经随 Git 下载。

## 需要准备

- Windows 10/11；
- Git；
- Python 3.12 或更新版本；
- Node.js 20 或更新版本；
- pnpm；
- FFmpeg 和 FFprobe，并能从终端直接运行；
- 自己的阿里云百炼业务空间、API Key 和可用额度。

仅使用云端模型不要求 NVIDIA 显卡。本地智能蒙版才需要额外安装 PyTorch、SAM 2 和权重。

## 1. 克隆和安装基础环境

```powershell
git clone <CaveSky GitHub 地址>
Set-Location cavesky

python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
pnpm install
```

如果 PowerShell 禁止激活脚本，可以只在后续命令中直接使用 `.venv\Scripts\python.exe`。

## 2. 配置一个百炼 Key

在百炼控制台确认自己的业务空间能够访问：

- `wan2.7-image`：关键帧图片；
- `wan2.7-i2v-2026-04-25`：首尾帧过渡视频；
- `qwen-flash`：动作规划语言模型。

复制环境示例：

```powershell
Copy-Item .env.example .env
```

填写 `.env`：

```dotenv
# 图片和视频使用百炼原生 DashScope 地址
CAVESKY_ALIYUN_BASE_URL=https://你的业务空间域名.cn-beijing.maas.aliyuncs.com/api/v1
CAVESKY_QWEN_API_KEY=你的Key
CAVESKY_WAN_API_KEY=你的Key
CAVESKY_KEYFRAME_IMAGE_MODEL=wan2.7-image
CAVESKY_WAN_27_VIDEO_MODEL=wan2.7-i2v-2026-04-25

# 动作规划使用 OpenAI 兼容地址
CAVESKY_PLANNER_BASE_URL=https://你的业务空间域名.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
CAVESKY_PLANNER_API_KEY=你的Key
CAVESKY_PLANNER_MODEL=qwen-flash
```

同一个业务空间 Key 可以复用在三个 Key 变量中，条件是它具有三个模型的权限。原生 `/api/v1` 与兼容 `/compatible-mode/v1` 是两个不同入口，不能只配置其中一个地址。

不要把 `.env` 上传 Git，不要把 Key 写进前端或镜头 JSON。Key 如果出现在聊天、截图或提交记录中，应立即去控制台轮换。

## 3. 启动项目

打开两个 PowerShell 窗口。

后端：

```powershell
Set-Location <仓库目录>
.venv\Scripts\python.exe -m uvicorn cavesky.api:app --reload --host 127.0.0.1 --port 8000
```

前端：

```powershell
Set-Location <仓库目录>
pnpm dev
```

打开 `http://127.0.0.1:5173/`。

不要同时启动多个后端。如果出现 `WinError 10013` 或端口占用，先关闭旧的 5173/8000 进程。

## 4. 启动后检查

依次访问：

- `http://127.0.0.1:8000/api/health`；
- `http://127.0.0.1:8000/api/generation-adapters`；
- `http://127.0.0.1:8000/api/planning-adapters`；
- `http://127.0.0.1:8000/api/segmentation/status`。

关键帧、Wan 2.7 和 Planner 应显示已配置。SAM 未安装时显示未配置是正常的，不影响云端规划、图片和视频流程。

## 5. 不花钱的首次验证

先运行测试：

```powershell
.venv\Scripts\python.exe -m unittest discover -s tests -v
pnpm typecheck
pnpm build
```

在编辑器中优先使用 `mock` Planner 检查动作组创建，不要一上来就调用图片或视频模型。真实调用前确认模型、首尾图、请求秒数、预计费用和是否存在相同历史任务。

## 6. 可选：安装本地 SAM 2.1 Tiny

需要智能蒙版和动态视频蒙版时：

1. 安装适合本机 CUDA 的 PyTorch；CPU 也可运行但会更慢。
2. 安装 Meta 官方 `segment-anything-2`。
3. 下载 `sam2.1_hiera_tiny.pt`。
4. 放到：

```text
work/models/sam2/sam2.1_hiera_tiny.pt
```

重新启动后端，然后检查 `/api/segmentation/status`。项目已在 RTX 3060 6 GB 上验证 SAM 2.1 Tiny；当前动态传播使用 512 像素宽代理、16 帧分块和一帧重叠。

动态蒙版是本地处理，可以反复重新生成，不会再次产生百炼视频费用。剧烈运动仍可能跟丢，应先在动态蒙版视图定位问题帧。

## 7. 当前推荐制作流程

1. 导入背景、人物和物品。
2. 创建并描述锚点关键帧，描述当前画面，不要把后续动作混进去。
3. 填写动作意图和时长，调用 Planner 生成动作组。
4. 检查规划状态和尾边界。
5. 生成两个尾帧候选，预览后采用一个。
6. 检查 Wan 提交预览和费用，确认后生成整组视频。
7. 采用视频后，用首帧蒙版生成动态蒙版。
8. 分别检查镜头合成、仅动作/互动层、动态蒙版和生成原视频。
9. 对失败结果保存拒绝原因；不要为了预览重复提交付费任务。

## 8. 常见问题

### 模型显示未配置

确认 `.env` 位于仓库根目录、变量名正确，并重启后端。检查业务空间域名和 Key 是否属于同一个空间。

### 规划可以用，但图片或视频不行

Planner 使用兼容地址，图片和视频使用原生地址。分别检查两个 Base URL，以及业务空间是否开通目标模型。

### 镜头有记录但图片或视频打不开

生成媒体位于创建者本机被 Git 忽略的 `work/generations/`。请使用自己的模型重新生成，或向创建者索取经过许可的独立媒体包。

### 蒙版黑色区域没有透明

刷新到最新前端。当前实现会把白色转为保留、黑色转为透明，并兼容已有灰度蒙版。旧蒙版可以载入后重新保存为带透明通道的 PNG。

### 动态蒙版剧烈运动时跟丢

先区分是播放器同步还是 SAM 跟踪：暂停在同一帧并切换“动态蒙版”查看。若蒙版本身错误，需要重新传播或后续使用关键帧修正；动态传播不消耗云端额度。

## 9. 协作规则

- 开始修改前执行 `git status --short`，不要覆盖其他人的未提交改动。
- 不执行破坏性 Git 操作清除未知改动。
- 不提交 `.env`、模型权重、虚拟环境、依赖目录和生成媒体。
- 默认使用 mock 完成自动测试；真实模型调用必须由使用者确认费用。
- 当前任务和高冲突文件以 [任务看板](TASKS.md) 为准。
