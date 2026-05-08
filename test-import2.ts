import type { ExtensionEvent } from '@earendil-works/pi-coding-agent';

type _MessageEndEvent = Extract<ExtensionEvent, { type: 'message_end' }>;

void (null as unknown as _MessageEndEvent);
console.log('Import successful');
