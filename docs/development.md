# 本地开发

## 前端

```powershell
pnpm install
pnpm dev
```

编辑器默认运行在 `http://localhost:5173`。

## 后端

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
python -m uvicorn cavesky.api:app --reload
```

API 默认运行在 `http://127.0.0.1:8000`，交互文档位于 `/docs`。

## 检查

```powershell
pnpm typecheck
pnpm build
python -m unittest discover -s tests -v
```

当前的“生成过渡”使用模拟适配器，只验证请求、状态和版本流程，不会输出真实媒体。

## 云模型密钥

云模型密钥只配置在本地后端进程中，不写入前端、镜头工程、生成记录或 Git：

```powershell
$env:QWEN_API_KEY="..."
$env:DASHSCOPE_API_KEY="..."
$env:VOLCENGINE_API_KEY="..."
python -m uvicorn cavesky.api:app --reload
```

也可以在本机使用已被 `.gitignore` 排除的 `.env` 文件，但应用接入具体 Adapter 时才会增加相应的读取逻辑。前端只发送通用任务和 Adapter ID；后端 Adapter 负责供应商鉴权、素材上传、状态轮询、错误归一化和结果下载。
