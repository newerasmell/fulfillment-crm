import { z } from "zod";

/** The Dev Dashboard app's credentials, stored encrypted as JSON in a Credential (one app can serve many stores). */
export const AppCredentials = z.object({
  clientId: z.string().trim().min(8).max(200),
  clientSecret: z.string().trim().min(8).max(500),
});
export type AppCredentials = z.infer<typeof AppCredentials>;

export function parseAppCredentials(secret: string): AppCredentials {
  return AppCredentials.parse(JSON.parse(secret));
}
