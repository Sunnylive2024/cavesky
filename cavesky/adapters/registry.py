from __future__ import annotations

from .base import AdapterCapability, GenerationAdapter


class AdapterNotFoundError(KeyError):
    pass


class AdapterRegistry:
    def __init__(self, adapters: list[GenerationAdapter] | None = None) -> None:
        self._adapters: dict[str, GenerationAdapter] = {}
        for adapter in adapters or []:
            self.register(adapter)

    def register(self, adapter: GenerationAdapter) -> None:
        adapter_id = adapter.capability.id
        if adapter_id in self._adapters:
            raise ValueError(f"Adapter already registered: {adapter_id}")
        self._adapters[adapter_id] = adapter

    def get(self, adapter_id: str) -> GenerationAdapter:
        try:
            return self._adapters[adapter_id]
        except KeyError as error:
            raise AdapterNotFoundError(adapter_id) from error

    def capabilities(self) -> list[AdapterCapability]:
        return [adapter.capability for adapter in self._adapters.values()]
