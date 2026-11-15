"""Local model adapter: Hugging Face transformers on CUDA, as in the prototype.

One model at a time, loaded lazily in 4-bit NF4 (float16 fallback), CUDA only
(the prototype's guard: no silent CPU offload), and unloaded after an idle timeout so
VRAM is returned. The lock is the "GPU lane": local jobs run one at a time.

Downloading a model (several GB the first time) and loading it run as background jobs
while the run sends a progress notice every few seconds: a stream that goes quiet for
minutes is dropped by the app's HTTP client, and a job outlives a dropped run, so the
next run picks up where it got to instead of starting the download again.
"""

from __future__ import annotations

import gc
import importlib.util
import os
import sys
import threading
import time
from fnmatch import fnmatch
from collections.abc import Callable, Iterator
from typing import Any

from ..ai_types import GenerateRequest, Profile, ProviderError, ProviderHealth, StreamEvent, done_event, plain_text, text_event, usage_event

DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct"
IDLE_UNLOAD_SECONDS = 600.0
LANE_WAIT_SECONDS = 120.0
# What loading a model needs besides PyTorch (requirements-local.txt). bitsandbytes is
# only needed for 4-bit; without it a model loads in float16, if it fits.
REQUIRED_LIBRARIES = ("transformers", "accelerate")


def missing_libraries() -> list[str]:
    return [name for name in REQUIRED_LIBRARIES if importlib.util.find_spec(name) is None]


# The files a model needs: weights, configuration and tokenizer (not other formats' weights).
DOWNLOAD_PATTERNS = ("*.json", "*.safetensors", "*.txt", "*.model", "*.tiktoken", "*.py")
PROGRESS_SECONDS = 5.0
GB = 1024**3


class Job:
    """Work on a background thread that outlives the run that started it."""

    def __init__(self, label: str, work: Callable[["Job"], Any]) -> None:
        self.done = threading.Event()
        self.error: BaseException | None = None
        self.result: Any = None
        self.started = time.monotonic()
        self.total: int | None = None  # bytes expected, for a download
        self._work = work
        threading.Thread(target=self._run, name=label, daemon=True).start()

    def _run(self) -> None:
        try:
            self.result = self._work(self)
        except BaseException as error:  # handed to whichever run waits for it
            self.error = error
        finally:
            self.done.set()


def cache_folder(name: str) -> str | None:
    """Where the Hugging Face cache keeps a model's files, or None for a model in a local folder."""
    if os.path.isdir(name):
        return None
    from huggingface_hub import constants

    return os.path.join(constants.HF_HUB_CACHE, "models--" + name.replace("/", "--"))


# A partial file untouched for this long was left by a download that stopped.
STALE_SECONDS = 600.0


def _blobs(name: str) -> list[tuple[str, int, float]]:
    """
    The files of a model in the cache: path, size and last change. Downloads land in
    `blobs`, and `snapshots` links to them; where Windows can't make links, the
    finished files are in `snapshots` themselves, so those count too (links don't).
    """
    folder = cache_folder(name)
    found: list[tuple[str, int, float]] = []
    if folder is None:
        return found
    for part in ("blobs", "snapshots"):
        for root, _dirs, files in os.walk(os.path.join(folder, part)):
            for file in files:
                path = os.path.join(root, file)
                try:
                    if os.path.islink(path):
                        continue
                    stat = os.stat(path)
                except OSError:
                    continue
                found.append((path, stat.st_size, stat.st_mtime))
    return found


def downloaded_bytes(name: str, now: float | None = None) -> int:
    """Bytes of the model on disk: finished files, and partial ones still being written."""
    now = time.time() if now is None else now
    return sum(size for path, size, changed in _blobs(name) if not (path.endswith(".incomplete") and now - changed > STALE_SECONDS))


def clear_stale_partials(name: str, now: float | None = None) -> int:
    """
    Removes the partial files a stopped download left in the model's cache folder (a
    new download starts its own), and returns the bytes freed. One still being
    written, by this or another process, is newer than STALE_SECONDS and stays.
    """
    now = time.time() if now is None else now
    freed = 0
    for path, size, changed in _blobs(name):
        if path.endswith(".incomplete") and now - changed > STALE_SECONDS:
            try:
                os.remove(path)
                freed += size
            except OSError:
                pass
    return freed


def download_model(name: str, job: Job) -> None:
    """Fetches a model's files into the cache; a model already there only costs a quick check."""
    if os.path.isdir(name):
        return
    from huggingface_hub import HfApi, snapshot_download

    try:
        info = HfApi().model_info(name, files_metadata=True)
        job.total = sum(
            file.size or 0 for file in info.siblings or [] if any(fnmatch(file.rfilename, pattern) for pattern in DOWNLOAD_PATTERNS)
        )
    except Exception:
        job.total = None  # offline, or the size is unknown; the notice says so
    try:
        snapshot_download(name, allow_patterns=list(DOWNLOAD_PATTERNS))
    except Exception as error:
        try:  # offline: fine if the files are all here already
            snapshot_download(name, allow_patterns=list(DOWNLOAD_PATTERNS), local_files_only=True)
        except Exception:
            raise ProviderError("unavailable", f"Couldn't download {name}: {error}") from error
    # The model is all here: what earlier, stopped downloads left behind is only taking space.
    freed = clear_stale_partials(name)
    if freed:
        # To the AI server's log (Settings), so the space it gave back is accounted for.
        print(f"Removed {freed / GB:.1f} GB of partial files a stopped download of {name} left behind", file=sys.stderr, flush=True)


class LocalHFProvider:
    id = "local_hf"
    label = "Local (transformers)"
    kind = "local"
    supports_tools = False

    def __init__(self, torch_status: Callable[[], dict[str, Any]], idle_seconds: float = IDLE_UNLOAD_SECONDS) -> None:
        self._torch_status = torch_status
        self._idle_seconds = idle_seconds
        self._lane = threading.Lock()
        self._loaded: tuple[str, Any, Any] | None = None  # (name, model, tokenizer)
        self._idle_timer: threading.Timer | None = None
        self._jobs: dict[tuple[str, str], Job] = {}  # ("download" | "load", model name)

    def health(self) -> ProviderHealth:
        status = self._torch_status()
        if status.get("state") == "pending":
            return ProviderHealth(False, "checking PyTorch…")
        if status.get("error"):
            return ProviderHealth(False, "PyTorch failed to load")
        if not status.get("installed"):
            return ProviderHealth(False, "PyTorch not installed")
        if not status.get("cuda_available"):
            return ProviderHealth(False, "CUDA unavailable")
        missing = missing_libraries()
        if missing:
            return ProviderHealth(False, f"{', '.join(missing)} not installed (reinstall the local-model libraries in AI settings)")
        return ProviderHealth(True)

    def loaded_models(self) -> list[str]:
        return [self._loaded[0]] if self._loaded else []

    def unload(self) -> None:
        with self._lane:
            self._unload_locked()

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]:
        health = self.health()
        if not health.configured:
            raise ProviderError("unavailable", f"Local model unavailable: {health.detail}.")
        if not self._lane.acquire(timeout=LANE_WAIT_SECONDS):
            raise ProviderError("unavailable", "The local model is busy with another job.")
        try:
            if self._idle_timer:
                self._idle_timer.cancel()
            name = profile.model or DEFAULT_MODEL
            if not (self._loaded and self._loaded[0] == name):
                download = self._job("download", name, lambda job: download_model(name, job))
                yield from self._wait(download, lambda: self._download_message(name, download))
                load = self._job("load", name, lambda _job: self._load_in_background(name, profile.params))
                yield from self._wait(load, lambda: f"Loading {name} onto the GPU… ({int(time.monotonic() - load.started)} s)")
            model, tokenizer = self._ensure_loaded(name, profile.params)
            yield from self._generate(model, tokenizer, request)
        finally:
            self._schedule_unload()
            self._lane.release()

    # -- internals -------------------------------------------------------------

    def _load_in_background(self, name: str, params: dict[str, Any]) -> tuple[Any, Any]:
        loaded = self._ensure_loaded(name, params)
        # The run that asked for it may be gone; the model still goes after an idle while.
        self._schedule_unload()
        return loaded

    def _job(self, kind: str, name: str, work: Callable[[Job], Any]) -> Job:
        """The job of this kind for this model: the one still running, or a new one."""
        key = (kind, name)
        job = self._jobs.get(key)
        if job is None or job.done.is_set():
            job = Job(f"local-{kind}", work)
            self._jobs[key] = job
        return job

    @staticmethod
    def _wait(job: Job, message: Callable[[], str]) -> Iterator[StreamEvent]:
        """Says how a job is going every few seconds until it ends, then raises its error if it failed."""
        if not job.done.wait(0.5):
            yield {"type": "notice", "message": message()}
            while not job.done.wait(PROGRESS_SECONDS):
                yield {"type": "notice", "message": message()}
        if isinstance(job.error, ProviderError):
            raise job.error
        if job.error is not None:
            raise ProviderError("unavailable", f"{type(job.error).__name__}: {job.error}") from job.error

    @staticmethod
    def _download_message(name: str, job: Job) -> str:
        done = downloaded_bytes(name)
        if job.total and done >= job.total:
            return f"Checking {name} is up to date…"
        if job.total:
            share = min(1.0, done / job.total)
            return f"Downloading {name}: {done / GB:.1f} of {job.total / GB:.1f} GB ({share:.0%}). Only the first time."
        if done:
            return f"Downloading {name}: {done / GB:.1f} GB so far. Only the first time."
        return f"Getting {name} ready…"

    def _ensure_loaded(self, name: str, params: dict[str, Any]) -> tuple[Any, Any]:
        if self._loaded and self._loaded[0] == name:
            return self._loaded[1], self._loaded[2]
        self._unload_locked()
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        attempts: list[tuple[str, dict[str, Any]]] = []
        if params.get("quant", "4bit") == "4bit" and importlib.util.find_spec("bitsandbytes") is not None:
            attempts.append(("4-bit NF4", {"quantization_config": BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=torch.bfloat16,
            )}))
        attempts.append(("float16", {"torch_dtype": torch.float16}))

        failures: list[str] = []
        for label, kwargs in attempts:
            try:
                model = AutoModelForCausalLM.from_pretrained(name, device_map="cuda", trust_remote_code=True, **kwargs)
            except Exception as error:  # try the next precision
                failures.append(f"{label}: {error}")
                continue
            devices = {parameter.device.type for parameter in model.parameters()}
            if devices != {"cuda"}:
                del model
                self._free_cuda()
                raise ProviderError("unavailable", f"{name} did not fit on the GPU (parts landed on {sorted(devices)}).")
            tokenizer = AutoTokenizer.from_pretrained(name, trust_remote_code=True)
            self._loaded = (name, model, tokenizer)
            return model, tokenizer
        raise ProviderError("unavailable", f"Could not load {name}. " + " | ".join(failures))

    def _generate(self, model: Any, tokenizer: Any, request: GenerateRequest) -> Iterator[StreamEvent]:
        from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

        messages = [{"role": "system", "content": request.system}] if request.system else []
        messages += [{"role": message.role, "content": plain_text(message)} for message in request.messages]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=300)
        cancelled = threading.Event()

        class StopWhenCancelled(StoppingCriteria):
            def __call__(self, *_args: Any, **_kwargs: Any) -> bool:
                return cancelled.is_set()

        options: dict[str, Any] = {
            **inputs,
            "max_new_tokens": request.max_tokens,
            "streamer": streamer,
            "stopping_criteria": StoppingCriteriaList([StopWhenCancelled()]),
            "pad_token_id": tokenizer.eos_token_id,
            "repetition_penalty": 1.1,
        }
        if request.temperature:
            options.update(do_sample=True, temperature=request.temperature, top_p=0.9)
        else:
            options.update(do_sample=False)

        failures: list[BaseException] = []

        def work() -> None:
            try:
                model.generate(**options)
            except BaseException as error:  # reported below, not lost in the thread
                failures.append(error)
                streamer.end()

        worker = threading.Thread(target=work, name="local-generate", daemon=True)
        worker.start()
        try:
            for piece in streamer:
                if piece:
                    yield text_event(piece)
        finally:
            # Runs on completion and when the client disconnects (generator closed).
            cancelled.set()
            worker.join()
        if failures:
            raise ProviderError("unavailable", f"The local model failed: {failures[0]}")
        # Not reached when the client disconnects: closing the generator stops at the finally above.
        yield usage_event(int(inputs["input_ids"].shape[1]), None)
        yield done_event("end_turn")

    def _schedule_unload(self) -> None:
        if self._idle_timer:
            self._idle_timer.cancel()
        self._idle_timer = threading.Timer(self._idle_seconds, self.unload)
        self._idle_timer.daemon = True
        self._idle_timer.start()

    def _unload_locked(self) -> None:
        if self._loaded is None:
            return
        self._loaded = None
        self._free_cuda()

    @staticmethod
    def _free_cuda() -> None:
        gc.collect()
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:
            pass
