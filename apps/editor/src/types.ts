export type ElementKind = "background" | "character" | "prop" | "foreground" | "effect";

export interface FrameRange { start: number; end: number }
export interface Transform { x: number; y: number; scale: number; rotation: number }
export interface VisualKeyframe { id: string; frame: number; image: string; mask?: string | null; instruction?: string | null; state: Record<string, unknown>; locked: boolean; renderPolicy:"required"|"optional"|"extractFromVideo"; generationBoundary:boolean; sourceKind:"authored"|"generatedImage"|"acceptedVideoFrame" }
export interface Layer { id: string; role: string; order: number; locked: boolean }
export interface Element {
  id: string; kind: ElementKind; assetId: string; layerId: string; name?: string | null;
  activeRange: FrameRange; transform: Transform; visible: boolean; locked: boolean; keyframes: VisualKeyframe[];
}
export interface InteractionExit { mode:"restoreIndependent"|"keepMerged"|"attachToMember"|"hideMember"; subjectId?:string|null; targetId?:string|null; anchor?:string|null }
export interface InteractionGroup { id: string; kind:"action"|"interaction"; members: string[]; anchorKeyframeId: string; range: FrameRange; instruction: string; contextPolicy: "referenceOnly"; outputMode: "mergedRgba" | "rgbWithMask"; cameraMode: CameraContinuityMode; cameraInstruction?: string | null; exit:InteractionExit; keyframes: VisualKeyframe[] }
export interface Transition { id: string; targetType: "element" | "interactionGroup"; targetId: string; fromFrame: number; toFrame: number; instruction: string; strategy: string; selectedGenerationId?: string | null }
export interface GenerationRecord { id: string; type: "keyframe" | "interactionKeyframe" | "transition"; targetId?: string | null; keyframeId?: string | null; transitionId?: string | null; adapter: string; outputs?: string[]; output?: string; maskOutput?: string; status: string; message?: string; qualityReview?:Record<string,unknown> }
export interface Shot {
  schemaVersion: "0.1"; id: string; fps: number; durationFrames: number;
  canvas: { width: number; height: number; backgroundColor: string };
  layers: Layer[]; elements: Element[]; interactionGroups: InteractionGroup[]; transitions: Transition[]; generations: GenerationRecord[]; planningHistory:Array<{id:string;createdAt:string;planner:string;anchorKeyframeId:string;groupId?:string;status:string;rawRequest:Record<string,unknown>;rawResponse:string;parsedProposal?:Record<string,unknown>}>
}
export interface Asset { id: string; name: string; kind: ElementKind; url: string }
export interface GenerationOutput { kind: "image" | "video" | "mask" | "metadata"; uri: string; mimeType?: string | null }
export interface GenerationJob {
  id: string; shotId: string; transitionId?: string | null; adapter: string;
  targetType: "keyframe" | "interactionKeyframe" | "transition"; targetId?: string | null; keyframeId?: string | null;
  status: "queued" | "running" | "succeeded" | "failed"; progress: number; message: string;
  outputs: GenerationOutput[]; error?: { code: string; message: string; retryable: boolean } | null;
}
export interface GenerationQuote { fingerprint:string; adapter:string; timelineSeconds:number; requestSeconds:number; segmentCount:number; estimatedCostCny?:number|null; durationRatio:number; durationWarning:boolean; playbackSpeedRatio:number; finalPrompt:string }
export interface AdapterCapability { id:string; label:string; kinds:string[]; supportsMasks:boolean; supportsFirstLastFrame:boolean; supportsImageReference:boolean; maxReferenceImages:number; configured:boolean }
export interface PlannerCapability { id:string; label:string; configured:boolean; supportsVision:boolean }

export type CameraContinuityMode = "free" | "prefer" | "lock" | "directed";
export type ReferenceSelectionMode = "auto" | "none" | "previous" | "next" | "both";
export type ReferenceRelation = "before" | "after" | "same" | "timeless";
export type ReferencePurpose = "continuity" | "scene" | "identity" | "objectIdentity";
export interface KeyframeReference { frame?: number | null; relation: ReferenceRelation; purpose: ReferencePurpose; image: string; targetId?: string | null }
export interface KeyframeReferenceCandidate { keyframeId: string; frame: number; relation: "before" | "after"; image: string }
export interface KeyframeReferencePreview { references: KeyframeReference[]; directions: string[]; candidates: KeyframeReferenceCandidate[]; warnings: string[] }
export interface KeyframeGenerationQuote { adapter: string; finalInstruction: string; negativePrompt: string; references: KeyframeReference[]; candidateCount: number; estimatedCost: null }
