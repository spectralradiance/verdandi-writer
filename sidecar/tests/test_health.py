from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from verdandi_ai.__main__ import main, watch_parent
from verdandi_ai.main import create_app
from verdandi_ai.system import parse_nvidia_smi

TOKEN = "a" * 64
AUTH = {"Authorization": f"Bearer {TOKEN}"}

GPU = {
    "available": True,
    "devices": [{
        "index": 0,
        "name": "NVIDIA GeForce RTX 4070 Laptop GPU",
        "memory_total_mb": 8188,
        "memory_used_mb": 1200,
        "memory_free_mb": 6988,
        "driver_version": "610.88",
    }],
    "error": None,
}


class FakeGpu:
    def snapshot(self) -> dict[str, Any]:
        return GPU


class FakeTorch:
    def __init__(self, **overrides: Any) -> None:
        self.started = False
        self.result = {"state": "ready", "installed": True, "version": "2.14.0", "cuda_available": True,
                       "cuda_version": "12.6", "error": None, **overrides}

    def start(self) -> None:
        self.started = True

    def snapshot(self) -> dict[str, Any]:
        return self.result


def make_client(env: dict[str, str] | None = None, torch: FakeTorch | None = None) -> TestClient:
    app = create_app(TOKEN, gpu_probe=FakeGpu(), torch_probe=torch or FakeTorch(), env=env or {})
    return TestClient(app)


def providers_by_id(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {provider["id"]: provider for provider in body["providers"]}


def test_missing_token_is_rejected() -> None:
    assert make_client().get("/health").status_code == 401


def test_wrong_token_is_rejected() -> None:
    response = make_client().get("/health", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_health_reports_gpu_torch_and_providers() -> None:
    response = make_client().get("/health", headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["python_prefix"]
    assert isinstance(body["in_virtualenv"], bool)
    assert body["gpu"]["devices"][0]["memory_free_mb"] == 6988
    assert body["torch"]["cuda_available"] is True
    assert set(providers_by_id(body)) == {"anthropic", "openai", "gemini", "openai_compat", "local_hf"}


def test_lifespan_starts_torch_probe() -> None:
    torch = FakeTorch()
    with make_client(torch=torch):
        pass
    assert torch.started


def test_api_keys_are_reported_but_never_echoed() -> None:
    env = {"ANTHROPIC_API_KEY": "sk-ant-secret-value", "GOOGLE_API_KEY": "google-secret-value"}
    response = make_client(env=env).get("/health", headers=AUTH)
    providers = providers_by_id(response.json())
    assert providers["anthropic"]["configured"] is True
    assert providers["gemini"]["configured"] is True
    assert providers["openai"]["configured"] is False
    assert "secret-value" not in response.text


def test_local_provider_requires_cuda() -> None:
    torch = FakeTorch(cuda_available=False)
    providers = providers_by_id(make_client(torch=torch).get("/health", headers=AUTH).json())
    assert providers["local_hf"]["configured"] is False
    assert providers["local_hf"]["detail"] == "CUDA unavailable"


def test_local_provider_reports_missing_torch() -> None:
    torch = FakeTorch(installed=False, version=None, cuda_available=False, cuda_version=None)
    providers = providers_by_id(make_client(torch=torch).get("/health", headers=AUTH).json())
    assert providers["local_hf"]["detail"] == "PyTorch not installed"


def test_parse_nvidia_smi_skips_malformed_lines() -> None:
    output = "0, NVIDIA GeForce RTX 4070 Laptop GPU, 8188, 1200, 6988, 610.88\nnot a gpu line\n1, X, n/a, 0, 0, 1\n"
    devices = parse_nvidia_smi(output)
    assert len(devices) == 1
    assert devices[0]["name"] == "NVIDIA GeForce RTX 4070 Laptop GPU"
    assert devices[0]["memory_total_mb"] == 8188


def test_create_app_requires_token() -> None:
    with pytest.raises(ValueError):
        create_app("")


def test_refuses_non_loopback_host() -> None:
    with pytest.raises(SystemExit):
        main(["--host", "0.0.0.0"])


def test_shutdown_calls_the_server_hook() -> None:
    calls: list[bool] = []
    app = create_app(TOKEN, gpu_probe=FakeGpu(), torch_probe=FakeTorch(), env={}, shutdown=lambda: calls.append(True))
    with TestClient(app) as client:
        assert client.post("/shutdown").status_code == 401
        assert client.post("/shutdown", headers=AUTH).json() == {"stopping": True}
    assert calls == [True]


def test_watch_parent_fires_when_the_parent_exits() -> None:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.5)"])
    fired = threading.Event()
    watch_parent(child.pid, fired.set)
    assert not fired.is_set()
    child.wait()
    assert fired.wait(5)


def test_local_model_needs_its_libraries(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from verdandi_ai.providers import local_hf

    ready = {"state": "ready", "installed": True, "cuda_available": True}
    provider = local_hf.LocalHFProvider(lambda: ready)
    monkeypatch.setattr(local_hf, "missing_libraries", lambda: ["transformers", "accelerate"])
    health = provider.health()
    assert health.configured is False
    assert "transformers, accelerate not installed" in (health.detail or "")
    monkeypatch.setattr(local_hf, "missing_libraries", lambda: [])
    assert provider.health().configured is True


def test_a_slow_job_sends_progress_and_is_shared(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import threading

    import pytest

    from verdandi_ai.ai_types import ProviderError
    from verdandi_ai.providers import local_hf

    monkeypatch.setattr(local_hf, "PROGRESS_SECONDS", 0.05)
    provider = local_hf.LocalHFProvider(lambda: {})
    release = threading.Event()
    job = provider._job("download", "m", lambda _job: release.wait(5))
    # A second run while it is still going waits on the same job instead of starting another.
    assert provider._job("download", "m", lambda _job: None) is job
    events = provider._wait(job, lambda: "still going")
    assert next(events) == {"type": "notice", "message": "still going"}
    assert next(events)["type"] == "notice"
    release.set()
    assert list(events) in ([], [{"type": "notice", "message": "still going"}])

    failed = provider._job("load", "m", lambda _job: (_ for _ in ()).throw(RuntimeError("CUDA out of memory")))
    with pytest.raises(ProviderError, match="CUDA out of memory"):
        list(provider._wait(failed, lambda: "loading"))
    # A finished job is replaced by a new one next time.
    assert provider._job("load", "m", lambda _job: None) is not failed


def test_partials_left_by_a_stopped_download_are_not_counted_and_are_cleared(tmp_path, monkeypatch):
    from huggingface_hub import constants

    from verdandi_ai.providers import local_hf

    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    blobs = tmp_path / "models--org--model" / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "done").write_bytes(b"x" * 100)
    (blobs / "old.a1.incomplete").write_bytes(b"x" * 40)
    (blobs / "new.b2.incomplete").write_bytes(b"x" * 7)
    now = time.time()
    old = now - local_hf.STALE_SECONDS - 60
    os.utime(blobs / "old.a1.incomplete", (old, old))

    # Where Windows can't make links, finished files sit in the snapshot folder.
    snapshot = tmp_path / "models--org--model" / "snapshots" / "abc"
    snapshot.mkdir(parents=True)
    (snapshot / "config.json").write_bytes(b"x" * 3)
    # Progress counts finished files and the partial being written, not the abandoned one.
    assert local_hf.downloaded_bytes("org/model", now) == 110
    assert local_hf.clear_stale_partials("org/model", now) == 40
    assert sorted(path.name for path in blobs.iterdir()) == ["done", "new.b2.incomplete"]
