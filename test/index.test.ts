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

  return {
    generateObjectMock,
    createOpenAIMock,
    defaultResourceLoaderMock,
    loaderReloadMock,
    loaderGetSkillsMock,
    existsSyncMock,
    readFileSyncMock,
    mkdirSyncMock,
    writeFileSyncMock
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
    writeFileSync: mocks.writeFileSyncMock
  }
}));

import extension from '../skill-mentor/index.js';

describe('Pi Skill Mentor', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('skill-mentor.json')) {
        return JSON.stringify({ model: 'adesso-openai/gpt-4o-mini' });
      }

      return `---\ntriggers:\n  - idea\ndescription: Captures ideas\n---\n# Skill`;
    });

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
        matched: true,
        skillName: 'capture-idea',
        reason: 'User wants to save an idea'
      }
    });
  });

  it('registers message_end hook', () => {
    const onMock = vi.fn();
    const pi = {
      on: onMock,
      sendUserMessage: vi.fn()
    } as any;

    extension(pi);

    expect(onMock).toHaveBeenCalledWith('message_end', expect.any(Function));
    expect(onMock).not.toHaveBeenCalledWith('before_agent_start', expect.any(Function));
  });

  it('evaluates user/assistant messages and injects follow-up instruction when matched', async () => {
    const onMock = vi.fn();
    const sendUserMessageMock = vi.fn();
    const pi = {
      on: onMock,
      sendUserMessage: sendUserMessageMock
    } as any;

    extension(pi);
    const messageEndHandler = onMock.mock.calls.find(([eventName]) => eventName === 'message_end')?.[1];

    await messageEndHandler({
      type: 'message_end',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Please save this idea for later.' }]
      }
    });

    expect(mocks.defaultResourceLoaderMock).toHaveBeenCalledWith({
      cwd: process.cwd(),
      agentDir: '~/.pi/agent'
    });
    expect(mocks.loaderReloadMock).toHaveBeenCalledTimes(1);
    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(1);
    expect(sendUserMessageMock).toHaveBeenCalledWith(
      'Execute skill capture-idea - Reason: User wants to save an idea',
      { deliverAs: 'followUp' }
    );
  });

  it('skips unsupported roles', async () => {
    const onMock = vi.fn();
    const sendUserMessageMock = vi.fn();
    const pi = {
      on: onMock,
      sendUserMessage: sendUserMessageMock
    } as any;

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
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });

  it('does not reprocess injected Execute skill follow-up messages', async () => {
    const onMock = vi.fn();
    const sendUserMessageMock = vi.fn();
    const pi = {
      on: onMock,
      sendUserMessage: sendUserMessageMock
    } as any;

    extension(pi);
    const messageEndHandler = onMock.mock.calls.find(([eventName]) => eventName === 'message_end')?.[1];

    await messageEndHandler({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Execute skill capture-idea - Reason: User wants to save an idea' }]
      }
    });

    expect(mocks.generateObjectMock).not.toHaveBeenCalled();
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });
});
