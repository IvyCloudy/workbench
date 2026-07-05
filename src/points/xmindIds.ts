import * as crypto from 'crypto';

export function createId(): string {
  return crypto.randomUUID();
}
