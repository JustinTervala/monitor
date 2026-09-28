import { z } from 'zod';

const id = z.string().min(1).max(256);
export const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('rename'),
      groupId: id,
      name: z.string().trim().min(1).max(120),
      projectOverride: z.string().trim().max(80).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('merge'),
      sourceId: id,
      targetId: id,
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      type: z.literal('move'),
      groupId: id,
      targetId: id,
      placement: z.enum(['before', 'after']),
    })
    .strict(),
  z
    .object({
      type: z.literal('snooze'),
      groupId: id,
      until: z.number().int().nonnegative().max(8e15).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('unsnooze'), groupId: id }).strict(),
  z.object({ type: z.literal('detach'), groupId: id, sessionId: id }).strict(),
  z.object({ type: z.literal('notifications'), enabled: z.boolean() }).strict(),
]);
