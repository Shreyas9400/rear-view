// Protocol constants. Single source for docs/PROTOCOL_SPEC.md numbers marked "proposed".

export const PROTOCOL_VERSION = 1 as const;
export const FRAME_MAGIC = 'RVF1';

export const LIMITS = {
  textMessageBytes: 16 * 1024,
  metaBytes: 16 * 1024,
  jpegBytes: 512 * 1024,
  frameMessageBytes: 600 * 1024,
  publisherBufferedBytes: 256 * 1024,
  maxViewers: 2,
  ackCredit: 2,
  helloTimeoutMs: 3000,
} as const;

export const CLOSE = {
  messageTooBig: 1009,
  malformed: 4400,
  badToken: 4401,
  badOrigin: 4403,
  helloTimeout: 4408,
  ingestReplaced: 4409,
  revoked: 4410,
  expired: 4411,
  badVersion: 4426,
  rateLimited: 4429,
  viewerLimit: 4430,
  slowViewer: 4440,
} as const;
