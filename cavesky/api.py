from pathlib import Path
import os
import hashlib
import json
from datetime import datetime, timezone

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import shutil
from uuid import uuid4

from .adapters import (
    AdapterCapability,
    AdapterNotFoundError,
    AdapterRegistry,
    MockGenerationAdapter,
    QwenImageAdapter,
    TransitionTask,
    Wan27ImageToVideoAdapter,
    WanKeyframeVideoAdapter,
    load_local_env,
)
from .jobs import InMemoryJobStore
from .models import Canvas, GenerationJob, GenerationRequest, Layer, Shot
from .repository import ShotRepository
from .segmentation import LocalSam2Segmenter, VideoMaskPropagator
from .planning import (
    ElementContext,
    MockPlanner,
    OpenAICompatPlanner,
    PlanRequest,
    PlannerCapability,
    PlannerError,
    PlannerNotFoundError,
    PlannerNotConfiguredError,
    PlannerRegistry,
    compile_action_group_prompt,
    create_action_group,
)

ROOT = Path(__file__).resolve().parents[1]
load_local_env(ROOT / ".env")
repository = ShotRepository(ROOT / "examples" / "pickup-cup" / "shots")
asset_root = ROOT / "examples" / "pickup-cup" / "assets"
source_asset_root = ROOT / "zichang"
asset_root.mkdir(parents=True, exist_ok=True)
jobs = InMemoryJobStore()
generated_media_root = ROOT / "work" / "generations"
generated_media_root.mkdir(parents=True, exist_ok=True)
segmenter = LocalSam2Segmenter(ROOT)
video_masker = VideoMaskPropagator(ROOT, segmenter.checkpoint)
video_mask_jobs: dict[str, dict[str, object]] = {}
aliyun_base_url = os.getenv(
    "CAVESKY_ALIYUN_BASE_URL",
    "https://dashscope.aliyuncs.com/api/v1",
)
adapters = AdapterRegistry(
    [
        MockGenerationAdapter(),
        QwenImageAdapter(
            root=ROOT,
            base_url=aliyun_base_url,
            api_key=os.getenv("CAVESKY_QWEN_API_KEY"),
            adapter_id="wan-image",
            model=os.getenv("CAVESKY_KEYFRAME_IMAGE_MODEL", os.getenv("CAVESKY_QWEN_IMAGE_MODEL", "wan2.7-image")),
        ),
        QwenImageAdapter(
            root=ROOT,
            base_url=aliyun_base_url,
            api_key=os.getenv("CAVESKY_QWEN_API_KEY"),
            adapter_id="qwen-image",
            model=os.getenv("CAVESKY_QWEN_IMAGE_MODEL", "qwen-image-3.0-pro"),
        ),
        WanKeyframeVideoAdapter(
            root=ROOT,
            base_url=aliyun_base_url,
            api_key=os.getenv("CAVESKY_WAN_API_KEY"),
            model=os.getenv("CAVESKY_WAN_VIDEO_MODEL", "wan2.2-kf2v-flash"),
        ),
        Wan27ImageToVideoAdapter(
            root=ROOT,
            base_url=aliyun_base_url,
            api_key=os.getenv("CAVESKY_WAN_API_KEY"),
            model=os.getenv("CAVESKY_WAN_27_VIDEO_MODEL", "wan2.7-i2v-2026-04-25"),
        ),
    ]
)

planners = PlannerRegistry(
    [
        MockPlanner(),
        OpenAICompatPlanner(
            base_url=os.getenv("CAVESKY_PLANNER_BASE_URL"),
            api_key=os.getenv("CAVESKY_PLANNER_API_KEY"),
            model=os.getenv("CAVESKY_PLANNER_MODEL", "qwen-flash"),
        ),
    ]
)

app = FastAPI(title="CaveSky Local API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/assets", StaticFiles(directory=asset_root), name="assets")
app.mount("/generated-media", StaticFiles(directory=generated_media_root), name="generated-media")
if source_asset_root.exists():
    app.mount("/source-assets", StaticFiles(directory=source_asset_root), name="source-assets")


class AssetRecord(BaseModel):
    id: str
    name: str
    kind: str
    url: str


class KeyframeGenerationRequest(BaseModel):
    shotId: str
    targetType: str
    targetId: str
    keyframeId: str
    instruction: str
    referenceImages: list[str] = Field(default_factory=list)
    candidateCount: int = 2
    promptExtend: bool = False
    adapter: str = "wan-image"


class AcceptKeyframeGenerationRequest(BaseModel):
    jobId: str
    shotId: str | None = None
    outputIndex: int = 0


class RevertKeyframeGenerationRequest(BaseModel):
    shotId: str
    generationId: str


class AcceptTransitionGenerationRequest(BaseModel):
    jobId: str
    shotId: str | None = None


class SaveMaskRequest(BaseModel):
    shotId: str
    targetType: str
    targetId: str
    keyframeId: str
    dataUrl: str

class SegmentationRequest(BaseModel):
    imageUri: str
    points: list[list[float]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    box: list[float] | None = None

class VideoMaskRequest(BaseModel):
    shotId: str
    generationId: str
    maxWidth: int = Field(default=640, ge=320, le=960)
    chunkFrames: int = Field(default=16, ge=4, le=48)

class VideoFrameExtractionRequest(BaseModel):
    shotId:str
    groupId:str
    keyframeId:str
    generationId:str

class GenerationReviewRequest(BaseModel):
    shotId:str
    generationId:str
    decision:str
    identityConsistent:bool
    handednessConsistent:bool
    limbsValid:bool
    backgroundStable:bool
    speedNatural:bool
    rejectionReason:str|None=None

class ActionGroupRequest(BaseModel):
    shotId: str
    anchorKeyframeId: str
    memberIds: list[str] = Field(default_factory=list)
    actionIntent: str
    planner: str = "mock"
    embellishment: float = Field(default=0.3, ge=0, le=1)
    desiredDurationFrames: int | None = Field(default=None, gt=0)

@app.get("/api/segmentation/status")
def segmentation_status(): return segmenter.status()

@app.post("/api/segmentation/predict")
def segmentation_predict(request: SegmentationRequest):
    if len(request.points)!=len(request.labels) or (not request.points and not request.box): raise HTTPException(422,"At least one point or box is required")
    uri = request.imageUri
    if uri.startswith("/generated-media/"):
        path = (generated_media_root / uri.split("/")[-1]).resolve()
    elif uri.startswith("/source-assets/"):
        path = (source_asset_root / uri.split("/")[-1]).resolve()
    elif uri.startswith("/assets/"):
        path = (asset_root / uri.split("/")[-1]).resolve()
    else:
        path = (ROOT / uri.lstrip("/")).resolve()
    if not path.exists(): raise HTTPException(404,"Image not found")
    try: png=segmenter.segment(path.read_bytes(),[(p[0],p[1]) for p in request.points],request.labels,request.box)
    except Exception as error: raise HTTPException(500,f"Local segmentation failed: {error}") from error
    name=f"sam-mask-{uuid4().hex}.png"; (generated_media_root/name).write_bytes(png); return {"uri":f"/generated-media/{name}"}

def find_keyframe_at(shot: Shot, group, frame: int):
    for keyframe in group.keyframes:
        if keyframe.frame == frame:
            return keyframe
    if group.anchorKeyframeId:
        for element in shot.elements:
            for keyframe in element.keyframes:
                if keyframe.id == group.anchorKeyframeId and keyframe.frame == frame:
                    return keyframe
    return None


def run_video_mask_job(job_id: str, request: VideoMaskRequest) -> None:
    job=video_mask_jobs[job_id];job.update({"status":"running","progress":1,"message":"Preparing video frames"})
    try:
        shot=repository.get(request.shotId)
        generation=next(item for item in shot.generations if item.get("id")==request.generationId)
        transition=next(item for item in shot.transitions if item.selectedGenerationId==request.generationId)
        if transition.targetType!="interactionGroup": raise ValueError("Video masks currently require an interaction group")
        group=next(item for item in shot.interactionGroups if item.id==transition.targetId)
        first_keyframe=find_keyframe_at(shot, group, transition.fromFrame)
        if not first_keyframe or not first_keyframe.mask: raise ValueError("The first interaction keyframe needs a saved mask")
        outputs=generation.get("outputs") or ([generation["output"]] if generation.get("output") else [])
        if not outputs: raise ValueError("Transition generation has no source video")
        video_path=(generated_media_root/Path(str(outputs[0])).name).resolve()
        mask_path=(generated_media_root/Path(first_keyframe.mask).name).resolve()
        output_path=generated_media_root/f"video-mask-{request.generationId}-{uuid4().hex[:8]}.mp4"
        last_frame_png=generated_media_root/f"mask-{request.generationId}-last-{uuid4().hex[:8]}.png"
        segmenter.release()
        metadata=video_masker.propagate(video_path,mask_path,output_path,max_width=request.maxWidth,chunk_frames=request.chunkFrames,progress=lambda value,message:job.update({"progress":value,"message":message}),last_frame_path=last_frame_png)
        generation.update({"maskOutput":f"/generated-media/{output_path.name}","maskMetadata":metadata})
        next_keyframe=find_keyframe_at(shot, group, transition.toFrame)
        if next_keyframe is not None and last_frame_png.is_file():
            next_keyframe.mask=f"/generated-media/{last_frame_png.name}"
        repository.save(shot)
        job.update({"status":"succeeded","progress":100,"message":"Dynamic video mask generated","maskUri":generation["maskOutput"]})
    except Exception as error:
        job.update({"status":"failed","progress":100,"message":str(error) or repr(error)})

@app.post("/api/video-mask-jobs", status_code=202)
def create_video_mask_job(request: VideoMaskRequest, background_tasks: BackgroundTasks):
    try:
        shot=repository.get(request.shotId)
    except FileNotFoundError as error:
        raise HTTPException(404,"Shot not found") from error
    generation=next((item for item in shot.generations if item.get("id")==request.generationId),None)
    if not generation or generation.get("type")!="transition" or generation.get("status")!="accepted": raise HTTPException(422,"An accepted transition generation is required")
    transition=next((item for item in shot.transitions if item.selectedGenerationId==request.generationId),None)
    if not transition: raise HTTPException(422,"The transition generation must be the currently selected version")
    if transition.targetType!="interactionGroup": raise HTTPException(422,"Video masks currently require an interaction transition")
    job_id=f"VMASK_{uuid4().hex[:10].upper()}";job={"id":job_id,"status":"queued","progress":0,"message":"Video mask queued","generationId":request.generationId};video_mask_jobs[job_id]=job
    background_tasks.add_task(run_video_mask_job,job_id,request)
    return job

@app.get("/api/video-mask-jobs/{job_id}")
def get_video_mask_job(job_id: str):
    job=video_mask_jobs.get(job_id)
    if not job: raise HTTPException(404,"Video mask job not found")
    return job


@app.post("/api/video-frame-extractions",response_model=Shot)
def extract_accepted_video_frame(request:VideoFrameExtractionRequest)->Shot:
    shot=repository.get(request.shotId)
    group=next((item for item in shot.interactionGroups if item.id==request.groupId),None)
    if group is None:raise HTTPException(422,"Action group not found")
    keyframe=next((item for item in group.keyframes if item.id==request.keyframeId),None)
    if keyframe is None:raise HTTPException(422,"Action state not found")
    generation=next((item for item in shot.generations if item.get("id")==request.generationId and item.get("status")=="accepted"),None)
    if generation is None:raise HTTPException(422,"An accepted video generation is required")
    transition=next((item for item in shot.transitions if item.id==generation.get("transitionId") and item.targetId==group.id and item.fromFrame<=keyframe.frame<=item.toFrame),None)
    if transition is None:raise HTTPException(422,"The accepted video does not cover this state")
    outputs=generation.get("outputs") or ([generation.get("output")] if generation.get("output") else [])
    if not outputs:raise HTTPException(422,"Accepted generation has no video")
    source=(generated_media_root/Path(str(outputs[0])).name).resolve()
    destination=generated_media_root/f"frame-{generation['id']}-{keyframe.id}-{uuid4().hex[:8]}.png"
    try:video_masker.extract_frame(source,destination,(keyframe.frame-transition.fromFrame)/(transition.toFrame-transition.fromFrame))
    except Exception as error:raise HTTPException(500,f"Video frame extraction failed: {error}") from error
    keyframe.image=f"/generated-media/{destination.name}"
    keyframe.renderPolicy="extractFromVideo";keyframe.sourceKind="acceptedVideoFrame";keyframe.locked=True
    keyframe.state["sourceGenerationId"]=generation["id"]
    repository.save(shot)
    return shot


@app.post("/api/generation-reviews",response_model=Shot)
def review_generation(request:GenerationReviewRequest)->Shot:
    if request.decision not in {"accepted","rejected"}:raise HTTPException(422,"Review decision must be accepted or rejected")
    if request.decision=="rejected" and not (request.rejectionReason or "").strip():raise HTTPException(422,"Rejected generation needs a reason")
    shot=repository.get(request.shotId)
    generation=next((item for item in shot.generations if item.get("id")==request.generationId),None)
    if generation is None:raise HTTPException(404,"Generation history not found")
    generation["qualityReview"]={"decision":request.decision,"identityConsistent":request.identityConsistent,"handednessConsistent":request.handednessConsistent,"limbsValid":request.limbsValid,"backgroundStable":request.backgroundStable,"speedNatural":request.speedNatural,"rejectionReason":request.rejectionReason}
    if request.decision=="rejected":generation["status"]="rejected"
    repository.save(shot);return shot


def read_assets() -> list[AssetRecord]:
    manifest = asset_root / "assets.json"
    if not manifest.exists():
        return []
    return [AssetRecord.model_validate(item) for item in __import__("json").loads(manifest.read_text(encoding="utf-8"))]


def write_assets(assets: list[AssetRecord]) -> None:
    import json
    (asset_root / "assets.json").write_text(
        json.dumps([item.model_dump() for item in assets], ensure_ascii=False, indent=2), encoding="utf-8"
    )


@app.post("/api/masks", response_model=Shot)
def save_mask(request: SaveMaskRequest) -> Shot:
    import base64
    if not request.dataUrl.startswith("data:image/png;base64,"):
        raise HTTPException(status_code=422, detail="Mask must be a PNG data URL")
    try:
        encoded = request.dataUrl.split(",", 1)[1]
        mask_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise HTTPException(status_code=422, detail="Mask data is invalid") from error
    if len(mask_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=422, detail="Mask exceeds 10 MB")
    shot = repository.get(request.shotId)
    if request.targetType == "interactionGroup":
        target = next((item for item in shot.interactionGroups if item.id == request.targetId), None)
    elif request.targetType == "element":
        target = next((item for item in shot.elements if item.id == request.targetId), None)
    else:
        raise HTTPException(status_code=422, detail="Unsupported mask target type")
    if target is None:
        raise HTTPException(status_code=422, detail="Mask target not found")
    keyframe = next((item for item in target.keyframes if item.id == request.keyframeId), None)
    if keyframe is None:
        raise HTTPException(status_code=422, detail="Mask keyframe not found")
    filename = f"mask-{shot.id}-{request.targetId}-{request.keyframeId}-{uuid4().hex[:8]}.png"
    (generated_media_root / filename).write_bytes(mask_bytes)
    keyframe.mask = f"/generated-media/{filename}"
    keyframe.state["maskSource"] = "manual"
    repository.save(shot)
    return shot


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


@app.get("/api/cloud-health")
def cloud_health() -> dict[str, object]:
    import json
    from urllib.request import Request, urlopen
    api_key = os.getenv("CAVESKY_QWEN_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Keyframe image API key is not configured")
    compatible_url = aliyun_base_url.replace("/api/v1", "/compatible-mode/v1")
    request = Request(f"{compatible_url}/models", headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urlopen(request, timeout=30) as response:
            models = json.loads(response.read().decode("utf-8")).get("data", [])
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Cloud connection failed: {error}") from error
    model_ids = {item.get("id") for item in models}
    image_model = os.getenv("CAVESKY_KEYFRAME_IMAGE_MODEL", os.getenv("CAVESKY_QWEN_IMAGE_MODEL", "wan2.7-image"))
    return {"status": "ok", "modelCount": len(models), "keyframeImageModel": image_model, "keyframeImageAvailable": image_model in model_ids}


@app.get("/api/shots", response_model=list[str])
def list_shots() -> list[str]:
    return repository.list()


class CreateShotRequest(BaseModel):
    id: str
    fps: int = Field(default=24, gt=0, le=120)
    durationFrames: int = Field(default=96, gt=0)
    width: int = Field(default=1280, gt=0)
    height: int = Field(default=720, gt=0)


@app.post("/api/shots", response_model=Shot, status_code=201)
def create_shot(request: CreateShotRequest) -> Shot:
    if request.id in repository.list():
        raise HTTPException(status_code=409, detail="Shot already exists")
    shot = Shot(
        schemaVersion="0.1",
        id=request.id,
        fps=request.fps,
        durationFrames=request.durationFrames,
        canvas=Canvas(width=request.width, height=request.height, backgroundColor="#000000"),
        layers=[
            Layer(id="BG", role="background", order=0, locked=True),
            Layer(id="SHADOW", role="shadow", order=10, locked=False),
            Layer(id="CONTENT", role="content", order=20, locked=False),
            Layer(id="FG", role="foreground", order=30, locked=True),
        ],
        elements=[],
    )
    repository.save(shot)
    return shot


@app.get("/api/shots/{shot_id}", response_model=Shot)
def get_shot(shot_id: str) -> Shot:
    try:
        return repository.get(shot_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Shot not found") from error


@app.put("/api/shots/{shot_id}", response_model=Shot)
def save_shot(shot_id: str, shot: Shot) -> Shot:
    if shot_id != shot.id:
        raise HTTPException(status_code=422, detail="Shot ID does not match route")
    repository.save(shot)
    return shot


@app.get("/api/assets", response_model=list[AssetRecord])
def list_assets() -> list[AssetRecord]:
    return read_assets()


@app.post("/api/assets", response_model=AssetRecord, status_code=201)
def upload_asset(kind: str, file: UploadFile = File(...)) -> AssetRecord:
    if kind not in {"background", "character", "prop", "foreground"}:
        raise HTTPException(status_code=422, detail="Unsupported asset kind")
    suffix = Path(file.filename or "asset.png").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".jfif", ".webp"}:
        raise HTTPException(status_code=422, detail="Only PNG, JPG, JFIF and WebP images are supported")
    asset_id = f"ASSET_{uuid4().hex[:10].upper()}"
    filename = f"{asset_id}{suffix}"
    with (asset_root / filename).open("wb") as output:
        shutil.copyfileobj(file.file, output)
    record = AssetRecord(id=asset_id, name=Path(file.filename or filename).stem, kind=kind, url=f"/assets/{filename}")
    assets = read_assets()
    assets.append(record)
    write_assets(assets)
    return record


@app.post("/api/shots/validate", response_model=Shot)
def validate_shot(shot: Shot) -> Shot:
    return shot


@app.post("/api/generations", response_model=GenerationJob, status_code=202)
def create_generation(request: GenerationRequest, background_tasks: BackgroundTasks) -> GenerationJob:
    try:
        shot = repository.get(request.shotId)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Shot not found") from error
    transition = next((item for item in shot.transitions if item.id == request.transitionId), None)
    if transition is None:
        raise HTTPException(status_code=422, detail="Transition not found in shot")
    if transition.targetType == "interactionGroup":
        group = next(item for item in shot.interactionGroups if item.id == transition.targetId)
        anchor = find_keyframe_at(shot, group, transition.fromFrame)
        tail = find_keyframe_at(shot, group, transition.toFrame)
        if not anchor or not anchor.image or not tail or not tail.image or not tail.locked:
            raise HTTPException(status_code=422, detail="Action group is planned but not video-ready: accepted start and end images are required")
    try:
        adapters.get(request.adapter)
    except AdapterNotFoundError as error:
        raise HTTPException(status_code=422, detail="Generation adapter is not available") from error
    quote = generation_quote(shot, transition, request)
    if request.adapter != "mock":
        if request.confirmationFingerprint != quote["fingerprint"]:
            raise HTTPException(status_code=409, detail={"code":"confirmation_required","quote":quote})
        if quote["durationWarning"] and not request.confirmDurationMismatch:
            raise HTTPException(status_code=409, detail={"code":"duration_confirmation_required","quote":quote})
        active = jobs.find_by_fingerprint(quote["fingerprint"])
        if active and active.status.value in {"queued", "running", "succeeded"}:
            raise HTTPException(status_code=409, detail={"code":"duplicate_generation","jobId":active.id})
        existing = next((record for record in shot.generations if record.get("requestFingerprint") == quote["fingerprint"] and record.get("status") in {"queued","running","succeeded","accepted"}), None)
        if existing:
            raise HTTPException(status_code=409, detail={"code":"duplicate_generation","generationId":existing.get("id")})
    job = jobs.create(request)
    task = TransitionTask(
        shotId=shot.id,
        transitionId=transition.id,
        targetType=transition.targetType,
        targetId=transition.targetId,
        instruction=transition.instruction,
        fromFrame=transition.fromFrame,
        toFrame=transition.toFrame,
        fps=shot.fps,
        width=shot.canvas.width,
        height=shot.canvas.height,
        parameters=request.parameters,
    )
    background_tasks.add_task(jobs.run, job.id, task, adapters)
    return job


def generation_quote(shot: Shot, transition, request: GenerationRequest) -> dict[str, object]:
    timeline_seconds = (transition.toFrame-transition.fromFrame)/shot.fps
    requested = request.parameters.get("duration", max(2, round(timeline_seconds)))
    request_seconds = float(requested)
    if request.adapter == "wan-i2v-2.7" and (not request_seconds.is_integer() or not 2 <= request_seconds <= 15):
        raise HTTPException(status_code=422, detail="Wan 2.7 duration must be an integer from 2 to 15 seconds")
    segment_count = int(request.parameters.get("segmentCount", 1))
    final_prompt = transition.instruction
    if transition.targetType == "interactionGroup":
        group = next(item for item in shot.interactionGroups if item.id == transition.targetId)
        anchor = find_keyframe_at(shot, group, transition.fromFrame)
        guiding = [item for item in group.keyframes if transition.fromFrame < item.frame <= transition.toFrame]
        if anchor:
            final_prompt = compile_action_group_prompt(anchor, guiding, group.instruction)
            transition.instruction = final_prompt
    fingerprint_payload = {"shotId":shot.id,"transitionId":transition.id,"adapter":request.adapter,"parameters":request.parameters,"instruction":final_prompt}
    fingerprint = hashlib.sha256(json.dumps(fingerprint_payload,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest()
    estimated_cost = round(request_seconds*segment_count*0.6,2) if request.adapter == "wan-i2v-2.7" else None
    ratio = max(request_seconds/timeline_seconds,timeline_seconds/request_seconds) if timeline_seconds and request_seconds else float("inf")
    speed_ratio = request_seconds / timeline_seconds if timeline_seconds else float("inf")
    return {"fingerprint":fingerprint,"adapter":request.adapter,"timelineSeconds":round(timeline_seconds,3),"requestSeconds":request_seconds,"segmentCount":segment_count,"estimatedCostCny":estimated_cost,"durationRatio":round(ratio,3),"durationWarning":ratio>2,"playbackSpeedRatio":round(speed_ratio,3),"finalPrompt":final_prompt}


@app.post("/api/generations/quote")
def quote_generation(request: GenerationRequest) -> dict[str, object]:
    try:
        shot=repository.get(request.shotId)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404,detail="Shot not found") from error
    transition=next((item for item in shot.transitions if item.id==request.transitionId),None)
    if transition is None:raise HTTPException(status_code=422,detail="Transition not found in shot")
    try:adapters.get(request.adapter)
    except AdapterNotFoundError as error:raise HTTPException(status_code=422,detail="Generation adapter is not available") from error
    return generation_quote(shot,transition,request)


@app.post("/api/keyframe-generations", response_model=GenerationJob, status_code=202)
def create_keyframe_generation(request: KeyframeGenerationRequest, background_tasks: BackgroundTasks) -> GenerationJob:
    try:
        shot = repository.get(request.shotId)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Shot not found") from error
    if request.targetType == "interactionGroup":
        target = next((item for item in shot.interactionGroups if item.id == request.targetId), None)
    elif request.targetType == "element":
        target = next((item for item in shot.elements if item.id == request.targetId), None)
    else:
        raise HTTPException(status_code=422, detail="Unsupported keyframe target type")
    if target is None:
        raise HTTPException(status_code=422, detail="Keyframe target not found in shot")
    keyframe = next((item for item in target.keyframes if item.id == request.keyframeId), None)
    if keyframe is None:
        raise HTTPException(status_code=422, detail="Keyframe not found in interaction group")
    if not request.instruction.strip():
        raise HTTPException(status_code=422, detail="Keyframe instruction is required")
    if len(request.referenceImages) > 3:
        raise HTTPException(status_code=422, detail="Keyframe image model accepts at most three reference images")
    try:
        selected_adapter = adapters.get(request.adapter)
    except AdapterNotFoundError as error:
        raise HTTPException(status_code=422, detail="Keyframe image adapter is not available") from error
    if "keyframeImage" not in selected_adapter.capability.kinds:
        raise HTTPException(status_code=422, detail="Selected adapter does not generate keyframe images")
    if request.targetType == "interactionGroup":
        job = jobs.create_interaction_keyframe(shot_id=shot.id, group_id=target.id, keyframe_id=keyframe.id, adapter=request.adapter)
        target_type = "interactionGroup"
        preservation = "这是同一镜头中人物与物品的联合关键状态。严格保持身份、服装、物品外观、二维画风、色板、固定机位、构图和未提及内容不变；只改变交互成员完成目标所必需的姿态和接触关系："
    else:
        job = jobs.create_keyframe(shot_id=shot.id, element_id=target.id, keyframe_id=keyframe.id, adapter=request.adapter)
        target_type = "element"
        preservation = "这是同一镜头中单个元素的关键状态编辑。严格保持身份、服装、二维画风、色板、固定机位、背景及其他元素不变；只改变目标元素完成以下状态所必需的内容："
    task = TransitionTask(
        shotId=shot.id,
        transitionId=keyframe.id,
        targetType=target_type,
        targetId=target.id,
        instruction=f"{preservation}{request.instruction.strip()}",
        fromFrame=keyframe.frame,
        toFrame=max(keyframe.frame + 1, 1),
        fps=shot.fps,
        width=shot.canvas.width,
        height=shot.canvas.height,
        parameters={
            "images": request.referenceImages,
            "n": max(1, min(request.candidateCount, 6)),
            "promptExtend": request.promptExtend,
            "negativePrompt": "画风变化，身份变化，服装变化，背景变化，多余人物，多余物体，多余手指，手部畸形，物体复制，镜头变化",
        },
    )
    background_tasks.add_task(jobs.run, job.id, task, adapters)
    return job


def persist_keyframe_job(job: GenerationJob) -> None:
    if job.targetType not in {"keyframe", "interactionKeyframe"} or job.status.value not in {"succeeded", "failed"}:
        return
    shot = repository.get(job.shotId)
    record = next((item for item in shot.generations if item.get("id") == job.id), None)
    payload = {
        "id": job.id,
        "type": job.targetType,
        "targetId": job.targetId,
        "keyframeId": job.keyframeId,
        "adapter": job.adapter,
        "outputs": [item.uri for item in job.outputs if item.kind == "image"],
        "status": job.status.value,
        "message": job.message,
    }
    if record is None:
        shot.generations.append(payload)
    else:
        record.update(payload)
    repository.save(shot)

def persist_transition_job(job: GenerationJob) -> None:
    if job.targetType != "transition" or job.status.value not in {"succeeded", "failed"}: return
    shot=repository.get(job.shotId);transition=next((item for item in shot.transitions if item.id==job.transitionId),None)
    if not transition:return
    record=next((item for item in shot.generations if item.get("id")==job.id),None)
    payload={"id":job.id,"type":"transition","transitionId":transition.id,"targetId":transition.targetId,"adapter":job.adapter,"outputs":[item.uri for item in job.outputs if item.kind=="video"],"status":job.status.value,"message":job.message,"requestFingerprint":job.requestFingerprint}
    if record is None:shot.generations.append(payload)
    else:record.update(payload)
    repository.save(shot)


@app.post("/api/keyframe-generations/accept", response_model=Shot)
def accept_keyframe_generation(request: AcceptKeyframeGenerationRequest) -> Shot:
    try:
        job = jobs.get(request.jobId)
        persist_keyframe_job(job)
        shot = repository.get(job.shotId)
        generation = next(item for item in shot.generations if item.get("id") == job.id)
    except KeyError:
        if not request.shotId:
            raise HTTPException(status_code=404, detail="Generation job is no longer in memory; shotId is required")
        shot = repository.get(request.shotId)
        generation = next((item for item in shot.generations if item.get("id") == request.jobId), None)
        if generation is None:
            raise HTTPException(status_code=404, detail="Generation history not found")
    if generation.get("type") not in {"keyframe", "interactionKeyframe"} or generation.get("status") not in {"succeeded", "accepted", "reverted"}:
        raise HTTPException(status_code=422, detail="Keyframe generation is not ready")
    image_outputs = generation.get("outputs") or ([generation["output"]] if generation.get("output") else [])
    if request.outputIndex < 0 or request.outputIndex >= len(image_outputs):
        raise HTTPException(status_code=422, detail="Output index is invalid")
    target = next((item for item in shot.interactionGroups if item.id == generation.get("targetId")), None) if generation.get("type") == "interactionKeyframe" else next((item for item in shot.elements if item.id == generation.get("targetId")), None)
    if target is None:
        raise HTTPException(status_code=422, detail="Generation target no longer exists")
    keyframe = next((item for item in target.keyframes if item.id == generation.get("keyframeId")), None)
    if keyframe is None:
        raise HTTPException(status_code=422, detail="Generation keyframe no longer exists")
    previous_output = keyframe.image
    keyframe.image = image_outputs[request.outputIndex]
    keyframe.locked = True
    keyframe.state["generatedComposite"] = True
    generation.update({"output": keyframe.image, "previousOutput": previous_output, "status": "accepted"})
    repository.save(shot)
    return shot


@app.post("/api/keyframe-generations/revert", response_model=Shot)
def revert_keyframe_generation(request: RevertKeyframeGenerationRequest) -> Shot:
    shot = repository.get(request.shotId)
    generation = next((item for item in reversed(shot.generations) if item.get("id") == request.generationId), None)
    if generation is None or generation.get("type") not in {"keyframe", "interactionKeyframe"}:
        raise HTTPException(status_code=404, detail="Accepted generation not found")
    targets = shot.interactionGroups if generation["type"] == "interactionKeyframe" else shot.elements
    target = next((item for item in targets if item.id == generation.get("targetId")), None)
    keyframe = next((item for item in target.keyframes if item.id == generation.get("keyframeId")), None) if target else None
    if keyframe is None:
        raise HTTPException(status_code=422, detail="Generation target no longer exists")
    keyframe.image = str(generation.get("previousOutput") or "")
    keyframe.locked = False
    keyframe.state.pop("generatedComposite", None)
    generation["status"] = "reverted"
    repository.save(shot)
    return shot


@app.post("/api/transition-generations/accept", response_model=Shot)
def accept_transition_generation(request: AcceptTransitionGenerationRequest) -> Shot:
    try:
        job = jobs.get(request.jobId)
        persist_transition_job(job)
        shot = repository.get(job.shotId)
        generation = next(item for item in shot.generations if item.get("id") == job.id)
    except KeyError:
        if not request.shotId:
            raise HTTPException(status_code=404, detail="Generation job is no longer in memory; shotId is required")
        shot = repository.get(request.shotId)
        generation = next((item for item in shot.generations if item.get("id") == request.jobId), None)
        if generation is None:
            raise HTTPException(status_code=404, detail="Transition generation history not found")
    if generation.get("type") != "transition" or generation.get("status") not in {"succeeded", "accepted"}:
        raise HTTPException(status_code=422, detail="Transition generation is not ready")
    outputs = generation.get("outputs") or ([generation["output"]] if generation.get("output") else [])
    transition_id = generation.get("transitionId")
    if not outputs or not transition_id:
        raise HTTPException(status_code=422, detail="Transition generation has no video")
    transition = next((item for item in shot.transitions if item.id == transition_id), None)
    if transition is None:
        raise HTTPException(status_code=422, detail="Transition no longer exists")
    transition.selectedGenerationId = str(generation["id"])
    generation.update({"output": outputs[0], "status": "accepted"})
    repository.save(shot)
    return shot


@app.get("/api/generation-adapters", response_model=list[AdapterCapability])
def list_generation_adapters() -> list[AdapterCapability]:
    return adapters.capabilities()


@app.get("/api/generations/{job_id}", response_model=GenerationJob)
def get_generation(job_id: str) -> GenerationJob:
    try:
        job = jobs.get(job_id)
        persist_keyframe_job(job)
        persist_transition_job(job)
        return job
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Generation job not found") from error


def find_anchor(shot: Shot, anchor_keyframe_id: str):
    for element in shot.elements:
        keyframe = next((item for item in element.keyframes if item.id == anchor_keyframe_id), None)
        if keyframe is not None:
            return element, keyframe
    return None, None


def suggest_action_duration_frames(action_intent: str, fps: int) -> int:
    separators = ("然后", "接着", "随后", "并且", "再")
    complexity = sum(action_intent.count(token) for token in separators)
    return round(fps * (3 if complexity >= 2 else 2))


def build_plan_request(shot: Shot, anchor_keyframe, member_ids: list[str], action_intent: str, embellishment: float = 0.3, desired_duration_frames: int | None = None) -> PlanRequest:
    elements_by_id = {element.id: element for element in shot.elements}
    members = [elements_by_id[member_id] for member_id in member_ids if member_id in elements_by_id]
    desired = desired_duration_frames or suggest_action_duration_frames(action_intent, shot.fps)
    common_end = min([shot.durationFrames, *[element.activeRange.end for element in members]])
    target_end = min(common_end, anchor_keyframe.frame + desired)
    if target_end <= anchor_keyframe.frame:
        raise ValueError("members have no room for the requested action duration")
    return PlanRequest(
        shotId=shot.id,
        fps=shot.fps,
        durationFrames=shot.durationFrames,
        desiredDurationFrames=target_end-anchor_keyframe.frame,
        targetEndFrame=target_end,
        modelDurationSeconds=list(range(2, 16)),
        members=[
            ElementContext(id=element.id, kind=element.kind, name=element.name, activeRange=element.activeRange)
            for element in members
        ],
        anchorFrame=anchor_keyframe.frame,
        anchorDescription=anchor_keyframe.instruction or "",
        actionIntent=action_intent,
        embellishment=embellishment,
    )


@app.get("/api/planning-adapters", response_model=list[PlannerCapability])
def list_planning_adapters() -> list[PlannerCapability]:
    return planners.capabilities()


@app.post("/api/action-groups", response_model=Shot)
def create_action_group_endpoint(request: ActionGroupRequest) -> Shot:
    try:
        shot = repository.get(request.shotId)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Shot not found") from error
    anchor_element, anchor_keyframe = find_anchor(shot, request.anchorKeyframeId)
    if anchor_element is None or anchor_keyframe is None:
        raise HTTPException(status_code=422, detail="Anchor keyframe not found in shot")
    if not (anchor_keyframe.instruction or "").strip():
        raise HTTPException(status_code=422, detail="Anchor keyframe needs a description")
    member_ids = list(dict.fromkeys([anchor_element.id, *request.memberIds]))
    missing = [member_id for member_id in member_ids if not any(element.id == member_id for element in shot.elements)]
    if missing:
        raise HTTPException(status_code=422, detail=f"Action group members not found: {missing}")
    if not request.actionIntent.strip():
        raise HTTPException(status_code=422, detail="Action intent is required")
    try:
        planner = planners.get(request.planner)
    except PlannerNotFoundError as error:
        raise HTTPException(status_code=422, detail="Planning adapter is not available") from error
    try:
        plan_request = build_plan_request(shot, anchor_keyframe, member_ids, request.actionIntent, request.embellishment, request.desiredDurationFrames)
        execution = planner.execute(plan_request)
        proposal = execution.proposal
    except PlannerNotConfiguredError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except PlannerError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Planning failed: {error}") from error
    try:
        shot, group_id = create_action_group(shot, anchor_element.id, anchor_keyframe.id, member_ids, proposal, request.actionIntent, plan_request.targetEndFrame)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    shot.planningHistory.append({
        "id": f"PLAN_{uuid4().hex[:10].upper()}", "createdAt": datetime.now(timezone.utc).isoformat(),
        "planner": request.planner, "anchorKeyframeId": anchor_keyframe.id, "groupId": group_id,
        "status": "succeeded", "rawRequest": execution.raw_request, "rawResponse": execution.raw_response,
        "parsedProposal": proposal.model_dump(),
    })
    repository.save(shot)
    return shot
