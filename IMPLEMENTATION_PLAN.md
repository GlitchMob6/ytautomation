# Implementation Plan: Local-First Preflight & Provider System

## Phase 0: Inspection Results
The current repository utilizes a highly coupled, Gemini-centric workflow initiated by `setup.js`, `walkthrough.js`, and `index.js`. 
- Startup (`index.js`, `setup.js`) performs scattered, shallow checks (e.g., checking if a key *exists* rather than if it *works*, and relying on `ffmpeg-static` without verifying runtime execution properly). 
- `utils/ai-text-service.js` and `utils/ai-video-generator.js` hardcode Gemini models and logic as defaults.
- Fallbacks are often "simulations" that write `.info` files, creating a false sense of readiness.

## Phase 1: Preflight Architecture (Implementation Target)
**Goal:** Build a robust, data-driven preflight system without touching the existing generation code yet.

**Files to create:**
1. `utils/preflight/registry.js`: Defines the structured requirements (Environment, Hardware, Models, Dependencies, etc.) and model catalog (Qwen, Flux, Kokoro).
2. `utils/preflight/status.js`: Defines the status enums (`NOT_CHECKED`, `READY`, `FAILED`, `BYPASSED`, etc.) and capabilities (`TEXT_GENERATION`, `NARRATION`, etc.).
3. `utils/preflight/checkers/base-checker.js` & specific checkers (Environment, Hardware, Dependency).
4. `utils/preflight/preflight-manager.js`: The orchestrator that runs the checks and evaluates overall pipeline readiness.
5. `utils/preflight/preflight-report.js`: Generates the machine-readable and human-readable audit log.

**Implementation Details:**
- We will define the requirement schema with properties: `id, name, category, description, severity, check(), install(), bypassAllowed, dependencies, affects`.
- Capability mapping will link requirements to core functions (e.g., FFmpeg -> `VIDEO_ASSEMBLY`).

## Future Phases (Outline)
- **Phase 2:** Build the GUI (`dashboard/preflight.html`, `preflight-api.js`) for transparent tracking.
- **Phase 3 & 4:** Introduce Provider Abstractions (`LLMProvider`, `TTSProvider`, `ImageProvider`, `VideoProvider`) targeting Qwen, Kokoro, FLUX, and FFmpeg, preserving Gemini as an *optional* provider.
- **Phase 5 & 6:** Strip out dangerous `.info` simulation fallbacks and fix dead YouTube code. Add strict real media verification (FFprobe, Sharp).
- **Phase 7 & 8:** End-to-end integration and optional remote OSS models.
