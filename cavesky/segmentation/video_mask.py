from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable


class VideoMaskPropagator:
    def __init__(self, root: Path, checkpoint: Path) -> None:
        self.root = root.resolve()
        self.checkpoint = checkpoint
        self._predictor = None

    def _ffmpeg(self, name: str) -> str:
        executable = shutil.which(name)
        if executable:
            return executable
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            sibling = Path(ffmpeg).with_name(f"{name}.exe")
            if sibling.exists():
                return str(sibling)
        raise RuntimeError(f"{name} is required for video mask propagation")

    def _get_predictor(self):
        if self._predictor is None:
            import torch
            from sam2.build_sam import build_sam2_video_predictor

            device = "cuda" if torch.cuda.is_available() else "cpu"
            self._predictor = build_sam2_video_predictor(
                "configs/sam2.1/sam2.1_hiera_t.yaml",
                str(self.checkpoint),
                device=device,
            )
        return self._predictor

    def propagate(
        self,
        video_path: Path,
        initial_mask_path: Path,
        output_path: Path,
        *,
        max_width: int = 640,
        chunk_frames: int = 16,
        progress: Callable[[int, str], None] | None = None,
    ) -> dict[str, object]:
        import numpy as np
        import torch
        from PIL import Image

        if not video_path.is_file() or not initial_mask_path.is_file():
            raise FileNotFoundError("Video or initial mask does not exist")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        ffmpeg = self._ffmpeg("ffmpeg")
        ffprobe = self._ffmpeg("ffprobe")
        probe = json.loads(subprocess.check_output([
            ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=avg_frame_rate", "-of", "json", str(video_path),
        ], text=True, encoding="utf-8"))
        rate = probe["streams"][0].get("avg_frame_rate") or "30/1"

        with tempfile.TemporaryDirectory(prefix="cavesky-mask-") as temporary:
            temp = Path(temporary)
            frames = temp / "frames"
            masks = temp / "masks"
            frames.mkdir(); masks.mkdir()
            subprocess.run([
                ffmpeg, "-y", "-i", str(video_path), "-vf",
                f"scale='min({max_width},iw)':-2", "-q:v", "2", str(frames / "%05d.jpg"),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            frame_paths = sorted(frames.glob("*.jpg"))
            if not frame_paths:
                raise RuntimeError("Video contains no readable frames")
            width, height = Image.open(frame_paths[0]).size
            anchor = np.asarray(Image.open(initial_mask_path).convert("L").resize((width, height), Image.Resampling.NEAREST)) > 127
            predictor = self._get_predictor()
            total = len(frame_paths)

            for start in range(0, total, max(2, chunk_frames)):
                chunk = frame_paths[start:start + max(2, chunk_frames)]
                chunk_dir = temp / f"chunk-{start:05d}"
                chunk_dir.mkdir()
                for index, source in enumerate(chunk):
                    shutil.copy2(source, chunk_dir / f"{index:05d}.jpg")
                state = predictor.init_state(
                    video_path=str(chunk_dir),
                    offload_video_to_cpu=True,
                    offload_state_to_cpu=True,
                    async_loading_frames=False,
                )
                predictor.add_new_mask(state, frame_idx=0, obj_id=1, mask=anchor)
                last_mask = anchor
                with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=torch.cuda.is_available()):
                    for local_index, _, logits in predictor.propagate_in_video(state):
                        mask = (logits[0] > 0).detach().cpu().numpy().squeeze().astype("uint8") * 255
                        Image.fromarray(mask, "L").save(masks / f"{start + local_index + 1:05d}.png")
                        last_mask = mask > 127
                anchor = last_mask
                predictor.reset_state(state)
                del state
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                if progress:
                    progress(min(95, round((start + len(chunk)) / total * 95)), f"Propagated {min(start+len(chunk), total)}/{total} frames")

            subprocess.run([
                ffmpeg, "-y", "-framerate", rate, "-i", str(masks / "%05d.png"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", str(output_path),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"frames": total, "width": width, "height": height, "fps": rate}
