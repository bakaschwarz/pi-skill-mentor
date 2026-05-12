import type { ExtensionAPI, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import * as yaml from "yaml";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";

type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>;

const DEFAULT_MODEL = "adesso-openai/gpt-4o-mini";
const INSTRUCTION_PREFIX = "Execute skill ";
const SKILL_MENTOR_CUSTOM_TYPE = "skill-mentor-instruction";

// Module-level state for singletons and caching
let resourceLoaderInstance: DefaultResourceLoader | null = null;
let openAIClientInstance: ReturnType<typeof createOpenAI> | null = null;
let perTurnEvaluated = false;

// Cache for skill triggers with file metadata
const skillTriggerCache = new Map<string, {
    content: string;
    triggers: Array<{ name: string; description: string; triggers: string[] }>;
    signature: string; // mtimeMs:size
}>();

const ConfigSchema = z.object({
    model: z.string().default(DEFAULT_MODEL),
    apiKey: z.string().default(""),
    apiKeyEnvVar: z.string().default(""),
    triggerOnUserMessages: z.boolean().default(true),
    triggerOnAgentMessages: z.boolean().default(false),
    debug: z.boolean().default(false),
    maxSkills: z.coerce.number().int().min(1).default(3),
});

export type SkillMentorConfig = z.infer<typeof ConfigSchema>;

// Schema for the LLM response
const SkillMatchSchema = z.object({
    skillName: z.string(),
    reason: z.string(),
});

const SkillMatchesSchema = z.object({
    matches: z.array(SkillMatchSchema),
});

/**
 * Extension factory function
 * @param pi The Pi extension API
 */
export default function (pi: ExtensionAPI): void {
    pi.on("before_agent_start", async (event: Extract<ExtensionEvent, { type: "before_agent_start" }>, ctx) => {
        try {
            const prompt = event.prompt;
            if (!prompt) return {};
            if (isSkillMentorInstruction(prompt)) return {};
            // Skip direct skill calls
            if (isDirectSkillCall(prompt)) return {};

            const modelConfig = loadModelConfig();
            const matches = await evaluateMessageMatch(prompt, "user", modelConfig, ctx);
            if (!matches || matches.length === 0) return {};

            // Set the gate flag only when a match was actually sent
            perTurnEvaluated = true;

            if (modelConfig.debug) {
                const debugContent = `Skill Mentor decision: matched=true, skillNames=[${matches.map(m => m.skillName).join(", ")}], reasons=[${matches.map(m => m.reason).join(", ")}]`;
                if (typeof (pi as Partial<ExtensionAPI>).sendMessage === "function") {
                    pi.sendMessage(
                        { customType: "skill-mentor-debug", content: debugContent, display: true },
                        { triggerTurn: false },
                    );
                } else {
                    console.log(debugContent);
                }
            }

            // Format all matched skills into a single instruction
            const instructions = matches.map(match => 
                `${INSTRUCTION_PREFIX}${match.skillName} - Reason: ${match.reason}`
            ).join("\n");
            
            return {
                message: {
                    customType: SKILL_MENTOR_CUSTOM_TYPE,
                    content: instructions,
                    display: false,
                },
            };
        } catch (error) {
            console.error("Error in skill-mentor before_agent_start hook:", error);
        }
        return {};
    });

    // Register the message_end hook
    pi.on("message_end", async (event: MessageEndEvent, ctx): Promise<void> => {
        await handleMessageEnd(event, pi, ctx);
    });

    // Reset per-turn evaluation flag at end of agent turn
    pi.on("agent_end", async (): Promise<void> => {
        perTurnEvaluated = false;
    });
}

/**
 * Get or create a singleton resource loader instance
 */
function getResourceLoader(): DefaultResourceLoader {
    if (!resourceLoaderInstance) {
        resourceLoaderInstance = new DefaultResourceLoader({
            cwd: process.cwd(),
            agentDir: path.join(os.homedir(), ".pi", "agent"),
        });
    }
    return resourceLoaderInstance;
}

/**
 * Get or create a singleton OpenAI client instance
 */
function getOpenAIClient(apiKey: string) {
    if (!openAIClientInstance) {
        openAIClientInstance = createOpenAI({ apiKey });
    }
    return openAIClientInstance;
}

/**
 * Reset module state (for testing)
 */
export function resetModuleState(): void {
    resourceLoaderInstance = null;
    openAIClientInstance = null;
    perTurnEvaluated = false;
    skillTriggerCache.clear();
}

/**
 * Handle the message_end event
 */
async function evaluateMessageMatch(
    messageText: string,
    messageRole: "user" | "assistant",
    modelConfig: SkillMentorConfig,
    ctx: any = {},
): Promise<Array<{ skillName: string; reason: string }> | null> {
    if (!messageText) return null;

    // Skip direct skill calls
    if (messageRole === "user" && isDirectSkillCall(messageText)) return null;

    if (messageRole === "user" && !modelConfig.triggerOnUserMessages) return null;
    if (messageRole === "assistant" && !modelConfig.triggerOnAgentMessages) return null;

    const resolvedApiKey = resolveApiKey(modelConfig);
    if (!resolvedApiKey) return null;

    // Use singleton resource loader
    const loader = getResourceLoader();
    await loader.reload();

    const { skills } = loader.getSkills();
    if (skills.length === 0) return null;

    const skillsWithTriggers = await extractSkillsWithTriggersAsync(skills);
    if (skillsWithTriggers.length === 0) return null;

    // Use singleton OpenAI client
    const openai = getOpenAIClient(resolvedApiKey);
    const model = openai(modelConfig.model || DEFAULT_MODEL);

    // Set UI working indicator before LLM call
    if (ctx.ui) {
        ctx.ui.setStatus("skill-mentor", "● Skill Mentor is thinking...");
    }

    // Allow UI to update before blocking LLM call
    // Note: setTimeout(0) hack removed as it doesn't work in before_agent_start hook
    // The loading animation doesn't exist yet, so we use setStatus instead

    try {
        const result = await generateObject({
            model,
            schema: SkillMatchesSchema,
            prompt: `You are a skill matching assistant. Your task is to determine if the latest message in the conversation (which could be from the user OR the agent) implies that skills should be executed.

Latest message to evaluate: "${messageText}"
Message role: ${messageRole}

Available skills with their triggers:
${skillsWithTriggers.map(s => `- ${s.name}: ${s.description}\n  Triggers: ${s.triggers.join(", ")}`).join("\n")}

Triggers can be describing a context in which a skill should be triggered or just keywords to look for in a fuzzy manner.
You have to evaluate both

Please rank the skills by relevance to the message, with the most relevant first. Return up to ${modelConfig.maxSkills} skills in order of relevance.

Examples of good matches:
- Any User message -> Good match for a skill with triggers like ["trigger always", "use on every user message", "at all times"] (context)
- Any Agent message -> Good match for a skill with triggers like ["trigger always", "use on every agent message", "at all times"] (context)
- User message: "Save this idea about improving the UI" -> Good match for a skill with triggers like ["idea", "concept", "suggestion"] (keywords)
- User message: "Remember this link for later" -> Good match for a skill with triggers like ["save link", "bookmark", "remember url"] (keywords)
- Agent message: "I should capture this as a concept entry first" -> Good match when a trigger-like action is explicitly proposed (context)

Examples of bad matches:
- User message: "What do you think about this idea?" -> Bad match, just discussing ideas without intent to capture/save
- User message: "Ideas are interesting" -> Bad match, general comment without action
- Agent message: "Interesting point, let's continue" -> Bad match, conversational continuation without a concrete skill action

The bad matches are overridden if triggers are something like "on every message", since those should trigger on **every** message.

Return a ranked list of skills that match the message. Only include skills that clearly indicate intent to execute a skill action.`,
        });
        
        // Normalize and filter results
        if (!result.object.matches || result.object.matches.length === 0) return [];
        
        // Filter to only include known skills
        const knownSkillNames = new Set(skillsWithTriggers.map(s => s.name));
        const filteredMatches = result.object.matches.filter(match => knownSkillNames.has(match.skillName));
        
        // Deduplicate by skillName
        const seen = new Set<string>();
        const deduplicatedMatches = filteredMatches.filter(match => {
            if (seen.has(match.skillName)) return false;
            seen.add(match.skillName);
            return true;
        });
        
        // Cap to maxSkills
        return deduplicatedMatches.slice(0, modelConfig.maxSkills);
    } finally {
        // Always clear UI working indicator
        if (ctx.ui) {
            ctx.ui.setStatus("skill-mentor", undefined);
        }
    }
}

async function handleMessageEnd(event: MessageEndEvent, pi: ExtensionAPI, ctx: any = {}): Promise<void> {
    try {
        // Skip evaluation when both conditions are true:
        // 1. perTurnEvaluated === true (already evaluated in this turn)
        // 2. triggerOnUserMessages is enabled (user-trigger mode)
        const modelConfig = loadModelConfig();
        if (perTurnEvaluated && modelConfig.triggerOnUserMessages) return;

        if (!isSupportedMessage(event.message)) return;
        if (event.message.role !== "assistant") return; // Only process assistant messages here
        if (!("content" in event.message)) return;

        const messageText = extractMessageText(event.message.content);
        if (!messageText) return;

        if (isSkillMentorMessage(event.message) || isSkillMentorInstruction(messageText)) return;

        // Skip direct skill calls in message_end as well
        if (isDirectSkillCall(messageText)) return;
        
        const matches = await evaluateMessageMatch(messageText, "assistant", modelConfig, ctx);
        if (!matches || matches.length === 0) return;

        if (modelConfig.debug) {
            const debugContent = `Skill Mentor decision: matched=true, skillNames=[${matches.map(m => m.skillName).join(", ")}], reasons=[${matches.map(m => m.reason).join(", ")}]`;
            if (typeof (pi as Partial<ExtensionAPI>).sendMessage === "function") {
                pi.sendMessage(
                    { customType: "skill-mentor-debug", content: debugContent, display: true },
                    { triggerTurn: false },
                );
            } else {
                console.log(debugContent);
            }
        }

        // Format all matched skills into a single instruction
        const instructions = matches.map(match => 
            `${INSTRUCTION_PREFIX}${match.skillName} - Reason: ${match.reason}`
        ).join("\n");
        
        sendInstruction(pi, instructions, "steer");
    } catch (error) {
        console.error("Error in skill-mentor extension:", error);
    }
}

function isSupportedMessage(
    message: MessageEndEvent["message"],
): message is MessageEndEvent["message"] & { role: "user" | "assistant"; content: unknown } {
    return (message.role === "user" || message.role === "assistant") && "content" in message;
}

function isSkillMentorMessage(message: MessageEndEvent["message"]): boolean {
    return "customType" in message && message.customType === SKILL_MENTOR_CUSTOM_TYPE;
}

function extractMessageText(content: unknown): string {
    if (!Array.isArray(content)) {
        return "";
    }

    const textParts: string[] = [];

    for (const part of content) {
        if (!part || typeof part !== "object") {
            continue;
        }

        const maybeType = (part as { type?: unknown }).type;
        const maybeText = (part as { text?: unknown }).text;

        if (maybeType === "text" && typeof maybeText === "string") {
            textParts.push(maybeText);
        }
    }

    return textParts.join("\n").trim();
}

function isSkillMentorInstruction(text: string): boolean {
    // Handle both single-line and multi-line instruction payloads
    const lines = text.split('\n');
    return lines.every(line => /^Execute skill .+ - Reason: .+$/.test(line.trim()));
}

/**
 * Check if a message is a direct skill call
 */
function isDirectSkillCall(messageText: string): boolean {
    return messageText.trim().startsWith('/skill:');
}

function sendInstruction(pi: ExtensionAPI, instruction: string, deliverAs: "steer" | "followUp" = "steer"): void {
    if (typeof (pi as Partial<ExtensionAPI>).sendMessage === "function") {
        pi.sendMessage(
            {
                customType: SKILL_MENTOR_CUSTOM_TYPE,
                content: instruction,
                display: false,
            },
            {
                triggerTurn: true,
                deliverAs,
            },
        );
        return;
    }

    pi.sendUserMessage(instruction, { deliverAs });
}

export function loadModelConfig(): SkillMentorConfig {
    const configDir = path.join(os.homedir(), ".pi", "agent");
    const configPath = path.join(configDir, "skill-mentor.json");
    const defaultConfig = ConfigSchema.parse({});

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
    }

    try {
        const configFile = fs.readFileSync(configPath, "utf8");
        const parsed = JSON.parse(configFile);
        return ConfigSchema.parse(parsed);
    } catch {
        return defaultConfig;
    }
}

export function resolveApiKey(config: SkillMentorConfig): string {
    if (config.apiKeyEnvVar && process.env[config.apiKeyEnvVar]) {
        return process.env[config.apiKeyEnvVar]!;
    }
    if (config.apiKey && process.env[config.apiKey]) {
        return process.env[config.apiKey]!;
    }
    if (config.apiKey) {
        return config.apiKey;
    }
    if (process.env.OPENAI_API_KEY) {
        return process.env.OPENAI_API_KEY;
    }
    return "";
}

async function extractSkillsWithTriggersAsync(
    skills: Array<{ name: string; description?: string; filePath?: string }>,
): Promise<Array<{ name: string; description: string; triggers: string[] }>> {
    const skillsWithTriggers: Array<{ name: string; description: string; triggers: string[] }> = [];

    for (const skill of skills) {
        try {
            if (!skill.filePath) {
                continue;
            }

            // Use async fs operations for cache invalidation
            const stat = await fs.promises.stat(skill.filePath).catch(() => null);
            if (!stat) {
                // File doesn't exist, remove from cache if present
                skillTriggerCache.delete(skill.filePath);
                continue;
            }

            // Create cache signature using mtimeMs and size
            const signature = `${stat.mtimeMs}:${stat.size}`;
            
            // Check if we have a cached version with the same signature
            const cached = skillTriggerCache.get(skill.filePath);
            if (cached && cached.signature === signature) {
                // Reuse cached parsed frontmatter
                skillsWithTriggers.push(...cached.triggers);
                continue;
            }

            // Read file content and parse
            const fileContent = await fs.promises.readFile(skill.filePath, "utf8");

            // Extract YAML frontmatter
            const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
            const match = fileContent.match(frontmatterRegex);

            if (!match?.[1]) {
                continue;
            }

            const frontmatter = yaml.parse(match[1]) as { description?: string; triggers?: unknown };

            if (Array.isArray(frontmatter.triggers)) {
                const triggers = frontmatter.triggers.filter(
                    (trigger): trigger is string => typeof trigger === "string",
                );

                if (triggers.length > 0) {
                    const skillTrigger = {
                        name: skill.name,
                        description: skill.description || frontmatter.description || "",
                        triggers,
                    };
                    skillsWithTriggers.push(skillTrigger);
                    
                    // Update cache
                    skillTriggerCache.set(skill.filePath, {
                        content: fileContent,
                        triggers: [skillTrigger],
                        signature
                    });
                }
            }
        } catch (error) {
            console.warn(`Error processing skill file ${skill.filePath}:`, error);
            // Remove from cache on error
            skillTriggerCache.delete(skill.filePath);
        }
    }

    return skillsWithTriggers;
}
