import { z } from 'zod';

export const idSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine((value) =>
  Number.isSafeInteger(Number(value))
);
export const loginSchema = z.string().regex(
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/,
);
const repositoryName = z.string().regex(/^[a-zA-Z0-9_.-]+$/).refine((value) =>
  value !== '.' && value !== '..'
);
export const permissionsSchema = z.record(
  z.string().min(1),
  z.enum(['read', 'write']),
);
export const userSchema = z.object({ id: idSchema, login: loginSchema });
export const accountSchema = userSchema.extend({
  type: z.enum(['User', 'Organization']),
});
export const repositorySchema = z.object({
  id: idSchema,
  owner: loginSchema,
  name: repositoryName,
  private: z.boolean(),
  fullName: z.string(),
});
export const appInput = z.strictObject({
  slug: loginSchema,
  permissions: permissionsSchema.optional(),
  events: z.array(z.string().min(1)).optional(),
  callbackUrls: z.array(z.url()).optional(),
  webhook: z.strictObject({ url: z.url(), secret: z.string().min(1) })
    .optional(),
});
export const appSchema = z.object({
  id: idSchema,
  slug: loginSchema,
  clientId: z.string(),
  permissions: permissionsSchema,
  events: z.array(z.string()),
  callbackUrls: z.array(z.string()),
});
export const appRecordSchema = appSchema.extend({
  clientSecret: z.string().optional(),
  publicKey: z.string(),
  privateKey: z.string(),
  webhook: z.object({ url: z.string(), secret: z.string() }).nullable(),
});
export const appCreatedSchema = appSchema.extend({
  privateKey: z.string(),
  clientSecret: z.string(),
});
export const installationInput = z.strictObject({
  appId: idSchema,
  account: loginSchema,
  repositories: z.array(z.string().regex(/^[^/]+\/[^/]+$/)),
});
export const installationSchema = z.object({
  id: idSchema,
  appId: idSchema,
  account: loginSchema,
  repositories: z.array(z.string()),
  permissions: permissionsSchema,
  suspended: z.boolean(),
});
export const grantSchema = z.object({
  installationId: idSchema,
  repositoryIds: z.array(idSchema),
  permissions: permissionsSchema,
});
export const optionsSchema = z.strictObject({
  webhooks: z.strictObject({
    url: z.url(),
    secret: z.string().min(1).optional(),
  }).optional(),
  fixtures: z.strictObject({
    users: z.array(z.strictObject({ login: loginSchema })).optional(),
    repositories: z.array(
      z.strictObject({
        owner: loginSchema,
        name: repositoryName,
        private: z.boolean().optional(),
      }),
    ).optional(),
  }).optional(),
});

export type Permissions = Record<string, 'read' | 'write'>;
export interface Options {
  webhooks?: { url: string; secret?: string | undefined } | undefined;
  fixtures?: {
    users?: { login: string }[] | undefined;
    repositories?: {
      owner: string;
      name: string;
      private?: boolean | undefined;
    }[] | undefined;
  } | undefined;
}
export interface AppInput {
  slug: string;
  permissions?: Permissions | undefined;
  events?: string[] | undefined;
  callbackUrls?: string[] | undefined;
  webhook?: { url: string; secret: string } | undefined;
}
export interface AppView {
  id: string;
  slug: string;
  clientId: string;
  permissions: Permissions;
  events: string[];
  callbackUrls: string[];
}
export interface AppCreated extends AppView {
  clientSecret: string;
  privateKey: string;
}
export interface App extends AppView {
  privateKey: string;
  clientSecret?: string | undefined;
  publicKey: string;
  webhook: { url: string; secret: string } | null;
}
export interface InstallationInput {
  appId: string;
  account: string;
  repositories: string[];
}
export interface Installation extends InstallationInput {
  id: string;
  permissions: Permissions;
  suspended: boolean;
}
export interface Repository {
  id: string;
  owner: string;
  name: string;
  private: boolean;
  fullName: string;
}
