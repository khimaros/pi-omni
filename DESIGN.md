# DESIGN

## Overview

pi-omni is a voice interface for pi.dev. It provides a bridge between a local STT/LLM/TTS stack and a pi agent session.

## Components

### Extension (src/extension/)
The core pi extension that handles commands and shortcuts within the pi TUI.

### Web Server (src/server/)
A Node.js HTTP and WebSocket server that serves the browser-based UI and handles real-time communication between the browser and the pi session.

### Audio Pipeline (src/audio/)
Handles microphone input, Voice Activity Detection (VAD), Acoustic Echo Cancellation (AEC), Speech-to-Text (STT), and Text-to-Speech (TTS).

## Web UI & PWA

The Web UI is a vanilla HTML/JS/CSS application designed for low latency and high interactivity.

### PWA Implementation
- **Manifest**: `public/manifest.json` defines the app identity and standalone display mode.
- **Service Worker**: `public/sw.js` provides basic offline caching for core assets and satisfies installation criteria.
- **Icon**: A premium waveform-based icon (`public/icon.png`) is used for the app icon on mobile/desktop.
- **Aesthetics**: Modern typography, dark mode, and glowing animations consistent with the pi.dev aesthetic.
