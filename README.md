# Pi Skill Mentor Extension

This extension helps users discover and invoke skills based on natural language prompts.

## How it works

1. Listens to the `message_end` event to capture both user prompts and agent responses
2. Uses `DefaultResourceLoader` to locate active skill files and extracts YAML frontmatter with `triggers`
3. Uses an LLM to match conversation messages (from both user and agent) with appropriate skills
4. Automatically injects skill execution instructions when a match is found

## Configuration

Create a `~/.pi/agent/skill-mentor.json` file to configure the model:

```json
{
  "model": "gpt-4o-mini"
}
```

If this file is not found, it defaults to using `gpt-4o-mini`.

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