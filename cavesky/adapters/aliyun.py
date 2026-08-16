from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from ..media import is_remote_or_data, resolve_media_path
from ..models import GenerationError, GenerationOutput
from ..prompting import compile_reference_role_text
from ..references import KeyframeReference
from .base import AdapterCapability, AdapterResult, GenerationAdapter, TransitionTask


def load_local_env(path: Path) -> None:
    """Load a small .env file without adding a runtime dependency."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class AliyunApiError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class AliyunAdapterBase(GenerationAdapter):
    def __init__(self, *, root: Path, base_url: str, api_key: str | None, model: str) -> None:
        self.root = root.resolve()
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.output_root = self.root / "work" / "generations"

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None = None,
        *,
        asynchronous: bool = False,
    ) -> dict[str, object]:
        if not self.api_key:
            raise AliyunApiError("not_configured", "Aliyun API key is not configured")
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if asynchronous:
            headers["X-DashScope-Async"] = "enable"
        request = Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=120) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            response_body = error.read().decode("utf-8", errors="replace")
            try:
                details = json.loads(response_body)
            except json.JSONDecodeError:
                details = {}
            code = str(details.get("code") or f"http_{error.code}")
            message = str(details.get("message") or "Aliyun request failed")
            raise AliyunApiError(code, message, error.code >= 500 or error.code == 429) from error
        except (URLError, TimeoutError) as error:
            raise AliyunApiError("network_error", str(error), True) from error

    def _image_value(self, value: object, parameter_name: str) -> str:
        if not isinstance(value, str) or not value:
            raise AliyunApiError("missing_input", f"{parameter_name} is required")
        if is_remote_or_data(value):
            return value
        try:
            resolved = resolve_media_path(self.root, value)
        except ValueError as error:
            raise AliyunApiError("invalid_input_path", str(error)) from error
        if not resolved.is_file():
            raise AliyunApiError("missing_input", f"{parameter_name} file does not exist")
        if resolved.stat().st_size > 10 * 1024 * 1024:
            raise AliyunApiError("input_too_large", f"{parameter_name} exceeds 10 MB")
        mime_type = mimetypes.guess_type(resolved.name)[0] or "image/png"
        encoded = base64.b64encode(resolved.read_bytes()).decode("ascii")
        return f"data:{mime_type};base64,{encoded}"

    def _download(self, url: str, suffix: str) -> Path:
        self.output_root.mkdir(parents=True, exist_ok=True)
        destination = self.output_root / f"{uuid4().hex}{suffix}"
        try:
            with urlopen(url, timeout=180) as response, destination.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        except (HTTPError, URLError, TimeoutError) as error:
            destination.unlink(missing_ok=True)
            raise AliyunApiError("download_failed", str(error), True) from error
        return destination

    def _error_result(self, error: AliyunApiError) -> AdapterResult:
        return AdapterResult(
            message="Aliyun generation failed",
            error=GenerationError(code=error.code, message=str(error), retryable=error.retryable),
        )


class QwenImageAdapter(AliyunAdapterBase):
    def __init__(self, *, root: Path, base_url: str, api_key: str | None, model: str, adapter_id: str = "qwen-image") -> None:
        super().__init__(root=root, base_url=base_url, api_key=api_key, model=model)
        self.adapter_id = adapter_id

    @property
    def capability(self) -> AdapterCapability:
        return AdapterCapability(
            id=self.adapter_id,
            label=f"Keyframe Image ({self.model})",
            kinds=["keyframeImage"],
            supportsMasks=False,
            supportsFirstLastFrame=False,
            supportsImageReference=True,
            maxReferenceImages=3,
            cameraLockIsSoftHint=True,
            configured=bool(self.api_key and self.base_url),
        )

    def run_transition(self, task: TransitionTask) -> AdapterResult:
        try:
            content: list[dict[str, str]] = []
            references = task.parameters.get("references")
            raw_images = task.parameters.get("images")
            if references is not None:
                if not isinstance(references, list):
                    raise AliyunApiError("invalid_input", "references must be a list")
                if len(references) > self.capability.maxReferenceImages:
                    raise AliyunApiError(
                        "too_many_references",
                        f"adapter accepts at most {self.capability.maxReferenceImages} reference images",
                    )
                for index, raw in enumerate(references):
                    reference = self._coerce_reference(raw, index)
                    content.append({"text": compile_reference_role_text(reference)})
                    content.append({"image": self._image_value(reference.image, f"references[{index}].image")})
            elif raw_images is not None:
                if not isinstance(raw_images, list):
                    raise AliyunApiError("invalid_input", "images must be a list")
                for index, image in enumerate(raw_images or []):
                    content.append({"image": self._image_value(image, f"images[{index}]")})
            content.append({"text": task.instruction})
            parameters: dict[str, object] = {
                "prompt_extend": bool(task.parameters.get("promptExtend", False)),
                "watermark": bool(task.parameters.get("watermark", False)),
                "n": int(task.parameters.get("n", 1)),
            }
            parameters["size"] = task.parameters.get("size", f"{task.width}*{task.height}")
            for source, target in (("negativePrompt", "negative_prompt"), ("seed", "seed")):
                if source in task.parameters:
                    parameters[target] = task.parameters[source]
            response = self._request_json(
                "POST",
                "/services/aigc/multimodal-generation/generation",
                {
                    "model": self.model,
                    "input": {"messages": [{"role": "user", "content": content}]},
                    "parameters": parameters,
                },
            )
            choices = ((response.get("output") or {}).get("choices") or [])  # type: ignore[union-attr]
            outputs: list[GenerationOutput] = []
            for choice in choices:
                for item in choice.get("message", {}).get("content", []):
                    if image_url := item.get("image"):
                        path = self._download(image_url, ".png")
                        outputs.append(GenerationOutput(kind="image", uri=f"/generated-media/{path.name}", mimeType="image/png"))
            if not outputs:
                raise AliyunApiError("empty_output", "Keyframe image model returned no image")
            return AdapterResult(outputs=outputs, message=f"Generated {len(outputs)} keyframe image(s)")
        except AliyunApiError as error:
            return self._error_result(error)

    @staticmethod
    def _coerce_reference(raw: object, index: int) -> KeyframeReference:
        if isinstance(raw, str):
            # Legacy bare image: treat as a generic timeless reference.
            return KeyframeReference(relation="timeless", purpose="continuity", image=raw)
        if isinstance(raw, dict):
            return KeyframeReference.model_validate(raw)
        raise AliyunApiError("invalid_input", f"references[{index}] must be an object or image string")


class WanKeyframeVideoAdapter(AliyunAdapterBase):
    @property
    def capability(self) -> AdapterCapability:
        return AdapterCapability(
            id="wan-kf2v",
            label=f"Wan first/last frame video ({self.model})",
            kinds=["transitionVideo"],
            supportsMasks=False,
            supportsFirstLastFrame=True,
            configured=bool(self.api_key and self.base_url),
        )

    def run_transition(self, task: TransitionTask) -> AdapterResult:
        try:
            first_frame = self._image_value(task.parameters.get("firstImage"), "firstImage")
            last_frame = self._image_value(task.parameters.get("lastImage"), "lastImage")
            generation = self._request_json(
                "POST",
                "/services/aigc/image2video/video-synthesis",
                {
                    "model": self.model,
                    "input": {
                        "first_frame_url": first_frame,
                        "last_frame_url": last_frame,
                        "prompt": task.instruction,
                        **({"negative_prompt": task.parameters["negativePrompt"]} if "negativePrompt" in task.parameters else {}),
                    },
                    "parameters": {
                        "resolution": task.parameters.get("resolution", "480P"),
                        "prompt_extend": bool(task.parameters.get("promptExtend", False)),
                        "watermark": bool(task.parameters.get("watermark", False)),
                        **({"seed": task.parameters["seed"]} if "seed" in task.parameters else {}),
                    },
                },
                asynchronous=True,
            )
            output = generation.get("output") or {}
            task_id = output.get("task_id")  # type: ignore[union-attr]
            if not task_id:
                raise AliyunApiError(str(generation.get("code") or "missing_task_id"), str(generation.get("message") or "Wan returned no task ID"))
            timeout_seconds = int(task.parameters.get("timeoutSeconds", 900))
            poll_seconds = max(2, int(task.parameters.get("pollSeconds", 10)))
            deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < deadline:
                status = self._request_json("GET", f"/tasks/{task_id}")
                result = status.get("output") or {}
                task_status = result.get("task_status")  # type: ignore[union-attr]
                if task_status == "SUCCEEDED":
                    video_url = result.get("video_url")  # type: ignore[union-attr]
                    if not video_url:
                        raise AliyunApiError("empty_output", "Wan returned no video URL")
                    path = self._download(str(video_url), ".mp4")
                    return AdapterResult(
                        outputs=[GenerationOutput(kind="video", uri=f"/generated-media/{path.name}", mimeType="video/mp4")],
                        message="Wan transition video generated",
                    )
                if task_status in {"FAILED", "CANCELED", "UNKNOWN"}:
                    raise AliyunApiError(str(result.get("code") or "generation_failed"), str(result.get("message") or f"Wan task ended with {task_status}"))  # type: ignore[union-attr]
                time.sleep(poll_seconds)
            raise AliyunApiError("generation_timeout", "Wan generation did not finish before the timeout", True)
        except AliyunApiError as error:
            return self._error_result(error)


class Wan27ImageToVideoAdapter(WanKeyframeVideoAdapter):
    @property
    def capability(self) -> AdapterCapability:
        return AdapterCapability(
            id="wan-i2v-2.7",
            label=f"Wan 2.7 first/last frame ({self.model})",
            kinds=["transitionVideo"],
            supportsMasks=False,
            supportsFirstLastFrame=True,
            configured=bool(self.api_key and self.base_url),
        )

    def run_transition(self, task: TransitionTask) -> AdapterResult:
        try:
            first_frame = self._image_value(task.parameters.get("firstImage"), "firstImage")
            last_frame = self._image_value(task.parameters.get("lastImage"), "lastImage")
            duration = max(2, min(15, int(task.parameters.get("duration", round((task.toFrame-task.fromFrame)/task.fps)))))
            generation = self._request_json(
                "POST",
                "/services/aigc/video-generation/video-synthesis",
                {
                    "model": self.model,
                    "input": {
                        "prompt": task.instruction,
                        "media": [
                            {"type": "first_frame", "url": first_frame},
                            {"type": "last_frame", "url": last_frame},
                        ],
                        **({"negative_prompt": task.parameters["negativePrompt"]} if "negativePrompt" in task.parameters else {}),
                    },
                    "parameters": {
                        "resolution": task.parameters.get("resolution", "720P"),
                        "duration": duration,
                        "prompt_extend": bool(task.parameters.get("promptExtend", False)),
                        "watermark": bool(task.parameters.get("watermark", False)),
                    },
                },
                asynchronous=True,
            )
            output = generation.get("output") or {}
            task_id = output.get("task_id")  # type: ignore[union-attr]
            if not task_id:
                raise AliyunApiError(str(generation.get("code") or "missing_task_id"), str(generation.get("message") or "Wan 2.7 returned no task ID"))
            deadline = time.monotonic() + int(task.parameters.get("timeoutSeconds", 900))
            poll_seconds = max(2, int(task.parameters.get("pollSeconds", 10)))
            while time.monotonic() < deadline:
                status = self._request_json("GET", f"/tasks/{task_id}")
                result = status.get("output") or {}
                task_status = result.get("task_status")  # type: ignore[union-attr]
                if task_status == "SUCCEEDED":
                    video_url = result.get("video_url")  # type: ignore[union-attr]
                    if not video_url:
                        raise AliyunApiError("empty_output", "Wan 2.7 returned no video URL")
                    path = self._download(str(video_url), ".mp4")
                    return AdapterResult(outputs=[GenerationOutput(kind="video", uri=f"/generated-media/{path.name}", mimeType="video/mp4")], message=f"Wan 2.7 generated a {duration}s transition video")
                if task_status in {"FAILED", "CANCELED", "UNKNOWN"}:
                    raise AliyunApiError(str(result.get("code") or "generation_failed"), str(result.get("message") or f"Wan 2.7 task ended with {task_status}"))  # type: ignore[union-attr]
                time.sleep(poll_seconds)
            raise AliyunApiError("generation_timeout", "Wan 2.7 generation did not finish before the timeout", True)
        except AliyunApiError as error:
            return self._error_result(error)
