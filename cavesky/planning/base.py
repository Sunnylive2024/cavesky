from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
import json

from .models import PlannerCapability, PlanProposal, PlanRequest


@dataclass
class PlanExecution:
    proposal: PlanProposal
    raw_request: dict
    raw_response: str


class PlannerError(Exception):
    """Raised when a planner fails to produce a valid proposal."""


class PlannerNotConfiguredError(PlannerError):
    """Raised when a planner is missing its key or endpoint configuration."""


class Planner(ABC):
    """Provider-neutral action planner.

    A planner only proposes; it must never mutate the shot and never trigger
    paid image or video generation.
    """

    @property
    @abstractmethod
    def capability(self) -> PlannerCapability:
        """Describe stable, provider-neutral behavior exposed to the editor."""

    @abstractmethod
    def plan(self, request: PlanRequest) -> PlanProposal:
        """Return a structured, validated proposal for the given intent."""

    def execute(self, request: PlanRequest) -> PlanExecution:
        proposal = self.plan(request)
        return PlanExecution(proposal, request.model_dump(), json.dumps(proposal.model_dump(), ensure_ascii=False))
