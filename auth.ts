import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const WORKSPACE_DOMAIN = process.env.GOOGLE_WORKSPACE_DOMAIN || "fomorentals.co.uk";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [Google({ authorization: { params: { hd: WORKSPACE_DOMAIN, prompt: "select_account" } } })],
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  callbacks: {
    // profile.hd is Google's verified Workspace domain claim: the real access boundary.
    async signIn({ profile }) {
      return !!profile?.email_verified && profile?.hd === WORKSPACE_DOMAIN;
    },
  },
});
