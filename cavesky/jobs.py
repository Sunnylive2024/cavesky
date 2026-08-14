from __future__ import annotations

from uuid import uuid4

from .adapters import AdapterRegistry, TransitionTask
from .models import GenerationError, GenerationJob, GenerationRequest, GenerationStatus


class InMemoryJobStore:
    """MVP store. Replace with persistent jobs only after the workflow is proven."""

    def __init__(self) -> None:
        self._jobs: dict[str, GenerationJob] = {}

    def create(self, request: GenerationRequest) -> GenerationJob:
        job = GenerationJob(
            id=f"GEN_{uuid4().hex[:10].upper()}",
            shotId=request.shotId,
            transitionId=request.transitionId,
            adapter=request.adapter,
            targetType="transition",
            targetId=request.transitionId,
            status=GenerationStatus.QUEUED,
            progress=0,
            message="Generation task queued",
        )
        self._jobs[job.id] = job
        return job

    def create_keyframe(self, *, shot_id: str, element_id: str, keyframe_id: str, adapter: str) -> GenerationJob:
        job = GenerationJob(
            id=f"GEN_{uuid4().hex[:10].upper()}",
            shotId=shot_id,
            adapter=adapter,
            targetType="keyframe",
            targetId=element_id,
            keyframeId=keyframe_id,
            status=GenerationStatus.QUEUED,
            progress=0,
            message="Keyframe generation queued",
        )
        self._jobs[job.id] = job
        return job

    def create_interaction_keyframe(self, *, shot_id: str, group_id: str, keyframe_id: str, adapter: str) -> GenerationJob:
        job = GenerationJob(
            id=f"GEN_{uuid4().hex[:10].upper()}",
            shotId=shot_id,
            adapter=adapter,
            targetType="interactionKeyframe",
            targetId=group_id,
            keyframeId=keyframe_id,
            status=GenerationStatus.QUEUED,
            progress=0,
            message="Interaction keyframe generation queued",
        )
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> GenerationJob:
        return self._jobs[job_id]

    def run(self, job_id: str, task: TransitionTask, adapters: AdapterRegistry) -> GenerationJob:
        job = self._jobs[job_id]
        job.status = GenerationStatus.RUNNING
        job.progress = 1
        job.message = "Generation task started"
        try:
            result = adapters.get(job.adapter).run_transition(task)
            if result.error is not None:
                job.status = GenerationStatus.FAILED
                job.error = result.error
            else:
                job.status = GenerationStatus.SUCCEEDED
                job.outputs = result.outputs
            job.progress = 100
            job.message = result.message
        except Exception as error:
            job.status = GenerationStatus.FAILED
            job.progress = 100
            job.message = "Adapter execution failed"
            job.error = GenerationError(
                code="adapter_execution_failed",
                message=str(error),
                retryable=False,
            )
        return job
