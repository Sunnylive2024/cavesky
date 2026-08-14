import { ChangeEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Box, Check, Eraser, Eye, Film, ImagePlus, Layers3, LoaderCircle, Lock, MousePointer2, Paintbrush, Pause, Play, Plus, Save, Sparkles, Trash2, Unlock, UserRound } from "lucide-react";
import type { AdapterCapability, Asset, Element, ElementKind, GenerationJob, Shot, VisualKeyframe } from "./types";

const API = "/api";
const iconFor = (kind: ElementKind) => kind === "character" ? <UserRound size={15}/> : kind === "prop" ? <Box size={15}/> : <Layers3 size={15}/>;
const layerFor = (kind: ElementKind) => kind === "background" ? "BG" : kind === "foreground" ? "FG" : "CONTENT";
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export function App() {
  const [shot, setShot] = useState<Shot | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [playhead, setPlayhead] = useState(24);
  const [status, setStatus] = useState("正在加载镜头…");
  const [assetKind, setAssetKind] = useState<ElementKind>("character");
  const [selectedKeyframe, setSelectedKeyframe] = useState<{ elementId: string; keyframeId: string } | null>(null);
  const [selectedInteractionKeyframe, setSelectedInteractionKeyframe] = useState<{ groupId: string; keyframeId: string } | null>(null);
  const [keyframeJob, setKeyframeJob] = useState<GenerationJob | null>(null);
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
  const [transitionAdapter,setTransitionAdapter]=useState("wan-kf2v");
  const [transitionView,setTransitionView]=useState<"composite"|"layer"|"mask"|"source">("composite");
  const [videoMaskJob,setVideoMaskJob]=useState<{id:string;status:string;progress:number;message:string;maskUri?:string}|null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const transitionVideoRef = useRef<HTMLVideoElement>(null);
  const transitionMaskVideoRef = useRef<HTMLVideoElement>(null);
  const transitionCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskEditorRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const [shotResponse, assetResponse, adapterResponse] = await Promise.all([fetch(`${API}/shots/SH001`), fetch(`${API}/assets`), fetch(`${API}/generation-adapters`)]);
    if (!shotResponse.ok) throw new Error("镜头加载失败");
    setShot(await shotResponse.json());
    setAssets(assetResponse.ok ? await assetResponse.json() : []);
    if(adapterResponse.ok)setAdapterCapabilities(await adapterResponse.json());
    setStatus("已载入真实镜头工程");
  };
  useEffect(() => { load().catch((error) => setStatus(error.message)); }, []);
  const refreshShot = async () => { const response=await fetch(`${API}/shots/SH001`);if(response.ok)setShot(await response.json()); };

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
  const activeView = activeInteractionKeyframe ? interactionView : elementView;
  const activeGenerationHistory = (shot?.generations ?? []).filter((item)=>item.keyframeId===activeMaskKeyframe?.id&&item.outputs?.length);
  const activeInteractionTransition = shot?.transitions.find((item)=>item.targetType==="interactionGroup"&&item.targetId===activeInteractionGroup?.id);
  const activeTransitionHistory = (shot?.generations ?? []).filter((item)=>item.type==="transition"&&(item.transitionId===activeInteractionTransition?.id||item.targetId===activeInteractionGroup?.id)&&(item.outputs?.length||item.output));
  const playingTransition = shot?.transitions.find((item)=>item.selectedGenerationId&&playhead>=item.fromFrame&&playhead<=item.toFrame);
  const playingGeneration = shot?.generations.find((item)=>item.id===playingTransition?.selectedGenerationId);
  const playingVideoUri = playingGeneration?.output??playingGeneration?.outputs?.[0];
  const playingMaskUri = playingGeneration?.maskOutput;

  const drawTransitionLayer=()=>{const video=transitionVideoRef.current;const mask=transitionMaskVideoRef.current;const canvas=transitionCanvasRef.current;if(!video||!mask||!canvas||video.readyState<2||mask.readyState<2)return;canvas.width=video.videoWidth;canvas.height=video.videoHeight;const context=canvas.getContext("2d");if(!context)return;context.clearRect(0,0,canvas.width,canvas.height);context.globalCompositeOperation="source-over";context.drawImage(video,0,0,canvas.width,canvas.height);context.globalCompositeOperation="destination-in";context.drawImage(mask,0,0,canvas.width,canvas.height);context.globalCompositeOperation="source-over";};

  useEffect(()=>{
    const video=transitionVideoRef.current;const mask=transitionMaskVideoRef.current;if(!video||!playingTransition||!playingVideoUri||isPlaying)return;
    const seek=()=>{if(Number.isFinite(video.duration)&&video.duration>0){const progress=(playhead-playingTransition.fromFrame)/(playingTransition.toFrame-playingTransition.fromFrame);video.currentTime=Math.max(0,Math.min(video.duration,progress*video.duration));if(mask&&Number.isFinite(mask.duration))mask.currentTime=Math.max(0,Math.min(mask.duration,progress*mask.duration));}};
    if(video.readyState>=1)seek();else video.addEventListener("loadedmetadata",seek,{once:true});
    return()=>video.removeEventListener("loadedmetadata",seek);
  },[playhead,playingTransition?.id,playingVideoUri,playingMaskUri,isPlaying]);

  useEffect(()=>{
    const video=transitionVideoRef.current;const mask=transitionMaskVideoRef.current;if(!video)return;
    if(isPlaying){void video.play().catch(()=>setIsPlaying(false));if(mask)void mask.play();}else{video.pause();mask?.pause();}
  },[isPlaying,playingVideoUri,playingMaskUri]);

  useEffect(()=>{if(!isPlaying||!playingMaskUri)return;let animation=0;const draw=()=>{drawTransitionLayer();animation=requestAnimationFrame(draw)};draw();return()=>cancelAnimationFrame(animation)},[isPlaying,playingMaskUri]);

  useEffect(()=>{
    if(!isPlaying||!shot)return;
    const timer=window.setInterval(()=>setPlayhead((current)=>{if(current>=shot.durationFrames){setIsPlaying(false);return shot.durationFrames;}return current+1;}),1000/shot.fps);
    return()=>window.clearInterval(timer);
  },[isPlaying,shot?.durationFrames,shot?.fps]);

  useEffect(()=>{
    const canvas=maskCanvasRef.current;if(!activeMaskKeyframe||!canvas)return;const context=canvas.getContext("2d");if(!context)return;
    context.clearRect(0,0,canvas.width,canvas.height);setMaskDirty(false);
    if(activeMaskKeyframe.mask){const image=new Image();image.onload=()=>context.drawImage(image,0,0,canvas.width,canvas.height);image.src=activeMaskKeyframe.mask;}
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

  const openInteractionTakeover = (group:Shot["interactionGroups"][number], frame=playhead) => {
    const keyframe=[...group.keyframes].sort((a,b)=>Math.abs(a.frame-frame)-Math.abs(b.frame-frame))[0];
    setSelected([]);setSelectedKeyframe(null);setKeyframeJob(null);setPlayhead(frame);
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
      keyframes: [{ id: uid("KF"), frame: playhead, image: asset.url, state: {}, locked: false }],
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
    const keyframe: VisualKeyframe = { id: uid("KF"), frame: playhead, image: nearest?.image ?? assetMap.get(primary.assetId)?.url ?? "", state: {}, locked: false };
    updateElement(primary.id, { keyframes: [...primary.keyframes, keyframe].sort((a,b) => a.frame-b.frame) }); setStatus(`已在第 ${playhead} 帧添加视觉关键帧`);
    setSelectedKeyframe({ elementId: primary.id, keyframeId: keyframe.id });
  };

  const deleteKeyframe = (element: Element, frame: number) => { updateElement(element.id, { keyframes: element.keyframes.filter((item) => item.frame !== frame) }); setStatus("关键帧已删除"); };

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

  const createInteraction = () => {
    if (!shot || selected.length < 2) { setStatus("请按住 Shift 选择至少两个元素"); return; }
    const start = Math.max(0, playhead); const end = Math.min(shot.durationFrames, start + 48); const groupId = uid("IG");
    const conflict=shot.interactionGroups.find((group)=>group.members.some((id)=>selected.includes(id))&&start<=group.range.end&&end>=group.range.start);
    if(conflict){setStatus(`无法创建：选中元素在这段时间已由 ${conflict.id} 接管`);return;}
    setShot({ ...shot,
      interactionGroups: [...shot.interactionGroups, { id: groupId, members: selected, range: { start, end }, instruction: "描述这段交互动作", contextPolicy: "referenceOnly", outputMode: "mergedRgba", exit:{mode:"restoreIndependent"}, keyframes: [
        {id:uid("IKF"),frame:start,image:"",instruction:"描述交互开始时的人物与物品状态",state:{},locked:false},
        {id:uid("IKF"),frame:end,image:"",instruction:"描述交互结束时的人物与物品状态",state:{},locked:false},
      ] }],
      transitions: [...shot.transitions, { id: uid("TR"), targetType: "interactionGroup", targetId: groupId, fromFrame: start, toFrame: end, instruction: "描述这段交互动作", strategy: "auto", selectedGenerationId: null }]
    }); setStatus("交互组已创建");
  };

  const updateInteraction = (groupId: string, patch: Partial<Shot["interactionGroups"][number]>) => {
    if (!shot) return;
    const current = shot.interactionGroups.find((group) => group.id === groupId);
    if (!current) return;
    const next = { ...current, ...patch };
    const safeStart = Math.max(0, Math.min(shot.durationFrames - 1, next.range.start));
    const safeEnd = Math.max(safeStart + 1, Math.min(shot.durationFrames, next.range.end));
    next.range = { start: safeStart, end: safeEnd };
    const conflict=shot.interactionGroups.find((group)=>group.id!==groupId&&group.members.some((id)=>next.members.includes(id))&&safeStart<=group.range.end&&safeEnd>=group.range.start);
    if(conflict){setStatus(`无法重叠：成员元素已由 ${conflict.id} 接管`);return;}
    next.keyframes = next.keyframes.map((keyframe,index,array)=>({
      ...keyframe,
      frame: keyframe.frame < safeStart ? safeStart : keyframe.frame > safeEnd ? safeEnd : keyframe.frame,
    })).filter((keyframe,index,array)=>array.findIndex((item)=>item.frame===keyframe.frame)===index);
    setShot({
      ...shot,
      interactionGroups: shot.interactionGroups.map((group) => group.id === groupId ? next : group),
      transitions: shot.transitions.map((transition) => transition.targetType === "interactionGroup" && transition.targetId === groupId
        ? { ...transition, fromFrame: next.range.start, toFrame: next.range.end, instruction: next.instruction }
        : transition),
    });
    setStatus("交互动作已修改，记得保存");
  };

  const deleteInteraction = (groupId: string) => {
    if (!shot) return;
    setShot({
      ...shot,
      interactionGroups: shot.interactionGroups.filter((group) => group.id !== groupId),
      transitions: shot.transitions.filter((transition) => !(transition.targetType === "interactionGroup" && transition.targetId === groupId)),
    });
    setStatus("交互动作及对应过渡任务已删除，记得保存");
  };

  const addInteractionKeyframe = (groupId: string) => {
    if (!shot) return; const group = shot.interactionGroups.find((item)=>item.id===groupId); if (!group) return;
    if (playhead < group.range.start || playhead > group.range.end) { setStatus("播放头需要位于交互区间内"); return; }
    if (group.keyframes.some((item)=>item.frame===playhead)) { setStatus("交互图层当前帧已有关键状态"); return; }
    const keyframe: VisualKeyframe = {id:uid("IKF"),frame:playhead,image:"",instruction:"",state:{},locked:false};
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

  const generateKeyframe = async () => {
    if (!shot || !activeInteractionGroup || !activeInteractionKeyframe) return;
    const instruction = activeInteractionKeyframe.instruction?.trim(); if (!instruction) { setStatus("请先填写交互关键状态"); return; }
    try {
      setStatus("正在整理关键帧上下文…"); await saveShot(shot);
      const references:string[]=[];
      const previousInGroup=activeInteractionGroup.keyframes.filter((item)=>item.frame<activeInteractionKeyframe.frame&&item.locked&&item.image).sort((a,b)=>b.frame-a.frame)[0];
      const previousGroup=!previousInGroup?[...shot.interactionGroups].filter((group)=>group.id!==activeInteractionGroup.id&&group.range.end<activeInteractionKeyframe.frame&&group.members.some((id)=>activeInteractionGroup.members.includes(id))).sort((a,b)=>b.range.end-a.range.end).find((group)=>group.keyframes.some((item)=>item.locked&&item.image)):undefined;
      const previousExit=previousGroup?.keyframes.filter((item)=>item.locked&&item.image).sort((a,b)=>b.frame-a.frame)[0];
      const continuityReference=previousInGroup?.image||previousExit?.image;
      if(continuityReference)references.push(await imageAsDataUrl(continuityReference));
      references.push(await renderFrame(activeInteractionKeyframe.frame, false));
      for (const memberId of activeInteractionGroup.members) { if(references.length>=3)break;const member=shot.elements.find((item)=>item.id===memberId); const src=member&&imageAtFrame(member,activeInteractionKeyframe.frame); if(src) references.push(await imageAsDataUrl(src)); }
      const response = await fetch(`${API}/keyframe-generations`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
        shotId:shot.id, targetType:"interactionGroup", targetId:activeInteractionGroup.id, keyframeId:activeInteractionKeyframe.id, instruction:continuityReference?`以上一张已确认交互状态为连续性基准，只推进到当前目标状态：${instruction}`:instruction, referenceImages:references.slice(0,3), candidateCount:2, promptExtend:false, adapter:imageAdapter,
      }) });
      if (!response.ok) throw new Error(await response.text());
      const job: GenerationJob = await response.json(); setKeyframeJob(job); setStatus("Wan 2.7 Image 正在生成两个候选关键帧…");
      watchJob(job.id, (next) => { setKeyframeJob(next);if(next.status==="succeeded")void refreshShot(); setStatus(next.status === "succeeded" ? "关键帧候选已生成并保存到此状态的历史" : next.status === "failed" ? `生成失败：${next.error?.message || next.message}` : "Wan 2.7 Image 正在生成关键帧…"); });
    } catch (error) { setStatus(error instanceof Error ? error.message : "关键帧生成失败"); }
  };

  const generateElementKeyframe = async () => {
    if(!shot||!primary||!activeKeyframe)return; const instruction=activeKeyframe.instruction?.trim(); if(!instruction){setStatus("请先填写元素关键帧状态描述");return;}
    try{
      setStatus("正在整理元素关键帧上下文…"); await saveShot(shot);
      const references=[await renderFrame(activeKeyframe.frame,false)]; const assetImage=assetMap.get(primary.assetId)?.url; if(assetImage)references.push(await imageAsDataUrl(assetImage));
      const previous=primary.keyframes.filter((item)=>item.frame<activeKeyframe.frame&&item.image).sort((a,b)=>b.frame-a.frame)[0]; if(previous?.image)references.push(await imageAsDataUrl(previous.image));
      const response=await fetch(`${API}/keyframe-generations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,targetType:"element",targetId:primary.id,keyframeId:activeKeyframe.id,instruction,referenceImages:references.slice(0,3),candidateCount:2,promptExtend:false,adapter:imageAdapter})});
      if(!response.ok)throw new Error(await response.text()); const job:GenerationJob=await response.json(); setKeyframeJob(job);setStatus("Wan 2.7 Image 正在生成元素关键状态…");
      watchJob(job.id,(next)=>{setKeyframeJob(next);if(next.status==="succeeded")void refreshShot();setStatus(next.status==="succeeded"?"元素关键帧候选已生成并保存到此状态的历史":next.status==="failed"?`生成失败：${next.error?.message||next.message}`:"Wan 2.7 Image 正在生成元素关键状态…");});
    }catch(error){setStatus(error instanceof Error?error.message:"元素关键帧生成失败");}
  };

  const generateElementTransition = async () => {
    if(!shot||!primary||!activeKeyframe)return; const next=primary.keyframes.filter((item)=>item.frame>activeKeyframe.frame).sort((a,b)=>a.frame-b.frame)[0]; if(!next){setStatus("当前关键帧后面没有下一关键帧");return;}
    try{
      let transition=shot.transitions.find((item)=>item.targetType==="element"&&item.targetId===primary.id&&item.fromFrame===activeKeyframe.frame&&item.toFrame===next.frame);
      const snapshot:Shot=transition?shot:{...shot,transitions:[...shot.transitions,{id:uid("TR"),targetType:"element",targetId:primary.id,fromFrame:activeKeyframe.frame,toFrame:next.frame,instruction:`${activeKeyframe.instruction||"当前状态"}，自然过渡到：${next.instruction||"下一状态"}`,strategy:"aiVideo",selectedGenerationId:null}]};
      transition=transition??snapshot.transitions.at(-1)!; setShot(snapshot);await saveShot(snapshot);setStatus("正在准备元素首尾帧…");
      const [firstImage,lastImage]=await Promise.all([renderFrame(activeKeyframe.frame),renderFrame(next.frame)]); const jobKey=`element:${primary.id}:${activeKeyframe.frame}:${next.frame}`;
      const response=await fetch(`${API}/generations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:snapshot.id,transitionId:transition.id,adapter:transitionAdapter,parameters:{firstImage,lastImage,resolution:transitionAdapter==="wan-i2v-2.7"?"720P":"480P",duration:Math.max(2,Math.min(15,Math.round((transition.toFrame-transition.fromFrame)/snapshot.fps))),promptExtend:false}})});if(!response.ok)throw new Error(await response.text());const job:GenerationJob=await response.json();setTransitionJobs((current)=>({...current,[jobKey]:job}));setStatus("Wan 正在生成元素过渡…");watchJob(job.id,(nextJob)=>{setTransitionJobs((current)=>({...current,[jobKey]:nextJob}));setStatus(nextJob.status==="succeeded"?"元素过渡视频已生成":nextJob.status==="failed"?`过渡失败：${nextJob.error?.message||nextJob.message}`:"Wan 正在生成元素过渡…");});
    }catch(error){setStatus(error instanceof Error?error.message:"元素过渡生成失败");}
  };

  const acceptKeyframe = async (outputIndex: number) => {
    if (!keyframeJob) return; setStatus("正在接受关键帧…");
    const response = await fetch(`${API}/keyframe-generations/accept`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:keyframeJob.id,shotId:shot?.id,outputIndex})});
    if (!response.ok) { setStatus(`接受失败：${await response.text()}`); return; }
    const acceptedId=keyframeJob.id;const saved: Shot = await response.json(); setShot(saved); const wasInteraction=keyframeJob.targetType==="interactionKeyframe";setLastAcceptedGeneration(acceptedId);setPreviewCandidate(null);setKeyframeJob(null); setStatus(wasInteraction?"候选图已写入交互图层；可以撤销返回":"候选图已写入元素关键帧；可以撤销返回");
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
      const group=shot.interactionGroups.find((item)=>item.id===groupId); const first=group?.keyframes.find((item)=>item.frame===transition.fromFrame&&item.locked&&item.image); const last=group?.keyframes.find((item)=>item.frame===transition.toFrame&&item.locked&&item.image);
      if(!first||!last){setStatus("请先生成并采用交互图层的首、尾关键状态");return;}
      setStatus("正在准备交互图层首尾帧…"); await saveShot(shot);
      const [firstImage,lastImage] = await Promise.all([imageAsDataUrl(first.image),imageAsDataUrl(last.image)]);
      const response = await fetch(`${API}/generations`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,transitionId:transition.id,adapter:transitionAdapter,parameters:{firstImage,lastImage,resolution:transitionAdapter==="wan-i2v-2.7"?"720P":"480P",duration:Math.max(2,Math.min(15,Math.round((transition.toFrame-transition.fromFrame)/shot.fps))),promptExtend:false}})});
      if (!response.ok) throw new Error(await response.text()); const job: GenerationJob = await response.json();
      setTransitionJobs((current)=>({...current,[groupId]:job})); setStatus("Wan 已收到任务，生成通常需要数分钟");
      watchJob(job.id,(next)=>{setTransitionJobs((current)=>({...current,[groupId]:next}));setStatus(next.status==="succeeded"?"过渡视频已生成":next.status==="failed"?`过渡失败：${next.error?.message||next.message}`:"Wan 正在生成过渡视频…");});
    } catch(error) { setStatus(error instanceof Error?error.message:"过渡生成失败"); }
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
    const response=await fetch(`${API}/video-mask-jobs`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,generationId:playingGeneration.id,maxWidth:320,chunkFrames:16})});
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
    try{const canvasBefore=maskCanvasRef.current;if(canvasBefore)setMaskUndo((current)=>[...current.slice(-9),canvasBefore.toDataURL("image/png")]);const response=await fetch(`${API}/segmentation/predict`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({imageUri:activeMaskKeyframe.image,points:samPoints.map((p)=>[p.x,p.y]),labels:samPoints.map((p)=>p.label)})});if(!response.ok)throw new Error(await response.text());const result:{uri:string}=await response.json();const image=await loadImage(`${result.uri}?t=${Date.now()}`);const canvas=maskCanvasRef.current;const context=canvas?.getContext("2d");if(canvas&&context){context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);setMaskDirty(true);setStatus("SAM 蒙版已更新；可继续添加保留点、排除点或手工补画")}}catch(error){setStatus(error instanceof Error?`SAM 失败：${error.message}`:"SAM 分割失败")}finally{setSamRunning(false)}
  };

  const fillMask = (filled:boolean) => {
    const canvas=maskCanvasRef.current;const context=canvas?.getContext("2d");if(!canvas||!context)return;context.clearRect(0,0,canvas.width,canvas.height);if(filled){context.fillStyle="white";context.fillRect(0,0,canvas.width,canvas.height)}setMaskDirty(true);
  };

  const saveActiveMask = async () => {
    if(!shot||!activeMaskKeyframe||!maskCanvasRef.current)return;const interaction=Boolean(activeInteractionGroup&&activeInteractionKeyframe);const targetId=interaction?activeInteractionGroup!.id:primary?.id;if(!targetId)return;setStatus("正在保存蒙版…");
    const response=await fetch(`${API}/masks`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shotId:shot.id,targetType:interaction?"interactionGroup":"element",targetId,keyframeId:activeMaskKeyframe.id,dataUrl:maskCanvasRef.current.toDataURL("image/png")})});
    if(!response.ok){setStatus(`蒙版保存失败：${await response.text()}`);return;}setShot(await response.json());setMaskDirty(false);setStatus("蒙版已保存到当前关键状态");
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
  const hiddenInteractionMembers = new Set(visibleInteractionKeyframe ? visibleInteractionGroup?.members : []);shot.interactionGroups.filter((group)=>playhead>group.range.end&&group.exit?.mode==="hideMember"&&group.exit.subjectId).forEach((group)=>hiddenInteractionMembers.add(group.exit!.subjectId!));
  const visibleElementComposite = !visibleInteractionKeyframe ? shot.elements.map((element)=>keyframeAtFrame(element,playhead)).find((keyframe)=>keyframe?.locked&&keyframe.image&&keyframe.state.generatedComposite===true) : undefined;
  const layerFallbackIds = new Set(activeInteractionGroup?.members ?? (primary ? [primary.id] : []));
  const showOriginalLayers = (activeView==="composite" || (activeView==="layer" && !visibleInteractionKeyframe && !visibleElementComposite)) && !(playingVideoUri&&transitionView==="layer");

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">C</span><span>CaveSky</span><small>v0.2</small></div><div className="shot-title"><div className="model-pickers"><label>关键帧<select aria-label="关键帧图片模型" value={imageAdapter} onChange={(event)=>setImageAdapter(event.target.value)}>{adapterCapabilities.filter((item)=>item.kinds.includes("keyframeImage")).map((item)=><option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{item.configured?"":" · 未配置"}</option>)}</select></label><label>过渡<select aria-label="过渡视频模型" value={transitionAdapter} onChange={(event)=>setTransitionAdapter(event.target.value)}>{adapterCapabilities.filter((item)=>item.kinds.includes("transitionVideo")&&item.id!=="mock").map((item)=><option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{item.configured?"":" · 未配置"}</option>)}</select></label></div><b>{shot.id} · {(playhead/shot.fps).toFixed(2)}s</b></div><button className="quiet-button" onClick={save}><Save size={16}/> 保存</button></header>
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
          {showOriginalLayers&&!visibleElementComposite && ordered.filter(e=>e.visible && !hiddenInteractionMembers.has(e.id) && (activeView==="composite"||layerFallbackIds.has(e.id)) && playhead>=e.activeRange.start && playhead<=e.activeRange.end).map((element)=>{ const asset=assetMap.get(element.assetId); const keyframe=keyframeAtFrame(element,playhead); const image=keyframe?.state.generatedComposite===true?asset?.url:keyframe?.image||asset?.url; if(!image) return null; return <div key={element.id} className={`stage-element ${selected.includes(element.id)?"selected":""}`} onPointerDown={(e)=>stagePointerDown(e,element)} style={{left:`${element.transform.x*100}%`,top:`${element.transform.y*100}%`,transform:`translate(-50%,-50%) scale(${element.transform.scale}) rotate(${element.transform.rotation}deg)`,zIndex:shot.layers.find(l=>l.id===element.layerId)?.order}}><img src={image}/><span>{element.name||element.id}</span></div>})}
          {!playingVideoUri&&visibleElementComposite&&activeView!=="mask"&&<img className={`interaction-stage-layer ${activeKeyframe?.mask&&activeView!=="cutout"?"masked":""}`} style={activeKeyframe?.mask&&activeView!=="cutout"?{maskImage:`url(${activeKeyframe.mask})`,WebkitMaskImage:`url(${activeKeyframe.mask})`}:undefined} src={visibleElementComposite.image} alt={activeView==="cutout"?"元素生成原图":"元素派生图层"}/>}
          {!playingVideoUri&&visibleInteractionKeyframe&&activeView!=="mask"&&<img className={`interaction-stage-layer ${visibleInteractionKeyframe.mask&&activeView!=="cutout"?"masked":""}`} style={visibleInteractionKeyframe.mask&&activeView!=="cutout"?{maskImage:`url(${visibleInteractionKeyframe.mask})`,WebkitMaskImage:`url(${visibleInteractionKeyframe.mask})`}:undefined} src={visibleInteractionKeyframe.image} alt={activeView==="cutout"?"交互生成原图":"交互派生图层"}/>}
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
          {primary ? <><div className="inspector-head"><div className="state-heading"><small>元素关键状态</small><b>{primary.name||primary.id} · {activeKeyframe ? `第 ${activeKeyframe.frame} 帧` : "未选择关键帧"}</b></div><div className="view-switch"><button className={elementView==="composite"?"active":""} onClick={()=>setElementView("composite")}><Layers3 size={13}/>合成</button><button className={elementView==="layer"?"active":""} onClick={()=>setElementView("layer")}><Eye size={13}/>仅当前层</button><button className={elementView==="mask"?"active":""} onClick={()=>setElementView("mask")}><Paintbrush size={13}/>蒙版</button><button className={elementView==="cutout"?"active":""} onClick={()=>setElementView("cutout")}><ImagePlus size={13}/>生成原图</button></div><button onClick={()=>updateElement(primary.id,{locked:!primary.locked})}>{primary.locked?<><Unlock size={14}/>解锁</>:<><Lock size={14}/>锁定</>}</button><button className="danger" onClick={()=>{setShot({...shot,elements:shot.elements.filter(e=>e.id!==primary.id)});setSelected([])}}><Trash2 size={14}/>移除</button></div>
          <div className="field-grid"><label>缩放<input type="range" min="0.2" max="5" step="0.05" value={primary.transform.scale} onChange={(e)=>updateElement(primary.id,{transform:{...primary.transform,scale:+e.target.value}})}/></label><label>出现帧<input type="number" value={primary.activeRange.start} onChange={(e)=>updateElement(primary.id,{activeRange:{...primary.activeRange,start:+e.target.value}})}/></label><label>结束帧<input type="number" value={primary.activeRange.end} onChange={(e)=>updateElement(primary.id,{activeRange:{...primary.activeRange,end:+e.target.value}})}/></label><button onClick={addKeyframe}><Plus size={14}/> 当前帧添加关键帧</button></div>
          {activeKeyframe && <><textarea className="state-description" aria-label="元素关键帧状态描述" placeholder="描述这个元素在当前帧的状态，例如：女孩缓慢抬头，看向洞穴入口" value={activeKeyframe.instruction??""} onChange={(e)=>updateKeyframe(primary.id,activeKeyframe.id,{instruction:e.target.value,locked:false})}/><div className="interaction-director-actions"><span>非接触动作使用元素轨道；涉及接触时改用交互图层。</span><div className="element-generate-actions"><button className="generate-button" disabled={keyframeJob?.status==="queued"||keyframeJob?.status==="running"} onClick={generateElementKeyframe}>{keyframeJob?.status==="queued"||keyframeJob?.status==="running"?<LoaderCircle className="spinning" size={14}/>:<Sparkles size={14}/>}生成两个候选</button><button onClick={generateElementTransition}><Film size={14}/>生成到下一关键帧</button></div></div>
          {keyframeJob?.targetType==="keyframe"&&keyframeJob.status==="succeeded"&&<><div className="generation-receipt">任务 {keyframeJob.id} · 已返回 {keyframeJob.outputs.filter((item)=>item.kind==="image").length} 个候选</div><div className="candidate-strip">{keyframeJob.outputs.filter((item)=>item.kind==="image").map((output,index)=><div className="candidate" key={output.uri}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri:output.uri,index})} title="仅放大预览，不会采用"><img src={output.uri}/><span>点击查看效果</span></button><button onClick={()=>acceptKeyframe(index)}><Check size={13}/>采用到元素轨道</button></div>)}</div></>}
          {activeGenerationHistory.length>0&&<><div className="generation-receipt">此关键帧的历史候选 · {activeGenerationHistory.length} 次任务</div><div className="candidate-strip history">{activeGenerationHistory.flatMap((record)=>record.outputs!.map((uri,index)=><div className="candidate" key={`${record.id}:${index}`}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri,index,generationId:record.id})}><img src={uri}/><span>{record.id}</span></button><button onClick={()=>acceptHistoricalKeyframe(record.id,index)}><Check size={13}/>重新采用</button></div>))}</div></>}
          {keyframeJob?.targetType==="keyframe"&&keyframeJob.status==="failed"&&<div className="generation-error">{keyframeJob.error?.message||keyframeJob.message}</div>}
          {lastAcceptedGeneration&&activeKeyframe&&<button className="revert-generation" onClick={revertAcceptedKeyframe}>撤销刚才采用的候选</button>}
          {activeKeyframe?.image&&maskUndo.length>0&&<button className="revert-generation" onClick={undoMask}>撤销上一步蒙版操作</button>}
          {activeKeyframe?.image&&samMode&&<div className="generation-receipt">智能选择中：点击添加保留点，Shift＋点击排除；Alt＋拖动可同时使用当前画笔或橡皮。</div>}
          {(()=>{const next=primary.keyframes.filter((item)=>item.frame>activeKeyframe.frame).sort((a,b)=>a.frame-b.frame)[0];const jobKey=next?`element:${primary.id}:${activeKeyframe.frame}:${next.frame}`:"";const job=transitionJobs[jobKey];const video=job?.outputs.find((item)=>item.kind==="video");return job?.status==="succeeded"&&video?<div className="element-transition-result"><video src={video.uri} controls/><button onClick={()=>acceptTransition(jobKey)}><Check size={13}/>采用过渡</button></div>:job?.status==="failed"?<div className="generation-error">{job.error?.message||job.message}</div>:null})()}</>}</> : <span>选择一个元素编辑属性；按住Shift选择两个元素建立交互组。</span>}
          {activeKeyframe?.image&&<div className="mask-editor compact"><div className="mask-editor-toolbar"><b>蒙版编辑</b><button className={samMode?"active":""} onClick={()=>{setSamMode(!samMode);setSamPoints([])}}><Sparkles size={13}/>智能选择</button><button disabled={!samMode||samPoints.length===0||samRunning} onClick={runSam}>{samRunning?<LoaderCircle className="spinning" size={13}/>:<Check size={13}/>}生成初始蒙版</button><button className={maskTool==="paint"?"active":""} onClick={()=>setMaskTool("paint")}><Paintbrush size={13}/>画笔</button><button className={maskTool==="erase"?"active":""} onClick={()=>setMaskTool("erase")}><Eraser size={13}/>橡皮</button><label>大小 <input type="range" min="6" max="120" value={maskBrush} onChange={(e)=>setMaskBrush(+e.target.value)}/><span>{maskBrush}px</span></label><button onClick={()=>fillMask(true)}>全选</button><button onClick={()=>fillMask(false)}>清空</button><button disabled={!maskDirty} onClick={saveActiveMask}><Save size={13}/>保存蒙版</button><button onClick={exportCutoutPreview}><Eye size={13}/>单独预览</button></div><div className={`mask-editor-canvas ${samMode?"sam-selecting":""}`}><img src={activeKeyframe.image}/><canvas ref={maskCanvasRef} width={1280} height={720} onPointerDown={maskPointerDown}/>{samMode&&<div className="sam-points">{samPoints.map((p,i)=><i key={i} className={p.label?"positive":"negative"} style={{left:`${p.x*100}%`,top:`${p.y*100}%`}}/>)}</div>}</div>{samMode&&<small>点击保留目标；Shift＋点击排除区域。添加点后生成初始蒙版。</small>}</div>}
        </div>
      </section>
    </section>
    <section className="timeline">
      <div className="timeline-head"><b>元素时间轴</b><span>{shot.fps} fps · 第 {playhead} 帧</span><button className="playback-button" aria-label={isPlaying?"暂停镜头":"播放镜头"} onClick={togglePlayback}>{isPlaying?<Pause size={14}/>:<Play size={14}/>} {isPlaying?"暂停":"播放"}</button><button onClick={createInteraction}><Sparkles size={14}/>由选中元素建立交互组</button></div>
      <div className="ruler-label"/><div className="ruler">{[0,1,2,3,4].map(s=><span key={s} style={{left:`${s*25}%`}}>{s}s</span>)}</div>
      {shot.elements.map((element)=>{const takeovers=shot.interactionGroups.filter((group)=>group.members.includes(element.id));const acceptedTransitions=shot.transitions.filter((item)=>item.targetType==="element"&&item.targetId===element.id&&item.selectedGenerationId);return <div className="track-row" key={element.id}><button className={`track-label ${selected.includes(element.id)?"selected":""} ${takeoverFor(element.id)?"taken-over":""}`} onClick={(e)=>selectElement(element.id,e.shiftKey)}>{iconFor(element.kind)}<span>{element.name||element.id}</span>{takeoverFor(element.id)&&<small>{playhead>takeoverFor(element.id)!.range.end?"退出延续":"交互中"}</small>}</button><div className="track-lane" onClick={(e)=>elementLaneClick(e,element)}><span className="active-span" style={{left:`${element.activeRange.start/shot.durationFrames*100}%`,width:`${(element.activeRange.end-element.activeRange.start)/shot.durationFrames*100}%`}}/>{acceptedTransitions.map((transition)=><span key={transition.id} className="accepted-transition-clip element-video-clip" title="已采用视频片段" style={{left:`${transition.fromFrame/shot.durationFrames*100}%`,width:`${(transition.toFrame-transition.fromFrame)/shot.durationFrames*100}%`}}><Film size={10}/><span>视频</span></span>)}{takeovers.map((group)=><span key={group.id} className="takeover-span" title={`由 ${group.id} 接管：${group.members.map((id)=>shot.elements.find((item)=>item.id===id)?.name||id).join("＋")}`} style={{left:`${group.range.start/shot.durationFrames*100}%`,width:`${(group.range.end-group.range.start)/shot.durationFrames*100}%`}}><span>交互接管</span></span>)}{takeovers.filter(groupContinuesAfterExit).map((group)=><span key={`${group.id}:exit`} className="exit-span" style={{left:`${group.range.end/shot.durationFrames*100}%`,width:`${(shot.durationFrames-group.range.end)/shot.durationFrames*100}%`}}><span>{group.exit.mode==="attachToMember"?`附着 · ${group.exit.anchor||"成员"}`:"保持联合"}</span></span>)}{element.keyframes.map(k=>{const suppressed=Boolean(takeoverFor(element.id,k.frame));return <button aria-label={`${element.name || element.id} 关键帧 ${k.frame}`} title={suppressed?"该关键帧位于交互接管区；点击将打开联合状态":`关键帧 ${k.frame}；左右拖动，右键删除`} className={`keyframe ${suppressed?"suppressed":""}`} key={k.id} style={{left:`${k.frame/shot.durationFrames*100}%`}} onClick={(e)=>e.stopPropagation()} onPointerDown={(e)=>keyframePointerDown(e,element,k.id)} onContextMenu={(e)=>{e.preventDefault();e.stopPropagation();if(suppressed){const group=takeoverFor(element.id,k.frame);if(group)openInteractionTakeover(group,k.frame)}else deleteKeyframe(element,k.frame)}}/>})}</div></div>})}
      {shot.interactionGroups.map(group=>{const transitionJob=transitionJobs[group.id];const transition=shot.transitions.find((item)=>item.targetType==="interactionGroup"&&item.targetId===group.id);const accepted=shot.generations.find((item)=>item.id===transition?.selectedGenerationId);return <div className="interaction-row" key={group.id}>
        <div className="interaction-label"><Film size={12}/><span>{group.id}</span><button className="run-transition" title="生成首尾帧过渡" disabled={transitionJob?.status==="queued"||transitionJob?.status==="running"} onClick={()=>generateTransition(group.id)}>{transitionJob?.status==="queued"||transitionJob?.status==="running"?<LoaderCircle className="spinning" size={12}/>:<Sparkles size={12}/>}</button><button title="删除交互动作" onClick={()=>deleteInteraction(group.id)}><Trash2 size={12}/></button></div>
        <div className="interaction-lane" onClick={seekTimeline}>
          {transition?.selectedGenerationId&&accepted&&<button className="accepted-transition-clip" aria-label={`${group.id} 已采用过渡视频`} title="已采用视频片段；点击可将播放头定位到片段" style={{left:`${transition.fromFrame/shot.durationFrames*100}%`,width:`${(transition.toFrame-transition.fromFrame)/shot.durationFrames*100}%`}} onClick={(event)=>{event.stopPropagation();setPlayhead(transition.fromFrame);setIsPlaying(false)}}><Film size={11}/><span>已采用视频</span></button>}
          <div className="interaction-clip" style={{left:`${group.range.start/shot.durationFrames*100}%`,width:`${(group.range.end-group.range.start)/shot.durationFrames*100}%`}}>
            <input aria-label={`${group.id} 动作描述`} value={group.instruction} onChange={(e)=>updateInteraction(group.id,{instruction:e.target.value})}/>
            <label>起 <input aria-label={`${group.id} 起始帧`} type="number" min="0" max={shot.durationFrames-1} value={group.range.start} onChange={(e)=>updateInteraction(group.id,{range:{...group.range,start:+e.target.value}})}/></label>
            <label>止 <input aria-label={`${group.id} 结束帧`} type="number" min="1" max={shot.durationFrames} value={group.range.end} onChange={(e)=>updateInteraction(group.id,{range:{...group.range,end:+e.target.value}})}/></label>
          </div>
          {group.keyframes.map((keyframe)=><button key={keyframe.id} aria-label={`${group.id} 交互关键状态 ${keyframe.frame}`} className={`interaction-keyframe ${selectedInteractionKeyframe?.keyframeId===keyframe.id?"selected":""} ${keyframe.locked?"locked":""}`} style={{left:`${keyframe.frame/shot.durationFrames*100}%`}} onClick={(event)=>{event.stopPropagation();setSelected([]);setSelectedKeyframe(null);setSelectedInteractionKeyframe({groupId:group.id,keyframeId:keyframe.id});setPlayhead(keyframe.frame);setKeyframeJob(null)}}/>) }
          {transitionJob?.status === "succeeded" && transitionJob.outputs.find((item)=>item.kind==="video") && <div className="transition-result"><video src={transitionJob.outputs.find((item)=>item.kind==="video")?.uri} controls/><button onClick={()=>acceptTransition(group.id)}><Check size={11}/>采用</button></div>}
          {transitionJob?.status === "failed" && <span className="transition-error">生成失败</span>}
        </div>
      </div>})}
      <div className="playhead" style={{left:`calc(156px + (100% - 156px) * ${playhead/shot.durationFrames})`}}/>
    </section>
    {activeInteractionGroup && activeInteractionKeyframe && <section className="interaction-director-panel">
      <div className="interaction-director-head"><div><small>交互图层关键状态</small><b>{activeInteractionGroup.id} · 第 {activeInteractionKeyframe.frame} 帧</b></div><div className="view-switch"><button className={interactionView==="composite"?"active":""} onClick={()=>setInteractionView("composite")}><Layers3 size={13}/>场景合成</button><button className={interactionView==="layer"?"active":""} onClick={()=>setInteractionView("layer")}><Eye size={13}/>仅交互层</button><button className={interactionView==="mask"?"active":""} onClick={()=>setInteractionView("mask")}><Paintbrush size={13}/>此状态蒙版</button><button className={interactionView==="cutout"?"active":""} onClick={()=>setInteractionView("cutout")}><ImagePlus size={13}/>生成原图</button></div><button onClick={()=>addInteractionKeyframe(activeInteractionGroup.id)}><Plus size={14}/>在播放头添加状态</button></div>
      <div className="takeover-notice"><Layers3 size={14}/><div><b>{activeInteractionGroup.members.map((id)=>shot.elements.find((item)=>item.id===id)?.name||id).join(" 正在与 ")}</b><span>第 {activeInteractionGroup.range.start}–{activeInteractionGroup.range.end} 帧由交互层接管；成员的独立关键帧在这段时间暂停输出。</span></div></div>
      <div className="exit-editor"><b>交互结束后</b><select aria-label="交互结束方式" value={activeInteractionGroup.exit.mode} onChange={(event)=>{const mode=event.target.value as Shot["interactionGroups"][number]["exit"]["mode"];const subjectId=activeInteractionGroup.exit.subjectId??activeInteractionGroup.members[1];const targetId=activeInteractionGroup.exit.targetId??activeInteractionGroup.members.find((id)=>id!==subjectId);updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,mode,subjectId:mode==="attachToMember"||mode==="hideMember"?subjectId:null,targetId:mode==="attachToMember"?targetId:null,anchor:mode==="attachToMember"?(activeInteractionGroup.exit.anchor||"rightHand"):null}})}}><option value="restoreIndependent">恢复成员独立轨道</option><option value="keepMerged">保持联合图层</option><option value="attachToMember">一个成员附着到另一个成员</option><option value="hideMember">隐藏一个成员</option></select>{(activeInteractionGroup.exit.mode==="attachToMember"||activeInteractionGroup.exit.mode==="hideMember")&&<label>对象<select aria-label="退出状态对象" value={activeInteractionGroup.exit.subjectId??activeInteractionGroup.members[1]} onChange={(event)=>updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,subjectId:event.target.value}})}>{activeInteractionGroup.members.map((id)=><option key={id} value={id}>{shot.elements.find((item)=>item.id===id)?.name||id}</option>)}</select></label>}{activeInteractionGroup.exit.mode==="attachToMember"&&<><label>附着到<select aria-label="附着目标" value={activeInteractionGroup.exit.targetId??activeInteractionGroup.members[0]} onChange={(event)=>updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,targetId:event.target.value}})}>{activeInteractionGroup.members.filter((id)=>id!==activeInteractionGroup.exit.subjectId).map((id)=><option key={id} value={id}>{shot.elements.find((item)=>item.id===id)?.name||id}</option>)}</select></label><label>位置<select aria-label="附着位置" value={activeInteractionGroup.exit.anchor??"rightHand"} onChange={(event)=>updateInteraction(activeInteractionGroup.id,{exit:{...activeInteractionGroup.exit,anchor:event.target.value}})}><option value="rightHand">右手</option><option value="leftHand">左手</option><option value="head">头部</option><option value="leftFoot">左脚</option><option value="rightFoot">右脚</option><option value="body">身体</option></select></label></>}</div>
      <textarea aria-label="交互关键帧状态描述" placeholder="描述人物和物品在这一帧的联合状态，例如：女孩右手握住杯柄，但杯底仍接触桌面" value={activeInteractionKeyframe.instruction ?? ""} onChange={(e)=>updateInteractionKeyframe(activeInteractionGroup.id,activeInteractionKeyframe.id,{instruction:e.target.value,locked:false})}/>
      <div className="interaction-director-actions"><span>系统自动附带完整镜头、角色和物品参考，并锁定画风、背景和机位。</span><button className="generate-button" disabled={keyframeJob?.status==="queued"||keyframeJob?.status==="running"} onClick={generateKeyframe}>{keyframeJob?.status==="queued"||keyframeJob?.status==="running"?<LoaderCircle className="spinning" size={14}/>:<Sparkles size={14}/>}生成两个候选</button></div>
      {keyframeJob?.status === "succeeded" && <><div className="generation-receipt">任务 {keyframeJob.id} · 已返回 {keyframeJob.outputs.filter((item)=>item.kind==="image").length} 个候选</div><div className="candidate-strip">{keyframeJob.outputs.filter((item)=>item.kind==="image").map((output,index)=><div className="candidate" key={output.uri}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri:output.uri,index})} title="仅放大预览，不会采用"><img src={output.uri}/><span>点击查看效果</span></button><button onClick={()=>acceptKeyframe(index)}><Check size={13}/>采用到交互图层</button></div>)}</div></>}
      {activeGenerationHistory.length>0&&<><div className="generation-receipt">此交互状态的历史候选 · {activeGenerationHistory.length} 次任务</div><div className="candidate-strip history">{activeGenerationHistory.flatMap((record)=>record.outputs!.map((uri,index)=><div className="candidate" key={`${record.id}:${index}`}><button className="candidate-preview" onClick={()=>setPreviewCandidate({uri,index,generationId:record.id})}><img src={uri}/><span>{record.id}</span></button><button onClick={()=>acceptHistoricalKeyframe(record.id,index)}><Check size={13}/>重新采用</button></div>))}</div></>}
      {activeTransitionHistory.length>0&&<div className="transition-history"><div className="generation-receipt">本段过渡视频历史 · {activeTransitionHistory.length} 个版本</div><div className="transition-history-list">{activeTransitionHistory.flatMap((record)=>(record.outputs?.length?record.outputs:[record.output!]).map((uri)=><div className="transition-history-item" key={`${record.id}:${uri}`}><video src={uri} controls preload="metadata"/><div><span>{record.id}{record.status==="accepted"?" · 已采用":""}</span><button onClick={()=>acceptHistoricalTransition(record.id)}><Check size={13}/>采用此版本</button></div></div>))}</div></div>}
      {keyframeJob?.status === "failed" && <div className="generation-error">{keyframeJob.error?.message || keyframeJob.message}</div>}
      {lastAcceptedGeneration&&<button className="revert-generation" onClick={revertAcceptedKeyframe}>撤销刚才采用的候选</button>}
      {activeInteractionKeyframe.image&&maskUndo.length>0&&<button className="revert-generation" onClick={undoMask}>撤销上一步蒙版操作</button>}
      {activeInteractionKeyframe.image&&samMode&&<div className="generation-receipt">智能选择中：点击添加保留点，Shift＋点击排除；Alt＋拖动可同时使用当前画笔或橡皮。</div>}
      {activeInteractionKeyframe.image&&<div className="mask-editor"><div className="mask-editor-toolbar"><b>蒙版编辑</b><button className={samMode?"active":""} onClick={()=>{setSamMode(!samMode);setSamPoints([])}}><Sparkles size={13}/>智能选择</button><button disabled={!samMode||samPoints.length===0||samRunning} onClick={runSam}>{samRunning?<LoaderCircle className="spinning" size={13}/>:<Check size={13}/>}生成初始蒙版</button><button className={maskTool==="paint"?"active":""} onClick={()=>setMaskTool("paint")}><Paintbrush size={13}/>画笔</button><button className={maskTool==="erase"?"active":""} onClick={()=>setMaskTool("erase")}><Eraser size={13}/>橡皮</button><label>大小 <input type="range" min="6" max="120" value={maskBrush} onChange={(e)=>setMaskBrush(+e.target.value)}/><span>{maskBrush}px</span></label><button onClick={()=>fillMask(true)}>全选</button><button onClick={()=>fillMask(false)}>清空</button><button disabled={!maskDirty} onClick={saveActiveMask}><Save size={13}/>保存蒙版</button><button onClick={exportCutoutPreview}><Eye size={13}/>单独预览</button></div><div className={`mask-editor-canvas ${samMode?"sam-selecting":""}`} ref={maskEditorRef}><img src={activeInteractionKeyframe.image}/><canvas ref={maskCanvasRef} width={1280} height={720} onPointerDown={maskPointerDown}/>{samMode&&<div className="sam-points">{samPoints.map((p,i)=><i key={i} className={p.label?"positive":"negative"} style={{left:`${p.x*100}%`,top:`${p.y*100}%`}}/>)}</div>}</div><small>{samMode?"点击保留人物或物品；Shift＋点击排除背景。":"白色区域保留为交互图层，透明区域显示下方锁定图层。SAM 生成初始蒙版后仍可用画笔修正。"}</small></div>}
    </section>}
    {previewCandidate&&<div className="candidate-modal" role="dialog" aria-modal="true" aria-label="候选图片预览" onClick={()=>setPreviewCandidate(null)}><div className="candidate-modal-card" onClick={(event)=>event.stopPropagation()}><img src={previewCandidate.uri} alt={`候选图片 ${previewCandidate.index+1}`}/><footer><span>候选 {previewCandidate.index+1} · 这里只是预览，不会修改关键帧</span><button onClick={()=>setPreviewCandidate(null)}>关闭</button><button className="accept-preview" onClick={()=>previewCandidate.generationId?acceptHistoricalKeyframe(previewCandidate.generationId,previewCandidate.index):acceptKeyframe(previewCandidate.index)}><Check size={13}/>采用这张</button></footer></div></div>}
  </main>;
}
