import { ChangeEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Box, Check, Eraser, Eye, Film, ImagePlus, Layers3, LoaderCircle, Lock, MousePointer2, Paintbrush, Pause, Play, Plus, Save, Sparkles, Trash2, Unlock, UserRound, Wand2 } from "lucide-react";
import type { AdapterCapability, Asset, Element, ElementKind, GenerationJob, GenerationQuote, PlannerCapability, Shot, VisualKeyframe } from "./types";

const API = "/api";
const iconFor = (kind: ElementKind) => kind === "character" ? <UserRound size={15}/> : kind === "prop" ? <Box size={15}/> : <Layers3 size={15}/>;
const layerFor = (kind: ElementKind) => kind === "background" ? "BG" : kind === "foreground" ? "FG" : "CONTENT";
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

const compileGroupPrompt = (shot: Shot, group: Shot["interactionGroups"][number]) => {
  const anchor = shot.elements.flatMap((element)=>element.keyframes).find((keyframe)=>keyframe.id===group.anchorKeyframeId);
  const ordered=[anchor,...group.keyframes].filter((item):item is VisualKeyframe=>Boolean(item)).sort((a,b)=>a.frame-b.frame);const total=Math.max(1,ordered.at(-1)!.frame-ordered[0].frame);
  const states=ordered.map((item,index)=>{const relative=(item.frame-ordered[0].frame)/total;const phase=String(item.state.phase??(index===0?"start":"unspecified"));const hold=Number(item.state.holdFrames??0);const transition=String(item.state.transitionToNext??(index===0?"进入动作":"无"));return `${Math.round(relative*100)}%（${phase}）：${item.instruction||"未描述状态"}；到下一状态：${transition}；保持 ${hold} 帧；连续性：${JSON.stringify(item.state.continuity??{})}`});
  return `动作意图：${group.instruction}。按相对时间推进：${states.join("；")}。固定人物身份、左右手、朝向、物体归属、接触/支撑关系、背景与机位。`;
};

const updateGroupTiming = (shot: Shot, groupId:string, keyframeId:string, requestedFrame:number):Shot => {
  const group=shot.interactionGroups.find((item)=>item.id===groupId);if(!group)return shot;
  const anchorOwner=shot.elements.find((element)=>element.keyframes.some((keyframe)=>keyframe.id===group.anchorKeyframeId));
  const anchor=anchorOwner?.keyframes.find((keyframe)=>keyframe.id===group.anchorKeyframeId);if(!anchor||!anchorOwner)return shot;
  const movingAnchor=keyframeId===anchor.id;const oldFrame=movingAnchor?anchor.frame:group.keyframes.find((item)=>item.id===keyframeId)?.frame;if(oldFrame===undefined)return shot;
  const otherFrames=group.keyframes.filter((item)=>item.id!==keyframeId).map((item)=>item.frame);
  const commonEnd=Math.min(...group.members.map((id)=>shot.elements.find((item)=>item.id===id)!.activeRange.end));
  const nextFrame=movingAnchor
    ? Math.max(anchorOwner.activeRange.start,Math.min(commonEnd,group.range.end-1,requestedFrame))
    : Math.max(anchor.frame+1,Math.min(commonEnd,requestedFrame));
  if(otherFrames.includes(nextFrame))return shot;
  const keyframes=group.keyframes.map((item)=>item.id===keyframeId?{...item,frame:nextFrame}:item).sort((a,b)=>a.frame-b.frame);
  const nextRange={start:movingAnchor?nextFrame:anchor.frame,end:Math.max(movingAnchor?nextFrame+1:anchor.frame+1,...keyframes.map((item)=>item.frame))};
  const nextGroup={...group,keyframes,range:nextRange};
  const affectedIds=new Set(shot.transitions.filter((transition)=>transition.targetType==="interactionGroup"&&transition.targetId===groupId).map((transition)=>transition.id));
  return {...shot,
    elements:movingAnchor?shot.elements.map((element)=>element.id===anchorOwner.id?{...element,keyframes:element.keyframes.map((item)=>item.id===anchor.id?{...item,frame:nextFrame}:item).sort((a,b)=>a.frame-b.frame)}:element):shot.elements,
    interactionGroups:shot.interactionGroups.map((item)=>item.id===groupId?nextGroup:item),
    transitions:shot.transitions.map((transition)=>transition.targetType==="interactionGroup"&&transition.targetId===groupId?{...transition,fromFrame:transition.fromFrame===oldFrame?nextFrame:transition.fromFrame,toFrame:transition.toFrame===oldFrame?nextFrame:transition.toFrame,instruction:compileGroupPrompt(shot,nextGroup),selectedGenerationId:null}:transition),
    generations:shot.generations.map((generation)=>generation.transitionId&&affectedIds.has(generation.transitionId)?{...generation,status:"archived"}:generation),
  };
};

export function App() {
  const [shot, setShot] = useState<Shot | null>(null);
  const [shotId, setShotId] = useState("SH002");
  const [shots, setShots] = useState<string[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [playhead, setPlayhead] = useState(24);
  const [status, setStatus] = useState("正在加载镜头…");
  const [assetKind, setAssetKind] = useState<ElementKind>("character");
  const [selectedKeyframe, setSelectedKeyframe] = useState<{ elementId: string; keyframeId: string } | null>(null);
  const [selectedInteractionKeyframe, setSelectedInteractionKeyframe] = useState<{ groupId: string; keyframeId: string } | null>(null);
  const [kfJobs, setKfJobs] = useState<Record<string, GenerationJob>>({});
  const [transitionJobs, setTransitionJobs] = useState<Record<string, GenerationJob>>({});
  const [elementView, setElementView] = useState<"composite"|"layer"|"mask"|"cutout">("composite");
  const [interactionView, setInteractionView] = useState<"composite"|"layer"|"mask"|"cutout">("composite");
  const [maskTool, setMaskTool] = useState<"paint"|"erase">("paint");
  const [maskBrush, setMaskBrush] = useState(28);
  const [maskDirty, setMaskDirty] = useState(false);
  const [samMode,setSamMode]=useState(false);
  const [samPoints,setSamPoints]=useState<Array<{x:number;y:number;label:0|1}>>([]);
  const [samRunning,setSamRunning]=useState(false);
  const [maskUndo,setMaskUndo]=useState<string[]>([]);
  const [previewCandidate, setPreviewCandidate] = useState<{uri:string;index:number;generationId?:string}|null>(null);
  const [lastAcceptedGeneration, setLastAcceptedGeneration] = useState<string|null>(null);
  const [isPlaying,setIsPlaying]=useState(false);
  const [adapterCapabilities,setAdapterCapabilities]=useState<AdapterCapability[]>([]);
  const [imageAdapter,setImageAdapter]=useState("wan-image");
  const [transitionAdapter,setTransitionAdapter]=useState("wan-i2v-2.7");
  const [transitionView,setTransitionView]=useState<"composite"|"layer"|"mask"|"source">("composite");
  const [videoMaskJob,setVideoMaskJob]=useState<{id:string;status:string;progress:number;message:string;maskUri?:string}|null>(null);
  const [planPlanner, setPlanPlanner] = useState("openai-compat");
  const [planning, setPlanning] = useState(false);
  const [plannerCapabilities, setPlannerCapabilities] = useState<PlannerCapability[]>([]);
  const [interactionTargetIds,setInteractionTargetIds]=useState<string[]>([]);
  const [actionIntent,setActionIntent]=useState("");
  const [qualityChecks,setQualityChecks]=useState({identityConsistent:true,handednessConsistent:true,limbsValid:true,backgroundStable:true,speedNatural:true});
  const [rejectionReason,setRejectionReason]=useState("");
  const [embellishment, setEmbellishment] = useState(0.3);
  const [actionDurationFrames,setActionDurationFrames]=useState(48);
  const [pendingGeneration,setPendingGeneration]=useState<{quote:GenerationQuote;payload:{shotId:string;transitionId:string;adapter:string;parameters:Record<string,unknown>};firstImage:string;lastImage:string}|null>(null);
  const pendingGenerationResult=useRef<{resolve:(job:GenerationJob)=>void;reject:(error:Error)=>void}|null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const transitionVideoRef = useRef<HTMLVideoElement>(null);
  const transitionMaskVideoRef = useRef<HTMLVideoElement>(null);
  const transitionCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskEditorRef = useRef<HTMLDivElement>(null);

  const loadShot = async (id: string) => {
    const response = await fetch(`${API}/shots/${id}`);
    if (!response.ok) throw new Error("镜头加载失败");
    setShot(await response.json());
    setShotId(id);
  };

  const load = async () => {
    const [shotsResponse, assetResponse, adapterResponse, plannerResponse] = await Promise.all([fetch(`${API}/shots`), fetch(`${API}/assets`), fetch(`${API}/generation-adapters`), fetch(`${API}/planning-adapters`)]);
    if (!shotsResponse.ok) throw new Error("镜头列表加载失败");
    const ids: string[] = await shotsResponse.json();
    setShots(ids);
    setAssets(assetResponse.ok ? await assetResponse.json() : []);
    if(adapterResponse.ok)setAdapterCapabilities(await adapterResponse.json());
    if(plannerResponse.ok)setPlannerCapabilities(await plannerResponse.json());
    const initial = ids.includes("SH002") ? "SH002" : ids[0];
    if (initial) await loadShot(initial);
    setStatus("已载入真实镜头工程");
  };
  useEffect(() => { load().catch((error) => setStatus(error.message)); }, []);
  const refreshShot = async () => { const response=await fetch(`${API}/shots/${shotId}`);if(response.ok)setShot(await response.json()); };

  const switchShot = async (id: string) => {
    if (!id || id === shotId) return;
    try { await loadShot(id); setStatus(`已切换到 ${id}`); }
    catch (error) { setStatus(error instanceof Error ? error.message : "切换镜头失败"); }
  };

  const createShot = async () => {
    const id = window.prompt("新镜头名称（英文/数字）", `SH${String(shots.length + 1).padStart(3, "0")}`);
    if (!id) return;
    const response = await fetch(`${API}/shots`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }) });
    if (!response.ok) { setStatus(`创建失败：${await response.text()}`); return; }
    const saved: Shot = await response.json();
    setShots((current) => current.includes(saved.id) ? current : [...current, saved.id]);
    setShot(saved); setShotId(saved.id);
    setStatus(`已创建并切换到 ${saved.id}`);
  };

  const selectedElements = useMemo(() => shot?.elements.filter((item) => selected.includes(item.id)) ?? [], [shot, selected]);
  const primary = selectedElements.at(-1);
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const activeKeyframe = primary && selectedKeyframe?.elementId === primary.id
    ? primary.keyframes.find((item) => item.id === selectedKeyframe.keyframeId)
    : primary?.keyframes.find((item) => item.frame === playhead);
  const activeInteractionGroup = shot?.interactionGroups.find((group) => group.id === selectedInteractionKeyframe?.groupId);
  const activeInteractionKeyframe = activeInteractionGroup?.keyframes.find((item) => item.id === selectedInteractionKeyframe?.keyframeId);
  const activeExit = activeInteractionGroup?.exit??{mode:"restoreIndependent" as const};
  const activeMaskKeyframe = activeInteractionKeyframe ?? activeKeyframe;
  const activeKeyframeJob = activeInteractionKeyframe ? kfJobs[activeInteractionKeyframe.id] : activeKeyframe ? kfJobs[activeKeyframe.id] : undefined;
  const activeView = activeInteractionKeyframe ? interactionView : elementView;
  const activeGenerationHistory = (shot?.generations ?? []).filter((item)=>item.keyframeId===activeMaskKeyframe?.id&&item.outputs?.length);
  const activeInteractionTransition = shot?.transitions.find((item)=>item.targetType==="interactionGroup"&&item.targetId===activeInteractionGroup?.id);
  const activeTransitionHistory = (shot?.generations ?? []).filter((item)=>item.type==="transition"&&(item.transitionId===activeInteractionTransition?.id||item.targetId===activeInteractionGroup?.id)&&(item.outputs?.length||item.output));
  const playingTransition = shot?.transitions.find((item)=>item.selectedGenerationId&&playhead>=item.fromFrame&&playhead<=item.toFrame);
  const playingGeneration = shot?.generations.find((item)=>item.id===playingTransition?.selectedGenerationId);
  const playingVideoUri = playingGeneration?.output??playingGeneration?.outputs?.[0];
  const playingMaskUri = playingGeneration?.maskOutput;

  const drawTransitionLayer=()=>{const video=transitionVideoRef.current;const mask=transitionMaskVideoRef.current;const canvas=transitionCanvasRef.current;if(!video||!mask||!canvas||video.readyState<2||mask.readyState<2||mask.seeking)return;const halfFrame=1/60;if(Math.abs(video.currentTime-mask.currentTime)>halfFrame)return;canvas.width=video.videoWidth;canvas.height=video.videoHeight;const context=canvas.getContext("2d",{willReadFrequently:true});if(!context)return;context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(video,0,0,canvas.width,canvas.height);const pixels=context.getImageData(0,0,canvas.width,canvas.height);const scratch=document.createElement("canvas");scratch.width=canvas.width;scratch.height=canvas.height;const maskContext=scratch.getContext("2d",{willReadFrequently:true});if(!maskContext)return;maskContext.drawImage(mask,0,0,canvas.width,canvas.height);const maskPixels=maskContext.getImageData(0,0,canvas.width,canvas.height).data;for(let index=0;index<pixels.data.length;index+=4){const luminance=.2126*maskPixels[index]+.7152*maskPixels[index+1]+.0722*maskPixels[index+2];pixels.data[index+3]=Math.round(pixels.data[index+3]*luminance/255)}context.putImageData(pixels,0,0);};

  useEffect(()=>{
    const video=transitionVideoRef.current;const mask=transitionMaskVideoRef.current;if(!video||!playingTransition||!playingVideoUri||isPlaying)return;
    const seek=()=>{if(Number.isFinite(video.duration)&&video.duration>0){const progress=(playhead-playingTransition.fromFrame)/(playingTransition.toFrame-playingTransition.fromFrame);video.currentTime=Math.max(0,Math.min(video.duration,progress*video.duration));if(mask&&Number.isFinite(mask.duration))mask.currentTime=Math.max(0,Math.min(mask.duration,progress*mask.duration));}};
    if(video.readyState>=1)seek();else video.addEventListener("loadedmetadata",seek,{once:true});
    return()=>video.removeEventListener("loadedmetadata",seek);
  },[playhead,playingTransition?.id,playingVideoUri,playingMaskUri,isPlaying]);

  useEffect(()=>{
    const video=transitionVideoRef.current;const mask=transitionMaskVideoRef.current;if(!video)return;
    if(!isPlaying){video.pause();mask?.pause();return}
    if(!mask){void video.play().catch(()=>setIsPlaying(false));return}
    video.pause();mask.pause();const startTogether=()=>{void Promise.all([video.play(),mask.play()]).catch(()=>setIsPlaying(false))};
    if(Math.abs(video.currentTime-mask.currentTime)>1/120){mask.currentTime=video.currentTime;mask.addEventListener("seeked",startTogether,{once:true})}else startTogether();
    return()=>mask.removeEventListener("seeked",startTogether);
  },[isPlaying,playingVideoUri,playingMaskUri]);

  useEffect(()=>{if(!isPlaying||!playingMaskUri)return;let animation=0;const draw=()=>{const video=transitionVideoRef.current;const mask=transitionMaskVideoRef.current;if(video&&mask&&!mask.seeking&&Math.abs(video.currentTime-mask.currentTime)>1/60)mask.currentTime=video.currentTime;else drawTransitionLayer();animation=requestAnimationFrame(draw)};draw();return()=>cancelAnimationFrame(animation)},[isPlaying,playingMaskUri]);

  useEffect(()=>{
    if(!isPlaying||!shot)return;
    const timer=window.setInterval(()=>setPlayhead((current)=>{if(current>=shot.durationFrames){setIsPlaying(false);return shot.durationFrames;}return current+1;}),1000/shot.fps);
    return()=>window.clearInterval(timer);
  },[isPlaying,shot?.durationFrames,shot?.fps]);

  useEffect(()=>{
    const canvas=maskCanvasRef.current;if(!activeMaskKeyframe||!canvas)return;const context=canvas.getContext("2d");if(!context)return;
    context.clearRect(0,0,canvas.width,canvas.height);setMaskDirty(false);
    if(activeMaskKeyframe.mask){const image=new Image();image.onload=()=>drawMaskAsAlpha(image,canvas);image.src=activeMaskKeyframe.mask;}
  },[activeMaskKeyframe?.id, activeMaskKeyframe?.mask]);
  useEffect(()=>{setSamPoints([]);setSamMode(false);setMaskUndo([])},[activeMaskKeyframe?.id]);

  const updateElement = (id: string, patch: Partial<Element>) => setShot((current) => current && ({ ...current, elements: current.elements.map((item) => item.id === id ? { ...item, ...patch } : item) }));

  const updateKeyframe = (elementId: string, keyframeId: string, patch: Partial<VisualKeyframe>) => setShot((current) => current && ({
    ...current,
    elements: current.elements.map((element) => element.id === elementId
      ? { ...element, keyframes: element.keyframes.map((keyframe) => keyframe.id === keyframeId ? { ...keyframe, ...patch } : keyframe) }
      : element),
  }));

  const updateInteractionKeyframe = (groupId: string, keyframeId: string, patch: Partial<VisualKeyframe>) => setShot((current) => current && ({
    ...current,
    interactionGroups: current.interactionGroups.map((group) => group.id === groupId
      ? { ...group, keyframes: group.keyframes.map((keyframe) => keyframe.id === keyframeId ? { ...keyframe, ...patch } : keyframe) }
      : group),
  }));

  const groupContinuesAfterExit = (group:Shot["interactionGroups"][number]) => group.exit?.mode==="keepMerged"||group.exit?.mode==="attachToMember";
  const groupTakesOverAt = (group:Shot["interactionGroups"][number], frame:number) => frame>=group.range.start&&(frame<=group.range.end||groupContinuesAfterExit(group));
  const takeoverFor = (elementId:string, frame=playhead) => {
    const candidates=shot?.interactionGroups.filter((group)=>group.members.includes(elementId)&&groupTakesOverAt(group,frame))??[];
    return candidates.find((group)=>frame<=group.range.end)??candidates.sort((a,b)=>b.range.end-a.range.end)[0];
  };

  const anchorKeyframeFor = (group: Shot["interactionGroups"][number]) => {
    if (!group.anchorKeyframeId) return undefined;
    for (const element of shot?.elements ?? []) {
      const keyframe = element.keyframes.find((item) => item.id === group.anchorKeyframeId);
      if (keyframe) return keyframe;
    }
    return undefined;
  };

  const openInteractionTakeover = (group:Shot["interactionGroups"][number], frame=playhead) => {
    const keyframe=[...group.keyframes].sort((a,b)=>Math.abs(a.frame-frame)-Math.abs(b.frame-frame))[0];
    setSelected([]);setSelectedKeyframe(null);setPlayhead(frame);
    if(keyframe)setSelectedInteractionKeyframe({groupId:group.id,keyframeId:keyframe.id});
    const names=group.members.map((id)=>shot?.elements.find((item)=>item.id===id)?.name||id).join("＋");
    setStatus(`${names} 正在交互中 · 已转到 ${group.id} 联合状态`);
  };

  const selectElement = (id: string, additive = false) => {
    const takeover=!additive?takeoverFor(id):undefined;
    if(takeover){openInteractionTakeover(takeover);return;}
    setSelected((current) => additive ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id] : [id]);
    if (!additive) setSelectedKeyframe(null);
    if (!additive) setSelectedInteractionKeyframe(null);
  };

  const addAssetToShot = (asset: Asset) => {
    if (!shot) return;
    const element: Element = {
      id: uid(asset.kind.toUpperCase()), kind: asset.kind, assetId: asset.id, layerId: layerFor(asset.kind), name: asset.name,
      activeRange: { start: 0, end: shot.durationFrames }, transform: { x: .5, y: .5, scale: 1, rotation: 0 }, visible: true, locked: false,
      keyframes: [{ id: uid("KF"), frame: playhead, image: asset.url, state: {}, locked: false, renderPolicy:"required", generationBoundary:true, sourceKind:"authored" }],
    };
    setShot({ ...shot, elements: [...shot.elements, element] });
    setSelected([element.id]);
    setSelectedInteractionKeyframe(null);
    setStatus(`${asset.name} 已加入镜头，并创建独立轨道`);
  };

  const uploadAsset = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    const form = new FormData(); form.append("file", file);
    setStatus("正在导入资产…");
    const response = await fetch(`${API}/assets?kind=${assetKind}`, { method: "POST", body: form });
    if (!response.ok) { setStatus("资产导入失败"); return; }
    const asset: Asset = await response.json(); setAssets((current) => [...current, asset]); setStatus(`${asset.name} 已加入资产库`); event.target.value = "";
  };

  const addKeyframe = () => {
    if (!primary) return;
    const takeover=takeoverFor(primary.id);
    if(takeover){openInteractionTakeover(takeover);addInteractionKeyframe(takeover.id);return;}
    const existing = primary.keyframes.find((item) => item.frame === playhead);
    if (existing) { setStatus("当前帧已有关键帧"); return; }
    const nearest = [...primary.keyframes].sort((a,b) => Math.abs(a.frame-playhead)-Math.abs(b.frame-playhead))[0];
    const keyframe: VisualKeyframe = { id: uid("KF"), frame: playhead, image: nearest?.image ?? assetMap.get(primary.assetId)?.url ?? "", state: {}, locked: false, renderPolicy:"required", generationBoundary:true, sourceKind:"authored" };
    updateElement(primary.id, { keyframes: [...primary.keyframes, keyframe].sort((a,b) => a.frame-b.frame) }); setStatus(`已在第 ${playhead} 帧添加视觉关键帧`);
    setSelectedKeyframe({ elementId: primary.id, keyframeId: keyframe.id });
  };

  const deleteKeyframe = (element: Element, frame: number) => {
    if (!shot) return;
    const keyframe = element.keyframes.find((item) => item.frame === frame);
    const anchorGroupIds = new Set(shot.interactionGroups.filter((group) => group.anchorKeyframeId && group.anchorKeyframeId === keyframe?.id).map((group) => group.id));
    setShot({
      ...shot,
      elements: shot.elements.map((item) => item.id === element.id ? { ...item, keyframes: item.keyframes.filter((k) => k.frame !== frame) } : item),
      interactionGroups: anchorGroupIds.size ? shot.interactionGroups.filter((group) => !anchorGroupIds.has(group.id)) : shot.interactionGroups,
      transitions: anchorGroupIds.size ? shot.transitions.filter((t) => !(t.targetType === "interactionGroup" && anchorGroupIds.has(t.targetId))) : shot.transitions,
    });
    setStatus(anchorGroupIds.size ? "首帧已删除，其动作/互动组一并移除" : "关键帧已删除");
  };

  const moveKeyframe = (element: Element, keyframeId: string, requestedFrame: number) => {
    const frame = Math.max(element.activeRange.start, Math.min(element.activeRange.end, requestedFrame));
    if (element.keyframes.some((item) => item.id !== keyframeId && item.frame === frame)) {
      setStatus(`第 ${frame} 帧已经有关键帧`);
      return;
    }
    updateElement(element.id, {
      keyframes: element.keyframes
        .map((item) => item.id === keyframeId ? { ...item, frame } : item)
        .sort((a, b) => a.frame - b.frame),
    });
    setPlayhead(frame);
    setStatus(`关键帧已移动到第 ${frame} 帧，记得保存`);
  };

  const keyframePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, element: Element, keyframeId: string) => {
    if (!shot || element.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const keyframeFrame=element.keyframes.find((item)=>item.id===keyframeId)?.frame??playhead;
    const takeover=takeoverFor(element.id,keyframeFrame);
    if(takeover){openInteractionTakeover(takeover,keyframeFrame);return;}
    setSelected([element.id]);
    setSelectedInteractionKeyframe(null);
    setSelectedKeyframe({ elementId: element.id, keyframeId });
    setPlayhead(keyframeFrame);
    const lane = event.currentTarget.parentElement;
    if (!lane) return;
    const bounds = lane.getBoundingClientRect();
    const onMove = (pointerEvent: PointerEvent) => {
      const frame = Math.round((pointerEvent.clientX - bounds.left) / bounds.width * shot.durationFrames);
      moveKeyframe(element, keyframeId, frame);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const interactionKeyframePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, group: Shot["interactionGroups"][number], keyframeId: string) => {
    if (!shot) return;
    event.preventDefault();
    event.stopPropagation();
    const keyframe = group.keyframes.find((item) => item.id === keyframeId);
    if (!keyframe) return;
    setSelected([]);
    setSelectedKeyframe(null);
    setSelectedInteractionKeyframe({ groupId: group.id, keyframeId });
    setPlayhead(keyframe.frame);
    const lane = event.currentTarget.parentElement;
    if (!lane) return;
    const bounds = lane.getBoundingClientRect();
    const onMove = (pointerEvent: PointerEvent) => {
      const frame = Math.round((pointerEvent.clientX - bounds.left) / bounds.width * shot.durationFrames);
      const anchorFrame = anchorKeyframeFor(group)?.frame ?? group.range.start;
      const clamped = Math.max(anchorFrame + 1, Math.min(shot.durationFrames, frame));
      setShot((current) => current ? updateGroupTiming(current,group.id,keyframeId,clamped) : current);
      setPlayhead(clamped);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const anchorKeyframePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, group: Shot["interactionGroups"][number], anchor: VisualKeyframe) => {
    if (!shot) return;
    const anchorElement = shot.elements.find((element) => element.keyframes.some((keyframe) => keyframe.id === anchor.id));
    if (!anchorElement) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected([anchorElement.id]);
    setSelectedKeyframe({ elementId: anchorElement.id, keyframeId: anchor.id });
    setSelectedInteractionKeyframe(null);
    setPlayhead(anchor.frame);
    const lane = event.currentTarget.parentElement;
    if (!lane) return;
    const bounds = lane.getBoundingClientRect();
    const onMove = (pointerEvent: PointerEvent) => {
      const frame = Math.round((pointerEvent.clientX - bounds.left) / bounds.width * shot.durationFrames);
      const clamped = Math.max(0, Math.min(group.range.end - 1, frame));
      setShot((current) => current ? updateGroupTiming(current,group.id,anchor.id,clamped) : current);
      setPlayhead(clamped);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const generateActionGroup = async (anchorKeyframeId: string, memberIds:string[] = []) => {
    if (!shot) return;
    const intent=actionIntent.trim();if(!intent){setStatus("请先填写动作意图");return;}
    setPlanning(true); setStatus("正在生成动作/互动组…");
    try {
      await saveShot(shot);
      const response = await fetch(`${API}/action-groups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shotId: shot.id, anchorKeyframeId, memberIds, actionIntent:intent, planner: planPlanner, embellishment, desiredDurationFrames:actionDurationFrames }) });
      if (!response.ok) throw new Error(await response.text());
      const saved: Shot = await response.json();
      setShot(saved);
      setStatus("已生成动作/互动组，并锚定到首帧");
    } catch (error) {
      let detail = error instanceof Error ? error.message : "生成失败";
      try { const parsed = JSON.parse(detail); if (parsed?.detail) detail = parsed.detail; } catch { /* 非 JSON */ }
      setStatus(`生成失败：${detail}`);
    }
    finally { setPlanning(false); }
  };

  const updateInteraction = (groupId: string, patch: Partial<Shot["interactionGroups"][number]>) => {
    if (!shot) return;
    setShot({
      ...shot,
      interactionGroups: shot.interactionGroups.map((group) => group.id === groupId ? { ...group, ...patch } : group),
    });
    setStatus("交互动作已修改，记得保存");
  };

  const deleteInteraction = (groupId: string) => {
    if (!shot) return;
    const group=shot.interactionGroups.find((item)=>item.id===groupId);if(!group)return;
    if(!window.confirm(`删除${group.kind==="action"?"动作组":"互动组"}？锚点关键帧和已付费媒体会保留，组结构与当前过渡会移除。`))return;
    setShot({
      ...shot,
      interactionGroups: shot.interactionGroups.filter((group) => group.id !== groupId),
      transitions: shot.transitions.filter((transition) => !(transition.targetType === "interactionGroup" && transition.targetId === groupId)),
    });
    setStatus("交互动作及对应过渡任务已删除，记得保存");
  };

  const deleteInteractionKeyframe=(groupId:string,keyframeId:string)=>{
    if(!shot)return;const group=shot.interactionGroups.find((item)=>item.id===groupId);const keyframe=group?.keyframes.find((item)=>item.id===keyframeId);if(!group||!keyframe)return;
    if(keyframe.generationBoundary&&keyframe.frame===group.range.end){setStatus("组尾边界不能直接删除；请先将另一个状态设为边界");return;}
    if(!window.confirm("删除这个动作状态节点？历史生成媒体会保留。"))return;
    const next={...group,keyframes:group.keyframes.filter((item)=>item.id!==keyframeId)};setShot({...shot,interactionGroups:shot.interactionGroups.map((item)=>item.id===groupId?next:item),generations:shot.generations.map((item)=>item.keyframeId===keyframeId?{...item,status:"archived"}:item)});setSelectedInteractionKeyframe(null);setStatus("状态节点已删除；历史媒体已归档");
  };

  const toggleGenerationBoundary=(groupId:string,keyframeId:string)=>{
    if(!shot)return;const group=shot.interactionGroups.find((item)=>item.id===groupId);const keyframe=group?.keyframes.find((item)=>item.id===keyframeId);if(!group||!keyframe)return;
    if(keyframe.frame===group.range.end&&keyframe.generationBoundary){setStatus("组尾必须保留为生成边界");return;}
    updateInteractionKeyframe(groupId,keyframeId,{generationBoundary:!keyframe.generationBoundary,renderPolicy:!keyframe.generationBoundary?"required":"optional"});setStatus(!keyframe.generationBoundary?"已设为强制生成边界，整组将按此拆段":"已改为描述型引导节点");
  };

  const extractAcceptedFrame=async()=>{
    if(!shot||!activeInteractionGroup||!activeInteractionKeyframe)return;const transition=shot.transitions.find((item)=>item.targetType==="interactionGroup"&&item.targetId===activeInteractionGroup.id&&item.selectedGenerationId&&item.fromFrame<=activeInteractionKeyframe.frame&&item.toFrame>=activeInteractionKeyframe.frame);
    if(!transition?.selectedGenerationId){setStatus("没有覆盖当前状态的已采用视频");return;}setStatus("正在从已采用视频抽取实际帧…");
    const response=await fetch(`${API}/video-frame-extractions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,groupId:activeInteractionGroup.id,keyframeId:activeInteractionKeyframe.id,generationId:transition.selectedGenerationId})});if(!response.ok){setStatus(`抽帧失败：${await response.text()}`);return;}setShot(await response.json());setStatus("已采用视频实际帧；未覆盖规划图片历史");
  };

  const submitQualityReview=async(decision:"accepted"|"rejected")=>{
    if(!shot||!playingGeneration)return;if(decision==="rejected"&&!rejectionReason.trim()){setStatus("拒绝版本时请填写原因");return;}
    const response=await fetch(`${API}/generation-reviews`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,generationId:playingGeneration.id,decision,...qualityChecks,rejectionReason:decision==="rejected"?rejectionReason:null})});if(!response.ok){setStatus(`质检保存失败：${await response.text()}`);return;}setShot(await response.json());setStatus(decision==="accepted"?"质检已通过并保存":"已保存拒绝原因，可用于再次生成");
  };

  const removeElement = (elementId: string) => {
    if (!shot) return;
    const groupIds = new Set(shot.interactionGroups.filter((group) => group.members.includes(elementId)).map((group) => group.id));
    setShot({
      ...shot,
      elements: shot.elements.filter((element) => element.id !== elementId),
      interactionGroups: shot.interactionGroups.filter((group) => !groupIds.has(group.id)),
      transitions: shot.transitions.filter((transition) =>
        !(transition.targetType === "interactionGroup" && groupIds.has(transition.targetId)) &&
        !(transition.targetType === "element" && transition.targetId === elementId)
      ),
    });
    setSelected([]);
    setStatus("元素及其动作/交互组已删除");
  };

  const addInteractionKeyframe = (groupId: string) => {
    if (!shot) return; const group = shot.interactionGroups.find((item)=>item.id===groupId); if (!group) return;
    if (playhead < group.range.start || playhead > group.range.end) { setStatus("播放头需要位于交互区间内"); return; }
    if (group.keyframes.some((item)=>item.frame===playhead)) { setStatus("交互图层当前帧已有关键状态"); return; }
    const keyframe: VisualKeyframe = {id:uid("IKF"),frame:playhead,image:"",instruction:"",state:{},locked:false,renderPolicy:"optional",generationBoundary:false,sourceKind:"authored"};
    updateInteraction(groupId,{keyframes:[...group.keyframes,keyframe].sort((a,b)=>a.frame-b.frame)});
    setSelectedInteractionKeyframe({groupId,keyframeId:keyframe.id}); setPlayhead(keyframe.frame); setStatus("已添加交互关键状态，请填写描述");
  };

  const saveShot = async (snapshot: Shot) => {
    const response = await fetch(`${API}/shots/${snapshot.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot) });
    if (!response.ok) throw new Error(await response.text());
  };

  const save = async () => {
    if (!shot) return; setStatus("正在保存…");
    const response = await fetch(`${API}/shots/${shot.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(shot) });
    setStatus(response.ok ? "镜头工程已保存" : `保存失败：${await response.text()}`);
  };

  const imageAtFrame = (element: Element, frame: number) => element.keyframes.filter((item) => item.frame <= frame).sort((a,b) => b.frame-a.frame)[0]?.image || assetMap.get(element.assetId)?.url;
  const keyframeAtFrame = (element: Element, frame: number) => element.keyframes.filter((item) => item.frame <= frame).sort((a,b) => b.frame-a.frame)[0];

  const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(`无法读取参考图：${src}`)); image.src = src;
  });

  const imageAsDataUrl = async (src: string) => {
    if (src.startsWith("data:")) return src;
    const image = await loadImage(src); const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    return canvas.toDataURL("image/jpeg", .9);
  };

  const drawMaskAsAlpha = (image:CanvasImageSource,canvas:HTMLCanvasElement) => {
    const context=canvas.getContext("2d",{willReadFrequently:true});if(!context)return;
    context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height);
    for(let index=0;index<pixels.data.length;index+=4){const sourceAlpha=pixels.data[index+3];const luminance=.2126*pixels.data[index]+.7152*pixels.data[index+1]+.0722*pixels.data[index+2];pixels.data[index]=255;pixels.data[index+1]=255;pixels.data[index+2]=255;pixels.data[index+3]=Math.round(sourceAlpha*luminance/255)}
    context.putImageData(pixels,0,0);
  };

  const renderFrame = async (frame: number, includeInteractionLayer = true) => {
    if (!shot) throw new Error("镜头尚未加载");
    const canvas = document.createElement("canvas"); canvas.width = shot.canvas.width; canvas.height = shot.canvas.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法合成画面");
    context.fillStyle = shot.canvas.backgroundColor; context.fillRect(0, 0, canvas.width, canvas.height);
    const elementComposite = shot.elements.map((element)=>keyframeAtFrame(element,frame)).find((keyframe)=>keyframe?.locked&&keyframe.image&&keyframe.state.generatedComposite===true);
    if (elementComposite) { const image=await loadImage(elementComposite.image); context.drawImage(image,0,0,canvas.width,canvas.height); return canvas.toDataURL("image/jpeg",.9); }
    const interactionCandidates = includeInteractionLayer ? shot.interactionGroups.filter((group)=>groupTakesOverAt(group,frame)&&group.keyframes.some((keyframe)=>keyframe.locked&&keyframe.image&&keyframe.frame<=Math.min(frame,group.range.end))) : [];
    const interaction = interactionCandidates.find((group)=>frame<=group.range.end)??interactionCandidates.sort((a,b)=>b.range.end-a.range.end)[0];
    const interactionImage = interaction?.keyframes.filter((keyframe)=>keyframe.locked&&keyframe.image&&keyframe.frame<=frame).sort((a,b)=>b.frame-a.frame)[0]?.image;
    const hiddenMembers = new Set(interactionImage ? interaction?.members : []);shot.interactionGroups.filter((group)=>frame>group.range.end&&group.exit?.mode==="hideMember"&&group.exit.subjectId).forEach((group)=>hiddenMembers.add(group.exit!.subjectId!));
    const elements = [...shot.elements].sort((a,b) => (shot.layers.find(l=>l.id===a.layerId)?.order ?? 0) - (shot.layers.find(l=>l.id===b.layerId)?.order ?? 0));
    for (const element of elements) {
      if (hiddenMembers.has(element.id)) continue;
      if (!element.visible || frame < element.activeRange.start || frame > element.activeRange.end) continue;
      const src = imageAtFrame(element, frame); if (!src) continue;
      const image = await loadImage(src); const width = canvas.width * .22 * element.transform.scale; const height = width * image.naturalHeight / image.naturalWidth;
      context.save(); context.translate(element.transform.x * canvas.width, element.transform.y * canvas.height); context.rotate(element.transform.rotation * Math.PI / 180);
      context.drawImage(image, -width/2, -height/2, width, height); context.restore();
    }
    if (interactionImage) { const image = await loadImage(interactionImage); context.drawImage(image,0,0,canvas.width,canvas.height); }
    return canvas.toDataURL("image/jpeg", .9);
  };

  const watchJob = (jobId: string, onUpdate: (job: GenerationJob) => void) => {
    const poll = async () => {
      try {
        const response = await fetch(`${API}/generations/${jobId}`); const job: GenerationJob = await response.json(); onUpdate(job);
        if (job.status === "queued" || job.status === "running") window.setTimeout(poll, 2000);
        else void refreshShot();
      } catch (error) { setStatus(error instanceof Error ? error.message : "生成状态查询失败"); }
    };
    window.setTimeout(poll, 600);
  };

  const submitTransitionGeneration = async (payload:{shotId:string;transitionId:string;adapter:string;parameters:Record<string,unknown>},firstImage:string,lastImage:string):Promise<GenerationJob> => {
    const quoteResponse=await fetch(`${API}/generations/quote`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(!quoteResponse.ok)throw new Error(await quoteResponse.text());
    const quote:GenerationQuote=await quoteResponse.json();
    setPendingGeneration({quote,payload,firstImage,lastImage});
    return new Promise<GenerationJob>((resolve,reject)=>{pendingGenerationResult.current={resolve,reject};});
  };

  const confirmPendingGeneration=async()=>{const pending=pendingGeneration;if(!pending)return;try{const response=await fetch(`${API}/generations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...pending.payload,confirmationFingerprint:pending.quote.fingerprint,confirmDurationMismatch:pending.quote.durationWarning})});if(!response.ok){const detail=await response.text();throw new Error(detail.includes("duplicate_generation")?"相同素材和参数已有进行中或成功任务，请查看历史候选":detail)}const job:GenerationJob=await response.json();pendingGenerationResult.current?.resolve(job)}catch(error){pendingGenerationResult.current?.reject(error instanceof Error?error:new Error("提交失败"))}finally{pendingGenerationResult.current=null;setPendingGeneration(null)}};
  const cancelPendingGeneration=()=>{pendingGenerationResult.current?.reject(new Error("已取消生成，没有提交付费任务"));pendingGenerationResult.current=null;setPendingGeneration(null)};

  const generateKeyframe = async () => {
    if (!shot || !activeInteractionGroup || !activeInteractionKeyframe) return;
    const keyframeId = activeInteractionKeyframe.id; const instruction = activeInteractionKeyframe.instruction?.trim(); if (!instruction) { setStatus("请先填写交互关键状态"); return; }
    try {
      if(activeInteractionKeyframe.renderPolicy==="required"&&!window.confirm("尾帧图片会产生模型费用。确认生成候选？生成后仍需由你选择并采用，不会自动扣费生成视频。")){setStatus("已取消尾帧图片生成");return;}
      setStatus("正在整理关键帧上下文…"); await saveShot(shot);
      const references:string[]=[];
      const previousInGroup=activeInteractionGroup.keyframes.filter((item)=>item.frame<activeInteractionKeyframe.frame&&item.locked&&item.image).sort((a,b)=>b.frame-a.frame)[0];
      const anchorReference=!previousInGroup?anchorKeyframeFor(activeInteractionGroup):undefined;
      const previousGroup=!previousInGroup&&!anchorReference?.image?[...shot.interactionGroups].filter((group)=>group.id!==activeInteractionGroup.id&&group.range.end<activeInteractionKeyframe.frame&&group.members.some((id)=>activeInteractionGroup.members.includes(id))).sort((a,b)=>b.range.end-a.range.end).find((group)=>group.keyframes.some((item)=>item.locked&&item.image)):undefined;
      const previousExit=previousGroup?.keyframes.filter((item)=>item.locked&&item.image).sort((a,b)=>b.frame-a.frame)[0];
      const continuityReference=previousInGroup?.image||anchorReference?.image||previousExit?.image;
      if(continuityReference)references.push(await imageAsDataUrl(continuityReference));
      references.push(await renderFrame(activeInteractionKeyframe.frame, false));
      for (const memberId of activeInteractionGroup.members) { if(references.length>=3)break;const member=shot.elements.find((item)=>item.id===memberId); const src=member&&(assetMap.get(member.assetId)?.url || imageAtFrame(member,activeInteractionKeyframe.frame)); if(src) references.push(await imageAsDataUrl(src)); }
      const response = await fetch(`${API}/keyframe-generations`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
        shotId:shot.id, targetType:"interactionGroup", targetId:activeInteractionGroup.id, keyframeId:activeInteractionKeyframe.id, instruction:continuityReference?`以上一张已确认交互状态为连续性基准，只推进到当前目标状态：${instruction}`:instruction, referenceImages:references.slice(0,3), candidateCount:2, promptExtend:false, adapter:imageAdapter,
      }) });
      if (!response.ok) throw new Error(await response.text());
      const job: GenerationJob = await response.json(); setKfJobs((current)=>({...current,[keyframeId]:job})); setStatus("Wan 2.7 Image 正在生成两个候选关键帧…");
      watchJob(job.id, (next) => { setKfJobs((current)=>({...current,[keyframeId]:next}));if(next.status==="succeeded")void refreshShot(); setStatus(next.status === "succeeded" ? "关键帧候选已生成并保存到此状态的历史" : next.status === "failed" ? `生成失败：${next.error?.message || next.message}` : "Wan 2.7 Image 正在生成关键帧…"); });
    } catch (error) { setStatus(error instanceof Error ? error.message : "关键帧生成失败"); }
  };

  const generateElementKeyframe = async () => {
    if(!shot||!primary||!activeKeyframe)return; const keyframeId=activeKeyframe.id; const instruction=activeKeyframe.instruction?.trim(); if(!instruction){setStatus("请先填写元素关键帧状态描述");return;}
    try{
      setStatus("正在整理元素关键帧上下文…"); await saveShot(shot);
      const references=[await renderFrame(activeKeyframe.frame,false)]; const assetImage=assetMap.get(primary.assetId)?.url; if(assetImage)references.push(await imageAsDataUrl(assetImage));
      const previous=primary.keyframes.filter((item)=>item.frame<activeKeyframe.frame&&item.image).sort((a,b)=>b.frame-a.frame)[0]; if(previous?.image)references.push(await imageAsDataUrl(previous.image));
      const response=await fetch(`${API}/keyframe-generations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,targetType:"element",targetId:primary.id,keyframeId:activeKeyframe.id,instruction,referenceImages:references.slice(0,3),candidateCount:2,promptExtend:false,adapter:imageAdapter})});
      if(!response.ok)throw new Error(await response.text()); const job:GenerationJob=await response.json(); setKfJobs((current)=>({...current,[keyframeId]:job}));setStatus("Wan 2.7 Image 正在生成元素关键状态…");
      watchJob(job.id,(next)=>{setKfJobs((current)=>({...current,[keyframeId]:next}));if(next.status==="succeeded")void refreshShot();setStatus(next.status==="succeeded"?"元素关键帧候选已生成并保存到此状态的历史":next.status==="failed"?`生成失败：${next.error?.message||next.message}`:"Wan 2.7 Image 正在生成元素关键状态…");});
    }catch(error){setStatus(error instanceof Error?error.message:"元素关键帧生成失败");}
  };

  const generateElementTransition = async () => {
    if(!shot||!primary||!activeKeyframe)return; const next=primary.keyframes.filter((item)=>item.frame>activeKeyframe.frame).sort((a,b)=>a.frame-b.frame)[0]; if(!next){setStatus("当前关键帧后面没有下一关键帧");return;}
    try{
      let transition=shot.transitions.find((item)=>item.targetType==="element"&&item.targetId===primary.id&&item.fromFrame===activeKeyframe.frame&&item.toFrame===next.frame);
      const snapshot:Shot=transition?shot:{...shot,transitions:[...shot.transitions,{id:uid("TR"),targetType:"element",targetId:primary.id,fromFrame:activeKeyframe.frame,toFrame:next.frame,instruction:`${activeKeyframe.instruction||"当前状态"}，自然过渡到：${next.instruction||"下一状态"}`,strategy:"aiVideo",selectedGenerationId:null}]};
      transition=transition??snapshot.transitions.at(-1)!; setShot(snapshot);await saveShot(snapshot);setStatus("正在准备元素首尾帧…");
      const [firstImage,lastImage]=await Promise.all([renderFrame(activeKeyframe.frame),renderFrame(next.frame)]); const jobKey=`element:${primary.id}:${activeKeyframe.frame}:${next.frame}`;
      const job=await submitTransitionGeneration({shotId:snapshot.id,transitionId:transition.id,adapter:transitionAdapter,parameters:{firstImage,lastImage,resolution:transitionAdapter==="wan-i2v-2.7"?"720P":"480P",duration:Math.max(2,Math.min(15,Math.round((transition.toFrame-transition.fromFrame)/snapshot.fps))),promptExtend:false,segmentCount:1}},activeKeyframe.image,next.image);setTransitionJobs((current)=>({...current,[jobKey]:job}));setStatus("Wan 正在生成元素过渡…");watchJob(job.id,(nextJob)=>{setTransitionJobs((current)=>({...current,[jobKey]:nextJob}));setStatus(nextJob.status==="succeeded"?"元素过渡视频已生成":nextJob.status==="failed"?`过渡失败：${nextJob.error?.message||nextJob.message}`:"Wan 正在生成元素过渡…");});
    }catch(error){setStatus(error instanceof Error?error.message:"元素过渡生成失败");}
  };

  const acceptKeyframe = async (outputIndex: number) => {
    const job = activeKeyframeJob;
    if (!job) return; setStatus("正在接受关键帧…");
    const response = await fetch(`${API}/keyframe-generations/accept`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:job.id,shotId:shot?.id,outputIndex})});
    if (!response.ok) { setStatus(`接受失败：${await response.text()}`); return; }
    const acceptedId=job.id;const saved: Shot = await response.json(); setShot(saved); const wasInteraction=job.targetType==="interactionKeyframe";setLastAcceptedGeneration(acceptedId);setPreviewCandidate(null); const clearedKey=activeInteractionKeyframe?.id ?? activeKeyframe?.id ?? ""; setKfJobs((current)=>{ const next={...current}; delete next[clearedKey]; return next; }); setStatus(wasInteraction?"候选图已写入交互图层；可以撤销返回":"候选图已写入元素关键帧；可以撤销返回");
  };

  const acceptHistoricalKeyframe = async (generationId:string, outputIndex:number) => {
    if(!shot)return;setStatus("正在采用历史候选…");
    const response=await fetch(`${API}/keyframe-generations/accept`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:generationId,shotId:shot.id,outputIndex})});
    if(!response.ok){setStatus(`采用失败：${await response.text()}`);return;}setShot(await response.json());setLastAcceptedGeneration(generationId);setPreviewCandidate(null);setStatus("历史候选已采用；原始候选仍保留在历史中");
  };

  const revertAcceptedKeyframe = async () => {
    if(!shot||!lastAcceptedGeneration)return;const response=await fetch(`${API}/keyframe-generations/revert`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,generationId:lastAcceptedGeneration})});if(!response.ok){setStatus(`撤销失败：${await response.text()}`);return;}setShot(await response.json());setLastAcceptedGeneration(null);setStatus("已恢复采用候选前的关键帧");
  };

  const generateTransition = async (groupId: string) => {
    if (!shot) return; const transition = shot.transitions.find((item) => item.targetType === "interactionGroup" && item.targetId === groupId); if (!transition) return;
    try {
      const group=shot.interactionGroups.find((item)=>item.id===groupId); if(!group)return;const first=anchorKeyframeFor(group); const last=[...group.keyframes].filter((item)=>item.generationBoundary&&item.locked&&item.image).sort((a,b)=>b.frame-a.frame)[0];
      if(!first?.image||!last){setStatus("请先准备锚点图片，并为组尾边界生成和采用图片");return;}
      transition.instruction=compileGroupPrompt(shot,group);
      setStatus("正在准备交互图层首尾帧…"); await saveShot(shot);
      const [firstImage,lastImage] = await Promise.all([imageAsDataUrl(first.image),imageAsDataUrl(last.image)]);
      const job=await submitTransitionGeneration({shotId:shot.id,transitionId:transition.id,adapter:transitionAdapter,parameters:{firstImage,lastImage,resolution:transitionAdapter==="wan-i2v-2.7"?"720P":"480P",duration:Math.max(2,Math.min(15,Math.round((transition.toFrame-transition.fromFrame)/shot.fps))),promptExtend:false,segmentCount:1}},first.image,last.image);
      setTransitionJobs((current)=>({...current,[groupId]:job})); setStatus("Wan 已收到任务，生成通常需要数分钟");
      watchJob(job.id,(next)=>{setTransitionJobs((current)=>({...current,[groupId]:next}));setStatus(next.status==="succeeded"?"过渡视频已生成":next.status==="failed"?`过渡失败：${next.error?.message||next.message}`:"Wan 正在生成过渡视频…");});
    } catch(error) { setStatus(error instanceof Error?error.message:"过渡生成失败"); }
  };

  const generateInteractionToNext = async () => {
    if(!shot||!activeInteractionGroup||!activeInteractionKeyframe)return;
    const next=activeInteractionGroup.keyframes.filter((item)=>item.frame>activeInteractionKeyframe.frame).sort((a,b)=>a.frame-b.frame)[0];
    if(!next){setStatus("当前关键状态后面没有下一关键状态");return;}
    if(!activeInteractionKeyframe.image||!next.image){setStatus("请先生成并采用当前与下一关键状态的图像");return;}
    try{
      let transition=shot.transitions.find((item)=>item.targetType==="interactionGroup"&&item.targetId===activeInteractionGroup.id&&item.fromFrame===activeInteractionKeyframe.frame&&item.toFrame===next.frame);
      const snapshot:Shot=transition?shot:{...shot,transitions:[...shot.transitions,{id:uid("TR"),targetType:"interactionGroup",targetId:activeInteractionGroup.id,fromFrame:activeInteractionKeyframe.frame,toFrame:next.frame,instruction:`${activeInteractionKeyframe.instruction||"当前状态"}，自然过渡到：${next.instruction||"下一状态"}`,strategy:"aiVideo",selectedGenerationId:null}]};
      transition=transition??snapshot.transitions.at(-1)!; setShot(snapshot);await saveShot(snapshot);setStatus("正在准备交互首尾帧…");
      const [firstImage,lastImage]=await Promise.all([imageAsDataUrl(activeInteractionKeyframe.image),imageAsDataUrl(next.image)]); const jobKey=`${activeInteractionGroup.id}:${activeInteractionKeyframe.frame}:${next.frame}`;
      const job=await submitTransitionGeneration({shotId:snapshot.id,transitionId:transition.id,adapter:transitionAdapter,parameters:{firstImage,lastImage,resolution:transitionAdapter==="wan-i2v-2.7"?"720P":"480P",duration:Math.max(2,Math.min(15,Math.round((transition.toFrame-transition.fromFrame)/snapshot.fps))),promptExtend:false,segmentCount:1}},activeInteractionKeyframe.image,next.image);setTransitionJobs((current)=>({...current,[jobKey]:job}));setStatus("Wan 已收到任务，生成通常需要数分钟");watchJob(job.id,(nextJob)=>{setTransitionJobs((current)=>({...current,[jobKey]:nextJob}));setStatus(nextJob.status==="succeeded"?"过渡视频已生成":nextJob.status==="failed"?`过渡失败：${nextJob.error?.message||nextJob.message}`:"Wan 正在生成过渡视频…");});
    }catch(error){setStatus(error instanceof Error?error.message:"交互过渡生成失败");}
  };

  const generateAnchorTransition = async () => {
    if(!shot||!primary||!activeKeyframe)return;
    const anchorGroup=shot.interactionGroups.find((group)=>group.anchorKeyframeId===activeKeyframe.id);
    if(!anchorGroup){setStatus("当前关键帧不是动作组的首帧");return;}
    const next=anchorGroup.keyframes.filter((item)=>item.frame>activeKeyframe.frame).sort((a,b)=>a.frame-b.frame)[0];
    if(!next){setStatus("动作组里没有首帧之后的下一关键状态");return;}
    if(!activeKeyframe.image||!next.image){setStatus("请先生成并采用首帧与下一关键状态的图像");return;}
    try{
      let transition=shot.transitions.find((item)=>item.targetType==="interactionGroup"&&item.targetId===anchorGroup.id&&item.fromFrame===activeKeyframe.frame&&item.toFrame===next.frame);
      const snapshot:Shot=transition?shot:{...shot,transitions:[...shot.transitions,{id:uid("TR"),targetType:"interactionGroup",targetId:anchorGroup.id,fromFrame:activeKeyframe.frame,toFrame:next.frame,instruction:`${activeKeyframe.instruction||"首帧"}，自然过渡到：${next.instruction||"下一状态"}`,strategy:"aiVideo",selectedGenerationId:null}]};
      transition=transition??snapshot.transitions.at(-1)!; setShot(snapshot);await saveShot(snapshot);setStatus("正在准备首帧与下一关键状态…");
      const [firstImage,lastImage]=await Promise.all([imageAsDataUrl(activeKeyframe.image),imageAsDataUrl(next.image)]); const jobKey=`${anchorGroup.id}:${activeKeyframe.frame}:${next.frame}`;
      const job=await submitTransitionGeneration({shotId:snapshot.id,transitionId:transition.id,adapter:transitionAdapter,parameters:{firstImage,lastImage,resolution:transitionAdapter==="wan-i2v-2.7"?"720P":"480P",duration:Math.max(2,Math.min(15,Math.round((transition.toFrame-transition.fromFrame)/snapshot.fps))),promptExtend:false,segmentCount:1}},activeKeyframe.image,next.image);setTransitionJobs((current)=>({...current,[jobKey]:job}));setStatus("Wan 已收到任务，生成通常需要数分钟");watchJob(job.id,(nextJob)=>{setTransitionJobs((current)=>({...current,[jobKey]:nextJob}));setStatus(nextJob.status==="succeeded"?"过渡视频已生成":nextJob.status==="failed"?`过渡失败：${nextJob.error?.message||nextJob.message}`:"Wan 正在生成过渡视频…");});
    }catch(error){setStatus(error instanceof Error?error.message:"首帧过渡生成失败");}
  };

  const acceptTransition = async (groupId: string) => {
    const job=transitionJobs[groupId]; if(!job) return;
    const response=await fetch(`${API}/transition-generations/accept`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:job.id,shotId:shot?.id})});
    if(!response.ok){setStatus(`采用失败：${await response.text()}`);return;}
    setShot(await response.json()); setStatus("过渡视频已采用并记录到镜头版本");
  };

  const acceptHistoricalTransition = async (generationId:string) => {
    if(!shot)return;setStatus("正在采用历史过渡视频…");
    const response=await fetch(`${API}/transition-generations/accept`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:generationId,shotId:shot.id})});
    if(!response.ok){setStatus(`采用失败：${await response.text()}`);return;}
    setShot(await response.json());setStatus("历史过渡视频已采用；其他版本仍保留");
  };

  const generateVideoMask = async () => {
    if(!shot||!playingGeneration)return;setStatus("正在启动本地动态蒙版传播…");
    const response=await fetch(`${API}/video-mask-jobs`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,generationId:playingGeneration.id,maxWidth:512,chunkFrames:16})});
    if(!response.ok){setStatus(`动态蒙版启动失败：${await response.text()}`);return;}
    const initial=await response.json();setVideoMaskJob(initial);
    const poll=async()=>{const nextResponse=await fetch(`${API}/video-mask-jobs/${initial.id}`);if(!nextResponse.ok)return;const next=await nextResponse.json();setVideoMaskJob(next);setStatus(next.status==="succeeded"?"动态蒙版已生成，可查看合成与独立交互动画":next.status==="failed"?`动态蒙版失败：${next.message}`:`SAM 2 动态蒙版：${next.progress}% · ${next.message}`);if(next.status==="queued"||next.status==="running")window.setTimeout(poll,1500);else if(next.status==="succeeded")void refreshShot();};
    window.setTimeout(poll,700);
  };

  const maskPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if(samMode&&!event.altKey){event.preventDefault();const bounds=event.currentTarget.getBoundingClientRect();setSamPoints((current)=>[...current,{x:(event.clientX-bounds.left)/bounds.width,y:(event.clientY-bounds.top)/bounds.height,label:event.shiftKey?0:1}]);return;}
    const canvas=maskCanvasRef.current;if(!canvas)return;event.preventDefault();setMaskUndo((current)=>[...current.slice(-9),canvas.toDataURL("image/png")]);const bounds=canvas.getBoundingClientRect();const context=canvas.getContext("2d");if(!context)return;
    const draw=(clientX:number,clientY:number)=>{const x=(clientX-bounds.left)/bounds.width*canvas.width;const y=(clientY-bounds.top)/bounds.height*canvas.height;context.save();context.globalCompositeOperation=maskTool==="erase"?"destination-out":"source-over";context.fillStyle="white";context.beginPath();context.arc(x,y,maskBrush/2,0,Math.PI*2);context.fill();context.restore();setMaskDirty(true);};
    draw(event.clientX,event.clientY);const move=(moveEvent:PointerEvent)=>draw(moveEvent.clientX,moveEvent.clientY);const up=()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up)};window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  };

  const undoMask=async()=>{const snapshot=maskUndo.at(-1);const canvas=maskCanvasRef.current;const context=canvas?.getContext("2d");if(!snapshot||!canvas||!context)return;const image=await loadImage(snapshot);context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);setMaskUndo((current)=>current.slice(0,-1));setMaskDirty(true);setStatus("已撤销上一步蒙版操作")};

  const runSam = async()=>{
    if(!activeMaskKeyframe?.image||samPoints.length===0)return;setSamRunning(true);setStatus("SAM 正在本地分析当前关键帧…");
    try{const canvasBefore=maskCanvasRef.current;if(canvasBefore)setMaskUndo((current)=>[...current.slice(-9),canvasBefore.toDataURL("image/png")]);const response=await fetch(`${API}/segmentation/predict`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({imageUri:activeMaskKeyframe.image,points:samPoints.map((p)=>[p.x,p.y]),labels:samPoints.map((p)=>p.label)})});if(!response.ok)throw new Error(await response.text());const result:{uri:string}=await response.json();const image=await loadImage(`${result.uri}?t=${Date.now()}`);const canvas=maskCanvasRef.current;if(canvas){drawMaskAsAlpha(image,canvas);setMaskDirty(true);setStatus("SAM 蒙版已更新；黑色背景已转换为透明，可继续添加保留点、排除点或手工补画")}}catch(error){setStatus(error instanceof Error?`SAM 失败：${error.message}`:"SAM 分割失败")}finally{setSamRunning(false)}
  };

  const fillMask = (filled:boolean) => {
    const canvas=maskCanvasRef.current;const context=canvas?.getContext("2d");if(!canvas||!context)return;context.clearRect(0,0,canvas.width,canvas.height);if(filled){context.fillStyle="white";context.fillRect(0,0,canvas.width,canvas.height)}setMaskDirty(true);
  };

  const saveActiveMask = async () => {
    if(!shot){setStatus("镜头尚未加载");return;}
    if(!activeMaskKeyframe){setStatus("当前没有选中的关键帧");return;}
    if(!maskCanvasRef.current){setStatus("蒙版画布未就绪");return;}
    const interaction=Boolean(activeInteractionGroup&&activeInteractionKeyframe);
    const targetId=interaction?activeInteractionGroup!.id:primary?.id;
    if(!targetId){setStatus("请先选中一个元素或交互组");return;}
    setStatus("正在保存蒙版…");
    try{
      await saveShot(shot);
      const response=await fetch(`${API}/masks`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,targetType:interaction?"interactionGroup":"element",targetId,keyframeId:activeMaskKeyframe.id,dataUrl:maskCanvasRef.current.toDataURL("image/png")})});
      if(!response.ok){setStatus(`蒙版保存失败：${await response.text()}`);return;}
      setShot(await response.json());setMaskDirty(false);setStatus("蒙版已保存到当前关键状态");
    }catch(error){setStatus(error instanceof Error?error.message:"蒙版保存失败");}
  };

  const exportCutoutPreview = async () => {
    if(!activeMaskKeyframe?.image||!maskCanvasRef.current)return;const image=await loadImage(activeMaskKeyframe.image);const output=document.createElement("canvas");output.width=1280;output.height=720;const context=output.getContext("2d");if(!context)return;context.drawImage(image,0,0,output.width,output.height);context.globalCompositeOperation="destination-in";context.drawImage(maskCanvasRef.current,0,0,output.width,output.height);const preview=window.open();if(preview)preview.document.write(`<img style="max-width:100%;background:repeating-conic-gradient(#333 0 25%,#222 0 50%) 0/20px 20px" src="${output.toDataURL()}"/>`);
  };

  const stagePointerDown = (event: ReactPointerEvent, element: Element) => {
    event.stopPropagation(); const takeover=!event.shiftKey?takeoverFor(element.id):undefined;selectElement(element.id, event.shiftKey); if (element.locked||takeover) return;
    const stage = stageRef.current; if (!stage) return; const start = { pointerX: event.clientX, pointerY: event.clientY, elementX: element.transform.x, elementY: element.transform.y };
    const move = (moveEvent: PointerEvent) => updateElement(element.id, { transform: { ...element.transform, x: Math.max(0, Math.min(1, start.elementX + (moveEvent.clientX-start.pointerX)/stage.clientWidth)), y: Math.max(0, Math.min(1, start.elementY + (moveEvent.clientY-start.pointerY)/stage.clientHeight)) } });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const elementLaneClick = (event:ReactMouseEvent<HTMLDivElement>, element:Element) => {
    const bounds=event.currentTarget.getBoundingClientRect();const frame=Math.max(0,Math.min(shot?.durationFrames??0,Math.round((event.clientX-bounds.left)/bounds.width*(shot?.durationFrames??0))));setPlayhead(frame);
    const takeover=takeoverFor(element.id,frame);if(takeover)openInteractionTakeover(takeover,frame);
  };

  const seekTimeline = (event:ReactMouseEvent<HTMLDivElement>) => {
    if(!shot||(event.target as HTMLElement).closest("button,input,label"))return;
    const bounds=event.currentTarget.getBoundingClientRect();
    setPlayhead(Math.max(0,Math.min(shot.durationFrames,Math.round((event.clientX-bounds.left)/bounds.width*shot.durationFrames))));
    setIsPlaying(false);
  };

  const togglePlayback = () => {
    if(!shot)return;if(playhead>=shot.durationFrames)setPlayhead(0);setIsPlaying((current)=>!current);
  };

  if (!shot) return <div className="loading">{status}</div>;
  const ordered = [...shot.elements].sort((a,b) => (shot.layers.find(l=>l.id===a.layerId)?.order ?? 0) - (shot.layers.find(l=>l.id===b.layerId)?.order ?? 0));
  const visibleInteractionCandidates=shot.interactionGroups.filter((group)=>groupTakesOverAt(group,playhead)&&group.keyframes.some((keyframe)=>keyframe.locked&&keyframe.image&&keyframe.frame<=Math.min(playhead,group.range.end)));
  const visibleInteractionGroup = visibleInteractionCandidates.find((group)=>playhead<=group.range.end)??visibleInteractionCandidates.sort((a,b)=>b.range.end-a.range.end)[0];
  const visibleInteractionKeyframe = activeInteractionKeyframe?.locked&&activeInteractionKeyframe.image ? activeInteractionKeyframe : (!primary ? visibleInteractionGroup?.keyframes.filter((keyframe)=>keyframe.locked&&keyframe.image&&keyframe.frame<=Math.min(playhead,visibleInteractionGroup.range.end)).sort((a,b)=>b.frame-a.frame)[0] : undefined);
  const playingInteractionGroup=playingTransition?.targetType==="interactionGroup"?shot.interactionGroups.find((group)=>group.id===playingTransition.targetId):undefined;
  const hiddenInteractionMembers = new Set(playingInteractionGroup?.members??(visibleInteractionKeyframe ? visibleInteractionGroup?.members : []));shot.interactionGroups.filter((group)=>playhead>group.range.end&&group.exit?.mode==="hideMember"&&group.exit.subjectId).forEach((group)=>hiddenInteractionMembers.add(group.exit!.subjectId!));
  const visibleElementComposite = !visibleInteractionKeyframe ? shot.elements.map((element)=>keyframeAtFrame(element,playhead)).find((keyframe)=>keyframe?.locked&&keyframe.image&&keyframe.state.generatedComposite===true) : undefined;
  const layerFallbackIds = new Set(activeInteractionGroup?.members ?? (primary ? [primary.id] : []));
  const showOriginalLayers = (activeView==="composite" || (activeView==="layer" && !visibleInteractionKeyframe && !visibleElementComposite)) && !(playingVideoUri&&transitionView==="layer");

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">C</span><span>CaveSky</span><small>v0.2</small></div><div className="shot-title"><div className="model-pickers"><label>关键帧<select aria-label="关键帧图片模型" value={imageAdapter} onChange={(event)=>setImageAdapter(event.target.value)}>{adapterCapabilities.filter((item)=>item.kinds.includes("keyframeImage")).map((item)=><option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{item.configured?"":" · 未配置"}</option>)}</select></label><label>过渡<select aria-label="过渡视频模型" value={transitionAdapter} onChange={(event)=>setTransitionAdapter(event.target.value)}>{adapterCapabilities.filter((item)=>item.kinds.includes("transitionVideo")&&item.id!=="mock").map((item)=><option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{item.configured?"":" · 未配置"}</option>)}</select></label><label>规划<select aria-label="动作规划模型" value={planPlanner} onChange={(event)=>setPlanPlanner(event.target.value)}>{plannerCapabilities.map((item)=><option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{item.configured?"":" · 未配置"}</option>)}</select></label></div><div className="shot-selector"><select aria-label="切换镜头" value={shotId} onChange={(event)=>switchShot(event.target.value)}>{shots.map((id)=><option key={id} value={id}>{id}</option>)}</select><button title="新建镜头" onClick={createShot}>＋ 新建</button><b>{(playhead/shot.fps).toFixed(2)}s</b></div></div><button className="quiet-button" onClick={save}><Save size={16}/> 保存</button></header>
    <section className="workspace">
      <aside className="assets-panel">
        <div className="panel-heading"><span>项目资产</span></div>
        <div className="asset-import"><select value={assetKind} onChange={(e)=>setAssetKind(e.target.value as ElementKind)}><option value="character">人物</option><option value="prop">物品</option><option value="background">背景</option><option value="foreground">前景</option></select><label><ImagePlus size={15}/>导入图片<input type="file" accept="image/png,image/jpeg,image/jfif,image/webp" onChange={uploadAsset}/></label></div>
        <div className="asset-library">{assets.length === 0 && <p>导入PNG、JPG或WebP资产</p>}{assets.map((asset)=><button className="library-card" key={asset.id} onClick={()=>addAssetToShot(asset)}><img src={asset.url}/><span>{asset.name}</span><Plus size={14}/></button>)}</div>
        <div className="panel-heading scene-heading"><span>当前镜头</span></div>
        {shot.elements.map((element)=><button className={`asset-row ${selected.includes(element.id)?"selected":""}`} key={element.id} onClick={(e)=>selectElement(element.id,e.shiftKey)}><span className="asset-icon">{iconFor(element.kind)}</span><div><b>{element.name || element.id}</b><small>{element.id}</small></div>{element.locked?<Lock size={13}/>:null}</button>)}
      </aside>
      <section className="stage-column">
        <div className="stage-toolbar"><span><MousePointer2 size={13}/> 点击或Shift多选元素，拖动改变位置</span>{playingVideoUri&&<div className="video-view-switch"><button className={transitionView==="composite"?"active":""} onClick={()=>setTransitionView("composite")}>镜头合成</button><button className={transitionView==="layer"?"active":""} onClick={()=>setTransitionView("layer")}>仅交互动画</button><button className={transitionView==="mask"?"active":""} onClick={()=>setTransitionView("mask")} disabled={!playingMaskUri}>动态蒙版</button><button className={transitionView==="source"?"active":""} onClick={()=>setTransitionView("source")}>生成原视频</button><button className="propagate-mask" disabled={videoMaskJob?.status==="queued"||videoMaskJob?.status==="running"} onClick={generateVideoMask}>{videoMaskJob?.status==="queued"||videoMaskJob?.status==="running"?<LoaderCircle className="spinning" size={12}/>:<Sparkles size={12}/>} {playingMaskUri?"重新生成动态蒙版":"生成动态蒙版"}</button></div>}<span>{status}</span></div>
        <div className="stage real-stage" ref={stageRef} onPointerDown={()=>setSelected([])} style={{background:shot.canvas.backgroundColor}}>
          {showOriginalLayers&&(!visibleElementComposite||Boolean(playingVideoUri)) && ordered.filter(e=>e.visible && !hiddenInteractionMembers.has(e.id) && (activeView==="composite"||layerFallbackIds.has(e.id)) && playhead>=e.activeRange.start && playhead<=e.activeRange.end).map((element)=>{ const asset=assetMap.get(element.assetId); const keyframe=keyframeAtFrame(element,playhead); const image=keyframe?.state.generatedComposite===true?asset?.url:keyframe?.image||asset?.url; if(!image) return null; return <div key={element.id} className={`stage-element ${selected.includes(element.id)?"selected":""}`} onPointerDown={(e)=>stagePointerDown(e,element)} style={{left:`${element.transform.x*100}%`,top:`${element.transform.y*100}%`,transform:`translate(-50%,-50%) scale(${element.transform.scale}) rotate(${element.transform.rotation}deg)`,zIndex:shot.layers.find(l=>l.id===element.layerId)?.order}}><img src={image}/><span>{element.name||element.id}</span></div>})}
          {!playingVideoUri&&visibleElementComposite&&activeView!=="mask"&&<img className={`interaction-stage-layer ${activeKeyframe?.mask&&activeView!=="cutout"?"masked":""}`} style={activeKeyframe?.mask&&activeView!=="cutout"?{maskImage:`url(${activeKeyframe.mask})`,WebkitMaskImage:`url(${activeKeyframe.mask})`,maskMode:"luminance"}:undefined} src={visibleElementComposite.image} alt={activeView==="cutout"?"元素生成原图":"元素派生图层"}/>}
          {!playingVideoUri&&visibleInteractionKeyframe&&activeView!=="mask"&&<img className={`interaction-stage-layer ${visibleInteractionKeyframe.mask&&activeView!=="cutout"?"masked":""}`} style={visibleInteractionKeyframe.mask&&activeView!=="cutout"?{maskImage:`url(${visibleInteractionKeyframe.mask})`,WebkitMaskImage:`url(${visibleInteractionKeyframe.mask})`,maskMode:"luminance"}:undefined} src={visibleInteractionKeyframe.image} alt={activeView==="cutout"?"交互生成原图":"交互派生图层"}/>}
          {visibleInteractionKeyframe&&activeView==="mask"&&visibleInteractionKeyframe.mask&&<img className="interaction-stage-layer mask-stage-layer" src={visibleInteractionKeyframe.mask} alt="交互蒙版"/>}
          {visibleInteractionKeyframe&&activeView==="mask"&&!visibleInteractionKeyframe.mask&&<div className="empty-stage">当前交互关键状态还没有蒙版</div>}
          {!visibleInteractionKeyframe&&activeKeyframe&&activeView==="mask"&&activeKeyframe.mask&&<img className="interaction-stage-layer mask-stage-layer" src={activeKeyframe.mask} alt="元素蒙版"/>}
          {!visibleInteractionKeyframe&&activeKeyframe&&activeView==="mask"&&!activeKeyframe.mask&&<div className="empty-stage">当前元素关键状态还没有蒙版</div>}
          {playingVideoUri&&<video ref={transitionVideoRef} className={`accepted-transition-stage ${transitionView==="source"?"":"processing-media"}`} src={playingVideoUri} muted playsInline preload="auto" aria-label="已采用过渡原视频" onSeeked={drawTransitionLayer} onLoadedMetadata={(event)=>{if(!playingTransition)return;const video=event.currentTarget;const timelineSeconds=(playingTransition.toFrame-playingTransition.fromFrame)/shot.fps;video.playbackRate=timelineSeconds>0?Math.max(.25,Math.min(4,video.duration/timelineSeconds)):1;const progress=(playhead-playingTransition.fromFrame)/(playingTransition.toFrame-playingTransition.fromFrame);video.currentTime=Math.max(0,Math.min(video.duration,progress*video.duration));if(isPlaying)void video.play()}}/>}
          {playingMaskUri&&<video ref={transitionMaskVideoRef} className={`accepted-transition-stage mask-video ${transitionView==="mask"?"":"processing-media"}`} src={playingMaskUri} muted playsInline preload="auto" aria-label="动态视频蒙版" onSeeked={drawTransitionLayer} onLoadedMetadata={drawTransitionLayer}/>} 
          {playingMaskUri&&(transitionView==="composite"||transitionView==="layer")&&<canvas ref={transitionCanvasRef} className="accepted-transition-stage transition-cutout-canvas" aria-label="蒙版后的交互动画"/>}
          {playingVideoUri&&!playingMaskUri&&(transitionView==="composite"||transitionView==="layer")&&<div className="video-mask-required"><b>生成原视频尚未分层</b><span>先生成动态蒙版，模型重绘的背景才不会覆盖锁定场景。</span></div>}
          {shot.elements.length===0 && <div className="empty-stage">从左侧资产库添加第一个元素</div>}
        </div>
        <div className="inspector">
          {primary ? <><div className="inspector-head"><div className="state-heading"><small>元素关键状态</small><b>{primary.name||primary.id} · {activeKeyframe ? `第 ${activeKeyframe.frame} 帧` : "未选择关键帧"}</b></div><div className="view-switch"><button className={elementView==="composite"?"active":""} onClick={()=>setElementView("composite")}><Layers3 size={13}/>合成</button><button className={elementView==="layer"?"active":""} onClick={()=>setElementView("layer")}><Eye size={13}/>仅当前层</button><button className={elementView==="mask"?"active":""} onClick={()=>setElementView("mask")}><Paintbrush size={13}/>蒙版</button><button className={elementView==="cutout"?"active":""} onClick={()=>setElementView("cutout")}><ImagePlus size={13}/>生成原图</button></div><button onClick={()=>updateElement(primary.id,{locked:!primary.locked})}>{primary.locked?<><Unlock size={14}/>解锁</>:<><Lock size={14}/>锁定</>}</button><button className="danger" onClick={()=>removeElement(primary.id)}><Trash2 size={14}/>移除</button></div>
          <div className="field-grid"><label>缩放<input type="range" min="0.2" max="5" step="0.05" value={primary.transform.scale} onChange={(e)=>updateElement(primary.id,{transform:{...primary.transform,scale:+e.target.value}})}/></label><label>出现帧<input type="number" value={primary.activeRange.start} onChange={(e)=>updateElement(primary.id,{activeRange:{...primary.activeRange,start:+e.target.value}})}/></label><label>结束帧<input type="number" value={primary.activeRange.end} onChange={(e)=>updateElement(primary.id,{activeRange:{...primary.activeRange,end:+e.target.value}})}/></label><button onClick={addKeyframe}><Plus size={14}/> 当前帧添加关键帧</button></div>
          {activeKeyframe && <><textarea className="state-description" aria-label="元素关键帧状态描述" placeholder="只描述当前画面可见状态，例如：女孩背对镜头，双手自然下垂" value={activeKeyframe.instruction??""} onChange={(e)=>updateKeyframe(primary.id,activeKeyframe.id,{instruction:e.target.value,locked:false})}/>{activeKeyframe.instruction?.trim()&&<div className="action-group-actions"><label>动作意图<input value={actionIntent} onChange={(event)=>setActionIntent(event.target.value)} placeholder="例如：转身面向镜头并微笑"/></label><label>动作时长（帧）<input type="number" min="1" max={Math.max(1,shot.durationFrames-activeKeyframe.frame)} value={actionDurationFrames} onChange={(event)=>setActionDurationFrames(Math.max(1,+event.target.value||48))}/><small>普通动作建议约 48 帧 / 2 秒；复杂动作可调长</small></label><button disabled={planning||!actionIntent.trim()} onClick={()=>generateActionGroup(activeKeyframe.id)}>{planning?<LoaderCircle className="spinning" size={14}/>:<Wand2 size={14}/>}生成动作组</button><details className="interaction-members"><summary>互动对象 · {interactionTargetIds.length} 个</summary>{shot.elements.filter((element)=>element.id!==primary.id&&element.kind!=="background"&&element.kind!=="foreground").map((element)=><label key={element.id}><input type="checkbox" checked={interactionTargetIds.includes(element.id)} onChange={()=>setInteractionTargetIds((current)=>current.includes(element.id)?current.filter((id)=>id!==element.id):[...current,element.id])}/>{element.name||element.id}</label>)}</details><button disabled={planning||interactionTargetIds.length===0||!actionIntent.trim()} onClick={()=>generateActionGroup(activeKeyframe.id,interactionTargetIds)}><Wand2 size={14}/>生成互动组</button><label className="embellishment">修饰<input type="range" min="0" max="1" step="0.1" value={embellishment} onChange={(event)=>setEmbellishment(+event.target.value)}/><span>{Math.round(embellishment*100)}%</span></label></div>}<div className="interaction-director-actions"><span>关键帧描述当前状态；动作意图描述接下来发生什么。</span><div className="element-generate-actions"><button className="generate-button" disabled={activeKeyframeJob?.status==="queued"||activeKeyframeJob?.status==="running"} onClick={generateElementKeyframe}>{activeKeyframeJob?.status==="queued"||activeKeyframeJob?.status==="running"?<LoaderCircle className="spinning" size={14}/>:<Sparkles size={14}/>}生成两个候选</button><button onClick={generateElementTransition}><Film size={14}/>生成到下一关键帧</button></div></div>
          {activeKeyframeJob?.targetType==="keyframe"&&activeKeyframeJob.status==="succeeded"&&<><div className="generation-receipt">任务 {activeKeyframeJob.id} · 已返回 {activeKeyframeJob.outputs.filter((item)=>item.kind==="image").length} 个候选</div><div className="candidate-strip">{activeKeyframeJob.outputs.filter((item)=>item.kind==="image").map((output,index)=><div className="candidate" key={output.uri}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri:output.uri,index})} title="仅放大预览，不会采用"><img src={output.uri}/><span>点击查看效果</span></button><button onClick={()=>acceptKeyframe(index)}><Check size={13}/>采用到元素轨道</button></div>)}</div></>}
          {activeGenerationHistory.length>0&&<><div className="generation-receipt">此关键帧的历史候选 · {activeGenerationHistory.length} 次任务</div><div className="candidate-strip history">{activeGenerationHistory.flatMap((record)=>record.outputs!.map((uri,index)=><div className="candidate" key={`${record.id}:${index}`}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri,index,generationId:record.id})}><img src={uri}/><span>{record.id}</span></button><button onClick={()=>acceptHistoricalKeyframe(record.id,index)}><Check size={13}/>重新采用</button></div>))}</div></>}
          {activeKeyframeJob?.targetType==="keyframe"&&activeKeyframeJob.status==="failed"&&<div className="generation-error">{activeKeyframeJob.error?.message||activeKeyframeJob.message}</div>}
          {lastAcceptedGeneration&&activeKeyframe&&<button className="revert-generation" onClick={revertAcceptedKeyframe}>撤销刚才采用的候选</button>}
          {activeKeyframe?.image&&maskUndo.length>0&&<button className="revert-generation" onClick={undoMask}>撤销上一步蒙版操作</button>}
          {activeKeyframe?.image&&samMode&&<div className="generation-receipt">智能选择中：点击添加保留点，Shift＋点击排除；Alt＋拖动可同时使用当前画笔或橡皮。</div>}
          {(()=>{const next=primary.keyframes.filter((item)=>item.frame>activeKeyframe.frame).sort((a,b)=>a.frame-b.frame)[0];const jobKey=next?`element:${primary.id}:${activeKeyframe.frame}:${next.frame}`:"";const job=transitionJobs[jobKey];const video=job?.outputs.find((item)=>item.kind==="video");return job?.status==="succeeded"&&video?<div className="element-transition-result"><video src={video.uri} controls/><button onClick={()=>acceptTransition(jobKey)}><Check size={13}/>采用过渡</button></div>:job?.status==="failed"?<div className="generation-error">{job.error?.message||job.message}</div>:null})()}</>}</> : <span>选择一个元素编辑属性；按住Shift选择两个元素建立交互组。</span>}
          {activeKeyframe?.image&&<div className="mask-editor compact"><div className="mask-editor-toolbar"><b>蒙版编辑</b><button className={samMode?"active":""} onClick={()=>{setSamMode(!samMode);setSamPoints([])}}><Sparkles size={13}/>智能选择</button><button disabled={!samMode||samPoints.length===0||samRunning} onClick={runSam}>{samRunning?<LoaderCircle className="spinning" size={13}/>:<Check size={13}/>}生成初始蒙版</button><button className={maskTool==="paint"?"active":""} onClick={()=>setMaskTool("paint")}><Paintbrush size={13}/>画笔</button><button className={maskTool==="erase"?"active":""} onClick={()=>setMaskTool("erase")}><Eraser size={13}/>橡皮</button><label>大小 <input type="range" min="6" max="120" value={maskBrush} onChange={(e)=>setMaskBrush(+e.target.value)}/><span>{maskBrush}px</span></label><button onClick={()=>fillMask(true)}>全选</button><button onClick={()=>fillMask(false)}>清空</button><button disabled={!maskDirty} onClick={saveActiveMask}><Save size={13}/>保存蒙版</button><button onClick={exportCutoutPreview}><Eye size={13}/>单独预览</button></div><div className={`mask-editor-canvas ${samMode?"sam-selecting":""}`}><img src={activeKeyframe.image}/><canvas ref={maskCanvasRef} width={1280} height={720} onPointerDown={maskPointerDown}/>{samMode&&<div className="sam-points">{samPoints.map((p,i)=><i key={i} className={p.label?"positive":"negative"} style={{left:`${p.x*100}%`,top:`${p.y*100}%`}}/>)}</div>}</div>{samMode&&<small>点击保留目标；Shift＋点击排除区域。添加点后生成初始蒙版。</small>}</div>}
        </div>
      </section>
    </section>
    <section className="timeline">
      <div className="timeline-head"><b>元素时间轴</b><span>{shot.fps} fps · 第 {playhead} 帧</span><button className="playback-button" aria-label={isPlaying?"暂停镜头":"播放镜头"} onClick={togglePlayback}>{isPlaying?<Pause size={14}/>:<Play size={14}/>} {isPlaying?"暂停":"播放"}</button></div>
      <div className="ruler-label"/><div className="ruler">{[0,1,2,3,4].map(s=><span key={s} style={{left:`${s*25}%`}}>{s}s</span>)}</div>
      {shot.elements.map((element)=>{const takeovers=shot.interactionGroups.filter((group)=>group.members.includes(element.id));const acceptedTransitions=shot.transitions.filter((item)=>item.targetType==="element"&&item.targetId===element.id&&item.selectedGenerationId);return <div className="track-row" key={element.id}><button className={`track-label ${selected.includes(element.id)?"selected":""} ${takeoverFor(element.id)?"taken-over":""}`} onClick={(e)=>selectElement(element.id,e.shiftKey)}>{iconFor(element.kind)}<span>{element.name||element.id}</span>{takeoverFor(element.id)&&<small>{playhead>takeoverFor(element.id)!.range.end?"退出延续":"交互中"}</small>}</button><div className="track-lane" onClick={(e)=>elementLaneClick(e,element)}><span className="active-span" style={{left:`${element.activeRange.start/shot.durationFrames*100}%`,width:`${(element.activeRange.end-element.activeRange.start)/shot.durationFrames*100}%`}}/>{acceptedTransitions.map((transition)=><span key={transition.id} className="accepted-transition-clip element-video-clip" title="已采用视频片段" style={{left:`${transition.fromFrame/shot.durationFrames*100}%`,width:`${(transition.toFrame-transition.fromFrame)/shot.durationFrames*100}%`}}><Film size={10}/><span>视频</span></span>)}{takeovers.map((group)=><span key={group.id} className="takeover-span" title={`由 ${group.id} 接管：${group.members.map((id)=>shot.elements.find((item)=>item.id===id)?.name||id).join("＋")}`} style={{left:`${group.range.start/shot.durationFrames*100}%`,width:`${(group.range.end-group.range.start)/shot.durationFrames*100}%`}}><span>交互接管</span></span>)}{takeovers.filter(groupContinuesAfterExit).map((group)=><span key={`${group.id}:exit`} className="exit-span" style={{left:`${group.range.end/shot.durationFrames*100}%`,width:`${(shot.durationFrames-group.range.end)/shot.durationFrames*100}%`}}><span>{group.exit.mode==="attachToMember"?`附着 · ${group.exit.anchor||"成员"}`:"保持联合"}</span></span>)}{element.keyframes.map(k=>{const suppressed=Boolean(takeoverFor(element.id,k.frame));return <button aria-label={`${element.name || element.id} 关键帧 ${k.frame}`} title={suppressed?"该关键帧位于交互接管区；点击将打开联合状态":`关键帧 ${k.frame}；左右拖动，右键删除`} className={`keyframe ${suppressed?"suppressed":""}`} key={k.id} style={{left:`${k.frame/shot.durationFrames*100}%`}} onClick={(e)=>e.stopPropagation()} onPointerDown={(e)=>keyframePointerDown(e,element,k.id)} onContextMenu={(e)=>{e.preventDefault();e.stopPropagation();const anchorGroup=shot.interactionGroups.find((g)=>g.anchorKeyframeId===k.id);if(anchorGroup||!suppressed){deleteKeyframe(element,k.frame)}else{const group=takeoverFor(element.id,k.frame);if(group)openInteractionTakeover(group,k.frame)}}}/>})}</div></div>})}
      {shot.interactionGroups.map(group=>{const transitionJob=transitionJobs[group.id];const transition=shot.transitions.find((item)=>item.targetType==="interactionGroup"&&item.targetId===group.id);const accepted=shot.generations.find((item)=>item.id===transition?.selectedGenerationId);return <div className="interaction-row" key={group.id}>
        <div className="interaction-label"><Film size={12}/><span>{group.kind==="action"?"动作组":"互动组"} · {group.id}</span><button className="run-transition" title={`生成整个${group.kind==="action"?"动作组":"互动组"}`} disabled={transitionJob?.status==="queued"||transitionJob?.status==="running"} onClick={()=>generateTransition(group.id)}>{transitionJob?.status==="queued"||transitionJob?.status==="running"?<LoaderCircle className="spinning" size={12}/>:<><Sparkles size={12}/>整组</>}</button><button title={`删除${group.kind==="action"?"动作组":"互动组"}`} onClick={()=>deleteInteraction(group.id)}><Trash2 size={12}/></button></div>
        <div className="interaction-lane" onClick={seekTimeline}>
          {transition?.selectedGenerationId&&accepted&&<button className="accepted-transition-clip" aria-label={`${group.id} 已采用过渡视频`} title="已采用视频片段；点击可将播放头定位到片段" style={{left:`${transition.fromFrame/shot.durationFrames*100}%`,width:`${(transition.toFrame-transition.fromFrame)/shot.durationFrames*100}%`}} onClick={(event)=>{event.stopPropagation();setPlayhead(transition.fromFrame);setIsPlaying(false)}}><Film size={11}/><span>已采用视频</span></button>}
          <div className="interaction-clip" style={{left:`${group.range.start/shot.durationFrames*100}%`,width:`${(group.range.end-group.range.start)/shot.durationFrames*100}%`}}>
            <input aria-label={`${group.id} 动作描述`} value={group.instruction} onChange={(e)=>updateInteraction(group.id,{instruction:e.target.value})}/>
            <span className="range-readonly">第 {group.range.start}–{group.range.end} 帧</span>
          </div>
          {(()=>{const anchor=anchorKeyframeFor(group);return <>{anchor&&<button key={anchor.id} title="首帧（锚点）" aria-label={`${group.id} 首帧 ${anchor.frame}`} className="interaction-keyframe anchor-keyframe" style={{left:`${anchor.frame/shot.durationFrames*100}%`}} onClick={(event)=>event.stopPropagation()} onPointerDown={(event)=>anchorKeyframePointerDown(event,group,anchor)}/>}{group.keyframes.map((keyframe)=><button key={keyframe.id} aria-label={`${group.id} 交互关键状态 ${keyframe.frame}`} className={`interaction-keyframe ${selectedInteractionKeyframe?.keyframeId===keyframe.id?"selected":""} ${keyframe.locked?"locked":""}`} style={{left:`${keyframe.frame/shot.durationFrames*100}%`}} onClick={(event)=>event.stopPropagation()} onPointerDown={(event)=>interactionKeyframePointerDown(event,group,keyframe.id)}/>)}</>})()}
          {transitionJob?.status === "succeeded" && transitionJob.outputs.find((item)=>item.kind==="video") && <div className="transition-result"><video src={transitionJob.outputs.find((item)=>item.kind==="video")?.uri} controls/><button onClick={()=>acceptTransition(group.id)}><Check size={11}/>采用</button></div>}
          {transitionJob?.status === "failed" && <span className="transition-error">生成失败</span>}
        </div>
      </div>})}
      <div className="playhead" style={{left:`calc(156px + (100% - 156px) * ${playhead/shot.durationFrames})`}}/>
    </section>
    {activeInteractionGroup && activeInteractionKeyframe && <section className={`interaction-director-panel ${activeInteractionGroup.kind}`}>
      <div className="interaction-director-head"><div><small>交互图层关键状态</small><b>{activeInteractionGroup.id} · 第 {activeInteractionKeyframe.frame} 帧</b></div><div className="view-switch"><button className={interactionView==="composite"?"active":""} onClick={()=>setInteractionView("composite")}><Layers3 size={13}/>场景合成</button><button className={interactionView==="layer"?"active":""} onClick={()=>setInteractionView("layer")}><Eye size={13}/>仅交互层</button><button className={interactionView==="mask"?"active":""} onClick={()=>setInteractionView("mask")}><Paintbrush size={13}/>此状态蒙版</button><button className={interactionView==="cutout"?"active":""} onClick={()=>setInteractionView("cutout")}><ImagePlus size={13}/>生成原图</button></div><button onClick={()=>addInteractionKeyframe(activeInteractionGroup.id)}><Plus size={14}/>在播放头添加状态</button></div>
      <div className={`takeover-notice ${activeInteractionGroup.kind}`}><Layers3 size={14}/><div><b>{activeInteractionGroup.kind==="action"?`${shot.elements.find((item)=>item.id===activeInteractionGroup.members[0])?.name||activeInteractionGroup.members[0]} 的动作` : activeInteractionGroup.members.map((id)=>shot.elements.find((item)=>item.id===id)?.name||id).join(" 正在与 ")}</b><span>{activeInteractionGroup.kind==="action"?`第 ${activeInteractionGroup.range.start}–${activeInteractionGroup.range.end} 帧继续输出到原元素语义层。`:`第 ${activeInteractionGroup.range.start}–${activeInteractionGroup.range.end} 帧由联合互动层接管；成员独立输出在此区间暂停。`}</span></div></div>
      <div className="exit-editor"><b>交互结束后</b><select aria-label="交互结束方式" value={activeInteractionGroup.exit.mode} onChange={(event)=>{const mode=event.target.value as Shot["interactionGroups"][number]["exit"]["mode"];const subjectId=activeInteractionGroup.exit.subjectId??activeInteractionGroup.members[1];const targetId=activeInteractionGroup.exit.targetId??activeInteractionGroup.members.find((id)=>id!==subjectId);updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,mode,subjectId:mode==="attachToMember"||mode==="hideMember"?subjectId:null,targetId:mode==="attachToMember"?targetId:null,anchor:mode==="attachToMember"?(activeInteractionGroup.exit.anchor||"rightHand"):null}})}}><option value="restoreIndependent">恢复成员独立轨道</option><option value="keepMerged">保持联合图层</option><option value="attachToMember">一个成员附着到另一个成员</option><option value="hideMember">隐藏一个成员</option></select>{(activeInteractionGroup.exit.mode==="attachToMember"||activeInteractionGroup.exit.mode==="hideMember")&&<label>对象<select aria-label="退出状态对象" value={activeInteractionGroup.exit.subjectId??activeInteractionGroup.members[1]} onChange={(event)=>updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,subjectId:event.target.value}})}>{activeInteractionGroup.members.map((id)=><option key={id} value={id}>{shot.elements.find((item)=>item.id===id)?.name||id}</option>)}</select></label>}{activeInteractionGroup.exit.mode==="attachToMember"&&<><label>附着到<select aria-label="附着目标" value={activeInteractionGroup.exit.targetId??activeInteractionGroup.members[0]} onChange={(event)=>updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,targetId:event.target.value}})}>{activeInteractionGroup.members.filter((id)=>id!==activeInteractionGroup.exit.subjectId).map((id)=><option key={id} value={id}>{shot.elements.find((item)=>item.id===id)?.name||id}</option>)}</select></label><label>位置<select aria-label="附着位置" value={activeInteractionGroup.exit.anchor??"rightHand"} onChange={(event)=>updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,anchor:event.target.value}})}><option value="rightHand">右手</option><option value="leftHand">左手</option><option value="head">头部</option><option value="leftFoot">左脚</option><option value="rightFoot">右脚</option><option value="body">身体</option></select></label></>}</div>
      <textarea aria-label="交互关键帧状态描述" placeholder="描述人物和物品在这一帧的联合状态，例如：女孩右手握住杯柄，但杯底仍接触桌面" value={activeInteractionKeyframe.instruction ?? ""} onChange={(e)=>updateInteractionKeyframe(activeInteractionGroup.id,activeInteractionKeyframe.id,{instruction:e.target.value,locked:false})}/>
      <div className="generation-receipt">{activeInteractionGroup.keyframes.at(-1)?.image&&activeInteractionGroup.keyframes.at(-1)?.locked?"可生成视频：首尾图片均已采用":"规划完成，但尚不可生成视频：请生成并采用尾帧图片"}</div>
      {(shot.planningHistory??[]).filter((record)=>record.groupId===activeInteractionGroup.id).map((record)=><details key={record.id} className="planning-history"><summary>规划历史 · {record.id} · {record.planner}</summary><b>原始请求</b><pre>{JSON.stringify(record.rawRequest,null,2)}</pre><b>语言模型原始回复</b><pre>{record.rawResponse}</pre></details>)}
      <div className="node-identity"><b>{activeInteractionKeyframe.sourceKind==="acceptedVideoFrame"?"视频实际抽帧":activeInteractionKeyframe.generationBoundary?"强制生成边界":activeInteractionKeyframe.image?"可选规划图":"仅描述"}</b><span>{activeInteractionKeyframe.image?"已有图片":"无需图片"}</span><button onClick={()=>toggleGenerationBoundary(activeInteractionGroup.id,activeInteractionKeyframe.id)}>{activeInteractionKeyframe.generationBoundary?"改为描述节点":"设为生成边界"}</button><button onClick={extractAcceptedFrame}><Film size={12}/>抽取实际帧</button><button className="danger" onClick={()=>deleteInteractionKeyframe(activeInteractionGroup.id,activeInteractionKeyframe.id)}><Trash2 size={12}/>删除节点</button></div>
      <label className="transition-desc">到下一状态的动作<input value={(activeInteractionKeyframe.state.transitionToNext as string) ?? ""} onChange={(e)=>updateInteractionKeyframe(activeInteractionGroup.id,activeInteractionKeyframe.id,{state:{...activeInteractionKeyframe.state,transitionToNext:e.target.value}})}/></label>
      <div className="interaction-director-actions"><span>系统自动附带完整镜头、角色和物品参考，并锁定画风、背景和机位。</span><div className="element-generate-actions"><button className="generate-button" disabled={activeKeyframeJob?.status==="queued"||activeKeyframeJob?.status==="running"} onClick={generateKeyframe}>{activeKeyframeJob?.status==="queued"||activeKeyframeJob?.status==="running"?<LoaderCircle className="spinning" size={14}/>:<Sparkles size={14}/>} {activeInteractionKeyframe.renderPolicy==="required"?"生成并采用尾帧":"生成两个候选"}</button><button onClick={generateInteractionToNext}><Film size={14}/>生成到下一关键帧</button></div></div>
      {activeKeyframeJob?.status === "succeeded" && <><div className="generation-receipt">任务 {activeKeyframeJob.id} · 已返回 {activeKeyframeJob.outputs.filter((item)=>item.kind==="image").length} 个候选</div><div className="candidate-strip">{activeKeyframeJob.outputs.filter((item)=>item.kind==="image").map((output,index)=><div className="candidate" key={output.uri}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri:output.uri,index})} title="仅放大预览，不会采用"><img src={output.uri}/><span>点击查看效果</span></button><button onClick={()=>acceptKeyframe(index)}><Check size={13}/>采用到交互图层</button></div>)}</div></>}
      {activeGenerationHistory.length>0&&<><div className="generation-receipt">此交互状态的历史候选 · {activeGenerationHistory.length} 次任务</div><div className="candidate-strip history">{activeGenerationHistory.flatMap((record)=>record.outputs!.map((uri,index)=><div className="candidate" key={`${record.id}:${index}`}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri,index,generationId:record.id})}><img src={uri}/><span>{record.id}</span></button><button onClick={()=>acceptHistoricalKeyframe(record.id,index)}><Check size={13}/>重新采用</button></div>))}</div></>}
      {activeTransitionHistory.length>0&&<div className="transition-history"><div className="generation-receipt">本段过渡视频历史 · {activeTransitionHistory.length} 个版本</div><div className="transition-history-list">{activeTransitionHistory.flatMap((record)=>(record.outputs?.length?record.outputs:[record.output!]).map((uri)=><div className="transition-history-item" key={`${record.id}:${uri}`}><video src={uri} controls preload="metadata"/><div><span>{record.id}{record.status==="accepted"?" · 已采用":""}</span><button onClick={()=>acceptHistoricalTransition(record.id)}><Check size={13}/>采用此版本</button></div></div>))}</div></div>}
      {activeKeyframeJob?.status === "failed" && <div className="generation-error">{activeKeyframeJob.error?.message || activeKeyframeJob.message}</div>}
      {lastAcceptedGeneration&&<button className="revert-generation" onClick={revertAcceptedKeyframe}>撤销刚才采用的候选</button>}
      {activeInteractionKeyframe.image&&maskUndo.length>0&&<button className="revert-generation" onClick={undoMask}>撤销上一步蒙版操作</button>}
      {activeInteractionKeyframe.image&&samMode&&<div className="generation-receipt">智能选择中：点击添加保留点，Shift＋点击排除；Alt＋拖动可同时使用当前画笔或橡皮。</div>}
      {activeInteractionKeyframe.image&&<div className="mask-editor"><div className="mask-editor-toolbar"><b>蒙版编辑</b><button className={samMode?"active":""} onClick={()=>{setSamMode(!samMode);setSamPoints([])}}><Sparkles size={13}/>智能选择</button><button disabled={!samMode||samPoints.length===0||samRunning} onClick={runSam}>{samRunning?<LoaderCircle className="spinning" size={13}/>:<Check size={13}/>}生成初始蒙版</button><button className={maskTool==="paint"?"active":""} onClick={()=>setMaskTool("paint")}><Paintbrush size={13}/>画笔</button><button className={maskTool==="erase"?"active":""} onClick={()=>setMaskTool("erase")}><Eraser size={13}/>橡皮</button><label>大小 <input type="range" min="6" max="120" value={maskBrush} onChange={(e)=>setMaskBrush(+e.target.value)}/><span>{maskBrush}px</span></label><button onClick={()=>fillMask(true)}>全选</button><button onClick={()=>fillMask(false)}>清空</button><button disabled={!maskDirty} onClick={saveActiveMask}><Save size={13}/>保存蒙版</button><button onClick={exportCutoutPreview}><Eye size={13}/>单独预览</button></div><div className={`mask-editor-canvas ${samMode?"sam-selecting":""}`} ref={maskEditorRef}><img src={activeInteractionKeyframe.image}/><canvas ref={maskCanvasRef} width={1280} height={720} onPointerDown={maskPointerDown}/>{samMode&&<div className="sam-points">{samPoints.map((p,i)=><i key={i} className={p.label?"positive":"negative"} style={{left:`${p.x*100}%`,top:`${p.y*100}%`}}/>)}</div>}</div><small>{samMode?"点击保留人物或物品；Shift＋点击排除背景。":"白色区域保留为交互图层，透明区域显示下方锁定图层。SAM 生成初始蒙版后仍可用画笔修正。"}</small></div>}
    </section>}
    {playingGeneration&&<section className="quality-review"><b>生成结果质检</b>{Object.entries({identityConsistent:"身份一致",handednessConsistent:"左右手正确",limbsValid:"肢体无变形",backgroundStable:"背景稳定",speedNatural:"速度自然"}).map(([key,label])=><label key={key}><input type="checkbox" checked={qualityChecks[key as keyof typeof qualityChecks]} onChange={()=>setQualityChecks((current)=>({...current,[key]:!current[key as keyof typeof current]}))}/>{label}</label>)}<input value={rejectionReason} onChange={(event)=>setRejectionReason(event.target.value)} placeholder="拒绝原因及再次生成建议"/><button onClick={()=>submitQualityReview("accepted")}>通过质检</button><button className="danger" onClick={()=>submitQualityReview("rejected")}>拒绝此版本</button></section>}
    {pendingGeneration&&<div className="candidate-modal" role="dialog" aria-modal="true" aria-label="Wan 提交预览"><div className="candidate-modal-card generation-preview"><div className="generation-endpoints"><figure><img src={pendingGeneration.firstImage}/><figcaption>首图</figcaption></figure><figure><img src={pendingGeneration.lastImage}/><figcaption>尾图</figcaption></figure></div><p>模型：{pendingGeneration.quote.adapter} · 时间轴 {pendingGeneration.quote.timelineSeconds}s · 请求 {pendingGeneration.quote.requestSeconds}s · 播放速度 {pendingGeneration.quote.playbackSpeedRatio.toFixed(2)}×</p><p>预计费用：{pendingGeneration.quote.estimatedCostCny==null?"以模型账单为准":`¥${pendingGeneration.quote.estimatedCostCny.toFixed(2)}`}{pendingGeneration.quote.durationWarning?` · 时长差 ${pendingGeneration.quote.durationRatio.toFixed(1)}×`:""}</p><textarea readOnly value={pendingGeneration.quote.finalPrompt}/><footer><button onClick={cancelPendingGeneration}>取消，不提交</button><button className="accept-preview" onClick={confirmPendingGeneration}>确认并提交 Wan</button></footer></div></div>}
    {previewCandidate&&<div className="candidate-modal" role="dialog" aria-modal="true" aria-label="候选图片预览" onClick={()=>setPreviewCandidate(null)}><div className="candidate-modal-card" onClick={(event)=>event.stopPropagation()}><img src={previewCandidate.uri} alt={`候选图片 ${previewCandidate.index+1}`}/><footer><span>候选 {previewCandidate.index+1} · 这里只是预览，不会修改关键帧</span><button onClick={()=>setPreviewCandidate(null)}>关闭</button><button className="accept-preview" onClick={()=>previewCandidate.generationId?acceptHistoricalKeyframe(previewCandidate.generationId,previewCandidate.index):acceptKeyframe(previewCandidate.index)}><Check size={13}/>采用这张</button></footer></div></div>}
  </main>;
}
