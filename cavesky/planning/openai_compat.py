from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import PlanExecution, Planner, PlannerError, PlannerNotConfiguredError
from .models import PlannerCapability, PlanProposal, PlanRequest

_SYSTEM_PROMPT = """你是动画分镜的动作规划助手。anchorDescription 是首帧当前可见状态，actionIntent 是首帧之后要发生的动作。你的任务是根据 actionIntent 规划 2–4 个连续的可见关键状态；不要把首帧静态描述误当作动作指令。

只输出一个 JSON 对象，不要输出任何解释、Markdown 或代码块。格式：

{"steps": [{"frame": 整数, "memberIds": ["元素ID"], "stateDescription": "该状态的详细视觉提示词", "transitionDescription": "到下一状态的动作描述，最后一步为 null", "requiresInteractionGroup": 布尔值, "phase": "main|completion|hold", "holdFrames": 整数, "continuity": {"facing":"left|right|front|back|unchanged","activeHand":"left|right|both|none|unchanged","ownership":{},"contacts":[],"supports":[],"wearables":[]}}]}

规则：
- 只拆解 actionIntent 里已经包含的动作，绝对不要编造意图之外的新动作或新剧情。
- stateDescription 要具体、可执行（姿态、朝向、表情、手部等），但不要写冗长咒语。
- 修饰程度 = 输入里的 embellishment（0 = 严格照描述拆分、几乎不加修饰；1 = 可补充合理的姿态、表情、光影细节）。
- 后端已经确定动作组范围。所有 step.frame 必须大于 anchorFrame、不超过 targetEndFrame、逐步递增；最后一个 step 必须恰好等于 targetEndFrame。不得自行延长或缩短动作组。
- desiredDurationFrames 是作者确认的目标长度；modelDurationSeconds 是后续视频模型允许请求的整数秒集合，只用于安排动作节奏，不能改变 targetEndFrame。
- memberIds 只用输入 members 里出现的 id；两个及以上成员发生接触时 requiresInteractionGroup 为 true。
- 必须覆盖 main、completion、hold；hold 通常 12–24 帧，重要情绪或姿态可 18–36 帧。
- 多个完整动词或目标不要挤在同一组；只规划 actionIntent 的第一个主要变化，并保持运动弧线、缓入缓出和屏幕方向。
- 左右手、朝向、物体归属、接触、支撑和穿戴关系必须写入 continuity，不得只写在自然语言里。"""


class OpenAICompatPlanner(Planner):
    """OpenAI-compatible Chat Completions planner.

    Provider-neutral: reads a base URL, API key and model from the caller and
    posts a standard Chat Completions request, then validates the returned JSON
    into a PlanProposal. No raw model response is persisted.
    """

    def __init__(self, *, base_url: str | None, api_key: str | None, model: str, adapter_id: str = "openai-compat") -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.adapter_id = adapter_id

    @property
    def capability(self) -> PlannerCapability:
        return PlannerCapability(
            id=self.adapter_id,
            label=f"OpenAI-compatible planner ({self.model})",
            configured=bool(self.api_key and self.base_url),
        )

    def plan(self, request: PlanRequest) -> PlanProposal:
        return self.execute(request).proposal

    def execute(self, request: PlanRequest) -> PlanExecution:
        if not self.api_key or not self.base_url:
            raise PlannerNotConfiguredError("planning API key or base URL is not configured")

        body = self._build_body(request)
        http_request = Request(
            f"{self.base_url.rstrip('/')}/chat/completions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urlopen(http_request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise PlannerError(f"planning service returned HTTP {error.code}") from error
        except (URLError, TimeoutError) as error:
            raise PlannerError(f"planning service unreachable: {error}") from error
        except json.JSONDecodeError as error:
            raise PlannerError("planning service returned invalid JSON") from error

        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise PlannerError("planning service returned an unexpected response shape") from error

        proposal = parse_plan_proposal(content)
        return PlanExecution(proposal, body, content)

    def _build_body(self, request: PlanRequest) -> dict:
        return {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(request.model_dump(), ensure_ascii=False)},
            ],
            "temperature": 0.2 + 0.8 * request.embellishment,
        }


def parse_plan_proposal(content: str) -> PlanProposal:
    """Parse a model reply into a validated PlanProposal."""
    if not content or not content.strip():
        raise PlannerError("planning service returned empty content")
    try:
        return PlanProposal.model_validate(_extract_json(content))
    except PlannerError:
        raise
    except Exception as error:
        raise PlannerError(f"planning response did not match the expected schema: {error}") from error


def _extract_json(text: str) -> dict:
    cleaned = text.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        return json.loads(cleaned[start : end + 1])
    raise PlannerError("planning response contained no JSON object")
