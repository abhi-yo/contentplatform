import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import clientPromise from "@/lib/mongodb";
import { compare } from "bcryptjs";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        try {
          const client = await clientPromise;
          const db = client.db();

          const user = await db.collection("users").findOne({
            email: credentials.email.toLowerCase(),
          });

          if (!user) {
            return null;
          }

          if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new Error("Account temporarily locked");
          }

          const isPasswordValid = await compare(
            credentials.password,
            user.password
          );

          if (!isPasswordValid) {
            return null;
          }

          if (!user.emailVerified || user.emailVerified === false) {
            throw new Error("Email not verified");
          }

          await db.collection("users").updateOne(
            { _id: user._id },
            {
              $unset: { loginAttempts: 1, lockedUntil: 1 },
              $set: { lastLoginAt: new Date() },
            }
          );

          return {
            id: user._id.toString(),
            email: user.email,
            name: user.name,
            role: user.role || "reader",
            walletAddress: user.walletAddress,
            needsRoleSelection: user.needsRoleSelection || false,
          };
        } catch (error) {
          console.error("Authentication error:", error);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account, trigger, session }) {
      if (trigger === "update" && session?.user) {
        console.log("JWT Update triggered with session:", session);
        token.name = session.user.name;
        token.role = session.user.role;
        token.needsRoleSelection = session.user.needsRoleSelection;
        token.walletAddress = session.user.walletAddress;

        try {
          await connectToDatabase();
          const dbUser = await User.findOne({ email: token.email });
          if (dbUser) {
            await User.updateOne(
              { email: token.email },
              {
                $set: {
                  name: token.name,
                  role: token.role,
                  needsRoleSelection: token.needsRoleSelection,
                  walletAddress: token.walletAddress,
                },
              }
            );
          }
          console.log(
            "JWT token updated with name:",
            token.name,
            "and walletAddress:",
            token.walletAddress
          );
        } catch (error) {
          console.error("Error updating user in database:", error);
        }
        return token;
      }

      if (account && user) {
        console.log("[JWT Callback] Initial sign-in triggered.");
        console.log("[JWT Callback] Provider User:", user);
        console.log("[JWT Callback] Account Provider:", account.provider);

        if (account.provider === "credentials") {
          token.role = user.role as string;
          token.id = user.id;
          token.name = user.name;
          token.walletAddress = user.walletAddress as string;
          token.needsRoleSelection = user.needsRoleSelection as boolean;
          console.log(
            "[JWT Callback] Credentials provider - using user data directly"
          );
        } else {
          try {
            await connectToDatabase();
            const dbUser = await User.findOne({ email: user.email });
            console.log("[JWT Callback] DB User found:", dbUser);

            if (!dbUser) {
              console.log("[JWT Callback] Creating new user.");
              const newUser = await User.create({
                email: user.email,
                name: user.name,
                role: "reader",
                needsRoleSelection: true,
              });
              console.log("[JWT Callback] New user created:", newUser);
              token.role = "reader";
              token.id = newUser._id.toString();
              token.name = user.name;
              token.walletAddress = newUser.walletAddress;
              token.needsRoleSelection = true;
            } else {
              console.log("[JWT Callback] Existing user found.");
              token.role = dbUser.role;
              token.id = dbUser._id.toString();
              token.name = dbUser.name;
              token.walletAddress = dbUser.walletAddress;
              token.needsRoleSelection = dbUser.needsRoleSelection || false;
              console.log(
                "[JWT Callback] Token name set from DB User:",
                token.name
              );
            }
          } catch (error) {
            console.error("[JWT Callback] Database error:", error);
            token.role = "reader";
            token.id = user.id;
            token.name = user.name;
            token.email = user.email;
            token.needsRoleSelection = false;
            console.log(
              "[JWT Callback] Using fallback user data due to DB error"
            );
          }
        }
      } else if (token.email) {
        try {
          await connectToDatabase();
          const dbUser = await User.findOne({ email: token.email });
          if (dbUser) {
            token.role = dbUser.role;
            token.needsRoleSelection = dbUser.needsRoleSelection || false;
            token.name = dbUser.name;
            token.walletAddress = dbUser.walletAddress;
            console.log("[JWT Callback] Updated token from database:", {
              role: token.role,
              needsRoleSelection: token.needsRoleSelection,
            });
          }
        } catch (error) {
          console.error(
            "[JWT Callback] Error fetching user from database:",
            error
          );
        }
      }
      console.log("[JWT Callback] Returning token:", token);
      return token;
    },
    async session({ session, token }) {
      if (session?.user) {
        session.user.role = (token.role as string) || "reader";
        session.user.id = token.id as string;
        session.user.name = token.name;
        session.user.walletAddress = token.walletAddress as string | undefined;
        session.user.needsRoleSelection =
          (token.needsRoleSelection as boolean) || false;

        console.log(
          "Session updated with name:",
          session.user.name,
          "and walletAddress:",
          session.user.walletAddress
        );
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith(baseUrl)) return url;
      if (url.includes("callbackUrl")) {
        const urlObj = new URL(url);
        const callbackUrl = urlObj.searchParams.get("callbackUrl");
        if (callbackUrl && callbackUrl.startsWith(baseUrl)) {
          return callbackUrl;
        }
      }
      return baseUrl;
    },
  },
  pages: {
    signIn: "/auth/signin",
    signOut: "/auth/signup",
    error: "/auth/error",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  debug: process.env.NODE_ENV === "development",
};

declare module "next-auth" {
  interface User {
    role: string;
    id: string;
    walletAddress?: string;
    needsRoleSelection?: boolean;
  }

  interface Session {
    user: {
      id: string;
      role: string;
      email: string;
      name?: string | null;
      image?: string | null;
      walletAddress?: string;
      needsRoleSelection?: boolean;
    };
  }

  interface JWT {
    role: string;
    id: string;
    email?: string;
    walletAddress?: string;
    needsRoleSelection?: boolean;
  }
}
