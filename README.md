# Pi Skill Mentor Extension

This extension helps users discover and invoke skills based on natural language prompts. It can now suggest multiple ranked skills per message and automatically skip direct skill calls.

## How it works

1. Listens to the `message_end` event to capture both user prompts and agent responses
2. Uses `DefaultResourceLoader` to locate active skill files and extracts YAML frontmatter with `triggers`
3. Uses an LLM to match conversation messages (from both user and agent) with appropriate skills
4. Automatically injects skill execution instructions when matches are found (up to `maxSkills` per message)
5. Skips evaluation for direct skill calls that begin with `/skill:`

## Evaluation Policy

The extension implements a one-evaluation-per-turn gating policy to avoid redundant evaluations. When `triggerOnUserMessages` is enabled (default), if a skill match is found during the user prompt phase (`before_agent_start`), no additional evaluation occurs during the agent response phase (`message_end`). The `agent_end` hook resets this gating flag for the next conversation turn.

## Caching Behavior

To optimize performance, the extension caches parsed skill frontmatter. Cache entries are invalidated based on file modification time and size (`mtimeMs + size`), ensuring fresh content is used when skill files change.

## Known Limitations

- UI working indicators set via `setWorkingMessage` in the `agent_start` hook may appear delayed due to [issue #935](https://github.com/earendil-works/pi/issues/935).
- Prompt payload-size optimization (embedding all skill descriptions) is explicitly out of scope for now to maintain simplicity and reduce token usage.

## Configuration

Create a `~/.pi/agent/skill-mentor.json` file to configure the model:

```json
{
  "model": "gpt-4o-mini",
  "maxSkills": 3
}
```

If this file is not found, it defaults to using `gpt-4o-mini` and a maximum of 3 skills per message.

## Skill Format

Skills should include YAML frontmatter with a `triggers` array:

```yaml
---
name: Idea Ingestion
description: Captures and stores ideas for later review
triggers:
  - "idea"
  - "concept"
  - "suggestion"
  - "store idea"
  - "capture idea"
---
# Skill implementation here
```

## Usage

Once installed, the extension automatically analyzes user prompts and suggests relevant skills.

Example interactions:
- User: "Save this idea about improving the UI" → Will match a skill with triggers like ["idea", "concept", "suggestion"]
- User: "Remember this link for later" → Will match a skill with triggers like ["save link", "bookmark", "remember url"]

When multiple skills match, the extension ranks them by relevance and injects up to `maxSkills` instructions.

Direct skill calls (messages starting with `/skill:`) are automatically skipped by the mentor.

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the extension:
   ```bash
   npm run build
   ```

3. The extension will be available in the `skill-mentor/` directory.

## Testing

Run tests with:
```bash
npm test
```

## Development

The extension follows the Pi Extension API and exports a default function that receives the ExtensionAPI.