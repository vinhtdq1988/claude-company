import { z } from 'zod';
import type { Membership } from './common';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(80),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export type AuthUser = { id: string; email: string; displayName: string };

/** Phản hồi register/login/me: client lưu `csrfToken` để gửi header X-CSRF-Token. */
export type AuthSessionResponse = {
  user: AuthUser;
  csrfToken: string;
  memberships: Membership[];
};

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['ceo', 'manager']),
  title: z.string().trim().min(1).max(120).optional(),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;
