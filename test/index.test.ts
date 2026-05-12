import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const generateObjectMock = vi.fn();
  const openAIModelMock = vi.fn();
  const createOpenAIMock = vi.fn(() => openAIModelMock);
  const loaderReloadMock = vi.fn();
  const loaderGetSkillsMock = vi.fn();
  const defaultResourceLoaderMock = vi.fn(() => ({
    reload: loaderReloadMock,
    getSkills: loaderGetSkillsMock
  }));

  const existsSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const mkdirSyncMock = vi.fn();
  const writeFileSyncMock = vi.fn();
  const statMock = vi.fn();
  const readFileMock = vi.fn();

  return {
    generateObjectMock,
    createOpenAIMock,
    defaultResourceLoaderMock,
    loaderReloadMock,
    loaderGetSkillsMock,
    existsSyncMock,
    readFileSyncMock,
    mkdirSyncMock,
    writeFileSyncMock,
    statMock,
    readFileMock
  };
});

vi.mock('ai', () => ({
  generateObject: mocks.generateObjectMock
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAIMock
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  DefaultResourceLoader: mocks.defaultResourceLoaderMock
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: mocks.readFileSyncMock,
    existsSync: mocks.existsSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
    writeFileSync: mocks.writeFileSyncMock,
    promises: {
      stat: mocks.statMock,
      readFile: mocks.readFileMock
    }
  }
}));

import extension, { resolveApiKey, resetModuleState } from '../skill-mentor/index.js';
import path from 'path';
import os from 'os';

describe('Pi Skill Mentor Config & API Key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MY_CUSTOM_KEY;
    delete process.env.OPENAI_API_KEY;
    resetModuleState();
  });

  it('resolves API key from apiKeyEnvVar priority', () => {
    process.env.MY_CUSTOM_KEY = 'env-var-key';
    const key = resolveApiKey({
      model: 'test',
      apiKey: 'some-literal',
      apiKeyEnvVar: 'MY_CUSTOM_KEY',
      triggerOnUserMessages: true,
      triggerOnAgentMessages: false, debug: false
    });
    expect(key).toBe('env-var-key');
  });

  it('resolves API key from apiKey as env var fallback', () => {
    process.env.MY_CUSTOM_KEY = 'fallback-env-key';
    const key = resolveApiKey({
      model: 'test',
      apiKey: 'MY_CUSTOM_KEY',
      apiKeyEnvVar: '',
      triggerOnUserMessages: true,
      triggerOnAgentMessages: false, debug: false
    });
    expect(key).toBe('fallback-env-key');
  });

  it('resolves API key from apiKey literal', () => {
    const key = resolveApiKey({
      model: 'test',
      apiKey: 'sk-literal-key',
      apiKeyEnvVar: '',
      triggerOnUserMessages: true,
      triggerOnAgentMessages: false, debug: false
    });
    expect(key).toBe('sk-literal-key');
  });

  it('resolves API key from OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'default-env-key';
    const key = resolveApiKey({
      model: 'test',
      apiKey: '',
      apiKeyEnvVar: '',
      triggerOnUserMessages: true,
      triggerOnAgentMessages: false, debug: false
    });
    expect(key).toBe('default-env-key');
  });

  it('returns empty string if no key is found', () => {
    const key = resolveApiKey({
      model: 'test',
      apiKey: '',
      apiKeyEnvVar: '',
      triggerOnUserMessages: true,
      triggerOnAgentMessages: false, debug: false
    });
    expect(key).toBe('');
  });
});

describe('Pi Skill Mentor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    resetModuleState();

    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('skill-mentor.json')) {
        return JSON.stringify({ model: 'adesso-openai/gpt-4o-mini', triggerOnAgentMessages: true });
      }
      return `---\ntriggers:\n  - idea\ndescription: Captures ideas\n---\n# Skill`;
    });
    
    mocks.statMock.mockResolvedValue({ mtimeMs: 1000, size: 100 });
    mocks.readFileMock.mockResolvedValue(`---\ntriggers:\n  - idea\ndescription: Captures ideas\n---\n# Skill`);

    mocks.loaderReloadMock.mockResolvedValue(undefined);
    mocks.loaderGetSkillsMock.mockReturnValue({
      skills: [
        {
          name: 'capture-idea',
          description: 'Capture ideas',
          filePath: '/tmp/capture-idea.md'
        }
      ],
      diagnostics: []
    });

    mocks.generateObjectMock.mockResolvedValue({
      object: {
        matches: [
          {
            skillName: 'capture-idea',
            reason: 'User wants to save an idea'
          }
        ]
      }
    });
  });

  it('registers hooks', () => {
    const onMock = vi.fn();
    const pi = {
      on: onMock,
      sendMessage: vi.fn()
    } as any;

    extension(pi);

    expect(onMock).toHaveBeenCalledWith('message_end', expect.any(Function));
    expect(onMock).toHaveBeenCalledWith('before_agent_start', expect.any(Function));
    expect(onMock).toHaveBeenCalledWith('agent_end', expect.any(Function));
  });

  it('resets perTurnEvaluated flag on agent_end', async () => {
    const onMock = vi.fn();
    const pi = { on: onMock, sendMessage: vi.fn() } as any;

    extension(pi);
    
    // First simulate a user message to set the perTurnEvaluated flag
    const beforeAgentStartHandler = onMock.mock.calls.find(([eventName]) => eventName === 'before_agent_start')?.[1];
    await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: 'Please save this idea for later.'
    }, {});

    // Simulate agent_end to reset the flag
    const agentEndHandler = onMock.mock.calls.find(([eventName]) => eventName === 'agent_end')?.[1];
    await agentEndHandler();
    
    // Verify that a subsequent evaluation can happen (flag was reset)
    mocks.generateObjectMock.mockClear();
    
    await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: 'Another idea to save'
    }, {});
    
    // Should be called again since flag was reset
    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it('evaluates user messages and returns message to inject (before_agent_start)', async () => {
    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const beforeAgentStartHandler = onMock.mock.calls.find(([eventName]) => eventName === 'before_agent_start')?.[1];

    const result = await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: 'Please save this idea for later.'
    }, {});

    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: { customType: 'skill-mentor-instruction', content: 'Execute skill capture-idea - Reason: User wants to save an idea', display: false } });
  });

  it('evaluates agent messages and sends steered instruction (message_end)', async () => {
    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const messageEndHandler = onMock.mock.calls.find(([eventName]) => eventName === 'message_end')?.[1];

    await messageEndHandler({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Please save this idea for later.' }]
      }
    });

    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      {
        customType: 'skill-mentor-instruction',
        content: 'Execute skill capture-idea - Reason: User wants to save an idea',
        display: false
      },
      { triggerTurn: true, deliverAs: 'steer' }
    );
  });

  it('does not return instruction when matched is false', async () => {
    mocks.generateObjectMock.mockResolvedValueOnce({
      object: { matches: [] }
    });

    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const beforeAgentStartHandler = onMock.mock.calls.find(([eventName]) => eventName === 'before_agent_start')?.[1];

    const result = await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: 'This is not a match.'
    }, {});

    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({});
  });

  it('skips unsupported roles', async () => {
    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const messageEndHandler = onMock.mock.calls.find(([eventName]) => eventName === 'message_end')?.[1];

    await messageEndHandler({
      type: 'message_end',
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }]
      }
    });

    expect(mocks.generateObjectMock).not.toHaveBeenCalled();
  });

  it('does not reprocess injected Execute skill follow-up messages', async () => {
    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const beforeAgentStartHandler = onMock.mock.calls.find(([eventName]) => eventName === 'before_agent_start')?.[1];

    const result = await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: 'Execute skill capture-idea - Reason: User wants to save an idea'
    }, {});

    expect(mocks.generateObjectMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('skips agent messages when triggerOnAgentMessages is false', async () => {
    mocks.readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('skill-mentor.json')) {
        return JSON.stringify({ triggerOnAgentMessages: false, debug: false });
      }
      return `---\ntriggers:\n  - idea\ndescription: Captures ideas\n---\n# Skill`;
    });

    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const messageEndHandler = onMock.mock.calls.find(([eventName]) => eventName === 'message_end')?.[1];

    await messageEndHandler({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I am an agent saying something.' }]
      }
    });

    expect(mocks.generateObjectMock).not.toHaveBeenCalled();
  });

  it('creates default config with correct defaults if it does not exist', async () => {
    mocks.existsSyncMock.mockImplementation((filePath: string) => !filePath.endsWith('skill-mentor.json'));

    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const beforeAgentStartHandler = onMock.mock.calls.find(([eventName]) => eventName === 'before_agent_start')?.[1];

    await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: 'test'
    }, {});

    expect(mocks.writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('skill-mentor.json'),
      expect.stringContaining('"triggerOnUserMessages": true')
    );
  });

  it('prints debug message if config.debug is true', async () => {
    mocks.readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('skill-mentor.json')) {
        return JSON.stringify({ debug: true });
      }
      return `---\ntriggers:\n  - idea\ndescription: Captures ideas\n---\n# Skill`;
    });

    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const beforeAgentStartHandler = onMock.mock.calls.find(([eventName]) => eventName === 'before_agent_start')?.[1];

    await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: 'Please save this idea'
    }, {});

    expect(sendMessageMock).toHaveBeenCalledWith(
      {
        customType: 'skill-mentor-debug',
        content: 'Skill Mentor decision: matched=true, skillNames=[capture-idea], reasons=[User wants to save an idea]',
        display: true
      },
      { triggerTurn: false }
    );
  });
});

describe('Direct skill call skipping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModuleState();
  });

  it('skips direct skill calls that start with /skill:', async () => {
    const onMock = vi.fn();
    const sendMessageMock = vi.fn();
    const pi = { on: onMock, sendMessage: sendMessageMock } as any;

    extension(pi);
    const beforeAgentStartHandler = onMock.mock.calls.find(([eventName]) => eventName === 'before_agent_start')?.[1];

    const result = await beforeAgentStartHandler({
      type: 'before_agent_start',
      prompt: '/skill:caveman'
    }, {});

    expect(mocks.generateObjectMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});
