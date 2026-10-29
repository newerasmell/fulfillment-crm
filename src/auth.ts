import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { verifyLogin, type LoginFailure } from "@/server/auth/login";

class LoginError extends CredentialsSignin {
  constructor(reason: LoginFailure) {
    super();
    this.code = reason;
  }
}

const LoginForm = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(1024),
  code: z.string().max(16).default(""),
});

export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

declare module "next-auth" {
  interface User {
    sessionVersion?: number;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, code: {} },
      async authorize(raw, request) {
        const parsed = LoginForm.safeParse(raw);
        if (!parsed.success) throw new LoginError("invalid");
        const forwarded = request.headers.get("x-forwarded-for");
        const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
        const result = await verifyLogin({
          ...parsed.data,
          ip,
          userAgent: request.headers.get("user-agent"),
        });
        if (!result.ok) throw new LoginError(result.reason);
        return {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          sessionVersion: result.user.sessionVersion,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.sv = user.sessionVersion ?? 0;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      (session as typeof session & { sv?: number }).sv = typeof token.sv === "number" ? token.sv : 0;
      return session;
    },
  },
});
