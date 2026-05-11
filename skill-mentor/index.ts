import type { ExtensionAPI, ExtensionEvent } from '@earendil-works/pi-coding-agent';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import * as yaml from 'yaml';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

type MessageEndEvent = Extract<ExtensionEvent, { type: 'message_end' }>;

const DEFAULT_MODEL = 'adesso-openai/gpt-4o-mini';
const INSTRUCTION_PREFIX = 'Execute skill ';
const SKILL_MENTOR_CUSTOM_TYPE = 'skill-mentor-instruction';

// Schema for the LLM response
const SkillMatchSchema = z.object({
  matched: z.boolean(),
  skillName: z.string().optional(),
  reason: z.string().optional()
});

/**
 * Extension factory function
 * @param pi The Pi extension API
 */
export default function (pi: ExtensionAPI): void {
  console.log('Pi Skill Mentor extension activated');

  // Register the message_end hook
  pi.on('message_end', async (event: MessageEndEvent): Promise<void> => {
    await handleMessageEnd(event, pi);
  });
}

/**
 * Handle the message_end event
 */
async function handleMessageEnd(event: MessageEndEvent, pi: ExtensionAPI): Promise<void> {
  try {
    if (!isSupportedMessage(event.message)) {
      return;
    }

    // Type guard to ensure content property exists
    if (!('content' in event.message)) {
      return;
    }
    
    const messageText = extractMessageText(event.message.content);
    if (!messageText) {
      return;
    }

    // Prevent recursive matching on our own follow-up instructions
    if (isSkillMentorMessage(event.message) || isSkillMentorInstruction(messageText)) {
      return;
    }

    const modelConfig = loadModelConfig();

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: '~/.pi/agent'
    });
    await loader.reload();

    const { skills } = loader.getSkills();
    if (skills.length === 0) {
      return;
    }

    const skillsWithTriggers = extractSkillsWithTriggers(skills);
    if (skillsWithTriggers.length === 0) {
      return;
    }

    const openai = createOpenAI({
      // Uses OPENAI_API_KEY from environment variables
    });

    const model = openai(modelConfig.model || DEFAULT_MODEL);

    const result = await generateObject({
      model,
      schema: SkillMatchSchema,
      prompt: `You are a skill matching assistant. Your task is to determine if the latest message in the conversation (which could be from the user OR the agent) implies that a skill should be executed.

Latest message to evaluate: "${messageText}"
Message role: ${event.message.role}

Available skills with their triggers:
${skillsWithTriggers.map(s => `- ${s.name}: ${s.description}\n  Triggers: ${s.triggers.join(', ')}`).join('\n')}

Examples of good matches:
- User message: "Save this idea about improving the UI" -> Good match for a skill with triggers like ["idea", "concept", "suggestion"]
- User message: "Remember this link for later" -> Good match for a skill with triggers like ["save link", "bookmark", "remember url"]
- Agent message: "I should capture this as a concept entry first" -> Good match when a trigger-like action is explicitly proposed

Examples of bad matches:
- User message: "What do you think about this idea?" -> Bad match, just discussing ideas without intent to capture/save
- User message: "Ideas are interesting" -> Bad match, general comment without action
- Agent message: "Interesting point, let's continue" -> Bad match, conversational continuation without a concrete skill action

Determine if the latest message is a good match for any skill. Only return matched=true if the message clearly indicates intent to execute a skill action.`
    });

    if (result.object.matched && result.object.skillName) {
      const reason = result.object.reason || 'Matched trigger intent';
      const instruction = `${INSTRUCTION_PREFIX}${result.object.skillName} - Reason: ${reason}`;
      sendInstruction(pi, instruction);
    }
  } catch (error) {
    console.error('Error in skill-mentor extension:', error);
    // Don't break the agent flow if we have an error
  }
}

function isSupportedMessage(message: MessageEndEvent['message']): message is MessageEndEvent['message'] & { role: 'user' | 'assistant'; content: unknown } {
  return (message.role === 'user' || message.role === 'assistant') && 'content' in message;
}

function isSkillMentorMessage(message: MessageEndEvent['message']): boolean {
  return 'customType' in message && message.customType === SKILL_MENTOR_CUSTOM_TYPE;
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  const textParts: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    const maybeType = (part as { type?: unknown }).type;
    const maybeText = (part as { text?: unknown }).text;

    if (maybeType === 'text' && typeof maybeText === 'string') {
      textParts.push(maybeText);
    }
  }

  return textParts.join('\n').trim();
}

function isSkillMentorInstruction(text: string): boolean {
  return /^Execute skill .+ - Reason: .+$/.test(text);
}

function sendInstruction(pi: ExtensionAPI, instruction: string): void {
  if (typeof (pi as Partial<ExtensionAPI>).sendMessage === 'function') {
    pi.sendMessage(
      {
        customType: SKILL_MENTOR_CUSTOM_TYPE,
        content: instruction,
        display: false
      },
      {
        triggerTurn: true,
        deliverAs: 'followUp'
      }
    );
    return;
  }

  pi.sendUserMessage(instruction, { deliverAs: 'followUp' });
}

function loadModelConfig(): { model: string } {
  const configDir = path.join(process.env.HOME || '~', '.pi', 'agent');
  const configPath = path.join(configDir, 'skill-mentor.json');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ model: DEFAULT_MODEL }, null, 2));
    return { model: DEFAULT_MODEL };
  }

  try {
    const configFile = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configFile);
  } catch {
    return { model: DEFAULT_MODEL };
  }
}

function extractSkillsWithTriggers(skills: Array<{ name: string; description?: string; filePath?: string }>): Array<{ name: string; description: string; triggers: string[] }> {
  const skillsWithTriggers: Array<{ name: string; description: string; triggers: string[] }> = [];

  for (const skill of skills) {
    try {
      if (!skill.filePath || !fs.existsSync(skill.filePath)) {
        continue;
      }

      const fileContent = fs.readFileSync(skill.filePath, 'utf8');

      // Extract YAML frontmatter
      const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
      const match = fileContent.match(frontmatterRegex);

      if (!match?.[1]) {
        continue;
      }

      const frontmatter = yaml.parse(match[1]) as { description?: string; triggers?: unknown };

      if (Array.isArray(frontmatter.triggers)) {
        const triggers = frontmatter.triggers.filter((trigger): trigger is string => typeof trigger === 'string');

        if (triggers.length > 0) {
          skillsWithTriggers.push({
            name: skill.name,
            description: skill.description || frontmatter.description || '',
            triggers
          });
        }
      }
    } catch (error) {
      console.warn(`Error processing skill file ${skill.filePath}:`, error);
    }
  }

  return skillsWithTriggers;
}
