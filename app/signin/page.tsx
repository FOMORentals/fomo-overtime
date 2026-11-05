import { signIn } from "@/auth";

export default function SignIn() {
  return (
    <main>
      <h1>FOMO Overtime</h1>
      <p className="muted">Admin page for Sam and Jamie. Everyone else uses the app in Slack.</p>
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/admin" });
        }}
      >
        <button type="submit">Sign in with Google</button>
      </form>
    </main>
  );
}
