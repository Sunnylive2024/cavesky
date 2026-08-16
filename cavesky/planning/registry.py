from __future__ import annotations

from .base import Planner
from .models import PlannerCapability


class PlannerNotFoundError(KeyError):
    pass


class PlannerRegistry:
    def __init__(self, planners: list[Planner] | None = None) -> None:
        self._planners: dict[str, Planner] = {}
        for planner in planners or []:
            self.register(planner)

    def register(self, planner: Planner) -> None:
        planner_id = planner.capability.id
        if planner_id in self._planners:
            raise ValueError(f"Planner already registered: {planner_id}")
        self._planners[planner_id] = planner

    def get(self, planner_id: str) -> Planner:
        try:
            return self._planners[planner_id]
        except KeyError as error:
            raise PlannerNotFoundError(planner_id) from error

    def capabilities(self) -> list[PlannerCapability]:
        return [planner.capability for planner in self._planners.values()]
