from pathlib import Path
from threading import Lock
import base64, io

class LocalSam2Segmenter:
    def __init__(self, root: Path):
        self.root=root; self.checkpoint=root/"work/models/sam2/sam2.1_hiera_tiny.pt"; self._predictor=None; self._lock=Lock()

    def status(self):
        try:
            import torch
            installed=True; cuda=torch.cuda.is_available(); device=torch.cuda.get_device_name(0) if cuda else "CPU"
        except Exception:
            installed=False; cuda=False; device="unavailable"
        return {"installed":installed,"checkpoint":self.checkpoint.exists(),"cuda":cuda,"device":device,"variant":"sam2.1-hiera-tiny"}

    def _get(self):
        if self._predictor is None:
            with self._lock:
                if self._predictor is None:
                    import torch
                    from sam2.build_sam import build_sam2
                    from sam2.sam2_image_predictor import SAM2ImagePredictor
                    device="cuda" if torch.cuda.is_available() else "cpu"
                    model=build_sam2("configs/sam2.1/sam2.1_hiera_t.yaml",str(self.checkpoint),device=device)
                    self._predictor=SAM2ImagePredictor(model)
        return self._predictor

    def release(self):
        with self._lock:
            self._predictor=None
            try:
                import torch
                if torch.cuda.is_available(): torch.cuda.empty_cache()
            except Exception:
                pass

    def segment(self, image_bytes: bytes, points: list[tuple[float,float]], labels: list[int], box=None) -> bytes:
        import numpy as np, torch
        from PIL import Image
        image=np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB")); h,w=image.shape[:2]
        coords=np.asarray([[x*w,y*h] for x,y in points],dtype=np.float32) if points else None
        labs=np.asarray(labels,dtype=np.int32) if labels else None
        pixel_box=np.asarray([box[0]*w,box[1]*h,box[2]*w,box[3]*h],dtype=np.float32) if box else None
        predictor=self._get()
        with torch.inference_mode(), torch.autocast("cuda",dtype=torch.bfloat16,enabled=torch.cuda.is_available()):
            predictor.set_image(image); masks,scores,_=predictor.predict(point_coords=coords,point_labels=labs,box=pixel_box,multimask_output=True)
        mask=(masks[int(scores.argmax())]*255).astype("uint8")
        output=io.BytesIO(); Image.fromarray(mask,"L").save(output,format="PNG"); return output.getvalue()
